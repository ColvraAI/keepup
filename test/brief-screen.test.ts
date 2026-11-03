// The one screen a founder reads: the top lever's block survives the screen budget, the table fits 80 columns, and every cell says something sourced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSummary } from '../src/brief.ts';
import { withValues, type ValueContext } from '../src/lever-value.ts';
import type { Finding, Recommendation } from '../src/run-shape.ts';

const JEV = { id: 'J', name: 'TypeSafe Jev', pattern: 'PAT-label-picking-call', kind: 'k', effects: [], gain: 'g', proof: 'vendor claim', source: 'https://jev.example/docs/pricing', how: 'h', price: '$0.042 per 1M input tokens; output tokens are free.', checked: '2026-11-01' };
const DECISIONS = { ...JEV, id: 'D', name: 'OpenAI Decisions API', source: 'https://decisions.example/docs/guide', price: '$0.10 per 1M uncached input tokens on gpt-6-luna; output tokens are not charged.' };
const CHEAP = { input: 0.15, output: 0.6, model: 'small-model', source: 'https://openrouter.ai/x/small-model', date: '2026-11-01' };
const CLASSIFIER = `const ROUTER_SYSTEM_PROMPT = \`You are a classifier for a router. Pick the first category that matches.\n\n{categories}\n\nAlways call the tool.\`;\nasync function classify(router) {\n  const role = ROUTER_SYSTEM_PROMPT.replace('{categories}', list);\n  return new Agent({ model: router.fallback_model, role });\n}\n`;
const context: ValueContext = { levers: [JEV, DECISIONS], files: new Map([['c.js', CLASSIFIER]]), modelIds: [], priceOf: (model) => (model === 'small-model' ? CHEAP : null), exampleModel: 'small-model' };
const lever: Finding = {
  title: "Move the prompt-injection guard's yes-or-no check from a small-model chat call to a decision model",
  effect: ['cheaper', 'faster'], proof: 'vendor claim', effort: 'A day or more',
  where: [{ file: 'c.js', line: 4, text: 'return new Agent({ model: router.fallback_model, role });' }, { file: 'd.js', line: 9, text: 'x' }, { file: 'e.js', line: 2, text: 'y' }],
  why: 'w',
  options: [{ name: 'TypeSafe Jev', what: 'answers yes or no with a confidence, and you keep the chat call as the fallback below a confidence of 0.8.', needs: 'n', source: 'https://jev.example/docs/pricing' }, { name: 'OpenAI Decisions API', what: 'a decision model that returns a label and a confidence for each call it gets.', needs: 'n', source: 'https://decisions.example/docs/guide' }],
  sources: ['https://jev.example/blog/launch'], lever: 'J', pr: null,
};
const team: Recommendation[] = ['Stripe', 'GitHub', 'Linear'].map((name) => ({ name: `${name}'s own MCP server`, kind: 'mcp-server', why: `the ${name} work this repo does, from its own server`, install: `claude mcp add ${name.toLowerCase()} -e TOKEN=$TOKEN -- docker run -i --rm -e TOKEN ghcr.io/${name.toLowerCase()}/${name.toLowerCase()}-mcp-server` }) as Recommendation);
const retired: Finding = { title: 'Move off gpt-4-0613', effect: ['keeps working'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'examples/old/run.py', line: 39, text: 'gpt-4-0613' }], why: 'w', options: [], sources: ['https://notice.example'], lever: null, pr: null, reach: 'sent' };
const run = {
  repo: 'o/n', commit: 'abc', db: { fetched: '2026-11-01', records: 41785, by_source: {}, window: { since: 'a', until: 'b' } }, profile: null, watching: [],
  held_back: Array.from({ length: 15 }, (_, i) => ({ thing: `thing ${i}`, date: null, reason: 'not in this code', source: null })),
  checks: { passed: 1, dropped: [] }, ran: { search: true, judge: true, online: false }, recommendations: team,
};
const [priced] = withValues([lever], context);
const one: Parameters<typeof renderSummary>[0] = { ...run, findings: [{ ...priced, rank: 1 }, retired] };

test('a one-lever brief keeps the lever block, with What it does and ROI, inside one screen', () => {
  assert.equal(priced.value?.roi?.money, true, 'the fixture is priced through roi');
  const text = renderSummary(one);
  assert.match(text, /What it does:/);
  assert.match(text, /ROI:/);
  assert.match(text, /Next: \/keepup:apply 1/);
  assert.ok(text.trimEnd().split('\n').length <= 40, text);
});

test('under "nothing clears its cost", a lever priced through roi gives its break-even, labelled', () => {
  const text = renderSummary(one);
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith('Nothing clears its cost'));
  assert.ok(at >= 0, text);
  const lead = lines.slice(at, lines.findIndex((line) => line.startsWith('Ranked by fit'))).join(' ').replace(/\s+/g, ' ');
  assert.match(lead, /not worth it below [\d,]+ calls a month/);
  assert.match(lead, /\[projected, example\]/);
});

test('no table line is wider than 80 columns', () => {
  const lines = renderSummary(one).split('\n');
  const start = lines.findIndex((line) => line.startsWith('Ranked by fit'));
  const end = lines.findIndex((line, i) => i > start && line.trim() === '');
  const rows = lines.slice(start + 1, end);
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.ok(row.length <= 80, `${row.length}: ${row}`);
});

test('a lever with no sourced effect shows what it brings, not how many places it is in', () => {
  const plain: Finding = { title: 'rmcp is 3 major versions behind', effect: ['new capability', 'security fixes'], proof: 'adoption only', effort: 'Hours', where: [{ file: 'a.rs', line: 1, text: 'rmcp' }, { file: 'b.rs', line: 2, text: 'rmcp' }], why: 'w', options: [], sources: ['https://changelog.example'], lever: null, pr: null, rank: 1 };
  const text = renderSummary({ ...run, recommendations: [], held_back: [], findings: [plain] });
  assert.doesNotMatch(text, /places in your code/);
  assert.match(text, /^ 1 .*new capability/m);
});
