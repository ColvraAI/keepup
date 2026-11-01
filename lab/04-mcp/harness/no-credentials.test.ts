import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dummyArguments, probeTools } from './no-credentials.ts';

test('dummy arguments fill only what a schema requires, with a value of the right type', () => {
  const schema = {
    required: ['slug', 'count', 'flag', 'list', 'choice', 'nested'],
    properties: { slug: { type: 'string' }, count: { type: 'integer' }, flag: { type: 'boolean' }, list: { type: 'array' }, choice: { type: 'string', enum: ['x', 'y'] }, nested: { type: 'object' }, optional: { type: 'string' } },
  };
  assert.deepEqual(dummyArguments(schema), { slug: 'demo', count: 1, flag: false, list: [], choice: 'x', nested: {} });
  assert.deepEqual(dummyArguments(undefined), {});
});

test("Dynatrace's alias argument gets the one value its schema check accepts, so the call reaches the cluster", () => {
  assert.deepEqual(dummyArguments({ required: ['environment_alias'], properties: { environment_alias: { type: 'string' } } }), { environment_alias: 'ALL_ENVIRONMENTS' });
});

test('each tool is called once, and what came back is kept short', async () => {
  const seen: string[] = [];
  const call = async (name: string) => {
    seen.push(name);
    return name === 'bad' ? { isError: true, text: 'x'.repeat(900) } : { isError: false, text: 'fine' };
  };
  const results = await probeTools([{ name: 'good' }, { name: 'bad' }], call);
  assert.deepEqual(seen, ['good', 'bad']);
  assert.deepEqual(results[0], { name: 'good', ok: true, text: 'fine' });
  assert.equal(results[1].ok, false);
  assert.ok(results[1].text.length <= 400);
});

test('a call that throws is a failed call, and the next tool still runs', async () => {
  const results = await probeTools([{ name: 'boom' }, { name: 'next' }], async (name) => {
    if (name === 'boom') throw new Error('invalid params');
    return { isError: false, text: 'ok' };
  });
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [['boom', false], ['next', true]]);
  assert.match(results[0].text, /invalid params/);
});

test('a server still building its docs index gets to finish, then gets asked again', async () => {
  let asked = 0;
  const results = await probeTools([{ name: 'docs' }], async () => {
    asked += 1;
    return asked < 3 ? { isError: true, text: '{"code":"INDEX_NOT_READY","retry_after_seconds":5}' } : { isError: false, text: 'pages' };
  }, { retryDelayMs: 1, retries: 5 });
  assert.equal(asked, 3);
  assert.deepEqual(results, [{ name: 'docs', ok: true, text: 'pages' }]);
});

test('asking again gives up in the end, and says the last thing it heard', async () => {
  const results = await probeTools([{ name: 'docs' }], async () => ({ isError: true, text: 'INDEX_NOT_READY' }), { retryDelayMs: 1, retries: 2 });
  assert.deepEqual(results, [{ name: 'docs', ok: false, text: 'INDEX_NOT_READY' }]);
});
