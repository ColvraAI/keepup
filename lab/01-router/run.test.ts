import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { EXIT_NEEDS_KEY, REPO_ROOT } from '../shared/env.ts';
import { manifestProblem, parseResult, readResult, renderResult } from '../shared/result.ts';
import { agentRates, anthropicRates, decisionsRates, jevRates, onboardingModel, substituteFor } from './rates.ts';
import { buildResult, parseLongRules, parseRaw, parseTestset, pathStats, scrubSecrets, titleNumber, VARIANTS, type Raw, type RawRecord, type RatesByRoute } from './report.ts';
import { parseChecks, summarize, testFilesIn } from './repo-tests.ts';
import { main, type Deps, type SandboxRequest } from './run.ts';

const require = createRequire(import.meta.url);
const { startRecorder, forwardTo, normalizeUsage, rawUsage } = require('./harness/recorder.cjs');
const { fakeProvider } = require('./harness/fake-provider.cjs');
const { measureAll, firstAvailableModel, longFormCheck } = require('./harness/measure.cjs');

const LAB = import.meta.dirname;
const CLONE = join(REPO_ROOT, 'tmp', 'anything-llm');
const VENDOR = join(REPO_ROOT, 'tmp', 'vendor-docs');
const hasClone = existsSync(CLONE);
const hasDocs = existsSync(VENDOR);
const readLab = (name: string) => readFileSync(join(LAB, name), 'utf8');

// --- The test set ---

const testset = parseTestset(readLab('testset.jsonl'));

test('the test set has 3 to 5 rules in the router title shape, and 60 distinct messages with 10 none', () => {
  assert.ok(testset.rules.length >= 3 && testset.rules.length <= 5);
  for (const rule of testset.rules) {
    assert.match(rule.title, /^[a-z0-9_]+$/, 'matches TITLE_REGEX in modelRouterRule.js');
    assert.ok(rule.description.length > 0);
  }
  assert.equal(testset.messages.length, 60);
  assert.equal(new Set(testset.messages.map((m) => m.text)).size, 60);
  assert.equal(new Set(testset.messages.map((m) => m.id)).size, 60);
  assert.equal(testset.messages.filter((m) => m.expected === 'none').length, 10);
  const titles = new Set([...testset.rules.map((r) => r.title), 'none']);
  for (const message of testset.messages) assert.ok(titles.has(message.expected), `${message.id} has an unknown label`);
});

test('the rule list is too short to cache, which the notes and the pull request both say', () => {
  const bytes = Buffer.byteLength(testset.rules.map((r) => `- ${r.title}: ${r.description}`).join('\n'));
  assert.ok(bytes < 1024, `${bytes} bytes`);
  assert.match(readLab('testset-notes.md'), /can't show a cache discount/);
  assert.match(readLab('testset-notes.md'), /Author\.\*\* Claude/);
});

const longRules = parseLongRules(readLab('testset-long-rules.jsonl'));
const listBytes = (rules: { title: string; description: string }[]) => Buffer.byteLength(rules.map((r) => `- ${r.title}: ${r.description}`).join('\n'));

test('the long rules are the same rules in the same order, so the same labels still hold', () => {
  assert.deepEqual(longRules.map((r) => r.title), testset.rules.map((r) => r.title));
  longRules.forEach((rule, index) => {
    assert.ok(rule.description.startsWith(testset.rules[index].description), `${rule.title} keeps its short description word for word`);
    assert.ok(rule.description.length > testset.rules[index].description.length, `${rule.title} adds to it`);
  });
});

const paddingOf = (rule: { description: string }, index: number) => rule.description.slice(testset.rules[index].description.length).trim();

test('the long rules add one neutral passage, the same on every rule, so it can\'t favour a rule', () => {
  const paddings = new Set(longRules.map(paddingOf));
  assert.equal(paddings.size, 1, 'one passage, word for word, on all four rules');
});

test('the neutral passage shares no word of five letters or more with any test message, or any rule title', () => {
  const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[a-z']+/g) ?? []);
  const padding = wordsOf(paddingOf(longRules[0], 0));
  const messages = new Set(testset.messages.flatMap((m) => [...wordsOf(m.text)]));
  const shared = [...padding].filter((word) => word.length >= 5 && messages.has(word));
  assert.deepEqual(shared, []);
  for (const rule of testset.rules) assert.ok(!padding.has(rule.title), `${rule.title} appears in the passage`);
});

test('the notes say how the long rules were made, and drop the claim the old ones failed', () => {
  const notes = readLab('testset-notes.md');
  assert.doesNotMatch(notes, /leave out guidance on the hard messages/);
  assert.match(notes, /same passage/);
});

test('the long list is big enough for the cached form of the request, by the rule in the patch', () => {
  const patch = readLab('patches/0002-feat-cache-long-router-category-lists-now-Decisions-.patch');
  const size = patch.match(/DECISIONS_CACHE_MIN_BYTES = (\d+) \* (\d+);/);
  assert.ok(size, 'the patch states the size');
  assert.ok(listBytes(longRules) >= Number(size[1]) * Number(size[2]), `${listBytes(longRules)} bytes`);
  assert.match(readLab('testset-notes.md'), /testset-long-rules\.jsonl/);
});

test('parseLongRules refuses a bad line instead of skipping it', () => {
  assert.throws(() => parseLongRules('{"title":"a"}\n'), /description/);
  assert.throws(() => parseLongRules('{"description":"a"}\n'), /title/);
});

test('parseTestset refuses a bad line instead of skipping it', () => {
  assert.throws(() => parseTestset('{"type":"message","id":"m1","text":"hi"}\n'), /expected/);
  assert.throws(() => parseTestset('{"type":"rule","title":"a"}\n'), /description/);
  assert.throws(() => parseTestset('{"type":"other"}\n'), /type/);
});

// --- The harness parts that have no AnythingLLM code in them ---

const DECISION_BODY = {
  model: 'gpt-6-luna',
  input: 'I was charged twice.',
  questions: [{ type: 'choice', name: 'category', instructions: 'Which?', choices: [{ value: 'billing' }, { value: 'none' }] }],
};

test('the fake answers POST /v1/decisions in the shape the docs show', async () => {
  const recorder = await startRecorder(fakeProvider());
  try {
    const response = await fetch(`${recorder.url}/v1/decisions`, { method: 'POST', body: JSON.stringify(DECISION_BODY) });
    const body = await response.json();
    assert.equal(response.status, 200);
    const answer = body.answers[0];
    assert.equal(answer.type, 'choice');
    assert.equal(answer.name, 'category');
    assert.equal(answer.choice, 'billing');
    assert.deepEqual(answer.probabilities.map((p: { value: string }) => p.value), ['billing', 'none']);
    assert.equal(typeof answer.confidence, 'number');
    assert.equal(typeof body.usage.input_tokens_details.cached_tokens, 'number');
    assert.equal(body.usage.output_tokens, 0);
  } finally {
    await recorder.close();
  }
});

test('the fake sends a Responses stream that carries a function call and usage', async () => {
  const recorder = await startRecorder(fakeProvider());
  try {
    const request = {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'I was charged twice.' }] }],
      stream: true,
      tools: [{ type: 'function', name: 'select_category', parameters: { properties: { category: { enum: ['billing', 'none'] } } } }],
    };
    const text = await (await fetch(`${recorder.url}/v1/responses`, { method: 'POST', body: JSON.stringify(request) })).text();
    assert.match(text, /response\.output_item\.added/);
    assert.match(text, /select_category/);
    assert.match(text, /billing/);
    assert.equal(recorder.calls[0].usage.output > 0, true);
    assert.equal(recorder.calls[0].usage.input > 0, true);
  } finally {
    await recorder.close();
  }
});

test('the fake says a retired model is gone, and the harness moves to the next candidate', async () => {
  const recorder = await startRecorder(fakeProvider({ retired: ['old-model'] }));
  try {
    const lookup = async (model: string) => (await fetch(`${recorder.url}/v1/models/${model}`)).status;
    assert.deepEqual(await firstAvailableModel(['old-model', 'new-model'], lookup), {
      model: 'new-model',
      tried: [{ model: 'old-model', status: 404 }, { model: 'new-model', status: 200 }],
    });
    assert.equal((await firstAvailableModel(['old-model'], lookup)).model, null);
  } finally {
    await recorder.close();
  }
});

test('the recorder forwards keys to the provider but never keeps them', async () => {
  const seen: Record<string, string> = {};
  const fakeFetch = async (url: string, init: { headers: Record<string, string> }) => {
    seen.url = url;
    seen.auth = init.headers.authorization;
    return new Response(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const upstreams = { openai: 'https://openai.test', anthropic: 'https://anthropic.test', typesafe: 'https://typesafe.test' };
  const recorder = await startRecorder(forwardTo(upstreams, fakeFetch));
  try {
    await fetch(`${recorder.url}/v1/decisions`, { method: 'POST', headers: { authorization: 'Bearer sk-secret-value' }, body: '{}' });
    assert.equal(seen.url, 'https://openai.test/v1/decisions');
    assert.equal(seen.auth, 'Bearer sk-secret-value');
    assert.ok(!JSON.stringify(recorder.calls).includes('sk-secret-value'));
  } finally {
    await recorder.close();
  }
});

test('usage comes out in one shape for all three providers', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, output_tokens: 0 }), { input: 100, cached: 60, cacheWrite: 10, output: 0 });
  assert.deepEqual(normalizeUsage({ input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 5 }), { input: 100, cached: 70, cacheWrite: 10, output: 5 });
  assert.deepEqual(normalizeUsage({ input_tokens: 42, output_tokens: 12 }), { input: 42, cached: 0, cacheWrite: 0, output: 12 });
  assert.equal(normalizeUsage(null), null);
});

test('usage is read from Anthropic and Responses event streams', () => {
  const anthropic = 'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
  assert.deepEqual(rawUsage(anthropic), { input_tokens: 9, output_tokens: 7 });
  const responses = 'data: {"type":"response.created"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3}}}\n\n';
  assert.deepEqual(rawUsage(responses), { input_tokens: 3 });
  assert.equal(rawUsage('not json at all'), null);
});

test('measureAll flips the order on each message and keeps each path to its own calls', async () => {
  const calls: { path: string }[] = [];
  const order: string[] = [];
  const classify = (path: string) => async () => {
    order.push(path);
    calls.push({ path });
    return { title: 'coding' };
  };
  const records: { path: string; predicted: string; calls: { path: string }[] }[] = [];
  await measureAll({
    messages: [{ id: 'a', text: 'x', expected: 'coding' }, { id: 'b', text: 'y', expected: 'none' }],
    classifiers: { before: classify('before'), after: classify('after') },
    calls,
    drainLogs: () => [],
    onRecord: (record: (typeof records)[number]) => records.push(record),
  });
  assert.deepEqual(order, ['before', 'after', 'after', 'before']);
  for (const record of records) assert.deepEqual(record.calls, [{ path: record.path }]);
});

test('a classifier that throws is recorded, and a null rule reads as none', async () => {
  const records: { predicted: string | null; thrown: string | null }[] = [];
  await measureAll({
    messages: [{ id: 'a', text: 'x', expected: 'none' }],
    classifiers: { before: async () => null, after: async () => { throw new Error('boom'); } },
    calls: [],
    drainLogs: () => [],
    onRecord: (record: (typeof records)[number]) => records.push(record),
  });
  assert.equal(records[0].predicted, 'none');
  assert.equal(records[1].predicted, null);
  assert.equal(records[1].thrown, 'boom');
});

test('the long-form check runs every message and keeps each one to its own calls', async () => {
  const calls: { path: string }[] = [];
  const result = await longFormCheck({
    messages: [{ id: 'a', text: 'x', expected: 'coding' }, { id: 'b', text: 'y', expected: 'none' }],
    classify: async (text: string) => {
      calls.push({ path: text });
      return text === 'x' ? { title: 'coding' } : null;
    },
    calls,
    drainLogs: () => [],
  });
  assert.equal(result.type, 'long_form_check');
  assert.deepEqual(result.records.map((r: RawRecord) => [r.id, r.path, r.predicted, r.expected]), [['a', 'after', 'coding', 'coding'], ['b', 'after', 'none', 'none']]);
  assert.deepEqual(result.records.map((r: RawRecord) => r.calls), [[{ path: 'x' }], [{ path: 'y' }]]);
});

// --- Prices, read from their sources ---

test('prices are read from their sources, with a date, and output on Decisions is not charged', { skip: !hasDocs }, () => {
  const decisions = decisionsRates(REPO_ROOT);
  assert.equal(decisions.input, 0.1);
  assert.equal(decisions.cached, 0.01);
  assert.equal(decisions.cacheWrite, 0.125);
  assert.equal(decisions.output, 0);
  assert.match(decisions.source, /openrouter\.ai/);
  assert.match(decisions.source, /changelog/);
  assert.match(decisions.fetched, /^\d{4}-\d{2}-\d{2}$/);

  const nano = agentRates('gpt-4.1-nano', REPO_ROOT);
  assert.deepEqual([nano.input, nano.output, nano.cached], [0.1, 0.4, 0.025]);
  const substitute = agentRates('gpt-5.6-luna', REPO_ROOT);
  assert.deepEqual([substitute.input, substitute.output, substitute.cached], [0.2, 1.2, 0.02]);
  assert.throws(() => agentRates('not-a-model', REPO_ROOT), /no price/);

  const jev = jevRates(REPO_ROOT);
  assert.deepEqual([jev.input, jev.output], [0.042, 0]);
});

test('the Claude price is read from the Anthropic pricing page', { skip: !existsSync(join(VENDOR, 'anthropic-pricing.md')) }, () => {
  const sonnet = anthropicRates('claude-sonnet-4-6', REPO_ROOT);
  assert.deepEqual([sonnet.input, sonnet.cacheWrite, sonnet.cached, sonnet.output], [3, 3.75, 0.3, 15]);
  assert.throws(() => anthropicRates('claude-not-real', REPO_ROOT), /no price/);
});

test('the agent model comes from the fork at the base commit, and its substitute from the deprecations page', { skip: !hasClone || !hasDocs }, () => {
  const settings = execFileSync('git', ['-C', CLONE, 'show', 'ead123f0:server/models/systemSettings.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(onboardingModel(settings, 'openai'), 'gpt-4.1-nano');
  assert.equal(onboardingModel(settings, 'anthropic'), 'claude-sonnet-4-6');
  assert.throws(() => onboardingModel('nothing here', 'openai'), /onboarding/);
  assert.deepEqual(substituteFor('gpt-4.1-nano', readFileSync(join(VENDOR, 'deprecations.md'), 'utf8')), { shutdown: 'October 23, 2026', substitute: 'gpt-5.6-luna' });
  assert.equal(substituteFor('not-a-model', ''), null);
});

// --- The table and the title ---

const RATES: RatesByRoute = {
  decisions: { label: 'gpt-6-luna on /v1/decisions', input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0, source: 'test source', fetched: '2026-10-31' },
  agent: { label: 'gpt-x', input: 1, cached: 0.5, cacheWrite: 1, output: 4, source: 'agent source', fetched: '2026-11-01' },
  jev: { label: 'jev', input: 0.042, cached: 0.042, cacheWrite: 0.042, output: 0, source: 'jev source', fetched: '2026-11-01' },
};

function call(path: string, usage: { input: number; cached?: number; cacheWrite?: number; output?: number } | null, status = 200) {
  return { method: 'POST', path, status, ms: 1, request: null, response: '', usage: usage && { cached: 0, cacheWrite: 0, output: 0, ...usage } };
}

function record(id: string, path: 'before' | 'after', ms: number, predicted: string | null, calls: RawRecord['calls'], expected = 'coding'): RawRecord {
  return { type: 'record', id, path, expected, predicted, thrown: null, ms, calls, logs: [] };
}

function rawOf(records: RawRecord[]): Raw {
  return { meta: { type: 'meta', real: true, variant: 'decisions', agentProvider: 'openai', agentModel: 'gpt-x', tried: [{ model: 'gpt-x', status: 200 }] }, records, longForm: null };
}

test('after-path cost counts the fallback call too, and charges nothing for Decisions output', () => {
  const records = [
    record('a', 'after', 10, 'coding', [call('/v1/decisions', { input: 1_000_000, output: 5_000_000 })]),
    record('b', 'after', 90, 'coding', [call('/v1/decisions', { input: 1_000_000 }), call('/v1/responses', { input: 1_000_000, output: 1_000_000 })]),
  ];
  const stats = pathStats(records, 'after', RATES);
  assert.ok(Math.abs(stats.totalUsd - (0.1 + 0.1 + 1 + 4)) < 1e-9);
  assert.ok(Math.abs(stats.costPer1000 - (stats.totalUsd / 2) * 1000) < 1e-9);
  assert.equal(stats.fellBack, 1);
});

test('cached and cache-write tokens are priced at their own rates, and aren\'t counted twice', () => {
  const records = [record('a', 'after', 10, 'coding', [call('/v1/decisions', { input: 1_000_000, cached: 600_000, cacheWrite: 100_000 })])];
  const stats = pathStats(records, 'after', RATES);
  assert.ok(Math.abs(stats.totalUsd - (0.3 * 0.1 + 0.6 * 0.01 + 0.1 * 0.125)) < 1e-9);
  assert.equal(stats.cachedTokens, 600_000);
});

test('p50, p95 and accuracy come from the records', () => {
  const records = Array.from({ length: 20 }, (_, i) => record(`m${i}`, 'before', i + 1, i < 15 ? 'coding' : 'billing', [call('/v1/responses', { input: 1 })]));
  const stats = pathStats(records, 'before', RATES);
  assert.equal(stats.p50, 10);
  assert.equal(stats.p95, 19);
  assert.equal(stats.accuracy, 0.75);
});

const stat = (over: Partial<ReturnType<typeof pathStats>>) => ({ n: 60, ran: 60, failed: 0, unpriced: 0, accuracy: 0.9, p50: 100, p95: 200, totalUsd: 1, costPer1000: 10, fellBack: 0, answeredByModel: 60, modelCalls: 60, modelRejected: 0, cachedTokens: 0, cacheWriteTokens: 0, inputTokens: 0, ...over });

test('the title takes the speed-up when it beats the cost cut', () => {
  assert.equal(titleNumber(stat({ p50: 620 }), stat({ p50: 100, costPer1000: 5 }), 60), '6.2x faster on 60 test messages');
});

test('the title takes the cost cut when it beats the speed-up', () => {
  assert.equal(titleNumber(stat({ p50: 200, costPer1000: 10 }), stat({ p50: 100, costPer1000: 2 }), 60), '80% cheaper on 60 test messages');
});

test('an accuracy drop of more than 2 points goes in the title', () => {
  const title = titleNumber(stat({ p50: 620, accuracy: 0.95 }), stat({ p50: 100, accuracy: 0.9 }), 60);
  assert.equal(title, '6.2x faster on 60 test messages, accuracy down 5 points');
});

test('an accuracy drop of 2 points or less stays out of the title', () => {
  assert.equal(titleNumber(stat({ p50: 620, accuracy: 0.95 }), stat({ p50: 100, accuracy: 0.93 }), 60), '6.2x faster on 60 test messages');
});

test('a run with no gain says so instead of claiming one', () => {
  assert.equal(titleNumber(stat({ p50: 100, costPer1000: 2 }), stat({ p50: 120, costPer1000: 3 }), 60), 'no faster or cheaper on 60 test messages');
});

test('a speed-up that rounds to 1.0x is no gain, so the title never prints 1.0x faster', () => {
  assert.equal(titleNumber(stat({ p50: 1040 }), stat({ p50: 1000 }), 4), 'no faster or cheaper on 4 test messages');
});

test('a cost cut that rounds to 0% is no gain, so the title never prints 0% cheaper', () => {
  assert.equal(titleNumber(stat({ costPer1000: 10 }), stat({ costPer1000: 9.96 }), 60), 'no faster or cheaper on 60 test messages');
});

test('a gain that rounds away gives way to the other one, even when its factor is larger', () => {
  assert.equal(titleNumber(stat({ p50: 1040, costPer1000: 10 }), stat({ p50: 1000, costPer1000: 9.8 }), 60), '2% cheaper on 60 test messages');
  assert.equal(titleNumber(stat({ p50: 1100, costPer1000: 10 }), stat({ p50: 1000, costPer1000: 9.99 }), 60), '1.1x faster on 60 test messages');
});

test('a gain that rounds away still leaves a real accuracy drop in the title', () => {
  assert.equal(titleNumber(stat({ p50: 1040, accuracy: 0.95 }), stat({ p50: 1000, accuracy: 0.9 }), 60), 'no faster or cheaper on 60 test messages, accuracy down 5 points');
});

function fullRun(): RawRecord[] {
  return testset.messages.flatMap((m, i) => [
    record(m.id, 'before', 600, m.expected, [call('/v1/responses', { input: 200, output: 20 })], m.expected),
    record(m.id, 'after', 100, m.expected, i === 0 ? [call('/v1/decisions', { input: 90 }), call('/v1/responses', { input: 200, output: 20 })] : [call('/v1/decisions', { input: 90 })], m.expected),
  ]);
}

test('a clean run is measured: the table has every row, the price and its date, and survives parsing', () => {
  const result = buildResult({ raw: rawOf(fullRun()), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null });
  assert.equal(result.status, 'measured');
  assert.equal(result.title_number, '95% cheaper on 60 test messages', 'the cost cut, a factor of about 20, beats the 6x speed-up');
  assert.deepEqual(parseResult(renderResult(result)).title_number, result.title_number);
  for (const needed of ['| | before | after |', 'n |', 'accuracy', 'p50', 'p95', 'cost per 1,000 messages', 'test source', '2026-10-31', 'agent source', '2026-11-02']) {
    assert.ok(result.body.includes(needed), `missing ${needed}`);
  }
});

test('the table says when caching did not apply, rather than implying a benefit', () => {
  const result = buildResult({ raw: rawOf(fullRun()), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null });
  assert.match(result.body, /cached tokens read[^\n]*\| 0 \|/);
  assert.match(result.body, /too short for the 1,024-token minimum/);
});

const CACHED_FORM = {
  input: [
    { role: 'developer', content: [{ type: 'input_text', text: 'Categories', prompt_cache_breakpoint: { mode: 'explicit' } }] },
    { role: 'user', content: 'hello' },
  ],
  prompt_cache_options: { mode: 'explicit' },
};
const SHORT_FORM = { input: 'hello', prompt_cache_options: { mode: 'explicit' } };
const longRecord = (id: string, predicted: string, expected: string, calls: RawRecord['calls']) => record(id, 'after', 50, predicted, calls, expected);
const decisionsCall = (usage: { input: number; cached?: number; cacheWrite?: number }, status = 200) => ({ ...call('/v1/decisions', usage, status), request: CACHED_FORM });

function resultWithLongForm(records: RawRecord[]) {
  const raw: Raw = { ...rawOf(fullRun()), longForm: { type: 'long_form_check', records } };
  return buildResult({ raw, rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null });
}

test('the long-form check is scored against the labels and reported beside the table, not in it', () => {
  const result = resultWithLongForm([
    longRecord('a', 'coding', 'coding', [decisionsCall({ input: 2000, cacheWrite: 1800 })]),
    longRecord('b', 'billing', 'billing', [decisionsCall({ input: 2000, cached: 1800 })]),
    longRecord('c', 'none', 'coding', [decisionsCall({ input: 2000, cached: 1800 }), call('/v1/responses', { input: 300, output: 20 })]),
    longRecord('d', 'none', 'none', [decisionsCall({ input: 2000, cached: 1800 })]),
  ]);
  const note = result.body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '';
  assert.match(note, /4 messages/);
  assert.match(note, /accuracy 75\.0%/, 'three of four match their labels');
  assert.match(note, /against 100\.0% for the short list/, 'beside the short-list number in the table');
  assert.match(note, /1 answered by the agent/);
  assert.match(note, /5400 of 8300 input tokens read from the cache/);
  assert.match(note, /testset-long-rules\.jsonl/);
  assert.match(note, /one longer version of one rule list/);
  assert.equal(result.title_number, '95% cheaper on 60 test messages', 'the title still reads the table only');
  assert.doesNotMatch(result.body.split('\n').filter((line) => line.startsWith('|')).join('\n'), /Long-list/);
});

test('a long-form check with failed calls gives no accuracy', () => {
  const result = resultWithLongForm([
    longRecord('a', 'coding', 'coding', [decisionsCall({ input: 2000 })]),
    { ...longRecord('b', 'none', 'none', [decisionsCall({ input: 0 }, 500), call('/v1/responses', null, 500)]) },
  ]);
  const note = result.body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '';
  assert.match(note, /1 of 2 messages ran/);
  assert.doesNotMatch(note, /accuracy \d/);
});

test('a long-form check with an answered call that reports no usage gives no accuracy and no cost', () => {
  const result = resultWithLongForm([
    longRecord('a', 'coding', 'coding', [decisionsCall({ input: 2000 })]),
    longRecord('b', 'none', 'none', [{ ...call('/v1/decisions', null), request: CACHED_FORM }]),
  ]);
  const note = result.body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '';
  assert.match(note, /1 of 2 messages ran/);
  assert.doesNotMatch(note, /accuracy \d|per 1,000/);
});

test('a long-form check that never used the cached form says it measured nothing about that form', () => {
  const result = resultWithLongForm([longRecord('a', 'coding', 'coding', [call('/v1/decisions', { input: 90 })])]);
  const note = result.body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '';
  assert.match(note, /0 of 1 requests/);
  assert.doesNotMatch(note, /accuracy \d/);
});

test('explicit mode with no breakpoint is not the cached form, because that request turns caching off', () => {
  const result = resultWithLongForm([longRecord('a', 'coding', 'coding', [{ ...call('/v1/decisions', { input: 90 }), request: SHORT_FORM }])]);
  const note = result.body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '';
  assert.match(note, /0 of 1 requests/);
  assert.doesNotMatch(note, /accuracy \d/);
});

test('a long-form check with every cached-form call rejected gives no accuracy, even when the agent answered all of them', () => {
  const rescued = (id: string) => longRecord(id, 'coding', 'coding', [decisionsCall({ input: 0 }, 400), call('/v1/responses', { input: 300, output: 20 })]);
  const note = (resultWithLongForm(['a', 'b', 'c'].map(rescued)).body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '');
  assert.match(note, /3 of 3 requests were rejected/);
  assert.doesNotMatch(note, /accuracy \d/);
});

test('one rejected cached-form call is enough to withhold the accuracy', () => {
  const note = (resultWithLongForm([
    longRecord('a', 'coding', 'coding', [decisionsCall({ input: 2000 })]),
    longRecord('b', 'coding', 'coding', [decisionsCall({ input: 0 }, 429), call('/v1/responses', { input: 300, output: 20 })]),
  ]).body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '');
  assert.match(note, /1 of 2 requests were rejected/);
  assert.doesNotMatch(note, /accuracy \d/);
});

test('a long-form check the agent answered most of gives no accuracy for the cached form', () => {
  const unsure = (id: string) => longRecord(id, 'coding', 'coding', [decisionsCall({ input: 2000 }), call('/v1/responses', { input: 300, output: 20 })]);
  const note = (resultWithLongForm([unsure('a'), unsure('b'), longRecord('c', 'coding', 'coding', [decisionsCall({ input: 2000 })])]).body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '');
  assert.match(note, /agent answered 2 of 3/);
  assert.doesNotMatch(note, /accuracy \d/);
});

test('the long-form note prints cache writes beside reads, and says a back-to-back run is the best case', () => {
  const note = (resultWithLongForm([
    longRecord('a', 'coding', 'coding', [decisionsCall({ input: 2000, cacheWrite: 1800 })]),
    longRecord('b', 'coding', 'coding', [decisionsCall({ input: 2000, cached: 1800 })]),
  ]).body.split('\n').find((line) => line.startsWith('Long-list check')) ?? '');
  assert.match(note, /1800 of 4000 input tokens read from the cache and 1800 written to it/);
  assert.match(note, /back to back/);
  assert.match(note, /best case/);
  assert.match(note, /same passage/, 'says the long descriptions are padding');
});

test('without a long-form check the result does not mention one', () => {
  const result = buildResult({ raw: rawOf(fullRun()), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null });
  assert.doesNotMatch(result.body, /Long-list check/);
});

test('parseRaw reads the long-form check apart from the table records', () => {
  const inner = record('a', 'after', 1, 'coding', []);
  const lines = [rawOf([]).meta, record('b', 'before', 1, 'coding', []), { type: 'long_form_check', records: [inner] }].map((line) => JSON.stringify(line)).join('\n');
  const raw = parseRaw(lines);
  assert.deepEqual(raw.records.map((r) => r.id), ['b']);
  assert.deepEqual(raw.longForm?.records.map((r) => r.id), ['a']);
});

const NANO = { label: 'gpt-nano', input: 0.5, cached: 0.1, cacheWrite: 0.5, output: 2, source: 'nano source', fetched: '2026-11-01' };
const DEPRECATION = { shutdown: 'October 23, 2026', substitute: 'gpt-5.6-luna' };

function swappedRaw(): Raw {
  const raw = rawOf(fullRun());
  return { ...raw, meta: { ...raw.meta, agentModel: 'gpt-5.6-luna', tried: [{ model: 'gpt-4.1-nano', status: 404 }, { model: 'gpt-5.6-luna', status: 200 }] } };
}

test('a substituted agent model is named in the result, with the shutdown and the reason', () => {
  const result = buildResult({ raw: swappedRaw(), rates: { ...RATES, onboarding: NANO }, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-4.1-nano', deprecation: DEPRECATION });
  assert.match(result.body, /gpt-5\.6-luna/);
  assert.match(result.body, /gpt-4\.1-nano/);
  assert.match(result.body, /October 23, 2026/);
});

test('a substituted agent model that costs more says the cost cut is measured against it, and prints the onboarding price', () => {
  const result = buildResult({ raw: swappedRaw(), rates: { ...RATES, onboarding: NANO }, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-4.1-nano', deprecation: DEPRECATION });
  assert.match(result.body, /measured against gpt-5\.6-luna, which costs more than gpt-4\.1-nano/);
  assert.match(result.body, /- gpt-nano: \$0\.5 input/, 'the price list has the onboarding model');
  assert.match(result.body, /nano source/);
  assert.match(result.body, /95% cut/, 'the measured cut, as in the title');
});

test('the same tokens are repriced at the onboarding prices, with every agent call on that price', () => {
  const result = buildResult({ raw: swappedRaw(), rates: { ...RATES, onboarding: NANO }, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-4.1-nano', deprecation: DEPRECATION });
  // Before: 200 in and 20 out at 0.5 and 2 is $0.00014 a message, $0.14 per 1,000.
  // After: 90 in at 0.1 on all 60, plus one agent call at $0.00014, over 60 messages.
  const before = 0.14;
  const after = (60 * 90 * 0.1) / 1e6 / 60 * 1000 + (0.00014 / 60) * 1000;
  assert.ok(result.body.includes(`$${before.toFixed(4)} before and $${after.toFixed(4)} after`), result.body);
  assert.match(result.body, /not a run on gpt-4\.1-nano/);
  assert.equal(result.title_number, '95% cheaper on 60 test messages', 'the title still reads the measured table');
});

test('a substitute that costs no more does not claim to', () => {
  const dearer = { ...NANO, input: 10, output: 40 };
  const result = buildResult({ raw: swappedRaw(), rates: { ...RATES, onboarding: dearer }, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-4.1-nano', deprecation: DEPRECATION });
  assert.doesNotMatch(result.body, /costs more than/);
  assert.match(result.body, /measured against gpt-5\.6-luna/);
});

test('a substituted agent model with no onboarding price refuses to write a result', () => {
  assert.throws(() => buildResult({ raw: swappedRaw(), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-4.1-nano', deprecation: DEPRECATION }), /no price for gpt-4\.1-nano/);
});

test('with the onboarding model itself, no price comparison is printed', () => {
  const result = buildResult({ raw: rawOf(fullRun()), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null });
  assert.doesNotMatch(result.body, /measured against|repriced|not a run on/);
});

test('a failed call means partial, with no title number and no accuracy or latency rows', () => {
  const records = fullRun().map((r, i) => (i === 0 ? { ...r, calls: [call('/v1/responses', null, 404)] } : r));
  const result = buildResult({ raw: rawOf(records), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null });
  assert.equal(result.status, 'partial');
  assert.equal(result.title_number, undefined);
  assert.ok(result.needs);
  assert.doesNotMatch(result.body, /accuracy|p50|cost per/);
  assert.match(result.body, /59 of 60/);
});

test('a Decisions error the agent recovers from is a working fallback, not a failed record', () => {
  const records = fullRun().map((r, i) => (i === 1 ? { ...r, calls: [call('/v1/decisions', null, 503), call('/v1/responses', { input: 200, output: 20 })] } : r));
  const result = buildResult({ raw: rawOf(records), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null });
  assert.equal(result.status, 'measured');
});

test('a Decisions error with a failed agent call, a thrown error or no calls at all count as failed', () => {
  for (const change of [
    { calls: [call('/v1/decisions', null, 503), call('/v1/responses', null, 500)] },
    { thrown: 'boom', predicted: null },
    { calls: [] },
  ]) {
    const records = fullRun().map((r, i) => (i === 1 ? { ...r, ...change } : r));
    assert.equal(buildResult({ raw: rawOf(records), rates: RATES, measuredAt: '2026-11-02', variant: 'decisions', onboarding: 'gpt-x', deprecation: null }).status, 'partial');
  }
});

/** The real shape of the failure nobody has tested: the agent rescues every message, 700 ms against 600 ms. */
function everyDecisionRejected(status = 400): RawRecord[] {
  return testset.messages.flatMap((m) => [
    record(m.id, 'before', 700, m.expected, [call('/v1/responses', { input: 200, output: 20 })], m.expected),
    record(m.id, 'after', 600, m.expected, [call('/v1/decisions', null, status), call('/v1/responses', { input: 200, output: 20 })], m.expected),
  ]);
}

const buildOf = (records: RawRecord[], variant: 'decisions' | 'jev' = 'decisions') =>
  buildResult({ raw: rawOf(records), rates: { ...RATES, jev: RATES.decisions }, measuredAt: '2026-11-02', variant, onboarding: 'gpt-x', deprecation: null });

test('every Decisions call rejected is partial, with no title number, even though the agent answered them all', () => {
  const result = buildOf(everyDecisionRejected());
  assert.equal(result.status, 'partial');
  assert.equal(result.title_number, undefined);
  assert.doesNotMatch(result.body, /accuracy|p50|cost per/);
  assert.match(result.body, /Decisions calls rejected[^\n]*60 of 60/);
  assert.match(result.needs ?? '', /Decisions answered 0 of 60/);
});

test('most Decisions calls rejected is partial too', () => {
  const records = fullRun().map((r, i) => (r.path === 'after' && i < 90 ? { ...r, calls: [call('/v1/decisions', null, 500), call('/v1/responses', { input: 200, output: 20 })] } : r));
  const result = buildOf(records);
  assert.equal(result.status, 'partial');
  assert.equal(result.title_number, undefined);
});

test('Decisions answering every call with a shape the code can\'t read is partial: 200s the agent had to answer', () => {
  const records = everyDecisionRejected().map((r) => (r.path === 'after' ? { ...r, calls: [call('/v1/decisions', { input: 90 }), call('/v1/responses', { input: 200, output: 20 })] } : r));
  const result = buildOf(records);
  assert.equal(result.status, 'partial');
  assert.equal(result.title_number, undefined);
  assert.match(result.needs ?? '', /Decisions answered 0 of 60/);
});

test('Decisions never being called is partial, which is what a key that did not reach the sandbox looks like', () => {
  const records = everyDecisionRejected().map((r) => (r.path === 'after' ? { ...r, calls: [call('/v1/responses', { input: 200, output: 20 })] } : r));
  assert.equal(buildOf(records).status, 'partial');
});

test('the Jev path is held to the same check', () => {
  const records = everyDecisionRejected().map((r) => (r.path === 'after' ? { ...r, calls: [call('/v1/systemone', null, 401), call('/v1/messages', { input: 200, output: 20 })] } : r));
  const result = buildOf(records, 'jev');
  assert.equal(result.status, 'partial');
  assert.match(result.needs ?? '', /Jev answered 0 of 60/);
  assert.match(result.body, /Jev calls rejected[^\n]*60 of 60/);
});

test('occasional rejected calls stay measured, and the table counts them in their own row', () => {
  const records = fullRun().map((r, i) => (i === 1 || i === 3 ? { ...r, calls: [call('/v1/decisions', null, 503), call('/v1/responses', { input: 200, output: 20 })] } : r));
  const result = buildOf(records);
  assert.equal(result.status, 'measured');
  assert.match(result.body, /\| Decisions calls rejected, status 400 or above \| not used \| 2 of 60 \|/);
});

test('a clean run still shows the rejected row, at zero', () => {
  assert.match(buildOf(fullRun()).body, /\| Decisions calls rejected, status 400 or above \| not used \| 0 of 60 \|/);
});

test('answered calls with no usage are partial with no title number, not priced at zero', () => {
  const records = fullRun().map((r) => (r.path === 'after' ? { ...r, calls: [call('/v1/decisions', null)] } : r));
  const result = buildOf(records);
  assert.equal(result.status, 'partial');
  assert.equal(result.title_number, undefined);
  assert.doesNotMatch(result.body, /accuracy|p50|cost per|cheaper/);
  assert.match(result.needs ?? '', /60 answered calls had no usage/);
  assert.match(result.body, /answered calls with no usage[^\n]*\| 0 \| 60 \|/);
});

test('one answered call with no usage is enough, on either path and even behind a fallback', () => {
  const cases: { path: 'before' | 'after'; calls: RawRecord['calls'] }[] = [
    { path: 'before', calls: [call('/v1/responses', null)] },
    { path: 'after', calls: [call('/v1/decisions', null)] },
    { path: 'after', calls: [call('/v1/decisions', null), call('/v1/responses', { input: 200, output: 20 })] },
    { path: 'after', calls: [call('/v1/decisions', { input: 90 }), call('/v1/responses', null)] },
    { path: 'after', calls: [call('/v1/decisions', { input: 0 })] },
  ];
  for (const { path, calls } of cases) {
    const at = fullRun().findIndex((r) => r.path === path);
    const result = buildOf(fullRun().map((r, i) => (i === at ? { ...r, calls } : r)));
    assert.equal(result.status, 'partial', JSON.stringify(calls.map((c) => c.usage)));
    assert.match(result.needs ?? '', /1 answered calls? had no usage/);
  }
});

test('a rejected call with no usage is not billed, so it stays a working fallback', () => {
  const records = fullRun().map((r, i) => (i === 1 ? { ...r, calls: [call('/v1/decisions', null, 429), call('/v1/responses', { input: 200, output: 20 })] } : r));
  assert.equal(buildOf(records).status, 'measured');
});

test('a model lookup has no usage and is not a billed call, which every real Claude agent run makes', () => {
  const lookup = { ...call('/v1/models/claude-sonnet-4-6', null), method: 'GET' };
  const records = fullRun().map((r) => (r.path === 'before' ? { ...r, calls: [lookup, ...r.calls] } : r));
  assert.equal(buildOf(records).status, 'measured');
});

test('parseRaw refuses output with missing records rather than computing from them', () => {
  const lines = [JSON.stringify(rawOf([]).meta), JSON.stringify(record('a', 'before', 1, 'coding', []))].join('\n');
  assert.equal(parseRaw(lines).records.length, 1);
  assert.throws(() => parseRaw(JSON.stringify(record('a', 'before', 1, 'coding', []))), /meta/);
});

test('scrubSecrets removes exact values, key shapes and bearer tokens', () => {
  const text = 'key=abc123secret sk-proj-AAAAAAAAAAAA Authorization: Bearer tok_123456 sk-ant-BBBBBBBBBBBB';
  const clean = scrubSecrets(text, ['abc123secret']);
  for (const leaked of ['abc123secret', 'sk-proj-AAAAAAAAAAAA', 'tok_123456', 'sk-ant-BBBBBBBBBBBB']) assert.ok(!clean.includes(leaked), leaked);
  assert.equal(scrubSecrets('plain words', ['']), 'plain words');
});

// --- The pipeline, with the sandbox faked ---

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'keepup-router-'));
  mkdirSync(join(root, 'lab', '01-router', 'patches'), { recursive: true });
  mkdirSync(join(root, 'lab', '01-router', 'patches-jev'), { recursive: true });
  writeFileSync(join(root, 'lab', '01-router', 'testset.jsonl'), readLab('testset.jsonl'));
  writeFileSync(join(root, 'lab', '01-router', 'testset-long-rules.jsonl'), readLab('testset-long-rules.jsonl'));
  for (const name of ['pr.json', 'pr-jev.json']) writeFileSync(join(root, 'lab', '01-router', name), JSON.stringify({ baseCommit: 'abc', stages: [{ patches: [] }] }));
  return root;
}

const treeOf = (root: string) => readdirSync(join(root, 'lab', '01-router')).sort();

function fakeDeps(root: string, env: Record<string, string | undefined>, leak = ''): Deps & { requests: SandboxRequest[]; logs: string[] } {
  const requests: SandboxRequest[] = [];
  const logs: string[] = [];
  const sandbox = (request: SandboxRequest) => {
    requests.push(request);
    const out = join(root, 'lab', '.work', request.outRelative);
    mkdirSync(dirname(out), { recursive: true });
    const raw = rawOf(fullRun());
    const leaked = record('m01', 'before', 600, 'coding', [{ ...call('/v1/responses', { input: 200, output: 20 }), response: `echo ${leak} sk-abcdefghijklmnop` }]);
    const records = [leaked, ...raw.records.slice(1)];
    writeFileSync(out, [raw.meta, ...records].map((line) => JSON.stringify(line)).join('\n'));
    return { status: 0, output: `sandbox says ${leak}` };
  };
  return {
    root,
    env,
    sandbox,
    prepareLabTree: () => {},
    removeLabTree: () => {},
    prepareDryTree: () => {},
    agentCandidates: () => ({ candidates: ['gpt-x'], onboarding: 'gpt-x', deprecation: null }),
    ratesFor: () => RATES,
    today: () => '2026-11-02',
    log: (line: string) => logs.push(line),
    requests,
    logs,
  };
}

test('with a key missing it writes not_run with one sentence and no numbers, and exits 3', async () => {
  const root = fixtureRoot();
  const deps = fakeDeps(root, {});
  assert.equal(await main(['--no-keys'], deps), EXIT_NEEDS_KEY);
  const result = readResult(join(root, 'lab', '01-router', 'result.md'));
  assert.equal(result?.status, 'not_run');
  assert.equal(result?.needs, 'OPENAI_API_KEY');
  assert.doesNotMatch(result?.body ?? '', /\d|\$/);
  assert.equal(deps.requests.length, 0, 'the sandbox never started');
});

test('a run with no key leaves an earlier measured result alone', async () => {
  const root = fixtureRoot();
  const path = join(root, 'lab', '01-router', 'result.md');
  await main([], fakeDeps(root, { OPENAI_API_KEY: 'sk-real-looking-key-value' }));
  const before = readFileSync(path, 'utf8');
  assert.equal(parseResult(before).status, 'measured');
  assert.equal(await main(['--no-keys'], fakeDeps(root, {})), EXIT_NEEDS_KEY);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('--no-keys never reads a key, even when one is in the environment', async () => {
  const root = fixtureRoot();
  writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=from-the-file\n');
  assert.equal(await main(['--no-keys'], fakeDeps(root, { OPENAI_API_KEY: 'from-the-env' })), EXIT_NEEDS_KEY);
});

test('the dry run writes only under lab/.work/01-router/dry-run and never touches result.md or out/', async () => {
  const root = fixtureRoot();
  const before = treeOf(root);
  const deps = fakeDeps(root, { OPENAI_API_KEY: 'should-not-be-used' });
  assert.equal(await main(['--dry-run'], deps), 0);
  assert.deepEqual(treeOf(root), before);
  assert.equal(existsSync(join(root, 'lab', '01-router', 'result.md')), false);
  assert.equal(existsSync(join(root, 'lab', '01-router', 'out')), false);
  assert.deepEqual(readdirSync(join(root, 'lab', '.work')), ['01-router']);
  assert.deepEqual(readdirSync(join(root, 'lab', '.work', '01-router')), ['dry-run']);
  const preview = readFileSync(join(root, 'lab', '.work', '01-router', 'dry-run', 'decisions', 'result.preview.md'), 'utf8');
  assert.match(preview, /Dry run against a fake provider/);
  assert.equal(deps.requests[0].real, false);
  assert.equal(deps.requests[0].env.SANDBOX_ENV, '');
  assert.equal(deps.requests[0].env.OPENAI_API_KEY, undefined);
});

test('the dry run leaves a measured result exactly as it was', async () => {
  const root = fixtureRoot();
  await main([], fakeDeps(root, { OPENAI_API_KEY: 'sk-real-looking-key-value' }));
  const path = join(root, 'lab', '01-router', 'result.md');
  const before = readFileSync(path, 'utf8');
  const outBefore = readFileSync(join(root, 'lab', '01-router', 'out', 'decisions', 'raw.jsonl'), 'utf8');
  await main(['--dry-run'], fakeDeps(root, {}));
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readFileSync(join(root, 'lab', '01-router', 'out', 'decisions', 'raw.jsonl'), 'utf8'), outBefore);
});

test('a keyed run passes keys by name, scrubs what it saves and writes the measured result', async () => {
  const root = fixtureRoot();
  const key = 'sk-very-secret-key-value-123';
  const deps = fakeDeps(root, { OPENAI_API_KEY: key }, key);
  assert.equal(await main([], deps), 0);
  const request = deps.requests[0];
  assert.equal(request.real, true);
  assert.equal(request.env.SANDBOX_ENV, 'OPENAI_API_KEY');
  const out = join(root, 'lab', '01-router', 'out', 'decisions');
  for (const name of readdirSync(out)) {
    const text = readFileSync(join(out, name), 'utf8');
    assert.ok(!text.includes(key), `${name} leaks the key`);
    assert.ok(!text.includes('sk-abcdefghijklmnop'), `${name} leaks a key-shaped value`);
  }
  assert.ok(!readFileSync(join(root, 'lab', '01-router', 'result.md'), 'utf8').includes(key));
  assert.equal(readResult(join(root, 'lab', '01-router', 'result.md'))?.status, 'measured');
});

test('--variant jev needs its own keys and writes result-jev.md, leaving result.md alone', async () => {
  const root = fixtureRoot();
  assert.equal(await main(['--variant', 'jev', '--no-keys'], fakeDeps(root, {})), EXIT_NEEDS_KEY);
  const result = readResult(join(root, 'lab', '01-router', 'result-jev.md'));
  assert.equal(result?.status, 'not_run');
  assert.equal(result?.needs, 'ANTHROPIC_API_KEY and TYPESAFE_API_KEY');
  assert.doesNotMatch(result?.body ?? '', /OpenAI/);
  assert.equal(existsSync(join(root, 'lab', '01-router', 'result.md')), false);

  const deps = fakeDeps(root, { ANTHROPIC_API_KEY: 'sk-ant-aaaaaaaaaaaa', TYPESAFE_API_KEY: 'ts-bbbbbbbbbbbb' });
  assert.equal(await main(['--variant', 'jev'], deps), 0);
  assert.equal(deps.requests[0].env.SANDBOX_ENV, 'ANTHROPIC_API_KEY TYPESAFE_API_KEY');
  assert.equal(readResult(join(root, 'lab', '01-router', 'result-jev.md'))?.status, 'measured');
  assert.equal(existsSync(join(root, 'lab', '01-router', 'result.md')), false);
});

test('the harness gets the long rules on the Decisions variant only, and the onboarding model for prices', async () => {
  const root = fixtureRoot();
  const asked: unknown[][] = [];
  const deps = { ...fakeDeps(root, {}), ratesFor: (...args: unknown[]) => (asked.push(args), RATES) };
  await main(['--dry-run'], deps);
  const configOf = (variant: string) => JSON.parse(readFileSync(join(root, 'lab', '.work', '01-router', 'dry-run', variant, 'config.json'), 'utf8'));
  assert.deepEqual(configOf('decisions').longRules, longRules);
  assert.deepEqual(asked[0], ['decisions', 'gpt-x', 'gpt-x']);
  await main(['--dry-run', '--variant', 'jev'], deps);
  assert.deepEqual(configOf('jev').longRules, []);
});

test('a sandbox failure writes no result', async () => {
  const root = fixtureRoot();
  const deps = { ...fakeDeps(root, { OPENAI_API_KEY: 'sk-real-looking-key-value' }), sandbox: () => ({ status: 1, output: 'it broke' }) };
  assert.equal(await main([], deps), 1);
  assert.equal(existsSync(join(root, 'lab', '01-router', 'result.md')), false);
});

/** The sandbox for a run that ends partial: every call was rate-limited. */
const partialSandbox = (root: string, output: string) => (request: SandboxRequest) => {
  const out = join(root, 'lab', '.work', request.outRelative);
  mkdirSync(dirname(out), { recursive: true });
  const records = fullRun().map((r) => ({ ...r, calls: [call(r.path === 'after' ? '/v1/decisions' : '/v1/responses', null, 429)] }));
  writeFileSync(out, [rawOf([]).meta, ...records].map((line) => JSON.stringify(line)).join('\n'));
  return { status: 0, output };
};

const VARIANT_RUNS = [
  { variant: 'decisions', flags: [], resultFile: 'result.md', env: { OPENAI_API_KEY: 'sk-real-looking-key-value' } },
  { variant: 'jev', flags: ['--variant', 'jev'], resultFile: 'result-jev.md', env: { ANTHROPIC_API_KEY: 'sk-ant-aaaaaaaaaaaa', TYPESAFE_API_KEY: 'ts-bbbbbbbbbbbb' } },
];

for (const { variant, flags, resultFile, env } of VARIANT_RUNS) {
  test(`a ${variant} rerun that ends partial keeps the measured result and the raw files behind it`, async () => {
    const root = fixtureRoot();
    const lab = join(root, 'lab', '01-router');
    const resultPath = join(lab, resultFile);
    const saved = () => readdirSync(join(lab, 'out', variant)).map((name) => [name, readFileSync(join(lab, 'out', variant, name), 'utf8')]);
    assert.equal(await main(flags, fakeDeps(root, env)), 0);
    const result = readFileSync(resultPath, 'utf8');
    const before = saved();

    const deps = { ...fakeDeps(root, env), sandbox: partialSandbox(root, 'the partial run') };
    assert.equal(await main(flags, deps), 1, 'a run that measured nothing new still exits 1');

    assert.equal(readFileSync(resultPath, 'utf8'), result);
    assert.deepEqual(saved(), before);
    assert.equal(manifestProblem(resultPath, parseResult(result)), null, 'the result still counts as measured');
    const log = deps.logs.join('\n');
    assert.match(log, /stay/);
    assert.match(log, new RegExp(`lab/\\.work/01-router/run/${variant}`), 'it says where this run\'s output went');
    assert.match(readFileSync(join(root, 'lab', '.work', '01-router', 'run', variant, 'sandbox.log'), 'utf8'), /the partial run/);
  });
}

test('a run that ends partial with nothing measured before it saves its raw output and says partial', async () => {
  const root = fixtureRoot();
  const lab = join(root, 'lab', '01-router');
  const deps = { ...fakeDeps(root, { OPENAI_API_KEY: 'sk-real-looking-key-value' }), sandbox: partialSandbox(root, 'the partial run') };
  assert.equal(await main([], deps), 1);
  assert.equal(readResult(join(lab, 'result.md'))?.status, 'partial');
  assert.ok(existsSync(join(lab, 'out', 'decisions', 'raw.jsonl')));
  assert.match(readFileSync(join(lab, 'out', 'decisions', 'sandbox.log'), 'utf8'), /the partial run/);
});

test('a second measured run replaces the first, and its result still counts as measured', async () => {
  const root = fixtureRoot();
  const resultPath = join(root, 'lab', '01-router', 'result.md');
  const env = { OPENAI_API_KEY: 'sk-real-looking-key-value' };
  assert.equal(await main([], fakeDeps(root, env)), 0);
  const logBefore = readFileSync(join(root, 'lab', '01-router', 'out', 'decisions', 'sandbox.log'), 'utf8');
  const deps = fakeDeps(root, env, 'second-run');
  assert.equal(await main([], deps), 0);
  assert.notEqual(readFileSync(join(root, 'lab', '01-router', 'out', 'decisions', 'sandbox.log'), 'utf8'), logBefore);
  assert.equal(manifestProblem(resultPath, parseResult(readFileSync(resultPath, 'utf8'))), null);
});

test('output the harness never finished leaves the measured raw files alone', async () => {
  const root = fixtureRoot();
  const raw = join(root, 'lab', '01-router', 'out', 'decisions', 'raw.jsonl');
  const env = { OPENAI_API_KEY: 'sk-real-looking-key-value' };
  assert.equal(await main([], fakeDeps(root, env)), 0);
  const before = readFileSync(raw, 'utf8');
  const noMeta = (request: SandboxRequest) => {
    writeFileSync(join(root, 'lab', '.work', request.outRelative), '');
    return { status: 0, output: 'nothing written' };
  };
  await assert.rejects(main([], { ...fakeDeps(root, env), sandbox: noMeta }), /meta/);
  assert.equal(readFileSync(raw, 'utf8'), before);
});

test('rerunning the variant never touches the run behind the main result, whichever ran first', async () => {
  const root = fixtureRoot();
  const resultPath = join(root, 'lab', '01-router', 'result.md');
  const jev = VARIANT_RUNS[1];
  await main(jev.flags, { ...fakeDeps(root, jev.env), sandbox: partialSandbox(root, 'the first variant run') });
  assert.equal(readResult(join(root, 'lab', '01-router', 'result-jev.md'))?.status, 'partial');
  assert.equal(await main([], fakeDeps(root, VARIANT_RUNS[0].env)), 0);
  await main(jev.flags, { ...fakeDeps(root, jev.env), sandbox: partialSandbox(root, 'the second variant run') });
  assert.equal(manifestProblem(resultPath, parseResult(readFileSync(resultPath, 'utf8'))), null);
  assert.ok(manifestProblem(join(root, 'lab', '01-router', 'result-jev.md'), { lab: '01-router-jev', status: 'measured', measured_at: '2026-11-02', body: 'typed' }), 'a partial run is no proof of a measured one');
});

test('an unknown flag or variant is refused', async () => {
  const deps = fakeDeps(fixtureRoot(), {});
  await assert.rejects(main(['--bogus'], deps), /Unknown flag/);
  await assert.rejects(main(['--variant', 'other'], deps), /variant/);
});

// --- pr.json, pr-jev.json and the patches ---

const pr = JSON.parse(readLab('pr.json'));
const prJev = JSON.parse(readLab('pr-jev.json'));
const WHERE: Record<string, string> = {
  'server/utils/agents/aibitat/plugins/router-classifier.js:71': 'async function classifyWithLLM',
  'server/utils/agents/aibitat/plugins/router-classifier.js:24': 'select_category',
  'server/utils/router/index.js:469': 'classifyWithLLM(llmRules',
};
const REQUIRED = ['schema', 'id', 'spec', 'upstream', 'fork', 'baseCommit', 'baseBranch', 'branch', 'lab', 'source', 'sourceUrl', 'where', 'founderLine', 'effect', 'effort', 'whyItFits', 'risks', 'rollback', 'proof', 'sources', 'stages'];
const EFFECTS = ['cheaper', 'faster', 'better answers', 'keeps working', 'new capability'];

for (const [name, file] of [['pr.json', pr], ['pr-jev.json', prJev]] as const) {
  test(`${name} has every contract field, and only allowed values`, () => {
    for (const field of REQUIRED) assert.ok(field in file, `missing ${field}`);
    assert.ok('ciWorkflow' in file);
    assert.equal(file.ciWorkflow, null);
    assert.equal(file.schema, 1);
    assert.match(file.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(file.baseBranch, name === 'pr.json' ? 'replay/ead123f0' : 'replay/ead123f0-jev', 'its own base, or merging one conflicts with the other');
    assert.equal(file.fork, 'anything-llm');
    assert.equal(file.upstream, 'Mintplex-Labs/anything-llm');
    assert.equal(file.spec, 'docs/prs/01-anythingllm-router-decision-model.md');
    assert.equal(file.lab, 'lab/01-router');
    assert.ok(['Hours', 'A day', 'A project'].includes(file.effort));
    for (const effect of file.effect) assert.ok(EFFECTS.includes(effect), effect);
    assert.ok(file.proof.vendor.claim && file.proof.vendor.url);
    assert.ok(Array.isArray(file.sources) && file.sources.length > 0);
    for (const text of [file.founderLine, file.whyItFits, file.risks, file.rollback]) assert.ok(text.length > 0);
    assert.doesNotMatch(file.founderLine, /\d/, 'the founder line has no measured number');
  });

  test(`${name} has patches that exist, stages in date order and titles with the one placeholder`, () => {
    const dates = file.stages.map((s: { date: string }) => s.date);
    assert.deepEqual(dates, [...dates].sort());
    for (const stage of file.stages) {
      assert.match(stage.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(stage.patches.length > 0);
      for (const patch of stage.patches) assert.ok(existsSync(join(LAB, patch)), patch);
      assert.match(stage.title, /\{\{lab\.title_number\}\}/);
      assert.doesNotMatch(stage.titleUnmeasured ?? '', /\{\{|\d/);
      assert.ok(stage.whatShipped && stage.whatThisChanges);
      assert.doesNotMatch(stage.title.replace('{{lab.title_number}}', ''), /\{\{/);
    }
  });

  test(`${name} "where" lines point at what they claim at the base commit`, { skip: !hasClone }, () => {
    for (const { path, line } of file.where) {
      const text = execFileSync('git', ['-C', CLONE, 'show', `${file.baseCommit}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const expected = WHERE[`${path}:${line}`];
      assert.ok(expected, `no expectation for ${path}:${line}`);
      assert.ok(text.split('\n')[line - 1].includes(expected), `${path}:${line} doesn't contain ${expected}`);
    }
  });

  test(`${name} patches apply in order with git apply at the base commit`, { skip: !hasClone }, () => {
    const dest = mkdtempSync(join(tmpdir(), 'keepup-router-patches-'));
    try {
      const tar = join(dest, '.base.tar');
      execFileSync('git', ['-C', CLONE, 'archive', `--output=${tar}`, file.baseCommit, '--', 'server', 'docker']);
      execFileSync('tar', ['-xf', tar, '-C', dest]);
      rmSync(tar);
      const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dest) };
      for (const stage of file.stages) {
        for (const patch of stage.patches) execFileSync('git', ['apply', '--whitespace=nowarn', join(LAB, patch)], { cwd: dest, env, stdio: ['ignore', 'pipe', 'pipe'] });
      }
      assert.ok(existsSync(join(dest, 'server/__tests__/utils/agents/aibitat/plugins/router-classifier.test.js')));
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
}

test('pr.json has the spec\'s branch, two stages, the rollback and the GA line', () => {
  assert.equal(pr.id, '01');
  assert.equal(pr.branch, 'keepup/2026-10-06-router-decision-model');
  assert.equal(pr.baseCommit, 'ead123f07befc7167d05f160dade56aed5fa7c10');
  assert.deepEqual(pr.stages.map((s: { date: string }) => s.date), ['2026-10-06', '2026-10-22']);
  assert.equal(pr.stages[0].comment, null);
  assert.equal(pr.stages[1].comment, 'Updated 22 Oct: Decisions API is generally available.');
  assert.match(pr.rollback, /ROUTER_CLASSIFIER=agent/);
  assert.deepEqual(pr.effect, ['cheaper', 'faster']);
  assert.equal(pr.effort, 'A day');
  assert.equal(pr.proof.vendor.claim, 'typed answers 10x faster than the Responses API');
});

test('pr.json states that the test set\'s list is too short to cache and why input_json is not used', () => {
  const update = pr.stages[1].whatThisChanges;
  assert.match(update, /1,024/);
  assert.match(update, /input_json/);
  assert.match(update, /no cache discount/);
});

test('pr.json says the lab table does not cover the cached form of the request', () => {
  const update = pr.stages[1].whatThisChanges;
  assert.match(update, /descriptions leave the choices/);
  assert.match(update, /0\.70/);
  assert.match(update, /table only measures the short form/);
  assert.match(update, /labelled examples/);
  assert.match(update, /no tokenizer runs over the list/);
  assert.doesNotMatch(update, /no tokenizer runs while routing/, 'the router already counts tokens while it gathers its context');
});

test('pr.json says what a cache write costs, and when a long list pays it on each message', () => {
  const update = pr.stages[1].whatThisChanges;
  for (const text of [update, pr.risks]) {
    assert.match(text, /1\.25 times/);
    assert.match(text, /every 30 minutes/);
  }
  assert.ok(pr.sources.includes('https://developers.openai.com/api/docs/guides/prompt-caching'), 'the source of both numbers');
});

test('the update\'s text says a short list turns caching off, not that it sends the same request', () => {
  const update = pr.stages[1].whatThisChanges;
  assert.doesNotMatch(update, /sends the same request as before/);
  assert.match(update, /turned off/);
  const patch = readLab('patches/0002-feat-cache-long-router-category-lists-now-Decisions-.patch');
  assert.doesNotMatch(patch, /sends exactly the request it sent before/);
  assert.doesNotMatch(patch, /couldn't be cached anyway/);
  assert.match(patch, /implicit/);
  assert.match(patch, /1\.25/);
});

test('the update\'s short form turns caching off in the code', () => {
  const patch = readLab('patches/0002-feat-cache-long-router-category-lists-now-Decisions-.patch');
  const code = patch.split('diff --git').filter((part) => !part.includes('__tests__')).join('');
  const added = code.split('\n').filter((line) => line.startsWith('+')).join('\n');
  assert.equal(added.match(/prompt_cache_options: \{ mode: "explicit" \}/g)?.length, 2, 'both forms of the request');
});

test('the Jev text says what its sources support, with no claim about being tied to a provider', () => {
  const texts = [readLab('pr-jev.json'), ...readdirSync(join(LAB, 'patches-jev')).map((name) => readFileSync(join(LAB, 'patches-jev', name), 'utf8'))];
  for (const text of texts) assert.doesNotMatch(text, /tie you|tie the router|one model provider|lock-?in/i);
  assert.match(prJev.founderLine, /TypeSafe key/);
});

test('pr-jev.json is a separate dated variant that points at its own result and never suggests OpenAI', () => {
  assert.equal(prJev.id, '01-jev');
  assert.equal(prJev.branch, 'keepup/2026-10-22-router-jev');
  assert.equal(prJev.resultFile, 'result-jev.md');
  assert.deepEqual(prJev.stages.map((s: { date: string }) => s.date), ['2026-10-22']);
  assert.match(prJev.rollback, /ROUTER_CLASSIFIER=agent/);
  assert.doesNotMatch(readLab('pr-jev.json'), /openai|gpt-|decisions api/i);
});

test('the Jev patch has no OpenAI code path in it', () => {
  for (const name of readdirSync(join(LAB, 'patches-jev'))) {
    const added = readFileSync(join(LAB, 'patches-jev', name), 'utf8').split('\n').filter((line) => line.startsWith('+')).join('\n');
    assert.doesNotMatch(added, /openai|gpt-6|decisions api/i);
    assert.match(added, /api\.typesafe\.ai\/v1\/systemone/);
  }
});

test('pr-jev.json keeps PR 01\'s base as a recorded exception, and says why in its own text', () => {
  assert.equal(prJev.baseCommit, pr.baseCommit);
  assert.match(prJev.stages[0].whatThisChanges, /same change re-planned for a Claude-only product, on PR 01's base/);
  assert.match(readFileSync(join(REPO_ROOT, pr.spec), 'utf8'), /recorded exception/);
});

const allPatches = () => [
  ...readdirSync(join(LAB, 'patches')).map((name) => readFileSync(join(LAB, 'patches', name), 'utf8')),
  ...readdirSync(join(LAB, 'patches-jev')).map((name) => readFileSync(join(LAB, 'patches-jev', name), 'utf8')),
];
const addedLines = (patch: string) => patch.split('\n').filter((line) => line.startsWith('+')).join('\n');

test('no patch uses the retired gpt-4.1-nano, even in a test fixture', () => {
  for (const patch of allPatches()) assert.doesNotMatch(patch, /gpt-4\.1-nano/);
  assert.match(readLab('patches/0001-feat-route-messages-with-the-Decisions-API-behind-a-.patch'), /fallback_model: "gpt-5\.6-luna"/);
});

test('classifyMessage logs the fall back before the agent runs, and only says the agent answered after it did', () => {
  for (const patch of allPatches().filter((text) => text.includes('async function classifyMessage'))) {
    const code = addedLines(patch.split('diff --git').filter((part) => !part.startsWith(' a/server/__tests__')).join(''));
    assert.doesNotMatch(code, /agent answered: /);
    const fallingBack = code.indexOf('falling back to the agent');
    const agentRuns = code.indexOf('await classifyWithLLM(rules, prompt, router);', fallingBack);
    const answered = code.indexOf('agent answered "');
    assert.ok(fallingBack > 0 && agentRuns > fallingBack && answered > agentRuns, 'the order is: why, the agent, what it returned');
    assert.match(code, /agent returned no rule/);
    assert.match(addedLines(patch), /doesn't say the agent answered when it failed/);
  }
});

test('the byte estimate is justified by what can be checked, and is not attributed to anyone', () => {
  const patch = readLab('patches/0002-feat-cache-long-router-category-lists-now-Decisions-.patch');
  assert.doesNotMatch(patch, /OpenAI's rule of thumb/);
  assert.doesNotMatch(patch, /rebuild the encoder/);
  assert.match(patch, /cl100k_base/);
  assert.match(patch, /doesn't know\s+gpt-6-luna/);
});

test('the test at the exact caching size asserts the list really moved', () => {
  const patch = readLab('patches/0002-feat-cache-long-router-category-lists-now-Decisions-.patch');
  const body = addedLines(patch).split('it("moves a list at that size into a cacheable shared prefix"')[1].split('it("puts the rules in the prefix')[0];
  assert.match(body, /expect\(input\[0\]\.role\)\.toBe\("developer"\)/);
  assert.match(body, /prompt_cache_breakpoint/);
});

test('the patches carry their replay dates', () => {
  const patchDate = (dir: string, name: string) => readFileSync(join(LAB, dir, name), 'utf8').match(/^Date: (.*)$/m)?.[1] ?? '';
  const main = readdirSync(join(LAB, 'patches')).sort();
  assert.equal(main.length, 2);
  assert.match(patchDate('patches', main[0]), /6 Oct 2026/);
  assert.match(patchDate('patches', main[1]), /22 Oct 2026/);
  const jev = readdirSync(join(LAB, 'patches-jev')).sort();
  assert.equal(jev.length, 1);
  assert.match(patchDate('patches-jev', jev[0]), /22 Oct 2026/);
});

test('the Decisions stages follow the changelog: beta has no caching, and the update adds it', () => {
  const patches = readdirSync(join(LAB, 'patches')).sort().map((name) => readFileSync(join(LAB, 'patches', name), 'utf8'));
  const added = (patch: string) => patch.split('\n').filter((line) => line.startsWith('+') && !line.includes('__tests__')).join('\n');
  const code = (patch: string) => added(patch.split('diff --git').filter((part) => !part.includes('__tests__')).join('diff --git'));
  assert.doesNotMatch(code(patches[0]), /prompt_cache|input_json/);
  assert.match(code(patches[1]), /prompt_cache_breakpoint/);
});

test('the checked-in results are honest about what ran', () => {
  for (const [variant, config] of Object.entries(VARIANTS)) {
    const result = readResult(join(LAB, config.resultFile));
    assert.ok(result, `${variant} has no result file yet`);
    if (result.status === 'not_run') assert.ok(result.needs);
    else assert.ok(existsSync(join(LAB, 'out', variant, 'raw.jsonl')), 'a result that ran has raw outputs');
  }
});

// --- Evidence of the repo's own tests ---

const JEST_REPORT = {
  numTotalTests: 4,
  numPassedTests: 3,
  numFailedTests: 1,
  testResults: [
    { name: '/repo/server/__tests__/utils/agents/aibitat/plugins/router-classifier.test.js', assertionResults: [{ fullName: 'router classifier works', status: 'passed' }, { fullName: 'router classifier logs', status: 'passed' }] },
    { name: '/repo/collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', assertionResults: [{ fullName: 'FFMPEGWrapper finds ffmpeg', status: 'failed' }, { fullName: 'FFMPEGWrapper other', status: 'passed' }] },
  ],
};
const CLASSIFIER_TEST = 'server/__tests__/utils/agents/aibitat/plugins/router-classifier.test.js';

test('the repo-tests summary is read from jest and the exit codes, and names what failed', () => {
  const evidence = summarize(JEST_REPORT, { jest: 1, 'server lint': 0, 'ffmpeg in image': 1 }, 'abc', '2026-11-01', [CLASSIFIER_TEST]);
  assert.match(evidence.summary, /^3 of 4 repo tests pass in the sandbox on Node 18\./);
  assert.match(evidence.summary, /The 1 that fails is in collector\/__tests__\/utils\/WhisperProviders\/ffmpeg\/index\.test\.js, and the image has no ffmpeg binary\./);
  assert.match(evidence.summary, /Every linter and check that ran passed: server lint\./);
  assert.deepEqual(evidence.tests, { total: 4, passed: 3, failed: 1 });
  assert.deepEqual(evidence.failed_tests, [{ file: 'collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', test: 'FFMPEGWrapper finds ffmpeg' }]);
  assert.deepEqual(evidence.tests_this_change_adds, [{ file: CLASSIFIER_TEST, total: 2, passed: 2 }]);
  assert.equal(evidence.commit, 'abc');
});

test('the repo-tests summary names a linter that failed, and blames no missing binary it did not check', () => {
  const evidence = summarize(JEST_REPORT, { jest: 1, 'server lint': 1 }, 'abc', '2026-11-01', []);
  assert.match(evidence.summary, /server lint failed\./);
  assert.doesNotMatch(evidence.summary, /no ffmpeg binary/);
});

test('parseChecks reads the exit codes, and refuses a line it cannot read', () => {
  assert.deepEqual(parseChecks('jest=1\nserver lint=0\n'), { jest: 1, 'server lint': 0 });
  assert.throws(() => parseChecks('server lint=\n'), /server lint/);
});

test('the test files a patch adds or changes are read from its diff', () => {
  assert.deepEqual(testFilesIn(readLab('patches/0002-feat-cache-long-router-category-lists-now-Decisions-.patch')), [CLASSIFIER_TEST]);
});

/** The branch's tip in the local clone, or null where it was never built: a fresh clone has no keepup branches. */
function branchTip(branch: string): string | null {
  try {
    return execFileSync('git', ['-C', CLONE, 'rev-parse', '--verify', '--quiet', branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

for (const [name, file, spec] of [['repo-tests.json', 'out/repo-tests.json', pr], ['repo-tests-jev.json', 'out/repo-tests-jev.json', prJev]] as const) {
  const skip = !existsSync(join(LAB, file)) ? 'no evidence saved' : branchTip(spec.branch) ? false : 'the branch is not in the local clone';
  test(`saved ${name} is for the tip of its branch, which is what the patches build`, { skip }, () => {
    const evidence = JSON.parse(readLab(file));
    assert.equal(evidence.commit, branchTip(spec.branch));
    assert.equal(evidence.tests.total, evidence.tests.passed + evidence.tests.failed);
    assert.ok(evidence.tests_this_change_adds.some((added: { file: string }) => added.file === CLASSIFIER_TEST));
    const patchIds = (range: string) => execFileSync('bash', ['-c', `git -C ${CLONE} format-patch --stdout --no-signature ${range} | git patch-id --stable | cut -d' ' -f1`], { encoding: 'utf8' }).trim().split('\n');
    const files = spec.stages.flatMap((stage: { patches: string[] }) => stage.patches);
    const fromFiles = files.map((patch: string) => execFileSync('bash', ['-c', `git patch-id --stable < '${join(LAB, patch)}' | cut -d' ' -f1`], { encoding: 'utf8' }).trim());
    assert.deepEqual(patchIds(`${spec.baseCommit}..${spec.branch}`), fromFiles);
  });
}

test('repo-test evidence alone never makes a typed result count as measured', () => {
  const root = fixtureRoot();
  const lab = join(root, 'lab', '01-router');
  mkdirSync(join(lab, 'out'), { recursive: true });
  writeFileSync(join(lab, 'out', 'repo-tests.json'), '{"summary":"x"}');
  assert.ok(manifestProblem(join(lab, 'result.md'), { lab: '01-router', status: 'measured', measured_at: '2026-11-02', title_number: '6.2x faster', body: 'typed' }));
});
