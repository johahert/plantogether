import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifyWithRules, splitQuickText, jevConfig } from '../lib/classify.js';

const list = {
  title: 'Move',
  tags: [
    { id: 't1', name: 'Buy', money: 'spend' },
    { id: 't2', name: 'Sell', money: 'income' },
    { id: 't3', name: 'Kitchen', money: 'spend' },
  ],
  items: [{ title: 'Toaster', tags: ['t3'] }],
};

test('splitQuickText pulls out the link', () => {
  assert.deepEqual(splitQuickText('sofa option https://ikea.com/p/1, nice'), { title: 'sofa option , nice', url: 'https://ikea.com/p/1' });
  assert.deepEqual(splitQuickText('call the movers'), { title: 'call the movers', url: '' });
});

test('rules: keywords, named tags, links and fallback', () => {
  const pick = (title, url = '') => {
    const { pick } = classifyWithRules({ title, url }, list.tags);
    return pick.tag?.name ?? `new:${pick.suggestion.name}`;
  };
  assert.equal(pick('sell the bookcase'), 'Sell');
  assert.equal(pick('Släng trasig stol'), 'new:Throw away');
  assert.equal(pick('new kettle for the kitchen'), 'Kitchen');
  assert.equal(pick('', 'https://shop.test/x'), 'Buy');
  assert.equal(pick('boka flyttfirma'), 'new:Services');
  assert.equal(pick('ändra adress hos Skatteverket'), 'new:Admin');
  assert.equal(pick('something vague'), 'new:Task');
});

test('jev: sends state + choice question, maps answer to existing or new tag', async () => {
  const calls = [];
  const fakeJev = (choice) => async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ answers: { tag: { choice, probabilities: {}, confidence: 0.81 } } }), { status: 200 });
  };
  const config = { url: 'https://api.typesafe.ai/v1/systemone', apiKey: 'sk-test', model: 'jev-latest' };

  let result = await classify({ title: 'kettle', url: '' }, list, { config, fetchImpl: fakeJev('Kitchen') });
  assert.deepEqual(result, { tagId: 't3', confidence: 0.81, source: 'jev' });

  const { body, init } = calls[0];
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.state.new_item.text, 'kettle');
  const q = body.questions.tag;
  assert.equal(q.type, 'choice');
  assert.match(q.criteria.Kitchen, /Toaster/, 'existing tags carry example items');
  assert.ok('Donate' in q.criteria, 'unused suggestions are offered');
  assert.ok(!('buy' in q.criteria) && 'Buy' in q.criteria);

  result = await classify({ title: 'give clothes to charity', url: '' }, list, { config, fetchImpl: fakeJev('Donate') });
  assert.deepEqual(result, { newTag: { name: 'Donate', money: 'spend' }, confidence: 0.81, source: 'jev' });
});

test('jev failures fall back to rules', async () => {
  const config = { url: 'https://x.test', apiKey: 'k', model: 'm' };
  const quiet = { warn() {} };
  const down = async () => new Response('nope', { status: 503 });
  assert.equal((await classify({ title: 'sell lamp', url: '' }, list, { config, fetchImpl: down, log: quiet })).source, 'rules');
  const weird = async () => new Response(JSON.stringify({ answers: { tag: { choice: 'Nonexistent' } } }));
  const r = await classify({ title: 'sell lamp', url: '' }, list, { config, fetchImpl: weird, log: quiet });
  assert.deepEqual(r, { tagId: 't2', confidence: 0.9, source: 'rules' });
});

test('jevConfig picks TypeSafe directly or via OpenRouter', () => {
  assert.equal(jevConfig({}), null);
  assert.equal(jevConfig({ JEV_API_KEY: 'a' }).url, 'https://api.typesafe.ai/v1/systemone');
  const or = jevConfig({ OPENROUTER_API_KEY: 'b' });
  assert.equal(or.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(or.model, 'typesafe/jev-1.13');
});
