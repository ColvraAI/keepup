import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { DependencyCheck, ModelCheck } from '../src/exact-checks.ts';
import { findingsFromExact } from '../src/findings.ts';

const CHANGELOG = 'https://developers.openai.com/api/docs/changelog';
const place = (over: object = {}) => ({ file: 'a.js', line: 3, text: 'x', context: 'code' as const, commented: false, route: 'direct' as const, ...over });
const model = (over: Partial<ModelCheck>): ModelCheck => ({
  kind: 'model', model: 'whisper-1', provider: 'openai', status: 'retiring', announced: '2026-08-26', effective: '2027-02-26',
  successors: ['gpt-live-transcribe', 'gpt-transcribe'], source: CHANGELOG, sentence: 'These models will shut down on February 26, 2027.',
  live_places: [place()], not_live: [], ...over,
});
const dependency = (over: Partial<DependencyCheck>): DependencyCheck => ({
  kind: 'dependency', name: 'rmcp', ecosystem: 'crates', status: 'behind', spec: '0.12.0', spec_kind: 'range', latest: '3.8.0', latest_date: '2026-10-26',
  declared_date: '2025-12-18', majors_behind: 3, stale: false, basis: 'registry', source: 'https://crates.io/crates/rmcp',
  places: [{ file: 'Cargo.toml', line: 49, spec: '0.12.0' }], ...over,
});
const lineText = () => 'the line';
const WINDOW = { since: '2026-09-01', until: '2026-10-31' };
const run = (exact: (ModelCheck | DependencyCheck)[]) => findingsFromExact(exact, { lineText, window: WINDOW });
const NOTES = { url: 'https://github.com/o/rmcp/blob/main/CHANGELOG.md', gains: [{ version: '3.8.0', date: '2026-10-23', kind: 'fix' as const, text: 'stop SSE reconnects on permanent GET errors' }, { version: '3.6.0', date: '2026-10-19', kind: 'add' as const, text: 'cancel an abandoned tools/call' }] };

describe('findingsFromExact: models', () => {
  it('a live retiring model is a finding with its date, successors and source', () => {
    const { findings } = run([model({})]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, "OpenAI's whisper-1 shuts down on 26 Feb 2027");
    assert.deepEqual(findings[0].effect, ['keeps working']);
    assert.equal(findings[0].proof, 'vendor claim');
    assert.equal(findings[0].effort, 'Hours');
    assert.equal(findings[0].deadline, '2027-02-26');
    assert.deepEqual(findings[0].options.map((o) => o.name), ['gpt-live-transcribe', 'gpt-transcribe']);
    assert.deepEqual(findings[0].sources, [CHANGELOG]);
    assert.match(findings[0].why, /Announced on 26 Aug 2026/);
  });

  it('one finding per provider, however many ids and places', () => {
    const { findings } = run([
      model({ model: 'claude-sonnet-4-20250514', provider: 'anthropic', status: 'retired', effective: '2026-06-15', successors: ['Claude Sonnet 4.6'], live_places: [place({ file: 'a.toml', line: 14 })] }),
      model({ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', effective: '2026-11-30', successors: ['Claude Sonnet 5.5'], live_places: [place({ file: 'b.toml', line: 61 })] }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, '2 Anthropic models are retired or retiring');
    assert.deepEqual(findings[0].where.map((w) => [w.file, w.line]), [['a.toml', 14], ['b.toml', 61]]);
    assert.equal(findings[0].deadline, '2026-06-15');
    assert.deepEqual(findings[0].options.map((o) => o.name), ['Claude Sonnet 4.6', 'Claude Sonnet 5.5']);
  });

  it('says a retired model is gone', () => {
    const { findings } = run([model({ model: 'claude-sonnet-4-20250514', provider: 'anthropic', status: 'retired', effective: '2026-06-15' })]);
    assert.equal(findings[0].title, 'Anthropic has shut down claude-sonnet-4-20250514');
  });

  it('a retired id only inside a #[cfg(test)] block is held back, naming the block', () => {
    const { findings, held_back } = run([model({
      model: 'claude-3-sonnet-20240229', provider: 'anthropic', status: 'retired', effective: '2025-07-21', live_places: [],
      not_live: [{ ...place({ file: 'crates/aura-config/src/writer.rs', line: 225, context: 'test', test_block_line: 210 }), why: 'test' }],
    })]);
    assert.deepEqual(findings, []);
    assert.equal(held_back.length, 1);
    assert.equal(held_back[0].thing, 'claude-3-sonnet-20240229, a retired model, in crates/aura-config/src/writer.rs:225');
    assert.match(held_back[0].reason, /#\[cfg\(test\)\].*line 210/);
  });

  it('groups a lookup table\'s ids into one held-back row', () => {
    const inTable = (id: string) => model({ model: id, provider: 'anthropic', status: 'retired', live_places: [], not_live: [{ ...place({ file: 'map.js' }), why: 'catalog' }] });
    const { held_back } = run([inTable('claude-2.0'), inTable('claude-2.1')]);
    assert.equal(held_back.length, 1);
    assert.match(held_back[0].thing, /2 Anthropic model ids in map\.js/);
    assert.match(held_back[0].reason, /^They're listed in a table of known models/);
  });

  it('names the #[cfg(test)] fixture over a test file, when an id is in both', () => {
    const { held_back } = run([model({
      model: 'claude-3-sonnet-20240229', provider: 'anthropic', status: 'retired', live_places: [],
      not_live: [
        { ...place({ file: 'crates/a/src/config_test.rs', context: 'test' }), why: 'test' },
        { ...place({ file: 'crates/a/src/writer.rs', line: 225, context: 'test', test_block_line: 210 }), why: 'test' },
      ],
    })]);
    assert.match(held_back[0].thing, /writer\.rs:225/);
  });

  it('says what each model is when a group mixes them', () => {
    const { findings } = run([
      model({ model: 'gemini-2.0-flash', provider: 'gemini', status: 'retired', effective: '2026-06-01' }),
      model({ model: 'gemini-3.5-flash', provider: 'gemini', status: 'deprecated', effective: null }),
    ]);
    assert.equal(findings[0].title, '2 Google models are retired or deprecated');
  });

  it('a gateway id says only what is known: who sends it, the maker\'s date, and that keepup can\'t see the gateway\'s plan', () => {
    const { held_back } = run([model({ model: 'gpt-5-mini', effective: '2026-12-11', status: 'retiring', live_places: [], not_live: [{ ...place({ file: 'x/openrouter.js', route: 'gateway' }), why: 'gateway' }] })]);
    assert.equal(held_back[0].reason, "Sent through OpenRouter. OpenAI retires this id on 11 Dec 2026, and keepup can't see OpenRouter's plan, so check with them.");
    assert.ok(!/your platform/.test(held_back[0].reason));
  });

  it('a live place wins: test hits on the same id make no held-back row', () => {
    const { findings, held_back } = run([model({ not_live: [{ ...place({ context: 'test' }), why: 'test' }] })]);
    assert.equal(findings.length, 1);
    assert.deepEqual(held_back, []);
  });
});

describe('findingsFromExact: successors', () => {
  const retirement = (id: string, successors: string[], status: 'retired' | 'retiring' | 'deprecated' = 'deprecated', effective: string | null = null) => ({ provider: 'gemini' as const, id, name: null, status, announced: null, effective, successors, source: 'https://x.example', sentence: 's' });
  const gemini = model({ model: 'gemini-2.0-flash', provider: 'gemini', status: 'retired', effective: '2026-06-01', successors: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'] });

  it('reports the provider\'s literal successor, and a successor on its way out is a separate note', () => {
    const retirements = [retirement('gemini-3.5-flash', ['gemini-3.6-flash'])];
    const { findings } = findingsFromExact([gemini], { lineText, window: WINDOW, retirements });
    assert.deepEqual(findings[0].options.map((o) => o.name), ['gemini-3.5-flash', 'gemini-3.1-flash-lite']);
    assert.match(findings[0].why, /Named successor: gemini-3\.5-flash or gemini-3\.1-flash-lite\./);
    assert.match(findings[0].why, /gemini-3\.5-flash is itself deprecated\. Google names gemini-3\.6-flash after it\./);
  });

  it('a lever, when there is one, wins over a changelog successor it does not agree with', () => {
    const lever = { id: 'ADV-x', name: 'Move to Sonnet 5.5', pattern: 'P', kind: 'model-successor', effects: ['keeps working'], gain: 'g', proof: 'vendor claim', source: 'https://lever.example', how: 'Change it to claude-sonnet-5-5.', models: ['claude-sonnet-4-20250514'] };
    const { findings } = findingsFromExact([model({ model: 'claude-sonnet-4-20250514', provider: 'anthropic', status: 'retired', effective: '2026-06-15', successors: ['Claude Sonnet 4.6'] })], { lineText, window: WINDOW, levers: [lever], asOf: '2026-10-31' });
    assert.ok(!findings[0].why.includes('Sonnet 4.6'));
    assert.deepEqual(findings[0].options.map((o) => o.name), ['Move to Sonnet 5.5']);
    assert.equal(findings[0].lever, 'ADV-x');
  });

  it('names what the successor breaks, read from the changelog, and whether the repo uses it', () => {
    const changelog = [{ provider: 'anthropic' as const, date: '2026-09-28', url: 'https://notes.example', change: null, tags: [], text: "We've launched Claude Sonnet 5.5 ( claude-sonnet-5-5 ). Forced tool use ( tool_choice types any and tool ) returns a 400 error." }];
    const check = model({ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', effective: '2026-11-30', successors: ['Claude Sonnet 5.5'] });
    const absent = findingsFromExact([check], { lineText, window: WINDOW, changelog, files: new Map([['a.js', 'x']]) });
    assert.match(absent.findings[0].why, /returns a 400 error/);
    assert.match(absent.findings[0].why, /tool_choice isn't anywhere in this repo's code/);
    const present = findingsFromExact([check], { lineText, window: WINDOW, changelog, files: new Map([['a.js', 'x\ntool_choice: "any"']]) });
    assert.match(present.findings[0].why, /tool_choice is at a\.js:2/);
  });

  it('a JS repo spells it in camelCase: the place and value are said, never that it\'s absent', () => {
    const changelog = [{ provider: 'anthropic' as const, date: '2026-09-28', url: 'https://notes.example', change: null, tags: [], text: "We've launched Claude Sonnet 5.5 ( claude-sonnet-5-5 ). Forced tool use ( tool_choice types any and tool ) returns a 400 error." }];
    const check = model({ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', effective: '2026-11-30', successors: ['Claude Sonnet 5.5'] });
    for (const [line, value] of [["  toolChoice: 'required',", "'required'"], ["  toolChoice: 'none',", "'none'"], ['"tool-choice": "any"', '"any"']] as const) {
      const { why } = findingsFromExact([check], { lineText, window: WINDOW, changelog, files: new Map([['app/chat.ts', `x\n${line}`]]) }).findings[0];
      assert.ok(!/isn't anywhere/.test(why), why);
      assert.match(why, /at app\/chat\.ts:2/);
      assert.ok(why.includes(value), why);
    }
  });

  it('a comment that mentions it sets nothing, and when something real was found, a tool the repo doesn\'t use is noise', () => {
    const text = "We've launched Claude Sonnet 5.5 ( claude-sonnet-5-5 ). Forced tool use ( tool_choice types any and tool ) returns a 400 error. On the Claude API, the earlier computer_20251124 computer use tool isn't accepted.";
    const changelog = [{ provider: 'anthropic' as const, date: '2026-09-28', url: 'https://notes.example', change: null, tags: [], text }];
    const check = model({ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', effective: '2026-11-30', successors: ['Claude Sonnet 5.5'] });
    const commented = findingsFromExact([check], { lineText, window: WINDOW, changelog, files: new Map([['a.rs', '/// would layer additional tool-choice bias']]) }).findings[0].why;
    assert.match(commented, /tool_choice isn't anywhere in this repo's code/);
    const real = findingsFromExact([check], { lineText, window: WINDOW, changelog, files: new Map([['a.ts', "toolChoice: 'none'"]]) }).findings[0].why;
    assert.match(real, /toolChoice is at a\.ts:1/);
    assert.ok(!/computer_20251124/.test(real), real);
  });

  it('a value that is anything but a plain word is not repeated, so a repo can\'t write into a finding', () => {
    const changelog = [{ provider: 'anthropic' as const, date: '2026-09-28', url: 'https://notes.example', change: null, tags: [], text: "We've launched Claude Sonnet 5.5 ( claude-sonnet-5-5 ). Forced tool use ( tool_choice types any and tool ) returns a 400 error." }];
    const check = model({ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', effective: '2026-11-30', successors: ['Claude Sonnet 5.5'] });
    const { why } = findingsFromExact([check], { lineText, window: WINDOW, changelog, files: new Map([['a.ts', 'toolChoice: "see evil.example.com now"']]) }).findings[0];
    assert.ok(!why.includes('evil.example.com'), why);
    assert.match(why, /toolChoice is at a\.ts:1/);
  });

  it('a setting a trade-off names is found in any spelling', () => {
    const lever = { id: 'ADV-x', name: 'Move', pattern: 'P', kind: 'model-successor', effects: ['keeps working'], gain: 'g', proof: 'vendor claim', source: 'https://lever.example', how: 'Change it to claude-sonnet-5-5.', models: ['claude-sonnet-4-5-20250929'], trade_offs: ['Thinking budgets are gone, and top_p and top_k are rejected.'] };
    const check = model({ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', effective: '2026-11-30', live_places: [{ ...place({ file: 'a.ts', line: 2, text: 'model: "claude-sonnet-4-5-20250929",' }) }] });
    const file = 'const o = {\n  model: "claude-sonnet-4-5-20250929",\n  topP: 0.9,\n  topK: 5,\n  budgetTokens: 100,\n};';
    const { why } = findingsFromExact([check], { lineText, window: WINDOW, asOf: '2026-10-31', levers: [lever], changelog: [], files: new Map([['a.ts', file]]) }).findings[0];
    assert.match(why, /budgetTokens at a\.ts:5/);
    assert.match(why, /topP at a\.ts:3/);
    assert.match(why, /topK at a\.ts:4/);
  });
});

describe('findingsFromExact: an option belongs to a model', () => {
  it('says which model each replacement is for, and what it needs', () => {
    const a = model({ model: 'gemini-a', provider: 'gemini', status: 'deprecated', effective: null, successors: ['gemini-a2'], successors_from_page: true, live_places: [{ ...place({ file: 'x.js', line: 4 }) }] });
    const b = model({ model: 'gemini-b', provider: 'gemini', status: 'retiring', effective: '2027-03-15', successors: ['gemini-b2'], successors_from_page: true, live_places: [{ ...place({ file: 'y.js', line: 9 }), catalog: true }] });
    const { findings } = findingsFromExact([a, b], { lineText, window: WINDOW });
    const [finding] = findings;
    const option = (name: string) => finding.options.find((item) => item.name === name);
    assert.equal(option('gemini-a2')?.what, 'Named by Google as the replacement for gemini-a.');
    assert.equal(option('gemini-b2')?.what, 'Named by Google as the replacement for gemini-b.');
    assert.equal(option('gemini-a2')?.needs, 'Change gemini-a to it at x.js:4.');
    assert.equal(option('gemini-b2')?.needs, 'Change gemini-b to it at y.js:9.');
  });

  it('one replacement for two models says both', () => {
    const a = model({ model: 'gemini-a', provider: 'gemini', status: 'deprecated', effective: null, successors: ['gemini-new'], successors_from_page: true });
    const b = model({ model: 'gemini-b', provider: 'gemini', status: 'deprecated', effective: null, successors: ['gemini-new'], successors_from_page: true });
    const { findings } = findingsFromExact([a, b], { lineText, window: WINDOW });
    assert.equal(findings[0].options.length, 1);
    assert.equal(findings[0].options[0].what, 'Named by Google as the replacement for gemini-a and gemini-b.');
  });

  it('a default code really sends is never called a choice on a list, and with no date it waits behind what has one', () => {
    const live = model({ model: 'gemini-a', provider: 'gemini', status: 'deprecated', effective: null, live_places: [{ ...place({ file: 'x.js', line: 4, text: 'const DEFAULT_MODEL = "gemini-a";' }) }] });
    assert.equal(findingsFromExact([live], { lineText, window: WINDOW }).findings[0].reach, 'undated');
    const listed = model({ model: 'gemini-b', provider: 'gemini', status: 'retiring', effective: '2027-03-15', live_places: [{ ...place({ file: 'y.js', line: 9 }), catalog: true }] });
    assert.equal(findingsFromExact([listed], { lineText, window: WINDOW }).findings[0].reach, 'picker');
  });
});

describe('findingsFromExact: grouping and places', () => {
  const lever = (id: string, models: string[]) => ({ id, name: id, pattern: 'P', kind: 'model-successor', effects: ['keeps working'], gain: 'g', proof: 'vendor claim', source: `https://${id}.example`, how: 'h', models });

  it('dedupes places', () => {
    const { findings } = run([model({ live_places: [place(), place(), place({ line: 4 })] })]);
    assert.deepEqual(findings[0].where.map((w) => w.line), [3, 4]);
  });

  it('with levers: one finding per lever, except what is already gone or goes within a month', () => {
    const levers = [lever('ADV-a', ['whisper-1']), lever('ADV-b', ['tts-1']), lever('ADV-c', ['old-a']), lever('ADV-d', ['old-b'])];
    const exact = [
      model({ model: 'whisper-1', effective: '2027-02-26', successors: [] }),
      model({ model: 'tts-1', effective: '2027-01-06', successors: [] }),
      model({ model: 'old-a', status: 'retired', effective: '2026-06-15', successors: [] }),
      model({ model: 'old-b', effective: '2026-11-30', successors: [] }),
    ];
    const { findings } = findingsFromExact(exact, { lineText, window: WINDOW, levers, asOf: '2026-10-31' });
    assert.deepEqual(findings.map((f) => f.lever).sort(), ['ADV-a', 'ADV-b', 'ADV-c']);
    assert.equal(findings.find((f) => f.lever === 'ADV-c')?.deadline, '2026-06-15');
  });

  it('a table a picker reads gets a finding that says so, and a row of its own is gone', () => {
    const inPicker = (id: string) => model({ model: id, status: 'retired', effective: '2026-06-01', successors: [], live_places: [{ ...place({ file: 'lib/models.json' }), catalog: true }] });
    const { findings } = run([inPicker('a-1'), inPicker('b-1')]);
    assert.match(findings[0].title, /^2 OpenAI models in your picker are retired$/);
    assert.match(findings[0].why, /lib\/models\.json feeds a picker/);
  });

  it('every retirement is locked, so a judge cannot talk it away', () => {
    assert.ok(run([model({})]).findings[0].locked);
  });
});

describe('findingsFromExact: dependencies', () => {
  it('an AI library two or more majors behind, with release notes naming a gain, is a finding, a project\'s worth', () => {
    const { findings } = run([dependency({ release_notes: NOTES })]);
    assert.equal(findings.length, 1);
    assert.match(findings[0].title, /^rmcp is 3 major versions behind: stop SSE reconnects/);
    assert.equal(findings[0].effort, 'A project');
    assert.deepEqual(findings[0].effect, ['keeps working']);
    assert.match(findings[0].why, /Cargo\.toml:49 declares 0\.12\.0, released 18 Dec 2025.*3\.8\.0, released 26 Oct 2026/);
    assert.match(findings[0].why, /cancel an abandoned tools\/call \(3\.6\.0\)/);
    assert.deepEqual(findings[0].where, [{ file: 'Cargo.toml', line: 49, text: 'the line' }]);
    assert.deepEqual(findings[0].sources, ['https://crates.io/crates/rmcp', NOTES.url]);
    assert.ok(findings[0].locked, 'a protocol library with named gains stays');
  });

  it('notes that only add things mean "new capability", never "keeps working"', () => {
    const { findings } = run([dependency({ name: 'openai', release_notes: { ...NOTES, gains: [NOTES.gains[1]] } })]);
    assert.deepEqual(findings[0].effect, ['new capability']);
    assert.equal(findings[0].locked, undefined, 'an ordinary client library is the judge\'s call');
  });

  it('being behind with no notes that name a gain is held back, because age alone is never a finding', () => {
    const { findings, held_back } = run([dependency({})]);
    assert.deepEqual(findings, []);
    assert.equal(held_back[0].thing, 'rmcp is 3 major versions behind');
    assert.match(held_back[0].reason, /no release notes/);
  });

  it('an AI library with no release in 18 months is held back, however old', () => {
    const { findings, held_back } = run([dependency({
      name: '@xenova/transformers', ecosystem: 'npm', status: 'allowed-by-range', spec: '^2.14.0', latest: '2.17.2', latest_date: '2024-05-29', majors_behind: 0, stale: true,
      source: 'https://www.npmjs.com/package/@xenova/transformers',
      places: [{ file: 'collector/package.json', line: 20, spec: '^2.14.0' }, { file: 'server/package.json', line: 41, spec: '^2.14.0' }],
    })]);
    assert.deepEqual(findings, []);
    assert.equal(held_back[0].thing, '@xenova/transformers has had no release since 29 May 2024');
  });

  it('names a dependency that carries this one through its features', () => {
    const files = new Map([['Cargo.toml', 'rig-core = { git = "x", features = ["rmcp", "tls"] }\nrmcp = { version = "0.12.0" }\nserde = "1"\n']]);
    const { findings } = findingsFromExact([dependency({ places: [{ file: 'Cargo.toml', line: 2, spec: '0.12.0' }], release_notes: NOTES })], { lineText, window: WINDOW, files });
    assert.deepEqual(findings[0].where.map((w) => w.line), [2, 1]);
    assert.match(findings[0].why, /Cargo\.toml:1 also carries its own rmcp feature/);
  });

  it('a range that already allows a release from the window is held back, with why', () => {
    const { findings, held_back } = run([dependency({
      name: '@modelcontextprotocol/sdk', ecosystem: 'npm', status: 'allowed-by-range', spec: '^1.24.3', latest: '1.32.2', latest_date: '2026-10-23', majors_behind: 0,
      source: 'https://www.npmjs.com/package/@modelcontextprotocol/sdk', places: [{ file: 'server/package.json', line: 36, spec: '^1.24.3' }],
    })]);
    assert.deepEqual(findings, []);
    assert.deepEqual(held_back, [{
      thing: '@modelcontextprotocol/sdk 1.32.2', date: '2026-10-23', reason: 'Your range ^1.24.3 (server/package.json:36) already allows it.', source: 'https://www.npmjs.com/package/@modelcontextprotocol/sdk',
    }]);
  });

  it('stays quiet about libraries that have nothing to do with AI, and small gaps', () => {
    const { findings, held_back } = run([
      dependency({ name: 'express', majors_behind: 5 }),
      dependency({ name: 'rmcp', majors_behind: 1 }),
      dependency({ name: 'rig-core', status: 'git', latest: null, majors_behind: 0 }),
      dependency({ name: 'openai', status: 'no-data', latest: null, majors_behind: 0 }),
    ]);
    assert.deepEqual([findings, held_back], [[], []]);
  });
});
