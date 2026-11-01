import assert from 'node:assert/strict';
import { test } from 'node:test';
import { literalPromptNear } from '../src/call-prompt.ts';
import { computeValue, recomputeAt, ASSUMED_CALLS_PER_MONTH, speedClaim, withValues } from '../src/lever-value.ts';
import { rankFindings } from '../src/rank.ts';
import type { Finding } from '../src/run-shape.ts';
import { renderSummary } from '../src/brief.ts';

const SYSTEM = 'You route messages. Pick exactly one category from the list and call the tool once. '.repeat(4);
const file = `const CLASSIFIER_SYSTEM_PROMPT = \`${SYSTEM}{categories}\`;\nfunction go() {\n  return client.chat({ system: CLASSIFIER_SYSTEM_PROMPT });\n}\n`;

test('the literal prompt at a call site is read, with its runtime slot named', () => {
  const found = literalPromptNear(file, 3);
  assert.ok(found);
  assert.equal(found.line, 1);
  assert.deepEqual(found.placeholders, ['{categories}']);
  assert.equal(found.runtime, false);
});

test('a prompt built at runtime is said to be so', () => {
  const built = literalPromptNear('const p = `${a}${b}`;\nclient.chat({ system: p });\n', 2);
  assert.equal(built, null);
  const mostly = literalPromptNear(`const SYSTEM_PROMPT = \`\${intro} ${SYSTEM}\`;\nclient.chat({ system: SYSTEM_PROMPT });\n`, 2);
  assert.equal(mostly?.runtime, true);
});

test('value is the plan formula, with every input labelled', () => {
  const value = computeValue({ gainType: 'substitute', inputTokens: 1000, outputTokens: 20, price: { input: 2, output: 10, model: 'm', source: 's' }, frontierInput: 0.042, hours: 8, leverId: 'L', tokensLabel: 'estimate' });
  assert.equal(value.status, 'priced');
  assert.equal(value.label, 'projected');
  assert.equal(value.inputs.calls_per_month.value, ASSUMED_CALLS_PER_MONTH);
  assert.equal(value.inputs.calls_per_month.label, 'assumed');
  const expected = (1000 * 2 + 20 * 10 - 1000 * 0.042) / 1e6;
  assert.ok(Math.abs((value.today_per_call_usd as number) - (1000 * 2 + 20 * 10) / 1e6) < 1e-9);
  assert.ok(Math.abs((value.monthly_gain_usd as number) - expected * 10000) < 1e-6);
  assert.ok(Math.abs((value.value_usd as number) - (expected * 10000 * 12 - 800)) < 1e-6);
  assert.match(value.formula, /10,000 calls a month/);
  assert.equal(recomputeAt(value, 20000).monthly_gain_usd, (value.monthly_gain_usd as number) * 2);
});

test('with no prompt to read, there is no number', () => {
  const value = computeValue({ gainType: 'cache', inputTokens: null, outputTokens: 0, price: { input: 2, output: 10, model: 'm', source: 's' }, hours: 3, leverId: 'L', tokensLabel: '' });
  assert.equal(value.status, 'no_number');
  assert.equal(value.value_usd, undefined);
});

test('prompts under the cache minimum carry no number and say why', () => {
  const value = computeValue({ gainType: 'cache', inputTokens: 100, outputTokens: 0, price: { input: 2, output: 10, model: 'm', source: 's' }, hours: 3, leverId: 'L', tokensLabel: '', cacheMinimum: 512 });
  assert.equal(value.status, 'no_number');
  assert.match(value.reason as string, /512/);
});

test('the speed claim takes the smallest number on offer and stays a vendor claim', () => {
  const claim = speedClaim(['"40x-200x faster" says TypeSafe', 'typed answers about 10x faster than Responses']);
  assert.equal(claim?.text, 'about 10x faster');
  assert.equal(claim?.label, 'vendor claim');
});

const base: Finding = { title: 't', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'a.js', line: 3, text: 'x' }], why: 'w', options: [], sources: ['https://x'], lever: null, pr: null };
const retired: Finding = { ...base, title: 'Your default m was shut down', effect: ['keeps working'], reach: 'sent', deadline: '2026-06-01', locked: 'a model this code sends is retired or retiring' };

test('levers lead and a dead model never does', () => {
  const lever = { ...base, title: 'router', value: { status: 'priced', value_usd: 5 } } as unknown as Finding;
  const big = { ...base, title: 'cache', value: { status: 'priced', value_usd: 50 } } as unknown as Finding;
  const plain = { ...base, title: 'plain' };
  const { findings } = rankFindings([retired, plain, lever, big], '2026-11-01');
  assert.deepEqual(findings.map((item) => item.title), ['cache', 'router', 'plain', retired.title]);
});

test('withValues reads the prompt at the place and prices the lever', () => {
  const files = new Map([['a.js', file]]);
  const levers = [{ id: 'L', name: 'n', pattern: 'PAT-label-picking-call', kind: 'k', effects: [], gain: 'about 10x faster', proof: 'vendor claim', source: 's', how: 'h', price: '$0.042 per 1M input tokens; output tokens are free.' }];
  const [priced] = withValues([{ ...base, lever: 'L', effort: 'A day' }], { levers, files, modelIds: [], priceOf: () => ({ input: 2, output: 10, model: 'm', source: 'src' }), fallbackModel: 'm' });
  assert.equal(priced.value?.status, 'priced');
  assert.match(priced.value?.inputs.input_tokens?.label ?? '', /a\.js:1/);
  assert.equal(priced.value?.speed?.text, 'about 10x faster');
});

const run = { repo: 'o/n', commit: 'abc', db: { fetched: '2026-11-01', records: 10, by_source: {}, window: { since: 'a', until: 'b' } }, profile: null, watching: [], held_back: [], checks: { passed: 1, dropped: [] }, ran: { search: true, judge: true, online: false } };

test('the first thing read names the biggest lever and a retired model is one line under it', () => {
  const lever = withValues([{ ...base, rank: 1, lever: 'L', title: 'Ticket routing can use a decision model', effort: 'A day' }], { levers: [{ id: 'L', name: 'n', pattern: 'PAT-label-picking-call', kind: 'k', effects: [], gain: 'about 10x faster', proof: 'vendor claim', source: 's', how: 'h', price: '$0.042 per 1M input tokens' }], files: new Map([['a.js', file]]), modelIds: [], priceOf: () => ({ input: 200, output: 1000, model: 'm', source: 'src' }), fallbackModel: 'm' })[0];
  const text = renderSummary({ ...run, findings: [lever, { ...retired, rank: 2 }], exact: [{ kind: 'model', status: 'retired', live_places: [{}] } as never, { kind: 'model', status: 'retired', live_places: [{}] } as never] });
  const lines = text.split('\n');
  assert.match(lines[1], /^Biggest lever: Ticket routing can use a decision model/);
  assert.match(text, /about 10x faster \[vendor claim\]/);
  assert.match(text, /\[projected, at 10,000 calls/);
  assert.match(text, /assumed/);
  assert.match(text, /Also: 2 models here have shut down · a\.js:3 · want the change\?/);
  assert.ok(!/^\d+\. Your default m was shut down/m.test(text));
});

test('with nothing else to say, a retired model is still one line', () => {
  const text = renderSummary({ ...run, findings: [{ ...retired, rank: 1 }] });
  assert.ok(!/^1\. Your default m was shut down/m.test(text));
  assert.match(text, /Nothing big fits this week/);
  assert.match(text, /^Also: /m);
});
