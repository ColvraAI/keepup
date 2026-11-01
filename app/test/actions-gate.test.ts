// The fork's Actions gate and the workflows on a replay base, against the fake's model of what real forks do.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { exitForCi, ciCause } from '../src/cli/pr.ts';
import { readCi, summarise, waitForCi } from '../src/ci.ts';
import { readObjects, updateObjects } from '../src/objects.ts';
import { createPrDeps, openOrUpdate, type PrOutcome } from '../src/pr.ts';
import { checkActions, rerunCi } from '../src/pr-gate.ts';
import { findSpec } from '../src/specs.ts';
import { computeStatus, formatStatus } from '../src/status.ts';
import { pressActionsButton, registerByDefaultBranchPush } from './fake-actions.ts';
import { git } from './fake-repos.ts';
import { allmWorld, aura, auraWorld, open, quick } from './aura-world.ts';
import { createWorld, ORG } from './world.ts';

test('a pull request opened with the gate closed gets no run, and pressing the button replays nothing', async () => {
  const w = await auraWorld(false);
  await open(w, '04');
  const repo = aura(w);
  assert.equal(repo.pulls.length, 1);
  assert.deepEqual(repo.runs, []);
  await pressActionsButton(repo);
  assert.deepEqual(repo.runs, [], 'opening the gate does not replay the event');
  assert.equal((await checkActions(findSpec('04', w.root), createPrDeps(w.root, w.env, quick({ gateWindowMs: 30_000 })))).running, false);
});

test('--rerun-ci closes and reopens, which fires the one event that can bring CI back', async () => {
  const w = await auraWorld(false);
  await open(w, '04');
  const repo = aura(w);
  await pressActionsButton(repo);
  const spec = findSpec('04', w.root);
  const deps = createPrDeps(w.root, w.env, quick());
  const pull = await rerunCi(spec, deps);
  assert.equal(pull.number, repo.pulls[0].number);
  assert.equal(repo.pulls[0].state, 'open');
  assert.deepEqual(w.fake.requests.filter((r) => r.method === 'PATCH').map((r) => (r.body as { state: string }).state), ['closed', 'open']);
  assert.deepEqual(repo.runs.map((r) => r.name), ['keepup-ci.yml']);
  assert.equal((await checkActions(spec, deps)).running, true);
  assert.equal((await readCi(deps.octokit, ORG, 'aura', repo.pulls[0].headSha)).state, 'success');
});

test('--rerun-ci refuses what is not open, and says plainly if it could not reopen', async () => {
  const w = await auraWorld();
  await open(w, '04');
  const repo = aura(w);
  repo.pulls[0].state = 'closed';
  repo.pulls[0].merged_at = '2026-11-01T00:00:00Z';
  const spec = findSpec('04', w.root);
  await assert.rejects(rerunCi(spec, createPrDeps(w.root, w.env, quick())), /no open pull request.*merged/);
  repo.pulls[0].state = 'open';
  repo.pulls[0].merged_at = null;
  w.fake.failNextReopen = true;
  await assert.rejects(rerunCi(spec, createPrDeps(w.root, w.env, quick())), /couldn't be reopened\. Reopen it by hand/);
});

test('--rerun-ci never touches a person\'s pull request, even on the spec\'s own branch', async () => {
  const w = await auraWorld();
  await open(w, '04');
  const repo = aura(w);
  repo.pulls[0].user = 'a-person';
  const writes = w.fake.writeRequests().length;
  await assert.rejects(rerunCi(findSpec('04', w.root), createPrDeps(w.root, w.env, quick())), /no open pull request/);
  assert.deepEqual(w.fake.writeRequests().slice(writes).filter((r) => r.method === 'PATCH'), []);
  assert.equal(repo.pulls[0].state, 'open');
});

test('--check-actions gives up after its window, and finds a run as soon as one exists', async () => {
  const w = await auraWorld(false);
  await open(w, '04');
  const spec = findSpec('04', w.root);
  let clock = 0;
  let polls = 0;
  const closed = await checkActions(spec, createPrDeps(w.root, w.env, { gateWindowMs: 90_000, gatePollMs: 10_000, nowMs: () => clock, sleep: async (ms) => { clock += ms; polls += 1; } }));
  assert.equal(closed.running, false);
  assert.equal(polls, 9, 'about 90 seconds, then it stops');
  const repo = aura(w);
  await pressActionsButton(repo);
  polls = 0;
  await checkActions(spec, createPrDeps(w.root, w.env, { gateWindowMs: 90_000, gatePollMs: 10_000, nowMs: () => clock, sleep: async (ms) => {
    clock += ms;
    polls += 1;
    if (polls === 2) repo.runs = [{ id: 1, name: 't', path: '.github/workflows/keepup-ci.yml', event: 'pull_request', status: 'queued', conclusion: null, head_sha: repo.pulls[0].headSha, html_url: 'https://github.com/x', run_number: 1, created_at: 'x' }];
  } }));
  assert.equal(polls, 2);
});

test('a default-branch push makes workflows read active with the gate still closed, and status still tells the truth', async () => {
  const w = await auraWorld(false);
  allmWorld(w, true);
  const repo = aura(w);
  await registerByDefaultBranchPush(repo);
  assert.ok(repo.workflows.length > 0 && repo.workflows.every((x) => x.state === 'active'));
  await open(w, '04');
  const later = () => Date.now() + 5 * 60_000;
  const status = await computeStatus({ root: w.root, env: w.env, live: true, nowMs: later });
  const line = status.actions?.find((a) => a.fork === 'aura');
  assert.equal(line?.ok, false);
  assert.match(line?.detail ?? '', /Actions isn't running: no workflow run on any of 1 open pull request \(04\)/);
  assert.match(line?.detail ?? '', /I understand my workflows/);
  assert.match(status.next.command, /fix Actions on anything-llm|fix Actions on aura/);
});

test('status --live says it can\'t tell before a pull request exists, and never claims the workflows are right', async () => {
  const w = await auraWorld(false);
  const status = await computeStatus({ root: w.root, env: w.env, live: true });
  const lines = status.actions ?? [];
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.ok, false);
    assert.match(line.detail, /The API can't tell until a pull request exists/);
  }
  assert.ok(!formatStatus(status).includes('the right workflows are on'));
  assert.equal(status.next.command, 'npm run go', 'nothing can clear that line but opening the first pull request');
});

test('a stray workflow is a note: it clears nothing and blocks nothing, and npm run go stays the next step', async () => {
  const w = await auraWorld(true);
  const repo = aura(w);
  repo.workflows = [{ id: 2, name: 'cla', path: '.github/workflows/cla.yml', state: 'active' }];
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.workflows = [{ id: 3, name: 'docker', path: '.github/workflows/docker.yaml', state: 'active' }];
  const status = await computeStatus({ root: w.root, env: w.env, live: true });
  assert.match(status.actions?.find((a) => a.fork === 'anything-llm')?.detail ?? '', /turn off docker\.yaml/);
  assert.equal(status.next.command, 'npm run go');
});

test('status --live and the plain status agree before the first pull request', async () => {
  const w = await auraWorld(false);
  const plain = await computeStatus({ root: w.root, env: w.env });
  const live = await computeStatus({ root: w.root, env: w.env, live: true });
  assert.equal(live.next.command, plain.next.command);
});

test('a just-pushed pull request is given its minute before status sends anyone to the button', async () => {
  const w = await auraWorld(false);
  await open(w, '04');
  const status = await computeStatus({ root: w.root, env: w.env, live: true, nowMs: () => Date.now() });
  assert.doesNotMatch(status.next.command, /fix Actions on aura/);
});

test('status --live gives a pull request a minute before it blames the gate', async () => {
  const w = await auraWorld(false);
  await open(w, '04');
  const status = await computeStatus({ root: w.root, env: w.env, live: true, nowMs: () => Date.now() });
  assert.match(status.actions?.find((a) => a.fork === 'aura')?.detail ?? '', /Look again in a minute/);
});

test('status --live reports the gate open once a run exists, whatever state the workflows read', async () => {
  const w = await auraWorld(true);
  await open(w, '04');
  const line = (await computeStatus({ root: w.root, env: w.env, live: true })).actions?.find((a) => a.fork === 'aura');
  assert.equal(line?.ok, true);
  assert.match(line?.detail ?? '', /workflows ran on 1 of 1 open pull requests/);
  const check = (await computeStatus({ root: w.root, env: w.env, live: true })).items.find((i) => i.n === 2)?.checks.find((c) => c.label === 'PR 04');
  assert.ok(!/CI none/.test(check?.detail ?? ''), `CI is read at the tip, where the run is: ${check?.detail}`);
});

test('status --live only flags stray workflows that have a file, and setup can clear the line', async () => {
  const w = await auraWorld(true);
  await open(w, '04');
  const repo = aura(w);
  repo.workflows = [{ id: 1, name: 'dep', path: 'dynamic/dependabot/dependabot-updates', state: 'active' }];
  assert.equal((await computeStatus({ root: w.root, env: w.env, live: true })).actions?.find((a) => a.fork === 'aura')?.ok, true);
  repo.workflows = [{ id: 2, name: 'cla', path: '.github/workflows/cla.yml', state: 'active' }];
  assert.match((await computeStatus({ root: w.root, env: w.env, live: true })).actions?.find((a) => a.fork === 'aura')?.detail ?? '', /turn off cla\.yml: run npm run setup/);
});

test('a lagging pull request object does not put the old commit\'s green on the new one', async () => {
  const w = await auraWorld();
  const repo = aura(w);
  await open(w, '04');
  repo.lagPullHead = true;
  const spec = findSpec('04', w.root);
  const outcome = await openOrUpdate(spec, { all: true }, createPrDeps(w.root, w.env, quick()));
  assert.deepEqual(outcome.pushedStages, ['2026-09-29']);
  const tip = git(repo.bare, 'rev-parse', `refs/heads/${spec.branch}`);
  const asked = w.fake.requests.filter((r) => r.path.includes('/check-runs')).at(-1);
  assert.ok(asked?.path.includes(tip), 'CI was read at the branch tip');
  const record = readObjects(w.root).prs['04'];
  assert.equal(record.ci.state, 'success');
  repo.checks = repo.checks.filter((c) => c.head_sha !== tip);
  repo.runs = repo.runs.filter((r) => r.head_sha !== tip);
  const again = await openOrUpdate(spec, { all: true }, createPrDeps(w.root, w.env, quick()));
  assert.equal(again.ci.state, 'none', 'no checks on the tip means none, even with the older commit green');
});

test('green means the repo\'s test workflow passed on this commit, not that something did', async () => {
  const w = await createWorld();
  allmWorld(w, true);
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  const deps = createPrDeps(w.root, w.env, quick());
  const sha = w.fix.mainTip;
  const check = (conclusion: string) => ({ name: 'changes', status: 'completed', conclusion, html_url: 'https://github.com/x/1', details_url: 'https://github.com/x/1' });
  const run = (file: string, conclusion: string, created: string) => ({ id: 1, name: file, path: `.github/workflows/${file}`, event: 'pull_request', status: 'completed', conclusion, html_url: 'https://github.com/x/1', run_number: 1, created_at: created });
  fork.checks = [check('success')];
  fork.runs = [run('lint.yaml', 'success', '2026-11-01T01:00:00Z')];
  assert.equal((await readCi(deps.octokit, ORG, 'anything-llm', sha)).state, 'neutral', 'lint alone passing is not the tests');
  fork.runs = [...fork.runs, run('run-tests.yaml', 'success', '2026-11-01T01:00:00Z')];
  assert.equal((await readCi(deps.octokit, ORG, 'anything-llm', sha)).state, 'success');
  fork.runs = [run('run-tests.yaml', 'success', '2026-11-01T01:00:00Z'), run('run-tests.yaml', 'cancelled', '2026-11-01T02:00:00Z')];
  assert.equal((await readCi(deps.octokit, ORG, 'anything-llm', sha)).state, 'neutral', 'only the newest run of it counts');
  fork.runs = [run('run-tests.yaml', 'cancelled', '2026-11-01T01:00:00Z'), { ...run('run-tests.yaml', 'success', '2026-11-01T02:00:00Z'), path: '.github/workflows/run-tests.yaml@refs/pull/1/merge' }];
  assert.equal((await readCi(deps.octokit, ORG, 'anything-llm', sha)).state, 'success', 'and a path may carry its ref');
});

test('a queued run with no check run yet is pending, not no CI', async () => {
  const w = await createWorld();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.runs = [{ id: 1, name: 't', path: '.github/workflows/run-tests.yaml', event: 'pull_request', status: 'queued', conclusion: null, html_url: 'https://github.com/x/q', run_number: 1, created_at: 'x' }];
  const deps = createPrDeps(w.root, w.env, quick());
  assert.deepEqual(await readCi(deps.octokit, ORG, 'anything-llm', w.fix.mainTip), { state: 'pending', url: 'https://github.com/x/q' });
});

test('every failing conclusion counts as failure', () => {
  const none = { state: 'pending', total_count: 0, statuses: [] };
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    assert.equal(summarise([{ status: 'completed', conclusion, html_url: 'h', details_url: 'd' }], none).state, 'failure', conclusion);
  }
});

const outcome = (state: string, url: string | null = 'https://github.com/x/1'): PrOutcome => ({ id: '04', number: 1, url: 'u', opened: false, pushedStages: [], edited: false, commented: 0, ci: { state, url }, ciTimedOut: false, state: 'open' });

test('exit codes for CI: only success is 0, and waiting is not the same as failing', () => {
  const codes = Object.fromEntries(['success', 'failure', 'neutral', 'none', 'pending'].map((s) => [s, exitForCi(outcome(s), true)]));
  assert.deepEqual(codes, { success: 0, failure: 1, neutral: 1, none: 3, pending: 3 });
  for (const state of ['failure', 'none', 'pending']) assert.equal(exitForCi(outcome(state), false), 0, 'not waiting, nothing to report');
});

test('each CI result names its real cause, and none of them is a key', () => {
  assert.equal(ciCause(outcome('success'), ORG, 'aura'), null);
  const none = ciCause(outcome('none', null), ORG, 'aura') ?? '';
  assert.match(none, /https:\/\/github\.com\/keepup-demo\/aura\/actions/);
  assert.match(none, /npm run pr -- 04 --rerun-ci/);
  assert.match(ciCause(outcome('pending'), ORG, 'aura') ?? '', /still running/);
  assert.match(ciCause(outcome('neutral'), ORG, 'aura') ?? '', /without a pass/);
  assert.match(ciCause(outcome('failure'), ORG, 'aura') ?? '', /CI failed: https:\/\/github\.com\/x\/1/);
  for (const state of ['none', 'pending', 'neutral', 'failure']) assert.ok(!/\bkey\b/.test(ciCause(outcome(state), ORG, 'aura') ?? ''));
});

test('the wait says what it is doing, ends early on silence, and has one bound for running checks', async () => {
  const w = await createWorld();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  const deps = createPrDeps(w.root, w.env, quick());
  let clock = 0;
  const lines: string[] = [];
  const opts = { timeoutMs: 20 * 60_000, noneTimeoutMs: 3 * 60_000, pollMs: 30_000, sleep: async (ms: number) => { clock += ms; }, nowMs: () => clock, log: (l: string) => lines.push(l) };
  const silent = await waitForCi(deps.octokit, ORG, 'anything-llm', w.fix.mainTip, opts);
  assert.deepEqual(silent, { ci: { state: 'none', url: null }, timedOut: true });
  assert.equal(clock, 3 * 60_000);
  assert.ok(lines.length >= 3, 'at least once a minute');
  clock = 0;
  lines.length = 0;
  fork.checks = [{ name: 't', status: 'in_progress', conclusion: null, html_url: 'https://github.com/x/1', details_url: 'https://github.com/x/1' }];
  const running = await waitForCi(deps.octokit, ORG, 'anything-llm', w.fix.mainTip, opts);
  assert.equal(running.ci.state, 'pending');
  assert.equal(running.timedOut, true);
  assert.equal(clock, 20 * 60_000);
  assert.ok(lines.length >= 20 && lines.every((l) => l.includes('https://github.com/x/1')), lines.join('\n'));
});

test('KEEPUP_CI_WAIT_MS is how go shares one deadline out', async () => {
  const w = await createWorld();
  assert.equal(createPrDeps(w.root, { ...w.env, KEEPUP_CI_WAIT_MS: '60000' }).ciTimeoutMs, 60_000);
  assert.equal(createPrDeps(w.root, { ...w.env, KEEPUP_CI_WAIT_MS: 'nonsense' }).ciTimeoutMs, 20 * 60_000);
  assert.equal(createPrDeps(w.root, w.env).ciTimeoutMs, 20 * 60_000);
});

test('--live reads each fork on its own: one the installation can\'t reach names itself and costs the other nothing', async () => {
  const w = await auraWorld(true);
  await open(w, '04');
  w.fake.hideFromInstallation = 'anything-llm';
  const status = await computeStatus({ root: w.root, env: w.env, live: true });
  assert.equal(status.live, true);
  assert.equal(status.actions?.find((a) => a.fork === 'aura')?.ok, true);
  assert.match(status.actions?.find((a) => a.fork === 'anything-llm')?.detail ?? '', /can't reach it.*settings\/installations\/777/);
  assert.match(status.next.command, /add anything-llm to the installation/);
});

test('--live finds what the file only claims: a missing issue, the real base and the real stages', async () => {
  const w = await auraWorld(true);
  await open(w, '04');
  updateObjects(w.root, (o) => ({
    ...o,
    issues: { 'aura/2026-10-26': { number: 99, url: 'https://github.com/x/aura/issues/99' } },
    prs: { ...o.prs, '04': { ...o.prs['04'], base: 'replay/wrong', stagesApplied: ['2026-09-22', '2026-09-29'] } },
  }));
  const fromFile = await computeStatus({ root: w.root, env: w.env });
  assert.ok(fromFile.items.find((i) => i.n === 3)?.checks.find((c) => c.label.startsWith('aura'))?.ok);
  const live = await computeStatus({ root: w.root, env: w.env, live: true });
  assert.equal(live.items.find((i) => i.n === 3)?.checks.find((c) => c.label.startsWith('aura'))?.ok, false);
  assert.ok(live.liveNotes.some((n) => /aura\/2026-10-26 isn't on GitHub/.test(n)), live.liveNotes.join('\n'));
  const check = live.extras.concat(live.items.find((i) => i.n === 2)?.checks ?? []).find((c) => c.label === 'PR 04');
  assert.ok(!/replay\/wrong/.test(check?.detail ?? ''), 'the base came from GitHub');
  assert.ok(/2026-10-30|lab/.test(check?.detail ?? ''));
});

test('--live compares the words on GitHub, not the words in the file', async () => {
  const w = await auraWorld(true);
  await open(w, '04');
  aura(w).pulls[0].body = 'someone edited this by hand';
  const fromFile = await computeStatus({ root: w.root, env: w.env });
  const live = await computeStatus({ root: w.root, env: w.env, live: true });
  const line = (s: typeof live) => s.items.find((i) => i.n === 2)?.checks.find((c) => c.label === 'PR 04')?.detail ?? '';
  assert.ok(!/isn't what the lab's result gives/.test(line(fromFile)));
  assert.match(line(live), /isn't what the lab's result gives/);
});
