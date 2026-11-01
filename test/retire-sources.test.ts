// Retirements come from the providers' deprecation pages as well as their changelogs, so an id the changelog
// never named still gets a warning. The page rows ship in db/patterns/PAT-retired-model-id.json.
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runPipeline } from '../src/pipeline.ts';
import { ROOT } from './helpers.ts';
import { retirements } from '../src/db.ts';
import { checkModels } from '../src/exact-checks.ts';
import { findRetirement } from '../src/retirements.ts';
import { catalogUse, type CatalogUse } from '../src/catalog-use.ts';
import { weeklyCheck } from '../src/weekly.ts';

describe('retirements()', () => {
  const all = retirements();

  it('holds what only the deprecation page names: tts-1, gpt-5.1, gpt-5.3-codex and gpt-5.4-nano', () => {
    for (const [id, date] of [['tts-1', '2027-01-06'], ['gpt-5.1', '2027-04-01'], ['gpt-5.3-codex', '2027-04-01'], ['gpt-5.4-nano', '2027-04-01'], ['gpt-4o', '2027-01-14']] as const) {
      const found = findRetirement(id, all);
      assert.ok(found, id);
      assert.equal(found.effective, date, id);
      assert.equal(found.source, 'https://developers.openai.com/api/docs/deprecations');
      assert.match(found.sentence, /shut/);
    }
  });

  it('a row with no shutdown date still gives its replacement: the page\'s own answer, for that model and no other', () => {
    const image = findRetirement('gemini-3.1-flash-image', all);
    assert.equal(image?.status, 'deprecated');
    assert.equal(image?.effective, null);
    assert.deepEqual(image?.successors, ['gemini-nano-banana-2.1']);
    assert.equal(image?.successors_from_page, true);
    assert.equal(image?.page_source, 'https://ai.google.dev/gemini-api/docs/deprecations');
    assert.deepEqual(findRetirement('gemini-2.5-flash-image', all)?.successors, ['gemini-3.1-flash-lite-image']);
    assert.equal(findRetirement('gemini-nano-banana-2.1', all), null, 'a replacement on the page is not itself going away');
  });

  it('keeps the changelog\'s own row where it has one', () => {
    const whisper = findRetirement('whisper-1', all);
    assert.equal(whisper?.source, 'https://developers.openai.com/api/docs/changelog');
    assert.equal(whisper?.announced, '2026-08-26');
  });

  it('flags a page-only id sent from production code', () => {
    const checks = checkModels([{ id: 'gpt-5.1', provider: 'openai', places: [{ file: 'src/agent.ts', line: 3, text: 'model: "gpt-5.1"', context: 'code', commented: false, route: 'direct' }] }], all, '2026-10-31');
    assert.equal(checks[0].status, 'retiring');
    assert.equal(checks[0].effective, '2027-04-01');
    assert.equal(checks[0].live_places.length, 1);
  });

  it('a Google "no earlier than" date that has passed is not stated as a shutdown', () => {
    const earliest = all.find((row) => row.earliest && row.effective && row.effective < '2026-10-31' && row.source.includes('ai.google.dev'));
    assert.ok(earliest);
    const [check] = checkModels([{ id: earliest.id as string, provider: 'google', places: [{ file: 'a.ts', line: 1, text: 'x', context: 'code', commented: false, route: 'direct' }] }], [earliest], '2026-10-31');
    assert.equal(check.status, 'deprecated');
    assert.equal(check.effective, null);
    assert.match(check.sentence, /no earlier than/);
  });
});

describe('checkModels and places that send nothing', () => {
  const retirement = { provider: 'openai' as const, id: 'gpt-5.1', name: null, status: 'retiring' as const, announced: null, effective: '2027-04-01', successors: ['gpt-6-sol'], source: 'https://x.example', sentence: 'shuts down' };
  const at = (file: string, text: string) => [{ id: 'gpt-5.1', provider: 'openai' as const, places: [{ file, line: 1, text, context: 'code' as const, commented: false, route: 'direct' as const }] }];
  const whyOf = (file: string, text: string) => checkModels(at(file, text), [retirement], '2026-10-31')[0].not_live[0]?.why ?? null;

  it('a provider that is not this model\'s maker is a gateway, by its path', () => {
    assert.equal(whyOf('server/utils/SpeechToText/lemonade/index.js', 'model = "gpt-5.1"'), 'gateway');
    assert.equal(whyOf('server/utils/AiProviders/cometapi/index.js', 'model = "gpt-5.1"'), 'gateway');
    assert.equal(whyOf('server/utils/TextToSpeech/openAiGeneric/index.js', 'model = "gpt-5.1"'), 'gateway');
    assert.equal(whyOf('server/utils/AiProviders/openai/index.js', 'model = "gpt-5.1"'), null);
  });

  it('display text sends nothing: a placeholder, a log line, a hint', () => {
    assert.equal(whyOf('a.jsx', 'placeholder="gpt-5.1"'), 'display');
    assert.equal(whyOf('a.js', 'console.log("using gpt-5.1");'), 'display');
    assert.equal(whyOf('a.rs', 'tracing::info!("using gpt-5.1");'), 'display');
    assert.equal(whyOf('a.js', 'const model = "gpt-5.1";'), null);
  });

  it('a list of refused models sends nothing', () => {
    const checks = checkModels(at('a.js', '"gpt-5.1",'), [retirement], '2026-10-31', { exclusionAt: () => true });
    assert.equal(checks[0].not_live[0]?.why, 'exclusion');
  });

  it('a JSON data file with nothing importing it sends nothing', () => {
    const use: CatalogUse = () => 'unused';
    const checks = checkModels(at('db/levers/x.json', '"models": ["gpt-5.1"]'), [retirement], '2026-10-31', { catalogUse: use });
    assert.equal(checks[0].not_live[0]?.why, 'catalog');
  });

  it('a catalog a picker reads is live, and says so', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ id: index === 0 ? 'gpt-5.1' : `gpt-${index}`, provider: 'openai' as const, places: [{ file: 'lib/models.json', line: index + 1, text: 'x', context: 'config' as const, commented: false, route: 'direct' as const }] }));
    const [check] = checkModels(many, [retirement], '2026-10-31', { catalogUse: () => 'picker' });
    assert.equal(check.live_places.length, 1);
    assert.equal(check.live_places[0].catalog, true);
  });
});

describe('catalogUse', () => {
  const files = new Map([
    ['lib/models.json', '{"models":[{"id":"gpt-5.1"}]}'],
    ['app/page.tsx', "import modelsList from '@/lib/models.json'\nexport const a = modelsList;\n"],
    ['server/modelMap/legacy.js', 'module.exports = {\n  "gpt-5.1": 128000,\n  "gpt-4.1": 128000,\n};\n'],
    ['server/modelMap/index.js', 'const legacy = require("./legacy");\n'],
    ['db/levers/x.json', '{"models":["gpt-5.1"]}'],
    ['test/picker.test.ts', "import x from '../db/levers/x.json';\n"],
    ['src/defaults.py', 'MODELS = ["gpt-5.1"]\n'],
    ['src/app.py', 'from src.defaults import MODELS\n'],
  ]);
  const use = catalogUse(files);

  it('imported by code: a picker or a lookup', () => {
    assert.equal(use('lib/models.json', ['gpt-5.1']), 'picker');
    assert.equal(use('src/defaults.py', ['gpt-5.1']), 'picker');
  });

  it('only sizes and limits: a table that picks nothing', () => {
    assert.equal(use('server/modelMap/legacy.js', ['gpt-5.1', 'gpt-4.1']), 'limits');
  });

  it('nothing but a test imports it: unused', () => {
    assert.equal(use('db/levers/x.json', ['gpt-5.1']), 'unused');
  });
});

describe('exclusionLookup and caseLookup', () => {
  it('a list that closes with .includes(model) === false is a refusal', async () => {
    const { exclusionLookup, caseLookup } = await import('../src/catalog-use.ts');
    const files = new Map([
      ['a.jsx', 'return (\n  [\n    "gpt-3.5-turbo-0301",\n    "o1-mini",\n  ].includes(model) === false\n);\nconst ok = ["gpt-4"].includes(model);\n'],
      ['b.js', 'switch (p) {\n  case "cometapi":\n    return x ?? "gpt-5-mini";\n  case "openai":\n    return "gpt-4o";\n}\n'],
    ]);
    const excluded = exclusionLookup(files);
    assert.equal(excluded('a.jsx', 3), true);
    assert.equal(excluded('a.jsx', 7), false);
    const caseAt = caseLookup(files);
    assert.equal(caseAt('b.js', 3), 'cometapi');
    assert.equal(caseAt('b.js', 5), 'openai');
    assert.equal(caseAt('b.js', 1), null);
  });
});

describe('real picker case: e2b-dev/fragments', { skip: !existsSync(join(ROOT, 'tmp', 'full', 'fragments')) && 'no clone' }, () => {
  it('its model list is a picker, so its retired ids are a finding, not held back', async () => {
    const run = await runPipeline(join(ROOT, 'tmp', 'full', 'fragments'), { commit: '3b11c7f' });
    const picker = run.findings.find((finding) => finding.where.some((place) => place.file === 'lib/models.json'));
    assert.ok(picker, run.findings.map((finding) => finding.title).join(' | '));
    assert.ok(!run.held_back.some((row) => /lib\/models\.json/.test(row.thing)));
    assert.match(picker.why, /lib\/models\.json feeds a picker/);
    const brief = run.findings.find((finding) => finding.where.some((place) => place.file === 'app/page.tsx' && place.line === 35));
    assert.ok(brief, 'the default model at app/page.tsx:35');
    assert.equal(brief.deadline !== null, true);
  });
});

describe('the weekly line on real repos', { skip: !existsSync(join(ROOT, 'tmp', 'full', 'fragments')) && 'no clone' }, () => {
  const fragments = join(ROOT, 'tmp', 'full', 'fragments');

  it('never says nothing applies on a repo with a model about to die', async () => {
    const result = await weeklyCheck(fragments, { commit: 'HEAD', asOf: '2026-11-01' });
    assert.ok(result.going_away.some((check) => check.model === 'claude-sonnet-4-5-20250929'));
    assert.match(result.line, /^keepup: \d+ models? you use /);
    assert.ok(!/no model you use/.test(result.line));
    assert.equal(result.line.split('\n').length, 1);
  });

  it('on first sight, it counts models going later too', async () => {
    const later = await weeklyCheck(join(ROOT, 'tmp', 'anything-llm'), { commit: '9caf2b4', asOf: '2026-11-01', firstSight: true });
    assert.ok(later.going_away.some((check) => check.model === 'whisper-1'));
    const usual = await weeklyCheck(join(ROOT, 'tmp', 'anything-llm'), { commit: '9caf2b4', asOf: '2026-11-01' });
    assert.ok(!usual.going_away.some((check) => check.model === 'whisper-1'));
  });
});
