// The demo's result is repeatable because its model answers are saved. This rebuilds each published run from data/replay,
// with no key, no network and no cost, and step 5 runs again over all of it, so a saved run that was edited by hand,
// or a finding that doesn't check out, fails here. It runs only when the clones are under tmp/.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { assertCloneThere, ROOT, skipWithoutClone } from './helpers.ts';

const RUNS: readonly { name: string; clone: string; commit: string; flags?: readonly string[] }[] = [
  { name: 'anything-llm', clone: 'tmp/anything-llm', commit: '9caf2b4' },
  { name: 'anything-llm-claude-only', clone: 'tmp/anything-llm', commit: '9caf2b4', flags: ['--provider-only', 'anthropic'] },
  { name: 'aura', clone: 'tmp/aura', commit: '5efb4e8' },
  { name: 'bolt.new', clone: 'tmp/full/bolt.new', commit: 'HEAD' },
  { name: 'farfalle', clone: 'tmp/full/farfalle', commit: 'HEAD' },
];
const COMPARED = ['repo', 'commit', 'findings', 'watching', 'held_back', 'profile', 'exact', 'rank_explanation', 'provider_only', 'db'] as const;

function replay(run: (typeof RUNS)[number], out: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'keepup.ts'), 'run', join(ROOT, run.clone), '--commit', run.commit, '--replay', '--out', out, ...(run.flags ?? [])], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: '' },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /spent 0\.0000/);
  return JSON.parse(readFileSync(out, 'utf8'));
}

describe('--replay rebuilds each published run exactly', () => {
  for (const run of RUNS) {
    it(run.name, { skip: skipWithoutClone(run.clone) }, () => {
      assertCloneThere(run.clone);
      const dir = mkdtempSync(join(tmpdir(), 'keepup-replay-'));
      try {
        const fresh = replay(run, join(dir, 'run.json'));
        const saved = JSON.parse(readFileSync(join(ROOT, 'data', 'runs', `${run.name}.json`), 'utf8'));
        for (const key of COMPARED) assert.deepEqual(fresh[key], saved[key], key);
        assert.deepEqual(fresh.checks, saved.checks);
        assert.equal(fresh.incomplete, undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
