// Proof of the scan's skip fields and literal gate on real code at pinned commits, with the real db/patterns.
// Runs only when the clones and the patterns exist. Written as properties, not counts, because the
// patterns keep growing: these must hold whatever the database says.
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { listRepoFiles, type RepoFile } from '../src/git-files.ts';
import { matchesAnyGlob } from '../src/glob.ts';
import { OPEN_GATE } from '../src/regex-literals.ts';
import { loadPatterns, type Pattern, scanFiles } from '../src/scan.ts';
import { loadSignals, runSignals } from '../src/signals.ts';
import { ROOT } from './helpers.ts';

const CLONES = [
  { name: 'AnythingLLM', path: join(ROOT, 'tmp', 'anything-llm'), commit: '9caf2b4' },
  { name: 'AURA', path: join(ROOT, 'tmp', 'aura'), commit: '5efb4e8' },
];
const haveAll = CLONES.every((clone) => existsSync(clone.path)) && existsSync(join(ROOT, 'db', 'patterns'));
const skip = haveAll ? false : 'needs the clones under tmp/ and db/patterns';
const SAMPLE_EVERY = 5;

const ungated = (patterns: readonly Pattern[]): Pattern[] => patterns.map((pattern) => ({
  ...pattern,
  find: pattern.find.map((rule) => ({ ...rule, gate: OPEN_GATE })),
}));
const key = (hit: { pattern: string; file: string; line: number }) => `${hit.pattern} ${hit.file}:${hit.line}`;

describe('the scan on real code', { skip }, () => {
  let patterns: Pattern[];
  let repos: { name: string; files: readonly RepoFile[] }[];
  before(() => {
    patterns = loadPatterns();
    repos = CLONES.map((clone) => ({ name: clone.name, files: listRepoFiles(clone.path, { commit: clone.commit }).files }));
  });
  const sampleOf = (files: readonly RepoFile[]) => files.filter((_, index) => index % SAMPLE_EVERY === 0);

  it('the gate changes speed and nothing else: the same hits with and without it', () => {
    for (const { name, files } of repos) {
      const sample = sampleOf(files);
      assert.deepEqual(scanFiles(sample, patterns), scanFiles(sample, ungated(patterns)), name);
    }
  });

  it('the gate changes nothing for the signals either', () => {
    const spec = loadSignals();
    const open = spec.signals.map((signal) => ({ ...signal, gate: OPEN_GATE }));
    for (const { name, files } of repos) {
      const sample = sampleOf(files);
      assert.deepEqual(runSignals(sample, spec), runSignals(sample, spec, open), name);
    }
  });

  it('no hit lands in a file its pattern skips', () => {
    const byId = new Map(patterns.map((pattern) => [pattern.id, pattern]));
    for (const { files } of repos) {
      for (const hit of scanFiles(files, patterns).hits) {
        assert.ok(!matchesAnyGlob(hit.file, byId.get(hit.pattern)?.skipFiles ?? []), key(hit));
      }
    }
  });

  it('the two fields only ever remove hits', () => {
    const plain = patterns.map((pattern) => ({ ...pattern, skipFiles: [], skipIfInFile: [] }));
    for (const { name, files } of repos) {
      const without = new Set(scanFiles(files, plain).hits.map(key));
      for (const hit of scanFiles(files, patterns).hits) assert.ok(without.has(key(hit)), `${name}: ${key(hit)}`);
    }
  });

  it('skip_files really drops hits on real code, in both repos', () => {
    const plain = patterns.map((pattern) => ({ ...pattern, skipFiles: [] }));
    for (const { name, files } of repos) {
      assert.ok(scanFiles(files, plain).hits.length > scanFiles(files, patterns).hits.length, name);
    }
  });

  it('skip_if_in_file alone drops the call in the Anthropic provider, whose cache setting is out of skip_if_near\'s reach', () => {
    const file = repos[0].files.filter((f) => f.path === 'server/utils/AiProviders/anthropic/index.js');
    const caching = patterns.filter((pattern) => pattern.id === 'PAT-prompt-caching-off').map((pattern) => ({ ...pattern, skipIfNear: [] }));
    assert.ok(caching[0].skipIfInFile.length > 0, 'the pattern should use the field');
    assert.deepEqual(scanFiles(file, caching).hits, []);
    assert.ok(scanFiles(file, caching.map((pattern) => ({ ...pattern, skipIfInFile: [] }))).hits.length > 0);
  });

  it('AnythingLLM: no retired-model hit in server/__tests__, and no caching hit in the Anthropic provider', () => {
    const { hits } = scanFiles(repos[0].files, patterns);
    assert.deepEqual(hits.filter((hit) => hit.pattern === 'PAT-retired-model-id' && hit.file.startsWith('server/__tests__/')).map(key), []);
    assert.deepEqual(hits.filter((hit) => hit.pattern === 'PAT-prompt-caching-off' && hit.file === 'server/utils/AiProviders/anthropic/index.js').map(key), []);
  });
});
