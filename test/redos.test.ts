// Every signal and pattern, against lines built to make a regex backtrack, each under the longest line a scan reads.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { listRepoFiles } from '../src/git-files.ts';
import { MASK_REGEXES } from '../src/mask.ts';
import { buildFacts } from '../src/facts.ts';
import { parseManifest } from '../src/manifests.ts';
import { loadPatterns } from '../src/scan.ts';
import { loadSignals, MAX_LINE_CHARS, runSignals } from '../src/signals.ts';
import { git } from './helpers.ts';

const LENGTH = MAX_LINE_CHARS - 10;
const PER_REGEX_MS = 150;
const fill = (head: string, unit: string) => head + unit.repeat(Math.ceil((LENGTH - head.length) / unit.length)).slice(0, LENGTH - head.length);
const ADVERSARIAL: readonly string[] = [
  fill('("', 'pass'), fill('set', 'pwd'), fill('-----BEGIN PRIVATE KEY-----', ' '), fill('key', ' '), fill('key=', ' '), fill('', '-_'),
  fill('while', ' '), fill('while(', ' '), fill('JSON.parse(', 'a'), fill('JSON.parse(', 'a.'), fill('json.loads(', '[a]'), fill('', ' '), fill('', 'a'), fill('', 'a.'), fill('', '"'), fill('', '\\'),
  fill('', 'a '), fill('', '- '), fill('', '<a '), fill('return', ' '), fill('def ', '_'), fill('', '('), fill('for x in range(', ' '), fill('', '`'), fill('role:', ' '), fill('model=', ' '),
];

function assertFast(re: RegExp, label: string): void {
  for (const line of ADVERSARIAL) {
    const started = performance.now();
    re.test(line);
    const took = performance.now() - started;
    assert.ok(took < PER_REGEX_MS, `${label} took ${Math.round(took)} ms on ${JSON.stringify(line.slice(0, 20))}`);
  }
}

describe('regex denial of service', () => {
  const spec = loadSignals();
  for (const signal of [...spec.signals, ...spec.strict]) it(`signal ${signal.name}`, () => assertFast(signal.re, signal.name));
  for (const pattern of loadPatterns()) {
    it(`pattern ${pattern.id}`, () => {
      for (const rule of pattern.find) assertFast(rule.re, pattern.id);
      for (const re of [...pattern.skipIfNear, ...pattern.skipIfInFile]) assertFast(re, `${pattern.id} skip`);
    });
  }

  for (const [name, re] of Object.entries(MASK_REGEXES)) it(`mask ${name}`, () => assertFast(re, `mask ${name}`));

  it('a scan stops at its time budget', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ path: `src/f${index}.py`, text: 'x = 1\n' }));
    assert.deepEqual(runSignals(files, spec, spec.signals, 4, -1), {});
  });
});

describe('a tiny repo can\'t make a run explode', () => {
  it('many names for one blob stop at the read budget, and it says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-bomb-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'a.txt'), 'x'.repeat(1024));
      const blob = git(dir, 'hash-object', '-w', 'a.txt');
      const index = Array.from({ length: 300 }, (_, i) => `100644 ${blob} 0\tf${i}.txt`).join('\n');
      execFileSync('git', ['update-index', '--index-info'], { cwd: dir, input: `${index}\n` });
      git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'bomb');
      const listed = listRepoFiles(dir, { commit: 'HEAD', maxTotalBytes: 10 * 1024 });
      assert.equal(listed.files.length, 10);
      assert.equal(listed.skipped.over_budget, 290);
      const capped = listRepoFiles(dir, { commit: 'HEAD', maxTotalFiles: 5 });
      assert.equal(capped.files.length, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a manifest of 60,000 dependencies stays fast and capped', () => {
    const big = JSON.stringify({ dependencies: Object.fromEntries(Array.from({ length: 60_000 }, (_, i) => [`pkg-${i}`, '^1.0.0'])) }, null, 1);
    const started = performance.now();
    const manifest = parseManifest('package.json', big);
    assert.ok(performance.now() - started < 3000);
    assert.equal(manifest?.dependencies.length, 3000);
    assert.equal(manifest?.dependencies[10].line, 13);
  });

  it('a file of 80,000 distinct model names stays fast', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-ids-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'a.py'), Array.from({ length: 80_000 }, (_, i) => `x${i} = "gpt-${i}"`).join('\n'));
      git(dir, 'add', '-A');
      git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'ids');
      const started = performance.now();
      const facts = buildFacts(dir, { commit: 'HEAD' });
      assert.ok(performance.now() - started < 40_000, 'it finished');
      assert.equal(facts.model_ids.length, 3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
