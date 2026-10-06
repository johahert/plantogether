import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classify } from '../lib/classify.js';
import { createServer, migrateList } from '../server.js';

let server;
let base;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'plantogether-'));
  server = createServer({
    dataDir,
    preview: async (url) => ({ title: `Preview of ${url}`, image: '', siteName: 'shop.test', price: 999, currency: 'SEK' }),
    // No JEV key in tests: quick add uses the keyword rules.
    classifyItem: (input, list) => classify(input, list, { config: null }),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await server.store.flush();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

async function call(method, url, { body, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-edit-key'] = key;
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

test('full planning flow: items, dates, choices, permissions', async () => {
  const created = await call('POST', '/api/lists', { body: { title: 'Move to Malmö', currency: 'sek' } });
  assert.equal(created.status, 201);
  const { list, editKey } = created.data;
  assert.equal(list.currency, 'SEK');
  assert.equal(list.editKey, undefined, 'edit key is never part of the list payload');
  const key = editKey;
  const id = list.id;
  assert.deepEqual(list.tags.map((t) => [t.name, t.money]), [['Buy', 'spend'], ['Sell', 'income'], ['Throw away', 'spend']]);
  const tagId = (l, name) => l.tags.find((t) => t.name === name).id;

  // View-only access can read but not write.
  const viewed = await call('GET', `/api/lists/${id}`);
  assert.equal(viewed.data.canEdit, false);
  assert.equal((await call('POST', `/api/lists/${id}/items`, { body: { title: 'x' } })).status, 403);
  assert.equal((await call('POST', `/api/lists/${id}/items`, { body: { title: 'x' }, key: 'wrong' })).status, 403);

  // Day- and month-scoped items.
  let r = await call('POST', `/api/lists/${id}/items`, { key, body: { title: 'Sell bookcase', tags: [tagId(list, 'Sell')], date: '2026-10-12' } });
  assert.equal(r.status, 200);
  // Tags can be given by name; unknown names create the tag.
  r = await call('POST', `/api/lists/${id}/items`, { key, body: { title: 'New sofa', tags: ['buy', 'Living room'], date: '2026-11' } });
  const sofa = r.data.list.items.at(-1);
  assert.equal(sofa.date, '2026-11');
  assert.deepEqual(sofa.tags, [tagId(r.data.list, 'Buy'), tagId(r.data.list, 'Living room')]);
  assert.equal(r.data.list.tags.length, 4);
  assert.equal((await call('POST', `/api/lists/${id}/items`, { key, body: { title: 'Bad', date: '12/10' } })).status, 400);
  assert.equal((await call('POST', `/api/lists/${id}/items`, { key, body: { title: '  ' } })).status, 400);

  // Four sofas to choose between.
  for (const [i, price] of ['4 995 kr', '7499', '6.250,50', 3200].entries()) {
    r = await call('POST', `/api/lists/${id}/items/${sofa.id}/options`, {
      key,
      body: { url: `https://shop.test/sofa-${i}`, title: `Sofa ${i}`, price },
    });
    assert.equal(r.status, 200);
  }
  const options = r.data.list.items.find((i) => i.id === sofa.id).options;
  assert.deepEqual(options.map((o) => o.price), [4995, 7499, 6250.5, 3200]);

  // Non-http links are rejected.
  r = await call('POST', `/api/lists/${id}/items/${sofa.id}/options`, { key, body: { url: 'javascript:alert(1)' } });
  assert.equal(r.status, 400);

  // Choose one; deleting the chosen option clears the choice.
  r = await call('PATCH', `/api/lists/${id}/items/${sofa.id}`, { key, body: { chosenId: options[1].id } });
  assert.equal(r.data.list.items.find((i) => i.id === sofa.id).chosenId, options[1].id);
  assert.equal((await call('PATCH', `/api/lists/${id}/items/${sofa.id}`, { key, body: { chosenId: 'nope' } })).status, 400);
  r = await call('DELETE', `/api/lists/${id}/items/${sofa.id}/options/${options[1].id}`, { key });
  const after = r.data.list.items.find((i) => i.id === sofa.id);
  assert.equal(after.options.length, 3);
  assert.equal(after.chosenId, '');

  // Done toggle + rename.
  const bookcase = r.data.list.items[0];
  r = await call('PATCH', `/api/lists/${id}/items/${bookcase.id}`, { key, body: { done: true } });
  assert.equal(r.data.list.items[0].done, true);
  r = await call('PATCH', `/api/lists/${id}`, { key, body: { title: 'Move!' } });
  assert.equal(r.data.list.title, 'Move!');

  // Preview needs the edit key.
  assert.equal((await call('GET', `/api/lists/${id}/preview?url=${encodeURIComponent('https://shop.test/a')}`)).status, 403);
  r = await call('GET', `/api/lists/${id}/preview?url=${encodeURIComponent('https://shop.test/a')}`, { key });
  assert.equal(r.data.price, 999);

  // Persisted to disk (with the edit key, which stays server-side).
  await server.store.flush();
  const saved = JSON.parse(await readFile(path.join(dataDir, `${id}.json`), 'utf8'));
  assert.equal(saved.title, 'Move!');
  assert.equal(saved.editKey, key);
});

test('unknown plans and path tricks are 404', async () => {
  assert.equal((await call('GET', '/api/lists/doesnotexist123')).status, 404);
  assert.equal((await call('GET', '/api/lists/..%2F..%2Fetc')).status, 404);
  const res = await fetch(`${base}/..%2Fserver.js`);
  assert.equal(res.status, 404);
});

test('serves the app for / and plan links', async () => {
  for (const url of ['/', '/l/abcdefgh1234']) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<div id="app">/);
  }
});

test('live updates are pushed over SSE', async () => {
  const { data } = await call('POST', '/api/lists', { body: { title: 'Live', currency: 'EUR' } });
  const controller = new AbortController();
  const res = await fetch(`${base}/api/lists/${data.list.id}/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const waitFor = async (pattern) => {
    while (!pattern.test(received)) received += decoder.decode((await reader.read()).value);
  };
  await waitFor(/"version":1/);
  await call('POST', `/api/lists/${data.list.id}/items`, { key: data.editKey, body: { title: 'Hello' } });
  await waitFor(/"version":2/);
  controller.abort();
});

test('tags: create, rename, recolor, switch to income, delete', async () => {
  const { data } = await call('POST', '/api/lists', { body: { title: 'Tags', currency: 'EUR' } });
  const key = data.editKey;
  const base = `/api/lists/${data.list.id}`;
  let r = await call('POST', `${base}/tags`, { key, body: { name: 'Kitchen' } });
  const kitchen = r.data.list.tags.find((t) => t.name === 'Kitchen');
  assert.equal(kitchen.money, 'spend');
  assert.equal((await call('POST', `${base}/tags`, { key, body: { name: 'kitchen' } })).status, 400, 'duplicate names');
  assert.equal((await call('POST', `${base}/tags`, { body: { name: 'X' } })).status, 403);

  r = await call('PATCH', `${base}/tags/${kitchen.id}`, { key, body: { name: 'Köket', color: 'pink', money: 'income' } });
  assert.deepEqual(r.data.list.tags.find((t) => t.id === kitchen.id), { ...kitchen, name: 'Köket', color: 'pink', money: 'income' });
  assert.equal((await call('PATCH', `${base}/tags/${kitchen.id}`, { key, body: { color: 'rainbow' } })).status, 400);
  assert.equal((await call('PATCH', `${base}/tags/${kitchen.id}`, { key, body: { name: 'Buy' } })).status, 400);

  r = await call('POST', `${base}/items`, { key, body: { title: 'Toaster', tags: [kitchen.id] } });
  r = await call('DELETE', `${base}/tags/${kitchen.id}`, { key });
  assert.ok(!r.data.list.tags.some((t) => t.id === kitchen.id));
  assert.deepEqual(r.data.list.items[0].tags, []);
});

test('smart quick add files items under existing or new tags', async () => {
  const { data } = await call('POST', '/api/lists', { body: { title: 'Quick', currency: 'SEK' } });
  const key = data.editKey;
  const url = `/api/lists/${data.list.id}/quick`;

  let r = await call('POST', url, { key, body: { text: 'sälj gamla bokhyllan' } });
  assert.equal(r.status, 200);
  let item = r.data.list.items.at(-1);
  assert.equal(item.title, 'Sälj gamla bokhyllan');
  assert.equal(r.data.list.tags.find((t) => t.id === r.data.added.tagId).name, 'Sell');
  assert.equal(r.data.added.newTag, false);
  assert.equal(r.data.added.source, 'rules');

  // A bare product link: titled from the page, price from the preview, filed under Buy.
  r = await call('POST', url, { key, body: { text: 'https://shop.test/sofa' } });
  item = r.data.list.items.at(-1);
  assert.equal(item.title, 'Preview of https://shop.test/sofa');
  assert.equal(item.options[0].price, 999);
  assert.equal(r.data.list.tags.find((t) => t.id === item.tags[0]).name, 'Buy');

  // Something no existing tag covers creates a suggested one.
  r = await call('POST', url, { key, body: { text: 'Donate the kids clothes', date: '2026-11' } });
  assert.equal(r.data.added.newTag, true);
  assert.equal(r.data.list.tags.at(-1).name, 'Donate');
  assert.equal(r.data.list.items.at(-1).date, '2026-11');

  assert.equal((await call('POST', url, { key, body: { text: '   ' } })).status, 400);
  assert.equal((await call('POST', url, { body: { text: 'sell x' } })).status, 403);
});

test('old plans with fixed categories are migrated to tags', () => {
  const list = migrateList({
    items: [
      { id: 'a', title: 'Sofa', category: 'buy', options: [] },
      { id: 'b', title: 'Lamp', category: 'sell', options: [] },
      { id: 'c', title: 'Call movers', category: 'task', options: [] },
    ],
  });
  assert.deepEqual(list.tags.map((t) => [t.name, t.money]), [['Buy', 'spend'], ['Sell', 'income']]);
  assert.deepEqual(list.items.map((i) => i.tags.length), [1, 1, 0]);
  assert.ok(list.items.every((i) => !('category' in i)));
});

test('health check', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('apartment layout: save, validate, permissions, floor plan image', async () => {
  const { list, editKey: key } = (await call('POST', '/api/lists', { body: { title: 'Layout' } })).data;
  const id = list.id;
  assert.deepEqual(list.layout, { height: 2.5, walls: [], openings: [], rooms: [], background: null });

  const layout = {
    height: 2.6,
    walls: [{ id: 'w1', a: [0, 0], b: [4, 0], t: 0.12 }, { id: 'w2', a: [4, 0], b: [4, 3], t: 0.12 }],
    openings: [{ id: 'd1', wall: 'w1', kind: 'door', at: 1, w: 0.9, h: 2.1, sill: 0 }],
    rooms: [{ id: 'r1', name: 'Kitchen', points: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
  };
  assert.equal((await call('PUT', `/api/lists/${id}/layout`, { body: layout })).status, 403);
  let r = await call('PUT', `/api/lists/${id}/layout`, { key, body: layout });
  assert.equal(r.status, 200);
  assert.equal(r.data.list.layout.walls.length, 2);
  assert.equal(r.data.list.layout.height, 2.6);
  assert.equal((await call('GET', `/api/lists/${id}`)).data.list.layout.rooms[0].name, 'Kitchen');

  r = await call('PUT', `/api/lists/${id}/layout`, { key, body: { walls: [{ id: 'x', a: [0, 0], b: ['a', 0] }] } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /number/);

  // Image upload: checked by content, not by the header.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const put = (body, query = '') =>
    fetch(`${base}/api/lists/${id}/layout/image${query}`, { method: 'PUT', headers: { 'x-edit-key': key, 'content-type': 'image/png' }, body });
  assert.equal((await put(Buffer.from('<svg onload=alert(1)>'))).status, 415);
  assert.equal((await fetch(`${base}/api/lists/${id}/layout/image`, { method: 'PUT', body: png })).status, 403);
  const uploaded = await put(png, '?x=1&y=2&scale=0.02');
  assert.equal(uploaded.status, 200);
  const bg = (await uploaded.json()).list.layout.background;
  assert.deepEqual({ ...bg, v: 0 }, { v: 0, x: 1, y: 2, scale: 0.02, opacity: 0.5 });
  assert.ok(bg.v > 0);

  const img = await fetch(`${base}/api/lists/${id}/layout/image?v=${bg.v}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

  // Saving the layout can move the image but never invent or drop it.
  r = await call('PUT', `/api/lists/${id}/layout`, { key, body: { ...layout, background: { x: 5, y: 5, scale: 0.03, opacity: 0.8, v: 1 } } });
  assert.deepEqual(r.data.list.layout.background, { v: bg.v, x: 5, y: 5, scale: 0.03, opacity: 0.8 });
  r = await call('PUT', `/api/lists/${id}/layout`, { key, body: { ...layout, background: null } });
  assert.equal(r.data.list.layout.background.v, bg.v);

  r = await call('DELETE', `/api/lists/${id}/layout/image`, { key });
  assert.equal(r.data.list.layout.background, null);
  assert.equal((await fetch(`${base}/api/lists/${id}/layout/image?v=${bg.v}`)).status, 404);
  assert.equal(r.data.list.layout.walls.length, 2, 'walls stay when the image goes');
});

test('vendored libraries are served gzipped and cached for good', async () => {
  const res = await fetch(`${base}/vendor/three-0.170.0/addons/OrbitControls.js`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.match(await res.text(), /class OrbitControls/);
  const page = await fetch(`${base}/l/abcdefgh12/apartment`);
  assert.match(await page.text(), /importmap/);
});
