import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readObjects } from '../src/objects.ts';
import { createPrDeps, openOrUpdate } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import type { FakeRun } from './fake-github.ts';
import { world } from './pr-world.ts';
import { ORG } from './world.ts';

export function testRun(conclusion: string, file = 'run-tests.yaml', created = '2026-11-01T09:00:00Z'): FakeRun {
  return { id: 1, name: file, path: `.github/workflows/${file}`, event: 'pull_request', status: 'completed', conclusion, html_url: `https://github.com/x/actions/${file}`, run_number: 1, created_at: created };
}

test('wait-ci records success only when every check says so', async () => {
  const w = await world();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = [
    { name: 'tests', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/runs/1', details_url: 'https://github.com/x/runs/1' },
    { name: 'lint', status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/x/runs/2', details_url: 'https://github.com/x/runs/2' },
  ];
  fork.runs = [testRun('success')];
  const outcome = await w.run({ waitCi: true });
  assert.deepEqual(outcome.ci, { state: 'success', url: 'https://github.com/x/runs/1' });
  assert.deepEqual(readObjects(w.root).prs['06'].ci, { state: 'success', url: 'https://github.com/x/runs/1' });
});

test('wait-ci polls until checks finish, within a bound', async () => {
  const w = await world();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = [{ name: 'tests', status: 'in_progress', conclusion: null, html_url: 'https://github.com/x/runs/1', details_url: 'https://github.com/x/runs/1' }];
  let polls = 0;
  const deps = createPrDeps(w.root, w.env, {
    sleep: async () => {
      polls += 1;
      if (polls === 2) fork.checks = [{ ...fork.checks[0], status: 'completed', conclusion: 'failure' }];
    },
  });
  const outcome = await openOrUpdate(findSpec('06', w.root), { waitCi: true }, deps);
  assert.equal(polls, 2);
  assert.deepEqual(outcome.ci, { state: 'failure', url: 'https://github.com/x/runs/1' });
});

test('wait-ci stops at its timeout, and never turns silence into success', async () => {
  const w = await world();
  let clock = 0;
  const deps = createPrDeps(w.root, w.env, { sleep: async () => { clock += 60_000; }, nowMs: () => clock, ciTimeoutMs: 120_000 });
  const outcome = await openOrUpdate(findSpec('06', w.root), { waitCi: true }, deps);
  assert.equal(outcome.ci.state, 'none');
  assert.equal(outcome.ciTimedOut, true);
  assert.equal(readObjects(w.root).prs['06'].ci.state, 'none');
});

test('all-skipped checks and a pending commit status are not success', async () => {
  const w = await world();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = [{ name: 'x', status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/x/1', details_url: 'https://github.com/x/1' }];
  assert.equal((await w.run()).ci.state, 'neutral');
  fork.checks = [{ name: 'x', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/1', details_url: 'https://github.com/x/1' }];
  fork.statuses = [{ state: 'pending', target_url: 'https://ci.example/1', context: 'ci' }];
  assert.equal((await w.run()).ci.state, 'pending');
  fork.statuses = [{ state: 'failure', target_url: 'https://ci.example/1', context: 'ci' }];
  assert.deepEqual((await w.run()).ci, { state: 'failure', url: 'https://ci.example/1' });
});
