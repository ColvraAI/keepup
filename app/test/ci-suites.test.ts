// A commit's checks, in the shape GitHub really returns them: a new event makes a new check suite,
// and the older suite's check runs stay listed under filter=latest.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readCi, waitForCi } from '../src/ci.ts';
import { createPrDeps, type PrDeps } from '../src/pr.ts';
import type { FakeCheckRun, FakeRun } from './fake-github.ts';
import { createWorld, ORG, type World } from './world.ts';

const quick = (over: Partial<PrDeps> = {}) => ({ sleep: async () => undefined, ...over });

function checkRun(name: string, conclusion: string | null, suite: number, url = `https://github.com/x/check/${suite}`): FakeCheckRun {
  return { name, status: conclusion ? 'completed' : 'in_progress', conclusion, html_url: url, details_url: url, check_suite: { id: suite } };
}

function workflowRun(id: number, file: string, conclusion: string | null, suite: number, status = conclusion ? 'completed' : 'in_progress'): FakeRun {
  return { id, name: file, path: `.github/workflows/${file}`, event: 'pull_request', status, conclusion, html_url: `https://github.com/x/runs/${id}`, run_number: id, created_at: `2026-11-01T0${id}:00:00Z`, check_suite_id: suite };
}

async function readWith(w: World, checks: FakeCheckRun[], runs: FakeRun[]) {
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = checks;
  fork.runs = runs;
  return readCi(createPrDeps(w.root, w.env, quick()).octokit, ORG, 'anything-llm', w.fix.mainTip);
}

test('a passing rerun clears the failure from the older suite, which GitHub still lists', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('tests', 'failure', 10), checkRun('tests', 'success', 20)],
    [workflowRun(1, 'run-tests.yaml', 'failure', 10), workflowRun(2, 'run-tests.yaml', 'success', 20)]);
  assert.deepEqual(ci, { state: 'success', url: 'https://github.com/x/check/20' });
});

test('the list order does not matter: GitHub lists the newest run first', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('tests', 'success', 20), checkRun('tests', 'failure', 10)],
    [workflowRun(2, 'run-tests.yaml', 'success', 20), workflowRun(1, 'run-tests.yaml', 'failure', 10)]);
  assert.equal(ci.state, 'success');
});

test('a run cancelled by a reopen does not count against the run that replaced it', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('tests', 'cancelled', 10), checkRun('tests', 'success', 20)],
    [workflowRun(1, 'run-tests.yaml', 'cancelled', 10), workflowRun(2, 'run-tests.yaml', 'success', 20)]);
  assert.equal(ci.state, 'success');
});

test('the newest run failing is still a failure, even when an older one passed', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('tests', 'success', 10), checkRun('tests', 'failure', 20)],
    [workflowRun(1, 'run-tests.yaml', 'success', 10), workflowRun(2, 'run-tests.yaml', 'failure', 20)]);
  assert.deepEqual(ci, { state: 'failure', url: 'https://github.com/x/check/20' });
});

test('a red check from another app, in a suite no run owns, is never dropped', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('outside', 'failure', 99), checkRun('tests', 'success', 20)],
    [workflowRun(2, 'run-tests.yaml', 'success', 20)]);
  assert.equal(ci.state, 'failure');
});

test('another workflow failing in its newest run still fails the commit', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('lint', 'failure', 30), checkRun('tests', 'success', 20)],
    [workflowRun(3, 'lint.yaml', 'failure', 30), workflowRun(2, 'run-tests.yaml', 'success', 20)]);
  assert.equal(ci.state, 'failure');
});

test('lint passed and the tests are still queued with no check run: pending, naming the queued run', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('changes', 'success', 30)],
    [workflowRun(3, 'lint.yaml', null, 30), workflowRun(4, 'run-tests.yaml', null, 40, 'queued')]);
  assert.deepEqual(ci, { state: 'pending', url: 'https://github.com/x/runs/4' });
});

test('every check passed but the required workflow is still running: pending, with its run', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('lint', 'success', 30)],
    [workflowRun(3, 'lint.yaml', 'success', 30), workflowRun(4, 'run-tests.yaml', null, 40, 'queued')]);
  assert.deepEqual(ci, { state: 'pending', url: 'https://github.com/x/runs/4' });
});

test('the required run finishing without success is final: neutral', async () => {
  const w = await createWorld();
  const ci = await readWith(w,
    [checkRun('lint', 'success', 30)],
    [workflowRun(3, 'lint.yaml', 'success', 30), workflowRun(4, 'run-tests.yaml', 'skipped', 40)]);
  assert.equal(ci.state, 'neutral');
});

const waiting = (sleep: () => void) => {
  let clock = 0;
  return { timeoutMs: 20 * 60_000, noneTimeoutMs: 3 * 60_000, pollMs: 30_000, nowMs: () => clock, sleep: async (ms: number) => { clock += ms; sleep(); }, elapsed: () => clock };
};

test('--wait-ci does not call it over while the tests have not started', async () => {
  const w = await createWorld();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = [checkRun('changes', 'success', 30)];
  fork.runs = [workflowRun(3, 'lint.yaml', 'success', 30), workflowRun(4, 'run-tests.yaml', null, 40, 'queued')];
  let polls = 0;
  const opts = waiting(() => {
    polls += 1;
    if (polls === 2) {
      fork.checks = [checkRun('changes', 'success', 30), checkRun('tests', 'success', 40)];
      fork.runs = [workflowRun(3, 'lint.yaml', 'success', 30), workflowRun(4, 'run-tests.yaml', 'success', 40)];
    }
  });
  const { ci, timedOut } = await waitForCi(createPrDeps(w.root, w.env, quick()).octokit, ORG, 'anything-llm', w.fix.mainTip, opts);
  assert.equal(polls, 2);
  assert.equal(timedOut, false);
  assert.equal(ci.state, 'success');
});

test('--wait-ci gives a test workflow with no run yet a bounded time to appear, then says neutral', async () => {
  const w = await createWorld();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = [checkRun('changes', 'success', 30)];
  fork.runs = [workflowRun(3, 'lint.yaml', 'success', 30)];
  const opts = waiting(() => undefined);
  const { ci, timedOut } = await waitForCi(createPrDeps(w.root, w.env, quick()).octokit, ORG, 'anything-llm', w.fix.mainTip, opts);
  assert.equal(ci.state, 'neutral', 'a paths filter can mean it never comes, so this has an end');
  assert.equal(timedOut, false);
  assert.equal(opts.elapsed(), 3 * 60_000);
});

test('--wait-ci takes the run if it appears during that time', async () => {
  const w = await createWorld();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = [checkRun('changes', 'success', 30)];
  fork.runs = [workflowRun(3, 'lint.yaml', 'success', 30)];
  let polls = 0;
  const opts = waiting(() => {
    polls += 1;
    if (polls === 1) fork.runs = [...fork.runs, workflowRun(4, 'run-tests.yaml', 'success', 40)];
  });
  const { ci } = await waitForCi(createPrDeps(w.root, w.env, quick()).octokit, ORG, 'anything-llm', w.fix.mainTip, opts);
  assert.equal(ci.state, 'success');
  assert.equal(polls, 1);
});
