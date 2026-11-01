// What's on the branches behind a pull request: the replay base, the fork's default branch, and where a head starts.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPlan } from '../src/go.ts';
import { readObjects } from '../src/objects.ts';
import { createPrDeps, openOrUpdate } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import { computeStatus } from '../src/status.ts';
import { aura, AURA_SPEC, auraWorld, CI_FILE, open, quick } from './aura-world.ts';
import { git } from './fake-repos.ts';
import { createWorld, installSpec, ORG, specJson, upstreamRequests, writeText } from './world.ts';

test('the replay base carries the CI file and no other workflow, and the default branch none, so a CLA bot has nothing to run from', async () => {
  const w = await auraWorld();
  await open(w, '04');
  const repo = aura(w);
  const baseBranch = findSpec('04', w.root).baseBranch;
  assert.deepEqual(git(repo.bare, 'ls-tree', '--name-only', `refs/heads/${baseBranch}`, '.github/workflows/').split('\n'), ['.github/workflows/keepup-ci.yml']);
  assert.equal(git(repo.bare, 'rev-list', '--count', `${w.fix.baseCommit}..refs/heads/${baseBranch}`), '1', 'one extra commit, as the footer says');
  const message = git(repo.bare, 'log', '-1', '--format=%B', `refs/heads/${baseBranch}`);
  assert.match(message, /Removes .*cla\.yml/);
  assert.equal(git(repo.bare, 'ls-tree', '--name-only', 'refs/heads/main', '.github/workflows/'), '', 'GitHub reads pull_request_target from the default branch, so the files have to go from there');
  assert.ok(git(repo.bare, 'ls-tree', '--name-only', 'refs/heads/main', 'README.md').includes('README.md'), 'and nothing else does');
  assert.equal(git(repo.bare, 'rev-list', '--count', `${w.fix.mainTip}..refs/heads/main`), '1', 'one commit on the default branch');
  assert.equal(git(repo.bare, 'rev-parse', 'refs/heads/main^'), w.fix.mainTip, 'on top of what was there, with no force');
  assert.match(git(repo.bare, 'log', '-1', '--format=%an|%B', 'refs/heads/main'), /^keepup\[bot\]\|.*default branch/s);
  assert.deepEqual(repo.runs.map((r) => [r.name, r.event, r.conclusion]), [['keepup-ci.yml', 'pull_request', 'success']], 'no CLAAssistant check on the pull request');
  assert.match(repo.pulls[0].body, /removes this repo's other workflow files/);
  assert.match(repo.pulls[0].body, /default branch/, 'the footer says so');
  assert.doesNotMatch(message, /reads pull_request_target workflows from this branch/, 'the old rule stays off a public fork');
  assert.deepEqual(upstreamRequests(w.fake), []);
});

test('the default branch is cleared once, before the first pull request, and a rerun pushes nothing to it', async () => {
  const w = await auraWorld();
  await open(w, '04');
  const toMain = () => w.fake.pushedRefs.filter((r) => r.ref === 'refs/heads/main').length;
  assert.equal(toMain(), 1);
  const order = w.fake.pushedRefs.map((r) => r.ref);
  assert.ok(order.indexOf('refs/heads/main') < order.indexOf(`refs/heads/${findSpec('04', w.root).branch}`));
  await open(w, '04');
  assert.equal(toMain(), 1);
  assert.deepEqual(aura(w).workflows, [], 'and setup then has nothing to switch off');
});

test('a fork whose repo keeps its own CI keeps its default branch too', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  await open(w, '06');
  assert.deepEqual(w.fake.pushedRefs.filter((r) => r.ref === 'refs/heads/main'), []);
  assert.equal(git(w.fake.repo(ORG, 'anything-llm')?.bare as string, 'rev-parse', 'refs/heads/main'), w.fix.mainTip);
});

test('a head branch starts at the base commit plus the CI commit, even after a merge moved the base', async () => {
  const w = await auraWorld();
  const repo = aura(w);
  await open(w, '04');
  const spec = findSpec('04', w.root);
  const ciCommit = git(repo.bare, 'rev-parse', `refs/heads/${spec.baseBranch}`);
  git(repo.bare, 'update-ref', `refs/heads/${spec.baseBranch}`, git(repo.bare, 'rev-parse', `refs/heads/${spec.branch}`));
  const stage = (specJson(w.fix.baseCommit).stages as Record<string, unknown>[])[0];
  installSpec(w.root, w.fix, { labDir: 'lab/05-other', overrides: { ...AURA_SPEC, id: '05', spec: 'docs/prs/05.md', branch: 'keepup/2026-09-01-other', stages: [{ ...stage, date: '2026-09-23', patches: ['patches/0001.patch'] }] } });
  const other = await open(w, '05');
  assert.equal(git(repo.bare, 'rev-parse', 'refs/heads/keepup/2026-09-01-other~1'), ciCommit, 'not the merged tip, where its patch may not apply');
  assert.match(repo.pulls.find((p) => p.number === other.number)?.body ?? '', /has one extra commit on top of/, 'what was merged since is not an extra commit');
});

test('with no CI commit, a head branch starts at the base commit, wherever the base has moved', async () => {
  const w = await createWorld();
  const repo = w.fake.repo(ORG, 'anything-llm');
  if (!repo) throw new Error('fixture');
  const stages = specJson(w.fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(w.root, w.fix, { overrides: { stages: [stages[0]] } });
  installSpec(w.root, w.fix, { labDir: 'lab/07-other', overrides: { id: '07', spec: 'docs/prs/07.md', branch: 'keepup/2026-09-23-other', stages: [{ ...stages[0], date: '2026-09-23' }] } });
  await open(w, '06');
  const spec = findSpec('06', w.root);
  git(repo.bare, 'update-ref', `refs/heads/${spec.baseBranch}`, git(repo.bare, 'rev-parse', `refs/heads/${spec.branch}`));
  await open(w, '07');
  assert.equal(git(repo.bare, 'rev-parse', 'refs/heads/keepup/2026-09-23-other~2'), w.fix.baseCommit);
});

test('the digest of a two-commit base matches: status is clean, and go has nothing to redo', async () => {
  const w = await auraWorld();
  const repo = aura(w);
  const spec = findSpec('04', w.root);
  const work = join(w.dir, 'old-base');
  git(w.dir, 'clone', '-q', repo.bare, work);
  git(work, 'checkout', '-q', '-b', 'old', w.fix.baseCommit);
  writeText(join(work, '.github/workflows/keepup-ci.yml'), CI_FILE);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'ci: the first version of the CI commit');
  git(repo.bare, 'fetch', '-q', work, `+old:refs/heads/${spec.baseBranch}`);
  await openOrUpdate(spec, { all: true }, createPrDeps(w.root, w.env, quick()));
  assert.match(repo.pulls[0].body, /has 2 extra commits on top of/);
  assert.equal(readObjects(w.root).prs['04'].baseExtraCommits, 2);
  const status = await computeStatus({ root: w.root, env: w.env });
  const check = status.extras.concat(status.items.flatMap((i) => i.checks)).find((c) => c.label === 'PR 04');
  assert.doesNotMatch(check?.detail ?? '', /isn't what the lab's result gives/);
  assert.equal(buildPlan(w.root, w.env, {}).find((s) => s.phase === 'prs' && s.args[0] === '04')?.skip, 'all stages applied');
});

test('without that removal the fake really would show the red check', async () => {
  const w = await auraWorld();
  const repo = aura(w);
  const baseBranch = findSpec('04', w.root).baseBranch;
  git(repo.bare, 'update-ref', `refs/heads/${baseBranch}`, w.fix.baseCommit);
  git(repo.bare, 'update-ref', 'refs/heads/plain', w.fix.mainTip);
  repo.pulls.push({ number: 9, title: 't', body: '', state: 'closed', user: 'x', created_at: 'x', comments: [], head: 'plain', headSha: w.fix.mainTip, base: baseBranch, merged_at: null });
  const { firePullEvent } = await import('./fake-actions.ts');
  await firePullEvent(w.fake, repo, repo.pulls[0]);
  assert.ok(repo.runs.some((r) => r.name === 'cla.yml' && r.event === 'pull_request_target' && r.conclusion === 'failure'), 'the model is what makes the test above mean something');
});

test('a base branch that already exists gets the stray workflows removed too, and the footer counts both commits', async () => {
  const w = await auraWorld();
  const repo = aura(w);
  const spec = findSpec('04', w.root);
  const work = join(w.dir, 'old-base');
  git(w.dir, 'clone', '-q', repo.bare, work);
  git(work, 'checkout', '-q', '-b', 'old', w.fix.baseCommit);
  writeText(join(work, '.github/workflows/keepup-ci.yml'), CI_FILE);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'ci: the first version of the CI commit');
  git(repo.bare, 'fetch', '-q', work, `+old:refs/heads/${spec.baseBranch}`);
  await open(w, '04');
  assert.deepEqual(git(repo.bare, 'ls-tree', '--name-only', `refs/heads/${spec.baseBranch}`, '.github/workflows/').split('\n'), ['.github/workflows/keepup-ci.yml']);
  assert.equal(git(repo.bare, 'rev-list', '--count', `${w.fix.baseCommit}..refs/heads/${spec.baseBranch}`), '2');
  assert.match(repo.pulls[0].body, /has 2 extra commits on top of/);
  const pushes = w.fake.pushes().length;
  await open(w, '04');
  assert.equal(w.fake.pushes().length, pushes, 'second run: nothing left to remove');
});

test('a CI file with a secret in it is refused at the last moment too, once the secret is known', async () => {
  const w = await auraWorld();
  const { registerSecret } = await import('../src/secrets.ts');
  registerSecret('only-known-at-runtime-0123');
  const spec = findSpec('04', w.root);
  writeText(join(w.root, 'lab/ci/aura.yml'), `${CI_FILE}# only-known-at-runtime-0123\n`);
  await assert.rejects(openOrUpdate(spec, {}, createPrDeps(w.root, w.env, quick())), /holds something secret/);
  assert.equal(w.fake.pushes().length, 0);
});
