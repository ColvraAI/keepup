import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropic, parseGemini, parseGeminiUndated, parseOpenAI, parseDate, idRegex, buildPattern } from './retired-models.ts';

test('parseDate reads every date style the provider pages use', () => {
  assert.equal(parseDate('January 14, 2027'), '2027-01-14');
  assert.equal(parseDate('Apr 1, 2027'), '2027-04-01');
  assert.equal(parseDate('2026-09-24'), '2026-09-24');
  assert.equal(parseDate('2026‑03‑26'), '2026-03-26');
  assert.equal(parseDate('at earliest 2024-06-13'), null);
  assert.equal(parseDate('No shutdown date announced'), null);
  assert.equal(parseDate('N/A'), null);
});

test('parseOpenAI reads aliases, keeps the newest row, skips non-model rows', () => {
  const md = [
    '| Shutdown date | Model / system | Recommended replacement |',
    '| --- | --- | --- |',
    '| Dec 11, 2026  | `o3` \\| `o3-2025-04-16` | `gpt-5.6-sol` |',
    '| January 14, 2027 | GPT-4o (`gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`) | `gpt-6-luna` |',
    '| Feb 26, 2027 | `/v1/audio/translations` | `v1/realtime/translations` |',
    '| 2024-10-28 | New fine-tuning training on `babbage-002` | `gpt-4o-mini` |',
    '| 2026-09-24 | `sora-2` | --- |',
    '',
    '| Shutdown date | Deprecated model | Recommended replacement |',
    '| --- | --- | --- |',
    '| 2020-01-01 | `o3` | `old` |',
    '| Date | Update |',
    '| June 3, 2026 | Deprecation announced |',
  ].join('\n');
  const rows = parseOpenAI(md);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'o3', 'o3-2025-04-16', 'sora-2']);
  const o3 = rows.find((r) => r.id === 'o3');
  assert.equal(o3?.date, '2026-12-11');
  assert.deepEqual(o3?.successors, ['gpt-5.6-sol']);
  assert.deepEqual(rows.find((r) => r.id === 'sora-2')?.successors, []);
});

test('parseOpenAI drops bare words that are not usable as exact model ids', () => {
  const md = ['| Shutdown date | Deprecated model | Recommended replacement |', '| 2024-01-04 | `ada` | `babbage-002` |', '| 2024-01-04 | `davinci` | `davinci-002` |'].join('\n');
  assert.deepEqual(parseOpenAI(md), []);
});

test('parseAnthropic reads the deprecation history tables', () => {
  const md = [
    '| Retirement date   | Deprecated model             | Recommended replacement |',
    '| ----------------- | ---------------------------- | ----------------------- |',
    '| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5`     |',
  ].join('\n');
  assert.deepEqual(parseAnthropic(md), [
    { id: 'claude-sonnet-4-5-20250929', provider: 'anthropic', date: '2026-11-30', successors: ['claude-sonnet-5-5'], earliest: false },
  ]);
});

test('parseGemini marks dates as the earliest shutdown and skips models with none', () => {
  const md = [
    '| **Model** | **Release date** | **Shutdown date** | **Recommended replacement** |',
    '|---|---|---|---|',
    '| `gemini-2.0-flash` | February 5, 2025 | June 1, 2026 | `gemini-3.6-flash` |',
    '| Preview models ||||',
    '| `gemini-3.5-flash` | May 19, 2026 | N/A | `gemini-3.6-flash` (the endpoint is not shutting down) |',
    '| `gemini-2.5-flash` | June 17, 2025 | No shutdown date announced |   |',
    '| `veo-3.0-generate-001` | September 9, 2025 | June 30, 2026 | `gemini-omni-1.1-flash` or the GA models |',
  ].join('\n');
  const rows = parseGemini(md);
  assert.deepEqual(rows.map((r) => r.id), ['gemini-2.0-flash', 'veo-3.0-generate-001']);
  assert.equal(rows[0].earliest, true);
  assert.equal(rows[0].date, '2026-06-01');
});

test('idRegex matches the exact id, quoted or assigned, and never a longer id', () => {
  const r = new RegExp(idRegex(['claude-sonnet-4-20250514', 'gpt-4']));
  assert.ok(r.test('model = "claude-sonnet-4-20250514"'));
  assert.ok(r.test('MODEL=claude-sonnet-4-20250514'));
  assert.ok(r.test('model: gpt-4  # the default'));
  assert.ok(r.test('"model": "gpt-4",'));
  assert.ok(!r.test('"anthropic.claude-sonnet-4-20250514-v1:0"'), 'a Bedrock id has its own lifecycle');
  assert.ok(!r.test('"gpt-4o"'));
  assert.ok(!r.test('"gpt-4.1"'));
  assert.ok(!r.test('"gpt-4-turbo"'));
  assert.ok(!r.test('# model = "gpt-4"'), 'a commented-out line sends nothing');
  assert.ok(!r.test('// use "gpt-4" here'));
  assert.ok(!r.test('4,096 (gpt-4)'), 'prose in a label sends nothing');
  assert.ok(!r.test('  "gpt-4": 8192,'), 'a lookup table describes a model, it does not choose one');
  assert.ok(!r.test('  "gpt-4": { maxTokens: 8192 },'));
});

test('short ids never match ordinary code', () => {
  const r = new RegExp(idRegex(['o1', 'o3-mini']));
  assert.ok(r.test('model: "o1",'));
  assert.ok(r.test("model='o3-mini'"));
  assert.ok(r.test('MODEL=o1'));
  assert.ok(!r.test('const o1 = compute(x)'));
  assert.ok(!r.test('big o1 notation'));
});

test('buildPattern has one regex per provider and a dated note for each id', () => {
  const p = buildPattern([
    { id: 'gpt-4', provider: 'openai', date: '2026-10-23', successors: ['x'], earliest: false },
    { id: 'gpt-5', provider: 'openai', date: '2026-12-11', successors: ['y'], earliest: false },
    { id: 'far-off', provider: 'openai', date: '2028-05-14', successors: [], earliest: false },
    { id: 'gemini-a', provider: 'google', date: '2026-06-01', successors: ['z'], earliest: true },
  ], '2026-11-01') as { find: unknown[]; models: { id: string; note: string }[] };
  assert.equal(p.find.length, 2);
  assert.deepEqual(p.models.map((m) => m.id), ['gpt-4', 'gpt-5', 'gemini-a'], 'a date over a year out is not actionable yet');
  assert.match(p.models[0].note, /shut down on 2026-10-23/);
  assert.match(p.models[1].note, /shuts down on 2026-12-11/);
  assert.match(p.models[2].note, /no earlier than 2026-06-01/);
});

test('parseGeminiUndated reads the replacement column of a row with no shutdown date, and only those', () => {
  const md = [
    '| **Model** | **Release date** | **Shutdown date** | **Recommended replacement** |',
    '|---|---|---|---|',
    '| `gemini-nano-banana-2.1` | October 6, 2026 | No shutdown date announced |   |',
    '| `gemini-3.1-flash-image` | May 28, 2026 | No shutdown date announced | `gemini-nano-banana-2.1` |',
    '| `gemini-2.5-flash-image` | October 2, 2025 | March 15, 2027 | `gemini-3.1-flash-lite-image` |',
  ].join('\n');
  assert.deepEqual(parseGeminiUndated(md), [{ id: 'gemini-3.1-flash-image', provider: 'google', successors: ['gemini-nano-banana-2.1'] }]);
});

test('buildPattern keeps undated successors apart from the dated ids a scan looks for', () => {
  const dated = { id: 'old-1', provider: 'google', date: '2026-12-01', successors: [], earliest: true };
  const pattern = buildPattern([dated], '2026-11-01', [{ id: 'new-1', provider: 'google', successors: ['newer-1'] }]) as { models: { id: string }[]; undated_successors: { id: string; successors: string[]; note: string; source: string }[] };
  assert.deepEqual(pattern.models.map((m) => m.id), ['old-1']);
  assert.equal(pattern.undated_successors[0].id, 'new-1');
  assert.match(pattern.undated_successors[0].note, /no shutdown date.*newer-1/i);
  assert.equal(pattern.undated_successors[0].source, 'https://ai.google.dev/gemini-api/docs/deprecations');
});
