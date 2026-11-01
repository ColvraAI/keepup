// A review changed one fact at a time in a copy of the saved runs, and these used to get past the tests on a fresh checkout.
// Each mutation here has to be caught with no clones and no network, by the same helpers test/acceptance.test.ts uses.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Finding, Run } from '../src/run-shape.ts';
import { ROOT } from './helpers.ts';
import { keyViolations } from './answer-key.ts';
import { knownSource, misstatedModelDates, unreadableNumbers } from './run-provenance.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const load = (name: string): Run => JSON.parse(readFileSync(join(ROOT, 'data', 'runs', `${name}.json`), 'utf8')) as Run;
const allm = load('anything-llm');
const aura = load('aura');
const find = (run: Run, part: RegExp): Finding => {
  const found = run.findings.find((finding) => part.test(`${finding.title} ${finding.sources.join(' ')}`));
  assert.ok(found, String(part));
  return found;
};
const edited = (finding: Finding, from: RegExp | string, to: string): Finding => ({ ...finding, why: finding.why.replace(from, to), title: finding.title.replace(from, to) });

describe('a changed fact is caught with no clones', () => {
  for (const [label, run, part, from, to] of [
    ['the Gemini date', allm, /gemini-2\.0-flash-lite/, '1 Jun 2026', '1 Jul 2026'],
    ['the tts date', allm, /tts-1/, '6 Jan 2027', '6 Jan 2028'],
    ['the 8K context', allm, /EmbeddingGemma/, '8K', '80K'],
    ['the Claude date', aura, /Anthropic models/, '15 Jun 2026', '15 Jul 2026'],
    ['the caching multiplier', aura, /prompt caching/i, '0.05x', '0.5x'],
    ['the rmcp release date', aura, /rmcp/, '26 Oct 2026', '26 Oct 2027'],
  ] as const) {
    it(label, () => {
      const finding = find(run, part);
      assert.deepEqual(unreadableNumbers(run, finding), [], 'the saved run reads clean');
      assert.ok(finding.why.includes(from) || finding.title.includes(from), `${from} is in the saved run`);
      const changed = edited(finding, from, to);
      assert.notDeepEqual([...unreadableNumbers(run, changed), ...misstatedModelDates(run, changed)], []);
    });
  }

  it('a retirement dropped from the run', () => {
    const placed = new Set(allm.findings.filter((finding) => !/gemini-2\.0-flash-lite/.test(finding.title)).flatMap((finding) => finding.where.map((place) => `${place.file}:${place.line}`)));
    const missing = allm.exact.flatMap((check) => (check.kind === 'model' && !check.routed_to ? check.live_places.filter((place) => !placed.has(`${place.file}:${place.line}`)) : []));
    assert.ok(missing.some((place) => place.file === 'server/models/systemSettings.js'), 'deleting the Gemini finding leaves its places uncovered');
  });

  it('an invented price', () => {
    const finding = find(allm, /router/i);
    assert.notDeepEqual(unreadableNumbers(allm, { ...finding, why: `${finding.why} It costs $9.99 per million tokens.` }), []);
  });

  it('a made-up source', () => {
    assert.equal(knownSource('https://example.com/made-up'), false);
    for (const finding of allm.findings) for (const url of finding.sources) assert.ok(knownSource(url), url);
  });
});

describe('the key catches a wrong finding, not only a missing one', () => {
  const NAME = { allm: 'anything-llm', aura: 'aura' } as const;
  const on = (run: Run, part: RegExp, change: (finding: Finding) => Finding): Run => {
    const found = find(run, part);
    return { ...run, findings: run.findings.map((finding) => (finding === found ? change(finding) : finding)) };
  };
  const swap = (from: RegExp | string, to: string) => (finding: Finding): Finding => ({ ...finding, why: finding.why.replace(from, to) });
  const named = (finding: Finding, from: RegExp | string, to: string): Finding => ({ ...finding, options: finding.options.map((option) => ({ ...option, name: option.name.replace(from, to), what: option.what.replace(from, to) })) });
  const CASES: readonly (readonly [string, string, Run])[] = [
    ['an invented finding at the right rank', NAME.aura, { ...aura, findings: [{ ...aura.findings[0], title: 'Swap Qdrant for Weaviate', where: [{ file: 'Cargo.toml', line: 1, text: 'x' }], locked: undefined }, ...aura.findings] }],
    ['the MCP proof', NAME.aura, on(aura, /Sentry/, (finding) => ({ ...finding, proof: 'vendor claim' }))],
    ['the aura Gemini proof', NAME.aura, on(aura, /gemini-2\.0-flash/, (finding) => ({ ...finding, proof: 'adoption only' }))],
    ['the gpt-4o proof', NAME.aura, on(aura, /gpt-4o/, (finding) => ({ ...finding, proof: 'projected' }))],
    ['the gpt-4o effect', NAME.aura, on(aura, /gpt-4o/, (finding) => ({ ...finding, effect: ['better answers'] }))],
    ['#7\'s effect', NAME.allm, on(allm, /3 Google models/, (finding) => ({ ...finding, effect: ['cheaper'] }))],
    ['cheaper added to the MCP finding', NAME.aura, on(aura, /Sentry/, (finding) => ({ ...finding, effect: [...finding.effect, 'cheaper'] }))],
    ['better answers added to caching', NAME.aura, on(aura, /prompt caching/i, (finding) => ({ ...finding, effect: [...finding.effect, 'better answers'] }))],
    ['a wrong successor for aura Gemini', NAME.aura, on(aura, /gemini-2\.0-flash/, swap('Named successor: gemini-3.6-flash', 'Named successor: gemini-3.1-flash-lite'))],
    ['a wrong successor for gpt-4o', NAME.aura, on(aura, /gpt-4o/, swap('Named successor: gpt-6-luna', 'Named successor: gpt-6-sol'))],
    ['a wrong successor for #7', NAME.allm, on(allm, /3 Google models/, swap('Named successor: gemini-nano-banana-2.1', 'Named successor: gemini-3.1-flash-lite-image'))],
    ['#7\'s option given to the wrong model', NAME.allm, on(allm, /3 Google models/, (finding) => named(finding, 'replacement for gemini-3.1-flash-image', 'replacement for gemini-2.5-flash-image'))],
    ['a wrong successor for gemini-3-pro-image', NAME.allm, on(allm, /gemini-2\.0-flash-lite/, swap('Named successor: gemini-3-pro-image', 'Named successor: gemini-nano-banana-2.1'))],
    ['Indra rewritten as MIT with an npm package', NAME.allm, { ...allm, watching: allm.watching.map((row) => (/indra/.test(row.thing) ? { ...row, why: 'It is MIT-licensed and ships as an npm package.' } : row)) }],
    ['"This is a vendor claim" taken off the TypeSafe option', NAME.allm, on(allm, /router/i, (finding) => ({ ...finding, options: finding.options.map((option) => ({ ...option, what: option.what.replace('This is a vendor claim', 'It is proven') })) }))],
    ['rmcp\'s declared version', NAME.aura, on(aura, /rmcp/, swap('0.12.0', '0.2.0'))],
    ['a held row citing a file that isn\'t there', NAME.allm, { ...allm, held_back: [...allm.held_back, { thing: 'gpt-4o, a retiring model, in server/nope.js:12', date: null, reason: 'x', source: null }] }],
    ['the profile\'s prose', NAME.aura, { ...aura, profile: { ...(aura.profile as NonNullable<Run['profile']>), one_liner: 'A chat app.' } }],
    ['the stack lock emptied', NAME.aura, { ...aura, profile: { ...(aura.profile as NonNullable<Run['profile']>), stack_lock: [] } }],
    ['the database total', NAME.aura, { ...aura, db: { ...aura.db, records: 99_999 } }],
    ['a finding dropped', NAME.aura, { ...aura, findings: aura.findings.slice(1) }],
  ];

  it('the saved runs read clean', () => {
    assert.deepEqual(keyViolations('anything-llm', allm), []);
    assert.deepEqual(keyViolations('aura', aura), []);
  });

  for (const [label, name, changed] of CASES) {
    it(label, () => assert.notDeepEqual(keyViolations(name, changed), [], label));
  }
});

describe('a hand edit to a published run', () => {
  const HASHES = join(ROOT, 'test', 'golden', 'published-runs.json');
  const hashes = JSON.parse(readFileSync(HASHES, 'utf8')) as Record<string, string>;

  it('every published run matches its committed hash', () => {
    for (const name of readdirSync(join(ROOT, 'data', 'runs')).filter((file) => file.endsWith('.json'))) {
      assert.equal(sha256(readFileSync(join(ROOT, 'data', 'runs', name))), hashes[name], `${name}: if this was on purpose, a person re-reads the key and runs npm run pin-replay -- --derived-only`);
    }
    assert.deepEqual(Object.keys(hashes).sort(), readdirSync(join(ROOT, 'data', 'runs')).filter((file) => file.endsWith('.json')).sort());
  });

  it('changing one character changes the hash', () => {
    const bytes = readFileSync(join(ROOT, 'data', 'runs', 'aura.json'), 'utf8');
    assert.notEqual(sha256(Buffer.from(bytes.replace('"vendor claim"', '"vendor Claim"'))), hashes['aura.json']);
  });
});
