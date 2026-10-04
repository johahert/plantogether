// PlanTogether server: JSON API + live updates (SSE) + static files.
// No dependencies, just Node.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, newId } from './lib/store.js';
import { fetchPreview } from './lib/preview.js';
import { classify, jevConfig, splitQuickText } from './lib/classify.js';
import { DEFAULT_TAGS, TAG_COLORS, nextTagColor, parsePrice } from './public/shared.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_ITEMS = 1000;
const MAX_OPTIONS = 30;
const MAX_TAGS = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- input cleaning -------------------------------------------------------

function text(value, max, field, { required = false } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const v = value.trim().slice(0, max);
  if (required && !v) throw new HttpError(400, `${field} is required`);
  return v;
}

function cleanDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(value)) return value;
  throw new HttpError(400, 'Date must be YYYY-MM-DD (a day) or YYYY-MM (a month)');
}

function cleanUrl(value, field = 'Link') {
  if (value == null || value === '') return '';
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new HttpError(400, `${field} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, `${field} must be http(s)`);
  return url.href.slice(0, 2000);
}

function cleanPrice(value) {
  const n = parsePrice(value);
  if (n === null) return null;
  if (Number.isNaN(n) || n > 1e9) throw new HttpError(400, 'Price is not a number');
  return n;
}

function cleanCurrency(value) {
  const v = String(value ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(v)) throw new HttpError(400, 'Currency must be a 3-letter code like SEK or EUR');
  return v;
}

// Applies the allowed fields from `body` onto `target`. `creating` enforces required fields.
function applyItemFields(target, body, creating, list) {
  if (creating || 'title' in body) target.title = text(body.title, 200, 'Title', { required: true });
  if (creating || 'notes' in body) target.notes = text(body.notes, 2000, 'Notes');
  if (creating || 'assignee' in body) target.assignee = text(body.assignee, 60, 'Who');
  if (creating || 'date' in body) target.date = cleanDate(body.date);
  if (creating || 'tags' in body) target.tags = resolveTags(list, body.tags ?? []);
  if ('done' in body) target.done = Boolean(body.done);
  if ('chosenId' in body) {
    const id = body.chosenId || '';
    if (id && !target.options.some((o) => o.id === id)) throw new HttpError(400, 'Unknown option');
    target.chosenId = id;
  }
}

function applyOptionFields(target, body, creating) {
  if (creating || 'url' in body) target.url = cleanUrl(body.url);
  if (creating || 'title' in body) target.title = text(body.title, 300, 'Title');
  if (creating || 'image' in body) target.image = cleanUrl(body.image, 'Image');
  if (creating || 'siteName' in body) target.siteName = text(body.siteName, 100, 'Site');
  if (creating || 'note' in body) target.note = text(body.note, 500, 'Note');
  if (creating || 'price' in body) target.price = cleanPrice(body.price);
  if (!target.url && !target.title) throw new HttpError(400, 'Add a link or a name');
}

// ---- tags -------------------------------------------------------------------

function findTagByName(list, name) {
  const wanted = name.trim().toLowerCase();
  return list.tags.find((t) => t.name.toLowerCase() === wanted);
}

function addTag(list, { name, color, money }) {
  const clean = text(name, 40, 'Tag name', { required: true });
  const existing = findTagByName(list, clean);
  if (existing) return existing;
  if (list.tags.length >= MAX_TAGS) throw new HttpError(400, 'Too many tags');
  const tag = { id: newId(6), name: clean, color: TAG_COLORS.includes(color) ? color : nextTagColor(list.tags), money: 'spend' };
  if (money) tag.money = cleanMoney(money);
  list.tags.push(tag);
  return tag;
}

function cleanMoney(value) {
  if (value !== 'spend' && value !== 'income') throw new HttpError(400, 'money must be "spend" or "income"');
  return value;
}

// Accepts tag ids, or names (an unknown name creates the tag).
function resolveTags(list, values) {
  if (!Array.isArray(values)) throw new HttpError(400, 'tags must be a list');
  const ids = [];
  for (const value of values.slice(0, 10)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const tag = list.tags.find((t) => t.id === value) ?? addTag(list, { name: value });
    if (!ids.includes(tag.id)) ids.push(tag.id);
  }
  return ids;
}

// Plans created before tags existed had a fixed `category` per item.
export function migrateList(list) {
  if (list.tags) return list;
  list.tags = [];
  const names = { buy: 'Buy', sell: 'Sell', dispose: 'Throw away' };
  for (const item of list.items) {
    const preset = DEFAULT_TAGS.find((t) => t.name === names[item.category]);
    item.tags = preset ? [addTag(list, preset).id] : [];
    delete item.category;
  }
  return list;
}

// ---- http helpers ---------------------------------------------------------

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function hasEditKey(list, req) {
  const given = Buffer.from(String(req.headers['x-edit-key'] || ''));
  const real = Buffer.from(list.editKey);
  return given.length === real.length && timingSafeEqual(given, real);
}

const publicList = ({ editKey, ...list }) => list;

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

// ---- server ---------------------------------------------------------------

export function createServer({
  dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'),
  publicDir = path.join(ROOT, 'public'),
  preview = fetchPreview,
  classifyItem = classify,
} = {}) {
  const store = new Store(dataDir, migrateList);
  const listeners = new Map(); // listId -> Set<res>

  function broadcast(list) {
    for (const res of listeners.get(list.id) ?? []) {
      res.write(`data: ${JSON.stringify({ version: list.version })}\n\n`);
    }
  }

  async function loadList(id) {
    const list = await store.get(id);
    if (!list) throw new HttpError(404, 'Plan not found');
    return list;
  }

  async function editableList(id, req) {
    const list = await loadList(id);
    if (!hasEditKey(list, req)) throw new HttpError(403, 'This link is view-only');
    return list;
  }

  function findItem(list, itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) throw new HttpError(404, 'Item not found (maybe someone deleted it)');
    return item;
  }

  function saved(res, list) {
    store.touch(list);
    broadcast(list);
    send(res, 200, { list: publicList(list), canEdit: true });
  }

  async function api(req, res, parts, url) {
    const method = req.method;
    // parts: ['api', 'lists', id, 'items', itemId, 'options', optionId]
    const [, resource, id, sub, itemId, subsub, optionId] = parts;
    if (resource === 'health') return send(res, 200, { ok: true, smartAdd: jevConfig() ? 'jev' : 'rules' });
    if (resource !== 'lists') throw new HttpError(404, 'Not found');

    if (!id) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req);
      const list = await store.create({
        title: text(body.title || 'Our move', 120, 'Title', { required: true }),
        currency: cleanCurrency(body.currency || 'EUR'),
        tags: DEFAULT_TAGS.map((t) => ({ ...t, id: newId(6) })),
      });
      return send(res, 201, { list: publicList(list), editKey: list.editKey, canEdit: true });
    }

    if (!sub) {
      if (method === 'GET') {
        const list = await loadList(id);
        return send(res, 200, { list: publicList(list), canEdit: hasEditKey(list, req) });
      }
      if (method === 'PATCH') {
        const list = await editableList(id, req);
        const body = await readJson(req);
        if ('title' in body) list.title = text(body.title, 120, 'Title', { required: true });
        if ('currency' in body) list.currency = cleanCurrency(body.currency);
        return saved(res, list);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (sub === 'events' && method === 'GET') {
      const list = await loadList(id);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 3000\ndata: ${JSON.stringify({ version: list.version })}\n\n`);
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        listeners.get(id)?.delete(res);
        if (listeners.get(id)?.size === 0) listeners.delete(id);
      });
      return;
    }

    if (sub === 'preview' && method === 'GET') {
      await editableList(id, req);
      const target = cleanUrl(url.searchParams.get('url'));
      if (!target) throw new HttpError(400, 'Missing url');
      try {
        return send(res, 200, await preview(target));
      } catch (err) {
        throw new HttpError(422, `Couldn't read that page (${err.message}). You can still fill in the details yourself.`);
      }
    }

    if (sub === 'tags') {
      const list = await editableList(id, req);
      const tagId = itemId;
      if (!tagId) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const body = await readJson(req);
        if (findTagByName(list, String(body.name ?? ''))) throw new HttpError(400, 'That tag already exists');
        addTag(list, body);
        return saved(res, list);
      }
      const tag = list.tags.find((t) => t.id === tagId);
      if (!tag) throw new HttpError(404, 'Tag not found');
      if (method === 'PATCH') {
        const body = await readJson(req);
        if ('name' in body) {
          const name = text(body.name, 40, 'Tag name', { required: true });
          const clash = findTagByName(list, name);
          if (clash && clash !== tag) throw new HttpError(400, 'That tag already exists');
          tag.name = name;
        }
        if ('color' in body) {
          if (!TAG_COLORS.includes(body.color)) throw new HttpError(400, 'Unknown color');
          tag.color = body.color;
        }
        if ('money' in body) tag.money = cleanMoney(body.money);
        return saved(res, list);
      }
      if (method === 'DELETE') {
        list.tags = list.tags.filter((t) => t !== tag);
        for (const item of list.items) item.tags = item.tags.filter((t) => t !== tag.id);
        return saved(res, list);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (sub === 'quick') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const list = await editableList(id, req);
      if (list.items.length >= MAX_ITEMS) throw new HttpError(400, 'This plan is full');
      const body = await readJson(req);
      const raw = text(body.text, 2200, 'Text', { required: true });
      cleanDate(body.date); // validate before anything changes
      const { title, url } = splitQuickText(raw);
      const link = url ? cleanUrl(url) : '';
      let page = null;
      if (link) page = await preview(link).catch(() => null);

      const decision = await classifyItem({ title, url: link, preview: page }, list);
      const tag = decision.tagId ? list.tags.find((t) => t.id === decision.tagId) : addTag(list, decision.newTag);

      const fallbackTitle = page?.title || (link ? new URL(link).hostname.replace(/^www\./, '') : '');
      const item = { id: newId(6), done: false, options: [], chosenId: '', createdAt: new Date().toISOString() };
      applyItemFields(item, { title: capitalize(title || fallbackTitle), date: body.date, tags: [tag.id] }, true, list);
      if (link) {
        const option = { id: newId(6) };
        applyOptionFields(option, {
          url: link,
          title: page?.title ?? '',
          image: page?.image ?? '',
          siteName: page?.siteName ?? '',
          price: page?.price ?? null,
        }, true);
        item.options.push(option);
      }
      list.items.push(item);
      store.touch(list);
      broadcast(list);
      return send(res, 200, {
        list: publicList(list),
        canEdit: true,
        added: { itemId: item.id, tagId: tag.id, newTag: !decision.tagId, confidence: decision.confidence, source: decision.source },
      });
    }

    if (sub !== 'items') throw new HttpError(404, 'Not found');
    const list = await editableList(id, req);

    if (!itemId) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (list.items.length >= MAX_ITEMS) throw new HttpError(400, 'This plan is full');
      const body = await readJson(req);
      const item = { id: newId(6), done: false, options: [], chosenId: '', createdAt: new Date().toISOString() };
      applyItemFields(item, body, true, list);
      list.items.push(item);
      return saved(res, list);
    }

    const item = findItem(list, itemId);

    if (!subsub) {
      if (method === 'PATCH') {
        applyItemFields(item, await readJson(req), false, list);
        return saved(res, list);
      }
      if (method === 'DELETE') {
        list.items = list.items.filter((i) => i !== item);
        return saved(res, list);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (subsub !== 'options') throw new HttpError(404, 'Not found');

    if (!optionId) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (item.options.length >= MAX_OPTIONS) throw new HttpError(400, 'Too many options');
      const option = { id: newId(6) };
      applyOptionFields(option, await readJson(req), true);
      item.options.push(option);
      return saved(res, list);
    }

    const option = item.options.find((o) => o.id === optionId);
    if (!option) throw new HttpError(404, 'Option not found');
    if (method === 'PATCH') {
      applyOptionFields(option, await readJson(req), false);
      return saved(res, list);
    }
    if (method === 'DELETE') {
      item.options = item.options.filter((o) => o !== option);
      if (item.chosenId === option.id) item.chosenId = '';
      return saved(res, list);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel = decodeURIComponent(url.pathname);
    // App routes (/ and /l/<id>) all get the single page.
    if (rel === '/' || rel.startsWith('/l/')) rel = '/index.html';
    const file = path.join(publicDir, path.normalize(rel));
    if (!file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'Not found');
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') await api(req, res, parts, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
      else res.end();
    }
  });
  server.store = store;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, '0.0.0.0', () => console.log(`PlanTogether running on http://localhost:${port}`));
  const shutdown = async () => {
    await server.store.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
