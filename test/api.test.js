import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

let server;
let base;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'plantogether-'));
  server = createServer({
    dataDir,
    preview: async (url) => ({ title: `Preview of ${url}`, image: '', siteName: 'shop.test', price: 999, currency: 'SEK' }),
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

  // View-only access can read but not write.
  const viewed = await call('GET', `/api/lists/${id}`);
  assert.equal(viewed.data.canEdit, false);
  assert.equal((await call('POST', `/api/lists/${id}/items`, { body: { title: 'x' } })).status, 403);
  assert.equal((await call('POST', `/api/lists/${id}/items`, { body: { title: 'x' }, key: 'wrong' })).status, 403);

  // Day- and month-scoped items.
  let r = await call('POST', `/api/lists/${id}/items`, { key, body: { title: 'Sell bookcase', category: 'sell', date: '2026-10-12' } });
  assert.equal(r.status, 200);
  r = await call('POST', `/api/lists/${id}/items`, { key, body: { title: 'New sofa', category: 'buy', date: '2026-11' } });
  const sofa = r.data.list.items.at(-1);
  assert.equal(sofa.date, '2026-11');
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
