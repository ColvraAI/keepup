// The plugin's gate and the pipeline have to agree on the same repo: every published finding, fed back unchanged, has to get through
// keepup verify, offline, with what ships in the plugin. A reviewer showed two answer-key findings dropped here while the website showed them.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadPinnedSources } from '../src/pinned-sources.ts';
import { knownWhere, safeRun } from '../src/pipeline.ts';
import type { Run } from '../src/run-shape.ts';
import { verifyFindings } from '../src/verify.ts';
import { buildPinnedSources } from '../scripts/pinned-sources.ts';
import { assertCloneThere, ROOT, skipWithoutClone } from './helpers.ts';

const RUNS: readonly { name: string; clone: string; commit: string }[] = [
  { name: 'anything-llm', clone: 'tmp/anything-llm', commit: '9caf2b4' },
  { name: 'aura', clone: 'tmp/aura', commit: '5efb4e8' },
  { name: 'bolt.new', clone: 'tmp/full/bolt.new', commit: 'HEAD' },
  { name: 'farfalle', clone: 'tmp/full/farfalle', commit: 'HEAD' },
];

describe('every published finding gets through keepup verify unchanged', () => {
  for (const { name, clone, commit } of RUNS) {
    it(name, { skip: skipWithoutClone(clone) }, async () => {
      assertCloneThere(clone);
      const run = JSON.parse(readFileSync(join(ROOT, 'data', 'runs', `${name}.json`), 'utf8')) as Run;
      const out = await verifyFindings(join(ROOT, clone), { findings: run.findings, watching: run.watching }, { commit });
      assert.deepEqual(out.dropped, []);
      assert.deepEqual(out.findings.map((finding) => finding.title).sort(), run.findings.map((finding) => finding.title).sort());
      assert.equal(out.watching.length, run.watching.length);
    });
  }
});

describe('db/pinned-sources.json', () => {
  it('is what data/replay holds today, so the gate reads what the pipeline read', () => {
    assert.deepEqual(loadPinnedSources(), buildPinnedSources(join(ROOT, 'data', 'replay'), join(ROOT, 'db', 'moves.json')));
  });

  it('holds what the two findings needed, and ships with the plugin', () => {
    const { sources } = loadPinnedSources();
    for (const url of ['https://crates.io/crates/rmcp', 'https://www.npmjs.com/package/@huggingface/transformers', 'https://www.npmjs.com/package/@xenova/transformers', 'https://huggingface.co/onnx-community/embeddinggemma-2-ONNX']) assert.ok(sources[url], url);
    assert.ok(Object.keys(sources).some((url) => /rmcp.*CHANGELOG/.test(url)));
  });
});

describe('a dropped place', () => {
  const files = new Map([['a.js', 'x']]);

  it('is said only if keepup really read that file', () => {
    assert.equal(knownWhere({ what: 'x', why: 'y', where: 'a.js:1' }, files).where, 'a.js:1');
    assert.equal(knownWhere({ what: 'x', why: 'y', where: '\u001b]0;pwned\u0007x.js:1' }, files).where, undefined);
    assert.equal(knownWhere({ what: 'x', why: 'y', where: 'nope.js:1' }, files).where, undefined);
  });

  it('never carries a control character into a run file', () => {
    const run = { checks: { passed: 0, dropped: [{ what: 'a', why: 'b', where: 'a\u001b.js:1' }] } } as unknown as Run;
    assert.equal(safeRun(run).checks.dropped[0].where, 'a.js:1');
  });
});
