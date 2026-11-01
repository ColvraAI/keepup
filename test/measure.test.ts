import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEASURE_MAX_USD, measureFinding, measuredTitleNumber, recipesFor, type MeasureInput } from '../src/measure.ts';
import type { Finding } from '../src/run-shape.ts';

const SYSTEM = 'Answer the customer using the policy below. Be brief and exact, and say when you do not know. '.repeat(80);
const finding = (lever: string): Finding => ({ rank: 1, title: 't', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'a.js', line: 3, text: 'x' }], why: 'w', options: [], sources: [], lever, pr: null });
const lever = (pattern: string, formula: string, can: string[]) => ({ id: 'L', name: 'n', pattern, kind: 'k', effects: [], gain: '', proof: 'vendor claim', source: 's', how: 'h', gain_model: { formula }, test_recipe: { can_run_with: can } });
const CACHE = lever('PAT-prompt-caching-off', 'input_tokens * hit_rate', ['ANTHROPIC_API_KEY']);
const prices = () => ({ model: 'm', input: 2, output: 10, cache_read: 0.1, cache_write: 2.5, source: 's' });

function base(overrides: Partial<MeasureInput>): MeasureInput {
  return { repo: 'o/n', commit: 'abc1234', finding: finding('L'), lever: CACHE, text: `const SYSTEM_PROMPT = \`${SYSTEM}\`;\nfunction go() {\n  client.messages.create({ system: SYSTEM_PROMPT });\n}\n`, env: {}, priceOf: prices, models: { current: 'm', cheaper: 'h' }, onStep: () => undefined, sleep: () => Promise.resolve(), ...overrides };
}

test('the recipes follow the lever', () => {
  assert.deepEqual(recipesFor(CACHE), ['prompt caching']);
  assert.deepEqual(recipesFor(lever('PAT-hand-parsed-json', 'x', [])), ['structured outputs']);
  assert.deepEqual(recipesFor(lever('PAT-label-picking-call', 'calls * decision_cost_per_call', [])), ['decision model']);
});

test('with no key it says not measured and what it needs, with no number and no call', async () => {
  const result = await measureFinding(base({ fetchImpl: () => { throw new Error('no call'); } }));
  assert.equal(result.rows[0].status, 'not measured');
  assert.equal(result.rows[0].needs, 'ANTHROPIC_API_KEY');
  assert.equal(result.rows[0].headline, undefined);
  assert.equal(result.usd, 0);
});

test('a prompt built at runtime is refused, and nothing is sent', async () => {
  const result = await measureFinding(base({ text: 'const p = `${a}${b}`;\nclient.chat({ system: p });\n', env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: () => { throw new Error('no call'); } }));
  assert.match(result.refused as string, /built at runtime/);
});

test('it says what goes to the provider before sending anything', async () => {
  const order: string[] = [];
  const fetchImpl = (async () => { order.push('sent'); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2000, output_tokens: 4 } })); }) as unknown as typeof fetch;
  await measureFinding(base({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl, onStep: (name) => order.push(name) }));
  assert.equal(order[0], 'What goes to the provider');
});

test('caching reads usage from real replies, counts n, and records raw results', async () => {
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    calls += 1;
    const cached = JSON.stringify(JSON.parse(init.body).system).includes('cache_control');
    const usage = !cached ? { input_tokens: 2000, output_tokens: 4 } : calls === 2 ? { input_tokens: 10, cache_creation_input_tokens: 2000, output_tokens: 4 } : { input_tokens: 10, cache_read_input_tokens: 2000, output_tokens: 4 };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage }));
  }) as unknown as typeof fetch;
  const result = await measureFinding(base({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl }));
  const row = result.rows[0];
  assert.equal(row.status, 'measured');
  assert.equal(row.n, 4);
  assert.match(row.headline as string, /^-\d+% input cost$/);
  assert.equal((row.raw as unknown[]).length, 4);
  assert.ok(result.usd > 0 && result.usd <= MEASURE_MAX_USD);
  assert.match(row.cannot_prove as string, /your traffic/);
});

test('the cap holds before a call goes out', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000000, output_tokens: 10 } }))) as unknown as typeof fetch;
  const result = await measureFinding(base({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl, priceOf: () => ({ model: 'm', input: 500, output: 500, cache_read: 50, cache_write: 625, source: 's' }) }));
  assert.ok(result.usd <= MEASURE_MAX_USD);
  assert.match(result.rows[0].reason ?? '', /cap/);
});

test('structured outputs counts parse failures across N runs each way', async () => {
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const strict = Boolean(JSON.parse(init.body).output_config);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: strict ? '{"answer":"x"}' : '```json\n{"answer":"x"}\n```' }], usage: { input_tokens: 100, output_tokens: 10 } }));
  }) as unknown as typeof fetch;
  const result = await measureFinding(base({ lever: lever('PAT-hand-parsed-json', 'x', ['ANTHROPIC_API_KEY']), env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl }));
  const row = result.rows[0];
  assert.equal(row.status, 'measured');
  assert.equal(row.n, 10);
  assert.match(row.summary as string, /5 of 5 .*failed/);
  assert.match(row.summary as string, /0 of 5/);
});

test('a title carries a number only when it was measured', () => {
  assert.equal(measuredTitleNumber([{ version: 1, id: 'x', finding_rank: 1, lever: null, commit: 'c', at: 'a', prompt: null, disclosure: '', usd: 0, cap_usd: 0.25, rows: [{ recipe: 'prompt caching', status: 'measured', rules: 2, n: 4, headline: '-34% input cost' }] }], 1, ['prompt caching']), 'measured -34% input cost, n=4');
  assert.equal(measuredTitleNumber([{ version: 1, id: 'x', finding_rank: 1, lever: null, commit: 'c', at: 'a', prompt: null, disclosure: '', usd: 0, cap_usd: 0.25, rows: [{ recipe: 'prompt caching', status: 'not measured', needs: 'X' }] }], 1, ['prompt caching']), null);
  assert.equal(measuredTitleNumber(undefined, 1, ['prompt caching']), null);
});

