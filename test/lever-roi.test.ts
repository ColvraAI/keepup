import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { namedPromptNear } from '../src/call-prompt.ts';
import { renderBrief, renderSummary } from '../src/brief.ts';
import { priceLookup, valueContext } from '../src/lever-prices.ts';
import { withValues, type ValueContext } from '../src/lever-value.ts';
import { leverAllowed, loadLevers } from '../src/levers.ts';
import { rankFindings } from '../src/rank.ts';
import { costAfter, costToday, effortWords, roiLine, roiSum } from '../src/roi.ts';
import type { Finding } from '../src/run-shape.ts';
import { loadPatterns, scanFiles } from '../src/scan.ts';
import { ROOT } from './helpers.ts';

const JEV = { id: 'J', name: 'TypeSafe Jev', pattern: 'PAT-label-picking-call', kind: 'k', effects: [], gain: 'g', proof: 'vendor claim', source: 'https://jev', how: 'h', price: '$0.042 per 1M input tokens; output tokens are free.', checked: '2026-11-01' };
const DECISIONS = { ...JEV, id: 'D', name: 'OpenAI Decisions API', source: 'https://dec', price: '$0.10 per 1M uncached input tokens on gpt-6-luna; output tokens are not charged.' };
const SONNET = { input: 2, output: 10, model: 'big-model', source: 'https://openrouter.ai/x/big-model', date: '2026-11-01' };
const CLASSIFIER = `const ROUTER_SYSTEM_PROMPT = \`You are a classifier for a router. Pick the first category that matches.\n\n{categories}\n\nAlways call the tool.\`;\nasync function classify(router) {\n  const role = ROUTER_SYSTEM_PROMPT.replace('{categories}', list);\n  return new Agent({ model: router.fallback_model, role });\n}\n`;
const finding: Finding = { title: 't', effect: ['cheaper', 'faster'], proof: 'vendor claim', effort: 'A day', where: [{ file: 'c.js', line: 4, text: 'x' }], why: 'w', options: [{ name: 'TypeSafe Jev', what: 'w', needs: 'n', source: 'https://jev' }, { name: 'OpenAI Decisions API', what: 'w', needs: 'n', source: 'https://dec' }], sources: ['https://jev'], lever: 'J', pr: null };
const context = (over: Partial<ValueContext> = {}): ValueContext => ({ levers: [JEV, DECISIONS], files: new Map([['c.js', CLASSIFIER]]), modelIds: [], priceOf: (model) => (model === 'big-model' ? SONNET : null), exampleModel: 'big-model', ...over });
const run = { repo: 'o/n', commit: 'abc', db: { fetched: '2026-11-01', records: 10, by_source: {}, window: { since: 'a', until: 'b' } }, profile: null, watching: [], held_back: [], checks: { passed: 1, dropped: [] }, ran: { search: true, judge: true, online: false } };

test('the sum is the plan formula: saving a month, then payback', () => {
  const sum = roiSum(0.002, 0.001, 10_000, 800);
  assert.ok(Math.abs(sum.monthly - 10) < 1e-9);
  assert.ok(Math.abs((sum.payback_months as number) - 80) < 1e-9);
  assert.equal(sum.worth_above_calls, Math.ceil(800 / (0.001 * 12)));
  assert.equal(costToday(1000, 20, { input: 2, output: 10 }), (1000 * 2 + 20 * 10) / 1e6);
  assert.equal(costAfter({ kind: 'substitute', input_per_m: 0.042 }, 1000, 20, { input: 2, output: 10 }), (1000 * 0.042) / 1e6);
});

test('the ROI line reads in plain words, and one that pays back says when', () => {
  assert.equal(roiLine(roiSum(0.1, 0, 10_000, 800), 10_000, 'A day', 'projected'), "Saves about $1,000 a month at 10,000 calls · a day's work · pays back in 1 month [projected]");
  assert.equal(roiLine(roiSum(0.1, 0, 1_000, 800), 1_000, 'A day', 'projected'), "Saves about $100 a month at 1,000 calls · a day's work · pays back in 8 months [projected]");
});

test('a saving that cannot pay back says so plainly', () => {
  assert.equal(roiLine(roiSum(0.0001, 0, 10_000, 800), 10_000, 'A day', 'projected'), "Saves about $1 a month at 10,000 calls · a day's work · not worth it below 666,667 calls a month [projected]");
  assert.match(roiLine(roiSum(0.001, 0.002, 10_000, 800), 10_000, 'Hours', 'projected'), /^No saving at these prices, at any volume · a few hours' work · not worth it \[projected\]$/);
});

test('effort words stay words', () => {
  assert.equal(effortWords('Hours'), "a few hours' work");
  assert.equal(effortWords('A day or more'), 'a day or more of work');
  assert.equal(effortWords('A project'), 'a project');
});

test('a prompt constant an agent framework sends is read, though no model call is in sight', () => {
  const found = namedPromptNear(CLASSIFIER, 4);
  assert.equal(found?.line, 1);
  assert.deepEqual(found?.placeholders, ['{categories}']);
  assert.equal(namedPromptNear('const NOTE = "a plain string that is long enough to be prose here";\nfunction a() { return NOTE; }\n', 2), null);
});

test('a model set at runtime still gets its sum, on a named model labelled example, and it never ranks', () => {
  const [item] = withValues([finding], context());
  const roi = item.value?.roi;
  assert.equal(item.value?.status, 'worked');
  assert.equal(roi?.money, true);
  assert.equal(roi?.basis, 'example');
  assert.equal(roi?.model?.id, 'big-model');
  assert.deepEqual(roi?.options.map((option) => option.name), ['TypeSafe Jev', 'OpenAI Decisions API']);
  assert.match(roi?.options[0].line ?? '', /\[projected, example\]$/);
  assert.match(roi?.what_to_enter ?? '', /model/);
  assert.equal(roi?.options[0].input_per_m, 0.042);
  assert.equal(roi?.options[1].input_per_m, 0.1);
  assert.equal(roi?.options[0].source, 'https://jev');
  assert.equal(roi?.options[0].checked, '2026-11-01');
  assert.ok(roi?.tokens.input_label.includes('c.js:1'));
  const ranked = rankFindings([{ ...finding, title: 'plain', value: { status: 'priced', value_usd: -5 } } as Finding, item], '2026-11-01').findings;
  assert.equal(ranked[0].title, 't');
});

test('a default the repo names is used before any example, and says where it was read', () => {
  const files = new Map([['c.js', `const DEFAULT_MODEL = "big-model";\n${CLASSIFIER}`]]);
  const [item] = withValues([{ ...finding, where: [{ file: 'c.js', line: 5, text: 'x' }] }], context({ files, modelIds: ['big-model'] }));
  assert.equal(item.value?.roi?.basis, 'default');
  assert.match(item.value?.roi?.model?.label ?? '', /c\.js:1/);
  assert.equal(item.value?.status, 'priced');
  assert.doesNotMatch(item.value?.roi?.options[0].line ?? '', /example/);
});

test('two providers each with their own default name no default', () => {
  const files = new Map([['c.js', CLASSIFIER], ['a.js', 'const defaultModel = "big-model";'], ['b.js', 'const defaultModel = "other-model";']]);
  const priceOf = (model: string) => (model === 'big-model' || model === 'other-model' ? { ...SONNET, model } : null);
  const [item] = withValues([finding], context({ files, modelIds: ['big-model', 'other-model'], priceOf }));
  assert.equal(item.value?.roi?.basis, 'example');
});

test('with no prompt to read, tokens are a stated assumption the person can change', () => {
  const [item] = withValues([{ ...finding, where: [{ file: 'none.js', line: 1, text: 'x' }] }], context());
  assert.match(item.value?.roi?.tokens.input_label ?? '', /^assumed/);
  assert.equal(item.value?.status, 'worked');
});

test('a lever with no money effect says its effect and effort, and that there is no money figure', () => {
  const [item] = withValues([{ ...finding, effect: ['better answers'], effort: 'A day or more', lever: null, options: [] }], context());
  assert.equal(item.value?.status, 'no_number');
  assert.equal(item.value?.roi?.money, false);
  assert.equal(item.value?.roi?.statement, 'Better answers · a day or more of work · no money figure: it changes what the product does, not what a call costs');
  const text = renderSummary({ ...run, findings: [{ ...item, rank: 1 }] });
  assert.match(text, /no money figure/);
  assert.doesNotMatch(text, /Saves about/);
});

test('both briefs print a line per option, the assumptions labelled, the price sourced and dated', () => {
  const [item] = withValues([finding], context());
  for (const text of [renderSummary({ ...run, findings: [{ ...item, rank: 1 }] }), renderBrief({ ...run, findings: [{ ...item, rank: 1 }] })].map((out) => out.replace(/\s+/g, ' '))) {
    assert.match(text, /TypeSafe Jev.*\$0\.042 per 1M input.*https:\/\/jev.*2026-11-01.*Saves about/);
    assert.match(text, /OpenAI Decisions API.*\$0\.10 per 1M.*https:\/\/dec.*Saves about/);
    assert.match(text, /Assumed: 10,000 calls a month/);
    assert.match(text, /example/);
    assert.match(text, /payback = cost of change ÷ monthly saving/);
    assert.doesNotMatch(text, /No money number/);
  }
});

test('on a full screen the lead lever keeps its price, source and assumptions', () => {
  const [item] = withValues([finding], context());
  const plain = withValues([{ ...finding, title: 'other', effect: ['better answers'], lever: null, options: [] }], context())[0];
  const held = Array.from({ length: 30 }, (_, index) => ({ thing: `h${index}`, date: null, reason: 'r', source: null }));
  const text = renderSummary({ ...run, findings: [{ ...item, rank: 1 }, { ...plain, rank: 2 }, { ...plain, rank: 3, title: 'third' }, { ...plain, rank: 4, title: 'fourth' }, { ...plain, rank: 5, title: 'fifth' }], held_back: held });
  const flat = text.replace(/\s+/g, ' ');
  assert.ok(text.split('\n').length <= 41, 'one screen');
  assert.match(flat, /TypeSafe Jev \(\$0\.042 per 1M input/);
  assert.match(flat, /Assumed: 10,000 calls a month/);
  assert.match(flat, /enter the model this call really uses/);
});

test('a retired model carries no ROI line', () => {
  const [item] = withValues([{ ...finding, reach: 'sent' as const, effect: ['keeps working'] }], context());
  assert.equal(item.value, undefined);
});

test('the browser sums what the brief sums: one file, copied byte for byte', () => {
  assert.equal(readFileSync(join(ROOT, 'site/src/lib/roi.ts'), 'utf8'), readFileSync(join(ROOT, 'src/roi.ts'), 'utf8'));
});

for (const file of ['triage.ts', 'triage.py']) {
  test(`${file}: a chat call that only picks from fixed labels fires the pattern and offers Jev, with no Jev key`, () => {
    const path = `test/fixtures/label-picking/${file}`;
    const text = readFileSync(join(ROOT, path), 'utf8');
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const { hits } = scanFiles([{ path: file, text }], loadPatterns());
      const hit = hits.find((item) => item.pattern === 'PAT-label-picking-call');
      assert.ok(hit, 'the label-picking pattern fired');
      const levers = loadLevers().filter((lever) => lever.pattern === 'PAT-label-picking-call' && leverAllowed(lever, undefined));
      const jev = levers.find((lever) => lever.id === 'ADV-2026-0915-typesafe-jev');
      assert.ok(jev, 'Jev is offered');
      const base: Finding = { title: 'Triage can use a decision model', effect: ['cheaper'], proof: 'vendor claim', effort: 'A day', where: [{ file, line: hit.line, text: hit.text }], why: 'w', options: [{ name: jev.name, what: 'w', needs: 'A TypeSafe key.', source: jev.source }], sources: [jev.source], lever: jev.id, pr: null };
      const [item] = withValues([base], { ...valueContext({ model_ids: [{ id: 'gpt-6-sol' }] as never }, new Map([[file, text]])), priceOf: priceLookup() });
      assert.equal(item.value?.status, 'priced');
      assert.equal(item.value?.roi?.model?.id, 'gpt-6-sol');
      assert.equal(item.value?.roi?.basis, 'read');
      assert.match(item.value?.roi?.options[0].line ?? '', /\[projected\]$/);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });
}
