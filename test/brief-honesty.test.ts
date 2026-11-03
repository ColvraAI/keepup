// What a person following the README hit: a brief that reassured on text it never could check, an effort label that hid the
// real job, Do lines cut mid-sentence, findings with no place, a coverage line that read as full coverage, and places a model dropped.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderRetired, renderSummary } from '../src/brief.ts';
import { findingsFromExact, moveTable } from '../src/findings.ts';
import { checkModels, type DependencyCheck, type ModelCheck } from '../src/exact-checks.ts';
import { unrecognisedOnLists } from '../src/list-ids.ts';
import { rankFindings } from '../src/rank.ts';
import { verifyFindings } from '../src/verify.ts';
import type { Lever } from '../src/levers.ts';
import type { Retirement } from '../src/retirements.ts';
import type { Finding } from '../src/run-shape.ts';
import { git } from './helpers.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const WINDOW = { since: '2026-09-01', until: '2026-10-31' };
const NOTES = 'https://notes.example';
const lineText = () => 'x';
const changelog = [{ provider: 'anthropic' as const, date: '2026-09-28', url: NOTES, change: null, tags: [], text: "We've launched Claude Sonnet 5.5 ( claude-sonnet-5-5 ). Forced tool use ( tool_choice types any and tool ) returns a 400 error." }];
const sonnet = (over: Partial<ModelCheck> = {}): ModelCheck => ({
  kind: 'model', model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', status: 'retiring', announced: '2026-09-30', effective: '2026-11-30',
  successors: ['claude-sonnet-5-5'], source: NOTES, sentence: 'Claude Sonnet 4.5 retires on November 30, 2026.',
  live_places: [{ id: 'claude-sonnet-4-5-20250929', file: 'app/page.tsx', line: 35, text: "model: 'claude-sonnet-4-5-20250929'", context: 'code', commented: false, route: 'direct' } as never], not_live: [], ...over,
});
const dep = (name: string, over: Partial<DependencyCheck> = {}): DependencyCheck => ({
  kind: 'dependency', name, ecosystem: 'npm', status: 'no-data', spec: '^1.1.6', spec_kind: 'range', latest: null, latest_date: null, declared_date: null, majors_behind: 0, stale: false, basis: null, source: null,
  places: [{ file: 'package.json', line: 12, spec: '^1.1.6' }], ...over,
});
const ai = dep('ai', { status: 'behind', spec: '^3.3.8', latest: '7.0.159', latest_date: '2026-10-30', majors_behind: 4, source: 'https://www.npmjs.com/package/ai', basis: 'database', locked: { version: '3.4.33', file: 'package-lock.json', line: 5348 } });
const provider = dep('@ai-sdk/anthropic', { locked: { version: '1.2.12', file: 'package-lock.json', line: 76 } });
const lever: Lever = {
  id: 'ADV-x', name: 'Move to Sonnet 5.5', pattern: 'PAT-retired-model-id', kind: 'model-successor', effects: ['keeps working'], gain: 'g', proof: 'vendor claim', source: 'https://deprecations.example',
  how: 'Change claude-sonnet-4-5-20250929 to claude-sonnet-5-5.', needs: 'Nothing new; the same Anthropic key.', models: ['claude-sonnet-4-5-20250929'],
  bridge: { model: 'claude-sonnet-4-6', until: '2027-02-17', what: 'Anthropic lists claude-sonnet-4-6 as active, and retires it no sooner than 17 Feb 2027.' },
};
const context = { lineText, window: WINDOW, changelog, files: new Map([['app/page.tsx', 'x']]), levers: [lever], asOf: '2026-11-01', retirements: [] as readonly Retirement[] };

describe('a successor that breaks something, reached through an SDK', () => {
  const floor = findingsFromExact([sonnet(), ai, provider], context);
  const [finding] = floor.findings;

  it('never reads a missing word as safe, and names the SDK and its installed version as unverified', () => {
    assert.ok(!/isn't anywhere/.test(finding.why), finding.why);
    assert.match(finding.why, /doesn't rule it out/);
    assert.match(finding.why, /ai 3\.4\.33 and @ai-sdk\/anthropic 1\.2\.12/);
    assert.match(finding.why, /not verified/i);
    assert.deepEqual(finding.sdk_unverified, { identifier: 'tool_choice', sdks: ['ai 3.4.33', '@ai-sdk/anthropic 1.2.12'] });
  });

  it('only the provider\'s own SDK packages count: @ai-sdk/google says nothing about a Claude model', () => {
    const [other] = findingsFromExact([sonnet(), dep('@ai-sdk/google')], context).findings;
    assert.equal(other.sdk_unverified, undefined);
  });

  it('with no SDK in the repo, the plain text check stands, and the effort stays Hours', () => {
    const [plain] = findingsFromExact([sonnet()], context).findings;
    assert.equal(plain.effort, 'Hours');
    assert.equal(plain.sdk_unverified, undefined);
    assert.equal(plain.options.length, 1);
  });

  it('where the repo sets it, the place is what matters, and nothing is unverified', () => {
    const [set] = findingsFromExact([sonnet(), ai], { ...context, files: new Map([['a.ts', "toolChoice: 'none'"]]) }).findings;
    assert.match(set.why, /toolChoice is at a\.ts:1/);
    assert.equal(set.sdk_unverified, undefined);
  });

  it('takes the upgrade off the held-back list, gives it as the reason, and raises the effort', () => {
    assert.ok(!floor.held_back.some((row) => row.thing.startsWith('ai is')), JSON.stringify(floor.held_back));
    assert.equal(finding.effort, 'A project');
    const upgrade = finding.options.find((option) => /^ai and @ai-sdk\/anthropic upgrade/.test(option.name));
    assert.ok(upgrade, JSON.stringify(finding.options));
    assert.match(upgrade.what, /ai 3\.4\.33 is 4 major versions behind 7\.0\.159/);
    assert.equal(upgrade.source, 'https://www.npmjs.com/package/ai');
    assert.ok(!finding.options.some((option) => /^Nothing new/.test(option.needs)), 'a move that may need an upgrade doesn\'t need "nothing new"');
  });

  it('an SDK nobody has an answer about still gets its option, with no made-up link', () => {
    const [unknown] = findingsFromExact([sonnet(), provider], context).findings;
    const upgrade = unknown.options.find((option) => option.name.startsWith('@ai-sdk/anthropic upgrade'));
    assert.equal(upgrade?.source, '');
    assert.equal(unknown.effort, 'A day or more');
  });

  it('a library a little behind is a day or more, not a project', () => {
    const [near] = findingsFromExact([sonnet(), { ...ai, majors_behind: 1, latest: '4.0.0' }], context).findings;
    assert.equal(near.effort, 'A day or more');
  });

  it('offers the bridge first when one is live, and not once its date has passed', () => {
    assert.match(finding.options[0].name, /claude-sonnet-4-6/);
    assert.match(finding.options[0].what, /17 Feb 2027/);
    const [late] = findingsFromExact([sonnet(), ai], { ...context, asOf: '2027-03-01' }).findings;
    assert.ok(!late.options.some((option) => /claude-sonnet-4-6/.test(option.name)));
  });

  it('prints the warning and the SDK on the screen, whole', () => {
    const text = renderRetired(summaryRun([{ ...finding, rank: 1 }]));
    assert.match(text, /Check first: Forced tool use/);
    assert.match(text, /Not ruled out: [^\n]*ai 3\.4\.33 and @ai-sdk\/anthropic 1\.2\.12/);
    assert.match(text, /A project/);
    assert.ok(!text.includes('...'), text);
  });
});

function summaryRun(findings: readonly Finding[], over: Record<string, unknown> = {}) {
  return {
    repo: 'o/r', commit: 'abcdef1234', commit_date: '2026-10-13', db: { fetched: '2026-10-31', records: 41785, by_source: { npm: 1 }, window: WINDOW },
    ran: { search: true, judge: true, online: false }, coverage: { searches: 2, reads: 1 }, profile: null, findings, watching: [], held_back: [], checks: { passed: 1, dropped: [] }, ...over,
  };
}

const pickerFinding = (title: string, over: Partial<Finding> = {}): Finding => ({
  title, effect: ['keeps working'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'lib/models.json', line: 67, text: 'x' }, { file: 'lib/models.json', line: 88, text: 'x' }], why: 'y',
  options: [{ name: 'gpt-3.5-turbo, gpt-4, gpt-4-turbo and o1 are shut down; move to GPT-5.6', what: 'Follow the page per id: a long sentence that goes on '.repeat(4), needs: '', source: 'https://d.example' }],
  sources: ['https://d.example'], lever: null, pr: null, reach: 'picker', ...over,
});

describe('the Do line', () => {
  const moves = [
    { from: 'gpt-4.5-preview', to: ['gpt-6-luna'], places: ['lib/models.json:67'] },
    { from: 'o1-mini', to: ['gpt-5.6-terra'], places: ['lib/models.json:88'] },
    { from: 'o4-mini', to: ['gpt-5.6-terra'], places: ['lib/models.json:39'] },
    { from: 'gemini-1.5-flash', to: [], places: ['lib/models.json:186'] },
    { from: 'elsewhere', to: ['nope'], places: ['other.json:1'] },
  ];

  it("a lever finding's Do is its own options, never a retirement move at the same place", () => {
    const lever = pickerFinding('Check pages with a cheaper classifier', { rank: 1, lever: 'J', reach: undefined, effect: ['cheaper'], where: [{ file: 'lib/models.json', line: 67, text: 'x' }], options: [{ name: 'TypeSafe Jev', what: 'Send the page to Jev instead.', needs: 'A key.', source: 'https://jev.example' }], sources: ['https://jev.example'] });
    for (const text of [renderSummary(summaryRun([lever], { moves })), renderSummary(summaryRun([lever, pickerFinding('Retired', { rank: 2 })], { moves }))]) {
      const leverPart = text.slice(text.indexOf('1. Check'), text.indexOf('2. ') > 0 ? text.indexOf('2. ') : undefined);
      assert.ok(!leverPart.includes('gpt-6-luna'), text);
      assert.ok(/What it does: TypeSafe Jev/.test(leverPart.replace(/\n\s+/g, ' ')), text);
    }
  });

  for (const [name, count] of [['in the top three', 1], ['past the top three', 5]] as const) {
    it(`${name}, it says this repo's ids and where each goes, uncut`, () => {
      const findings = Array.from({ length: count }, (_, index) => pickerFinding(`Finding ${index + 1}`, { rank: index + 1, where: [{ file: 'lib/models.json', line: 67, text: 'x' }, { file: 'lib/models.json', line: 88, text: 'x' }, { file: 'lib/models.json', line: 39, text: 'x' }, { file: 'lib/models.json', line: 186, text: 'x' }] }));
      const text = renderRetired(summaryRun(findings, { moves }));
      const flat = text.replace(/\n\s+/g, ' ');
      assert.ok(flat.includes('Do: gpt-4.5-preview to gpt-6-luna; o1-mini, o4-mini to gpt-5.6-terra; gemini-1.5-flash has no successor named'), text);
      assert.ok(!text.includes('gpt-3.5-turbo'), 'no id this repo doesn\'t have');
      assert.ok(!text.includes('nope'));
      assert.ok(!/Do:[^\n]*\.\.\./.test(text), text);
      assert.ok(text.split('\n').every((line) => line.length <= 120));
    });
  }

  it('an option with no moves wraps instead of cutting, so the action is whole', () => {
    const what = 'Change the id, then read the migration guide, and after that run the tests on a branch of your own, because the last words here are the ones that matter most of all.';
    const text = renderRetired(summaryRun([pickerFinding('One', { options: [{ name: 'Move', what, needs: '', source: 'https://d.example' }] })]));
    assert.ok(text.replace(/\n\s+/g, ' ').includes(what), text);
    assert.ok(text.split('\n').every((line) => line.length <= 120));
  });

  it('a long held-back row wraps too', () => {
    const reason = 'Sent through a gateway. Google retired this id, and keepup cannot see its plan, so check with them, and here are the last words that used to fall off.';
    const text = renderSummary(summaryRun([pickerFinding('One')], { held_back: [{ thing: 'gemini-x, a retired model, in a.json:1', date: null, reason, source: null }] }));
    assert.ok(text.replace(/\n\s+/g, ' ').includes(reason), text);
  });
});

describe('every finding says where', () => {
  it('past the top three, it prints the first place and how many more', () => {
    const findings = Array.from({ length: 5 }, (_, index) => pickerFinding(`Finding ${index + 1}`, { rank: index + 1 }));
    const text = renderRetired(summaryRun(findings));
    assert.match(text, /5\. Finding 5 · [^\n]+\n {3}lib\/models\.json:67 and 1 more\n {3}Do:/);
  });
});

describe('the order of models on a list', () => {
  it('one already gone comes before one that still works', () => {
    const list = (title: string, deadline: string): Finding => pickerFinding(title, { deadline });
    const ranked = rankFindings([list('live in Jan', '2027-01-14'), list('live in Dec', '2026-12-11'), list('dead', '2025-07-14'), list('dead too', '2026-06-01')], '2026-11-01');
    assert.deepEqual(ranked.findings.map((finding) => finding.title), ['dead', 'dead too', 'live in Dec', 'live in Jan']);
  });
});

describe('what the header says went unchecked', () => {
  const exact = [{ kind: 'dependency', status: 'no-data' }, { kind: 'dependency', status: 'no-data' }, { kind: 'dependency', status: 'current' }];

  it('gives the dependencies it did not check, and the ids on a list it did not recognise', () => {
    const text = renderSummary(summaryRun([pickerFinding('One')], { exact, unrecognised: { count: 21, files: ['lib/models.json'] } }));
    const flat = text.replace(/\n\s+/g, ' ');
    assert.ok(flat.includes('2 of 3 dependencies not checked (offline)'), text);
    assert.ok(flat.includes('21 model ids on lib/models.json not recognised'), text);
    assert.ok(flat.includes('0 fit.'), text);
    assert.ok(flat.includes('Also: '), text);
  });

  it('the quiet line says the same, on one line', () => {
    const text = renderSummary(summaryRun([], { exact, unrecognised: { count: 2, files: ['a.json', 'b.json'] } }));
    assert.equal(text, 'keepup: nothing new applies · 41,785 in the database · 2 searches · 1 read closely · 2 of 3 dependencies not checked (offline) · 2 model ids on lists not recognised\n');
  });

  it('counts only values under the key a recognised id sits on, and not the routes of ids it knows', () => {
    const text = ['{', '  "id": "gpt-4o",', '  "name": "GPT 4o",', '},{', '  "id": "codestral-latest",', '  "name": "Codestral",', '},{', '  "id": "models/gemini-2.0-flash",', '  "name": "G",', '},{', '  "id": "llama-3.3-70b-versatile",', '},{', '  "id": "codestral-latest",', '}'].join('\n');
    const modelIds = [
      { id: 'gpt-4o', provider: 'openai', places: [{ file: 'lib/models.json', line: 2, text: '"id": "gpt-4o",' }] },
      { id: 'gemini-2.0-flash', provider: 'google', places: [{ file: 'lib/models.json', line: 8, text: '"id": "models/gemini-2.0-flash",' }] },
    ] as never;
    assert.deepEqual(unrecognisedOnLists(modelIds, new Map([['lib/models.json', text]])), { count: 2, files: ['lib/models.json'] });
    assert.equal(unrecognisedOnLists(modelIds, new Map([['src/a.ts', text]])), null, 'a code file is not a list on two ids');
  });
});

describe('near variants of a retired id', () => {
  const rows: Retirement[] = [{ provider: 'gemini', id: 'gemini-1.5-flash', name: null, status: 'retired', announced: '2025-09-29', effective: '2025-09-29', successors: [], source: NOTES, sentence: 'x' }];
  const ids = (id: string) => [{ id, provider: 'google', places: [{ file: 'a.ts', line: 1, text: id, context: 'code', commented: false, route: 'direct' }] }] as never;

  it('a pinned version of a retired Gemini model is retired with it, and says that\'s how it knows', () => {
    const [check] = checkModels(ids('gemini-1.5-flash-002'), rows, '2026-11-01');
    assert.equal(check.model, 'gemini-1.5-flash-002');
    assert.equal(check.variant_of, 'gemini-1.5-flash');
    const [finding] = findingsFromExact([check], { lineText, window: WINDOW }).findings;
    assert.match(finding.why, /gemini-1\.5-flash-002 is a pinned version of gemini-1\.5-flash, which was shut down on 29 Sep 2025/);
  });

  it('nothing else counts as a variant', () => {
    assert.deepEqual(checkModels(ids('gemini-1.5-flash-8b'), rows, '2026-11-01'), []);
    assert.deepEqual(checkModels(ids('gemini-1.5-flash-lite'), rows, '2026-11-01'), []);
    assert.deepEqual(checkModels(ids('gpt-4o-002'), [{ ...rows[0], provider: 'openai', id: 'gpt-4o' }], '2026-11-01'), []);
  });
});

describe('an option\'s needs follow the route', () => {
  const entry = (id: string, providerId: string) => [`  {`, `    "id": "${id}",`, `    "providerId": "${providerId}",`, `    "multiModal": true`, `  },`];
  const lines = ['[', ...entry('gemini-2.0-flash-001', 'vertex'), ...entry('gemini-2.0-flash', 'google'), ']'];
  const places = (line: number, id: string) => ({ id, file: 'lib/models.json', line, text: `"id": "${id}",`, context: 'config', commented: false, route: 'direct', catalog: true });
  const google: Lever = { ...lever, id: 'ADV-g', name: 'Gemini', how: 'Change gemini-2.0-flash-001 and gemini-2.0-flash to gemini-3.6-flash.', needs: 'Nothing new; the same Gemini key.', models: ['gemini-2.0-flash', 'gemini-2.0-flash-001'], providers: ['google'], bridge: undefined };

  it('says when entries go through Vertex, which that key does not reach', () => {
    const checks = [sonnet({ model: 'gemini-2.0-flash-001', provider: 'gemini', status: 'retired', effective: '2026-06-01', successors: ['gemini-3.6-flash'], live_places: [places(3, 'gemini-2.0-flash-001')] as never }), sonnet({ model: 'gemini-2.0-flash', provider: 'gemini', status: 'retired', effective: '2026-06-01', successors: ['gemini-3.6-flash'], live_places: [places(8, 'gemini-2.0-flash')] as never })];
    const [finding] = findingsFromExact(checks, { ...context, changelog: [], levers: [google], files: new Map([['lib/models.json', lines.join('\n')]]) }).findings;
    assert.match(finding.options[0].needs, /lib\/models\.json:3 goes through Vertex/);
    assert.ok(!/lib\/models\.json:8/.test(finding.options[0].needs));
  });
});

describe('the move table', () => {
  const rows: Retirement[] = [
    { provider: 'openai', id: 'o4-mini', name: null, status: 'retired', announced: null, effective: '2026-10-23', successors: ['gpt-5.6-terra'], source: NOTES, sentence: 'x' },
    { provider: 'openai', id: 'gpt-4.5-preview', name: null, status: 'retired', announced: null, effective: '2025-07-14', successors: ['gpt-4.1'], source: NOTES, sentence: 'x' },
    { provider: 'openai', id: 'gpt-4.1', name: null, status: 'retiring', announced: null, effective: '2027-01-14', successors: ['gpt-6-luna'], source: NOTES, sentence: 'x' },
    { provider: 'gemini', id: 'gemini-1.5-flash', name: null, status: 'retired', announced: null, effective: '2025-09-29', successors: [], source: NOTES, sentence: 'x' },
  ];
  const check = (model: string, successors: string[]) => sonnet({ model, successors, provider: 'openai', live_places: [{ file: 'a.json', line: 1, text: model } as never] });

  it('follows a successor that is gone or going to where it ends, and says when there is none', () => {
    const table = moveTable([check('gpt-4.5-preview', ['gpt-4.1']), check('old', ['o4-mini']), check('gemini-1.5-flash', [])], { lineText, window: WINDOW, retirements: rows, asOf: '2026-11-01' });
    assert.deepEqual(table, [
      { from: 'gpt-4.5-preview', to: ['gpt-6-luna'], places: ['a.json:1'] },
      { from: 'old', to: ['gpt-5.6-terra'], places: ['a.json:1'] },
      { from: 'gemini-1.5-flash', to: [], places: ['a.json:1'] },
    ]);
  });
});

describe('the real gate on a repo that calls Claude through the AI SDK', () => {
  it('the top finding gets through verify with its label, its bridge and its warning', async () => {
    const path = mkdtempSync(join(tmpdir(), 'keepup-sdk-'));
    try {
      git(path, 'init', '-q', '-b', 'main');
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'x', dependencies: { ai: '^3.3.8', '@ai-sdk/anthropic': '^1.1.6' } }, null, 2));
      writeFileSync(join(path, 'chat.ts'), "import { streamObject } from 'ai';\nimport { anthropic } from '@ai-sdk/anthropic';\nexport const stream = streamObject({ model: anthropic('claude-sonnet-4-5-20250929') });\n");
      git(path, 'add', '-A');
      git(path, 'commit', '-qm', 'x');
      const { runPipeline } = await import('../src/pipeline.ts');
      const floor = await runPipeline(path, { online: false, asOf: '2026-11-01' }, {});
      const out = await verifyFindings(path, { findings: floor.findings, watching: [], held_back: floor.held_back, jobs: ['chat'] }, { asOf: '2026-11-01', log: { searches: 2, reads: 1 } });
      assert.deepEqual(out.dropped, []);
      const [finding] = out.findings;
      assert.equal(finding.effort, 'A project');
      assert.ok(finding.sdk_unverified);
      assert.match(finding.options[0].name, /claude-sonnet-4-6/);
      assert.ok(!out.held_back.some((row) => row.thing.startsWith('ai is')));
      assert.match(out.brief ?? '', /Also: /);
      assert.match(renderRetired({ ...floor, findings: out.findings }), /Not ruled out: /);
      assert.ok(!(out.brief ?? '').includes("isn't anywhere"));
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe('keepup verify on a floor finding a model rewrote', () => {
  const lines = (id: string, n: number) => Array.from({ length: n }, (_, index) => `  {"id": "${id}", "n": ${index}},`);
  const repo = () => {
    const path = mkdtempSync(join(tmpdir(), 'keepup-verify-'));
    git(path, 'init', '-q', '-b', 'main');
    mkdirSync(join(path, 'lib'));
    const models = ['[', ...lines('gemini-2.5-flash-preview-05-20', 1), '  {"id": "models/gemini-2.5-flash-preview-05-20"},', ...lines('gpt-4.5-preview', 1), ']'];
    writeFileSync(join(path, 'lib', 'models.json'), models.join('\n'));
    writeFileSync(join(path, 'lib', 'use.ts'), "import models from './models.json';\nexport const client = { model: models[0].id, provider: 'openai' };\n");
    git(path, 'add', '-A');
    git(path, 'commit', '-qm', 'x');
    return path;
  };

  it('puts back the places it dropped, its own wording, its options and its date, so the order and the proof hold', async () => {
    const path = repo();
    try {
      const { runPipeline } = await import('../src/pipeline.ts');
      const floor = await runPipeline(path, { online: false }, {});
      const target = floor.findings.find((finding) => finding.where.length >= 2 && /gemini/.test(finding.why));
      assert.ok(target, JSON.stringify(floor.findings.map((finding) => finding.title)));
      const rewritten = { ...target, why: 'Shut down. Named successor: nothing to worry about.', where: target.where.slice(0, 1), options: [{ name: 'Move', what: 'Just change the id.', needs: '', source: target.sources[0] }], deadline: undefined };
      const out = await verifyFindings(path, { findings: [rewritten as Finding] }, { log: { searches: 0, reads: 0 } });
      assert.deepEqual(out.dropped, []);
      const [kept] = out.findings;
      assert.deepEqual(kept.where.map((place) => `${place.file}:${place.line}`).sort(), target.where.map((place) => `${place.file}:${place.line}`).sort());
      assert.equal(kept.why, target.why);
      assert.deepEqual(kept.options, target.options);
      assert.equal(kept.deadline, target.deadline);
      const bare = await verifyFindings(path, { findings: [{ title: target.title, effect: target.effect, proof: target.proof, effort: target.effort, where: [], why: '', options: [], sources: [] } as unknown as Finding] }, { log: { searches: 0, reads: 0 } });
      assert.deepEqual(bare.dropped, [], 'a floor finding can be sent by its title alone, so the command stays short');
      assert.equal(bare.findings[0].why, target.why);
      assert.equal(bare.findings[0].where.length, target.where.length);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
