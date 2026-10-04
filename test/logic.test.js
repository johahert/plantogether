import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, itemCost, totals } from '../public/shared.js';
import { parseMeta, isPrivateAddress, fetchPreview } from '../lib/preview.js';

test('parsePrice handles common price formats', () => {
  const cases = {
    '4 995 kr': 4995,
    '4 995,00 kr': 4995,
    '1,299.00': 1299,
    '1.299,00': 1299,
    '1.299': 1299,
    '12,50': 12.5,
    '12.50': 12.5,
    '$1,299': 1299,
    '1 299:-': 1299,
    '0.99': 0.99,
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parsePrice(input), expected, input);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
  assert.ok(Number.isNaN(parsePrice('free')));
  assert.ok(Number.isNaN(parsePrice('1.2.3')));
});

test('choices only count once decided; sales are income', () => {
  const sofa = {
    category: 'buy',
    chosenId: '',
    options: [
      { id: 'a', price: 4000 },
      { id: 'b', price: 6000 },
    ],
  };
  assert.deepEqual(itemCost(sofa), { amount: 0, decided: false, min: 4000, max: 6000 });
  const items = [
    sofa,
    { category: 'buy', options: [{ id: 'c', price: 300 }] },
    { category: 'sell', options: [{ id: 'd', price: 1500 }] },
    { category: 'task', options: [] },
  ];
  assert.deepEqual(totals(items), { spend: 300, income: 1500, undecided: 1, minExtra: 4000, maxExtra: 6000 });
  sofa.chosenId = 'b';
  assert.equal(totals(items).spend, 6300);
  assert.equal(totals(items).undecided, 0);
});

test('parseMeta reads OpenGraph product tags', () => {
  const html = `<html><head>
    <title>Ignored</title>
    <meta property="og:title" content="Sofa &amp; Co &#8211; Grey">
    <meta content="/img/sofa.jpg" property="og:image">
    <meta property="og:site_name" content="Furniture Shop">
    <meta property="product:price:amount" content="4995.00">
    <meta property="product:price:currency" content="sek">
  </head></html>`;
  assert.deepEqual(parseMeta(html, 'https://shop.example/p/1'), {
    title: 'Sofa & Co – Grey',
    image: 'https://shop.example/img/sofa.jpg',
    siteName: 'Furniture Shop',
    price: 4995,
    currency: 'SEK',
  });
});

test('parseMeta falls back to JSON-LD and <title>', () => {
  const html = `<title> Armchair | Shop </title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
      {"@type":"Product","name":"Armchair","image":["https://cdn.example/a.jpg"],
       "offers":{"@type":"Offer","price":"1299","priceCurrency":"EUR"}}]}</script>`;
  const meta = parseMeta(html, 'https://www.example.com/x');
  assert.equal(meta.title, 'Armchair');
  assert.equal(meta.image, 'https://cdn.example/a.jpg');
  assert.equal(meta.price, 1299);
  assert.equal(meta.currency, 'EUR');
  assert.equal(meta.siteName, 'example.com');
});

test('preview refuses private network addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  assert.ok(!isPrivateAddress('93.184.216.34'));
  await assert.rejects(
    fetchPreview('http://internal.test/', { resolve: async () => [{ address: '10.0.0.5' }], fetchImpl: () => assert.fail() }),
    /not allowed/,
  );
  // A public page redirecting to a private one is stopped too.
  const resolve = async (host) => [{ address: host === 'public.test' ? '93.184.216.34' : '127.0.0.1' }];
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://evil.test/' } });
  await assert.rejects(fetchPreview('http://public.test/', { resolve, fetchImpl }), /not allowed/);
});
