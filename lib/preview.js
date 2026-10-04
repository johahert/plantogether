// Link previews: fetch a product page and pull title, image, site name
// and price out of its OpenGraph / product meta tags or JSON-LD.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { parsePrice } from '../public/shared.js';

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7)) || !net.isIPv4(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

// Don't let the preview endpoint be used to probe the server's own network.
async function assertPublicHost(hostname, resolve) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolve(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('That address is not allowed');
  }
}

async function readLimited(res, limit) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

export async function fetchPreview(rawUrl, { fetchImpl = fetch, resolve = lookup } = {}) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links');
    await assertPublicHost(url.hostname, resolve);
    const res = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en;q=0.8,*;q=0.5',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) throw new Error(`The site answered ${res.status}`);
    if (!(res.headers.get('content-type') || '').includes('html')) {
      return { title: '', image: '', siteName: url.hostname.replace(/^www\./, ''), price: null, currency: '' };
    }
    return parseMeta(await readLimited(res, MAX_BYTES), url);
  }
  throw new Error('Too many redirects');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return attrs;
}

// Walk JSON-LD looking for something with `offers` (a Product).
function findOffer(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findOffer(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (node.offers) {
    const offers = [node.offers].flat();
    for (const offer of offers) {
      const price = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price;
      if (price != null) {
        return { price, currency: offer.priceCurrency ?? offer.priceSpecification?.priceCurrency, image: node.image, name: node.name };
      }
    }
  }
  for (const value of Object.values(node)) {
    const found = findOffer(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function absoluteHttpUrl(value, base) {
  if (!value || typeof value !== 'string') return '';
  try {
    const u = new URL(value.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export function parseMeta(html, baseUrl) {
  const base = new URL(baseUrl);
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttrs(m[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content != null && !(key in meta)) meta[key] = decodeEntities(attrs.content).trim();
  }

  let offer = null;
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      offer = findOffer(JSON.parse(m[1]));
    } catch {
      // ignore broken JSON-LD
    }
    if (offer) break;
  }

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title =
    meta['og:title'] || meta['twitter:title'] || (offer?.name ? String(offer.name) : '') ||
    (titleTag ? decodeEntities(titleTag).replace(/\s+/g, ' ').trim() : '');

  const ldImage = [offer?.image].flat()[0];
  const image = absoluteHttpUrl(
    meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] ||
      meta['twitter:image'] || meta['twitter:image:src'] ||
      (typeof ldImage === 'string' ? ldImage : ldImage?.url),
    base,
  );

  const rawPrice = meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta['price'] ?? offer?.price;
  let price = rawPrice == null ? null : parsePrice(typeof rawPrice === 'number' ? rawPrice : String(rawPrice));
  if (Number.isNaN(price)) price = null;
  const currency = String(
    meta['product:price:currency'] ?? meta['og:price:currency'] ?? meta['pricecurrency'] ?? offer?.currency ?? '',
  ).toUpperCase();

  return {
    title: title.slice(0, 300),
    image,
    siteName: (meta['og:site_name'] || base.hostname.replace(/^www\./, '')).slice(0, 100),
    price,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : '',
  };
}
