import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { requireAppConfig } from '../src/config.ts';
import { createAppClient } from '../src/github.ts';
import { bodyDigest, readObjects, updateObjects } from '../src/objects.ts';
import { stagePatchIds } from '../src/patch-ids.ts';
import { PrStateError } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import { labOf, NotMeasuredError, renderBody, renderTitle } from '../src/template.ts';
import { git, PATCH_SUBJECTS } from './fake-repos.ts';
import { world } from './pr-world.ts';
import { MEASURED_RESULT, NOT_RUN_RESULT, ORG, upstreamRequests, writeMeasured, writeText, type World } from './world.ts';

const branch = 'keepup/2026-09-22-gpt-6-models';
const repoWrites = (w: World) => w.fake.writeRequests().filter((r) => !r.path.endsWith('/access_tokens'));

test('the first stage opens a pull request with exactly the template', async () => {
  const w = await world();
  const spec = findSpec('06', w.root);
  const outcome = await w.run();
  const fork = w.fake.repo(ORG, 'anything-llm');
  assert.equal(fork?.pulls.length, 1);
  const pull = fork?.pulls[0];
  const lab = labOf(spec, w.root);
  assert.equal(pull?.title, renderTitle(spec.stages[0], lab));
  assert.equal(pull?.title, 'Add GPT-6 Sol and GPT-6 Luna · answers on 3 of 3 new models');
  assert.equal(pull?.body, renderBody(spec, { org: ORG, applied: [spec.stages[0]], lab }));
  assert.equal(pull?.user, 'keepup[bot]');
  assert.equal(pull?.base, spec.baseBranch);
  assert.equal(pull?.head, branch);
  assert.deepEqual(outcome.pushedStages, ['2026-09-22']);
  assert.equal(outcome.opened, true);
  assert.deepEqual(w.fake.unhandled, []);
});

test('the base branch is made through REST at the base commit, and the head branch at its tip', async () => {
  const w = await world();
  const spec = findSpec('06', w.root);
  await w.run();
  const refs = w.fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/git/refs'));
  assert.deepEqual(refs.map((r) => r.body), [
    { ref: `refs/heads/${spec.baseBranch}`, sha: w.fix.baseCommit },
    { ref: `refs/heads/${branch}`, sha: w.fix.baseCommit },
  ]);
  const bare = w.fake.repo(ORG, 'anything-llm')?.bare as string;
  assert.equal(git(bare, 'rev-parse', `refs/heads/${spec.baseBranch}`), w.fix.baseCommit);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), w.fix.mainTip, 'main is never touched');
  assert.equal(w.fake.pushes().length, 1, 'only the head branch was pushed');
});

test('commits carry the patch subject and body, the bot as author and committer, and the replay date', async () => {
  const w = await world();
  await w.run();
  const bare = w.fake.repo(ORG, 'anything-llm')?.bare as string;
  const log = git(bare, 'log', '--reverse', '--format=%s|%b|%an|%ae|%cn|%ce|%aI|%cI', `${w.fix.baseCommit}..refs/heads/${branch}`).replace(/\n\|/g, '|').split('\n').filter(Boolean);
  const bot = 'keepup[bot]';
  const email = `987654+keepup[bot]@users.noreply.github.com`;
  assert.deepEqual(log, [
    `${PATCH_SUBJECTS[0]}|GPT-6 Sol shipped on 22 Sep.|${bot}|${email}|${bot}|${email}|2026-09-22T12:00:00+00:00|2026-09-22T12:00:00+00:00`,
    `${PATCH_SUBJECTS[1]}|GPT-6 Luna shipped on 22 Sep.|${bot}|${email}|${bot}|${email}|2026-09-22T12:01:00+00:00|2026-09-22T12:01:00+00:00`,
  ]);
});

test('update pushes the next commit with its replay date, edits the title and body, and comments once', async () => {
  const w = await world();
  await w.run();
  const spec = findSpec('06', w.root);
  const before = w.fake.pushes().length;
  const outcome = await w.run({ update: '2026-09-29' });
  const fork = w.fake.repo(ORG, 'anything-llm');
  const pull = fork?.pulls[0];
  assert.deepEqual(outcome.pushedStages, ['2026-09-29']);
  assert.equal(w.fake.pushes().length, before + 1);
  const bare = fork?.bare as string;
  assert.equal(git(bare, 'log', '-1', '--format=%s|%cI|%aI', `refs/heads/${branch}`), `${PATCH_SUBJECTS[2]}|2026-09-29T12:00:00+00:00|2026-09-29T12:00:00+00:00`);
  assert.equal(pull?.title, 'Add GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol · answers on 3 of 3 new models');
  assert.equal(pull?.body, renderBody(spec, { org: ORG, applied: spec.stages, lab: labOf(spec, w.root) }));
  assert.deepEqual(pull?.comments.map((c) => [c.body, c.user]), [['Updated 29 Sep: GPT-6.1 Sol shipped.', 'keepup[bot]']]);
  const edits = w.fake.requests.filter((r) => r.method === 'PATCH');
  assert.equal(edits.length, 1);
});

test('rerunning with nothing new changes nothing and posts nothing', async () => {
  const w = await world();
  await w.run({ all: true });
  const writes = repoWrites(w).length;
  const pushes = w.fake.pushes().length;
  const first = readObjects(w.root);
  await w.run({ all: true });
  await w.run();
  await w.run({ update: '2026-09-29' });
  assert.equal(repoWrites(w).length, writes, 'no API writes');
  assert.equal(w.fake.pushes().length, pushes, 'no pushes');
  assert.deepEqual(w.fake.repo(ORG, 'anything-llm')?.pulls[0].comments.length, 1);
  const again = readObjects(w.root);
  assert.deepEqual({ ...again.prs['06'], checkedAt: '' }, { ...first.prs['06'], checkedAt: '' });
});

test('what has been applied comes from the remote branch, not a local file', async () => {
  const w = await world();
  await w.run({ all: true });
  writeFileSync(join(w.root, 'data/github-objects.json'), '{"schema":1}\n');
  await import('node:fs').then((fs) => fs.rmSync(join(w.root, 'tmp'), { recursive: true, force: true }));
  const pushes = w.fake.pushes().length;
  const outcome = await w.run({ all: true });
  assert.equal(w.fake.pushes().length, pushes);
  assert.deepEqual(outcome.pushedStages, []);
  assert.deepEqual(readObjects(w.root).prs['06'].stagesApplied, ['2026-09-22', '2026-09-29']);
});

test('--all applies every remaining stage in order, each with its own push', async () => {
  const w = await world();
  const outcome = await w.run({ all: true });
  assert.deepEqual(outcome.pushedStages, ['2026-09-22', '2026-09-29']);
  assert.equal(w.fake.pushes().length, 2);
  const log = git(w.fake.repo(ORG, 'anything-llm')?.bare as string, 'log', '--reverse', '--format=%s', `${w.fix.baseCommit}..refs/heads/${branch}`).split('\n');
  assert.deepEqual(log, PATCH_SUBJECTS);
});

test('a date with no stage is a clear error, and so is skipping a stage', async () => {
  const w = await world();
  await assert.rejects(w.run({ update: '2026-10-05' }), /No stage dated 2026-10-05.*2026-09-22, 2026-09-29/);
  assert.equal(repoWrites(w).length, 0);
  await assert.rejects(w.run({ update: '2026-09-29' }), (e: unknown) => {
    assert.ok(e instanceof PrStateError);
    assert.match(e.message, /2026-09-22/);
    return true;
  });
  assert.equal(w.fake.pushes().length, 0);
});

test('an unmeasured lab refuses before any request is made', async () => {
  const w = await world({}, NOT_RUN_RESULT);
  await assert.rejects(w.run(), NotMeasuredError);
  assert.equal(w.fake.requests.length, 0);
  assert.equal(w.fake.pushes().length, 0);
});

test('--allow-unmeasured opens a title with no number and says so; a numbered title still refuses', async () => {
  const stages = [{ date: '2026-09-22', patches: ['patches/0001.patch', 'patches/0002.patch'], title: 'Keeps working', whatShipped: 'x', whatThisChanges: 'y', comment: null }];
  const w = await world({ stages }, NOT_RUN_RESULT);
  await assert.rejects(w.run(), NotMeasuredError);
  await w.run({ allowUnmeasured: true });
  assert.match(w.fake.repo(ORG, 'anything-llm')?.pulls[0].body ?? '', /Not measured yet: needs OPENAI_API_KEY/);
  const numbered = await world({}, NOT_RUN_RESULT);
  await assert.rejects(numbered.run({ allowUnmeasured: true }), NotMeasuredError);
});

test('a pull request opened unmeasured takes its number when the lab finishes, without a flag', async () => {
  const base = (await world()).fix.baseCommit;
  const stages = [{ date: '2026-09-22', patches: ['patches/0001.patch', 'patches/0002.patch'], title: 'Add it · {{lab.title_number}}', titleUnmeasured: 'Add it', whatShipped: 'x', whatThisChanges: 'y', comment: null }];
  const w = await world({ stages, baseCommit: base }, NOT_RUN_RESULT);
  await w.run({ allowUnmeasured: true });
  const pull = w.fake.repo(ORG, 'anything-llm')?.pulls[0];
  assert.equal(pull?.title, 'Add it');
  assert.match(pull?.body ?? '', /Not measured yet/);
  writeMeasured(w.root, 'lab/06-models');
  await w.run();
  assert.equal(pull?.title, 'Add it · answers on 3 of 3 new models');
  assert.match(pull?.body ?? '', /\| models answering \| 0 \| 3 \|/);
  assert.equal(w.fake.pushes().length, 1, 'no new commit: only the words changed');
});

test('the fork is verified: it must exist, be a fork, and have the spec upstream as its parent', async () => {
  const missing = await world({ fork: 'not-there' });
  await assert.rejects(missing.run(), /keepup-demo\/not-there doesn't exist/);
  const w = await world();
  const repo = w.fake.repo(ORG, 'anything-llm');
  if (!repo) throw new Error('fixture');
  repo.fork = false;
  await assert.rejects(w.run(), /isn't a fork/);
  repo.fork = true;
  repo.parent = 'mezmo/aura';
  w.fake.addRepo('mezmo', 'aura', w.fix.bare);
  await assert.rejects(w.run(), /forked from mezmo\/aura, not Mintplex-Labs\/anything-llm/);
  assert.equal(repoWrites(w).length, 0);
});

test('a base commit the fork does not have stops everything', async () => {
  const w = await world({ baseCommit: 'a'.repeat(40) });
  await assert.rejects(w.run(), /a{40} doesn't resolve/);
  assert.equal(repoWrites(w).length, 0);
});

test('an existing base branch that left the base commit behind is refused', async () => {
  const w = await world();
  const bare = w.fake.repo(ORG, 'anything-llm')?.bare as string;
  const spec = findSpec('06', w.root);
  const first = git(bare, 'rev-list', '--max-parents=0', 'refs/heads/main');
  git(bare, 'update-ref', `refs/heads/${spec.baseBranch}`, first);
  await assert.rejects(w.run(), /doesn't contain the base commit/);
});

test('ciWorkflow adds one commit on the base branch, before anything else, and only once', async () => {
  const w = await world({ ciWorkflow: 'lab/ci/aura.yml' });
  writeText(join(w.root, 'lab/ci/aura.yml'), 'name: keepup-ci\non: [pull_request]\njobs: {}\n');
  const spec = findSpec('06', w.root);
  await w.run();
  const fork = w.fake.repo(ORG, 'anything-llm');
  const bare = fork?.bare as string;
  const baseLog = git(bare, 'log', '--format=%s|%an|%cI', `${w.fix.baseCommit}..refs/heads/${spec.baseBranch}`).split('\n');
  assert.equal(baseLog.length, 1);
  assert.match(baseLog[0], /\|keepup\[bot\]\|2026-09-22T11:59:00\+00:00$/);
  assert.equal(git(bare, 'show', `refs/heads/${spec.baseBranch}:.github/workflows/keepup-ci.yml`), 'name: keepup-ci\non: [pull_request]\njobs: {}');
  assert.equal(git(bare, 'merge-base', `refs/heads/${spec.baseBranch}`, `refs/heads/${branch}`), git(bare, 'rev-parse', `refs/heads/${spec.baseBranch}`));
  assert.match(fork?.pulls[0].body ?? '', /one extra commit on top of/);
  const pushes = w.fake.pushes().length;
  await w.run();
  assert.equal(w.fake.pushes().length, pushes);
});

test('a CI file that drifted from the lab copy is reported, never rewritten', async () => {
  const w = await world({ ciWorkflow: 'lab/ci/aura.yml' });
  writeText(join(w.root, 'lab/ci/aura.yml'), 'name: keepup-ci\n');
  await w.run();
  writeText(join(w.root, 'lab/ci/aura.yml'), 'name: changed\n');
  await assert.rejects(w.run(), /differs from lab\/ci\/aura\.yml/);
});

test('a push the server refuses for a missing workflows permission says what to do', async () => {
  const w = await world({ ciWorkflow: 'lab/ci/aura.yml' });
  writeText(join(w.root, 'lab/ci/aura.yml'), 'name: keepup-ci\n');
  const bare = w.fake.repo(ORG, 'anything-llm')?.bare as string;
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "refusing to allow a GitHub App to create or update workflow .github/workflows/keepup-ci.yml without workflows permission" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(w.run(), /workflows: write/);
});

test('a crash between the push and the pull request is finished by the next run, without a second push', async () => {
  const w = await world();
  w.fake.failNextPullCreate = 'Something went wrong';
  await assert.rejects(w.run(), /Something went wrong/);
  assert.equal(w.fake.pushes().length, 1);
  assert.equal(w.fake.repo(ORG, 'anything-llm')?.pulls.length, 0);
  const outcome = await w.run();
  assert.equal(w.fake.pushes().length, 1);
  assert.equal(outcome.opened, true);
  assert.equal(w.fake.repo(ORG, 'anything-llm')?.pulls.length, 1);
});

test('a crash before the comment is finished by the next run, once', async () => {
  const w = await world();
  await w.run({ all: true });
  const pull = w.fake.repo(ORG, 'anything-llm')?.pulls[0];
  if (!pull) throw new Error('fixture');
  pull.comments = [];
  await w.run({ all: true });
  await w.run({ all: true });
  assert.equal(pull.comments.length, 1);
});

test('a new lab result is what counts as something new: title and body follow it', async () => {
  const w = await world();
  await w.run();
  writeMeasured(w.root, 'lab/06-models', MEASURED_RESULT.replace('3 of 3', '2 of 3'));
  await w.run();
  assert.match(w.fake.repo(ORG, 'anything-llm')?.pulls[0].title ?? '', /2 of 3/);
  assert.equal(w.fake.pushes().length, 1);
});

test('a merged pull request is recorded as merged, and a later stage is refused plainly', async () => {
  const w = await world();
  await w.run();
  const pull = w.fake.repo(ORG, 'anything-llm')?.pulls[0];
  if (!pull) throw new Error('fixture');
  pull.state = 'closed';
  pull.merged_at = '2026-11-01T10:00:00Z';
  const writes = repoWrites(w).length;
  await w.run();
  assert.equal(repoWrites(w).length, writes);
  assert.equal(readObjects(w.root).prs['06'].state, 'merged');
  writeMeasured(w.root, 'lab/06-models', MEASURED_RESULT.replace('3 of 3', '2 of 3'));
  await w.run();
  assert.equal(repoWrites(w).length, writes, 'a merged pull request is only read, even when its words would change');
  await assert.rejects(w.run({ update: '2026-09-29' }), /is merged/);
});

test('someone else\'s pull request on the branch is left alone', async () => {
  const w = await world();
  await w.run();
  const pull = w.fake.repo(ORG, 'anything-llm')?.pulls[0];
  if (!pull) throw new Error('fixture');
  pull.user = 'a-person';
  await assert.rejects(w.run(), /opened by a-person, not keepup\[bot\]/);
});

test('a duplicate pull request from a race is picked up, not doubled', async () => {
  const w = await world();
  const fork = w.fake.repo(ORG, 'anything-llm');
  w.fake.failNextPullCreate = `A pull request already exists for ${ORG}:${branch}.`;
  await assert.rejects(w.run(), /already exists/);
  await w.run();
  assert.equal(fork?.pulls.length, 1);
});

test('objects record what the API confirmed, and other entries survive', async () => {
  const w = await world();
  updateObjects(w.root, (o) => ({ ...o, issues: { 'aura/2026-10-26': { number: 9, url: 'https://github.com/x/aura/issues/9' } }, prs: { '05': { number: 5 } as never } }));
  await w.run();
  const objects = readObjects(w.root);
  assert.deepEqual(objects.issues, { 'aura/2026-10-26': { number: 9, url: 'https://github.com/x/aura/issues/9' } });
  assert.ok(objects.prs['05']);
  const spec = findSpec('06', w.root);
  assert.deepEqual(objects.prs['06'], {
    number: 1,
    url: `https://github.com/${ORG}/anything-llm/pull/1`,
    title: 'Add GPT-6 Sol and GPT-6 Luna · answers on 3 of 3 new models',
    state: 'open',
    base: spec.baseBranch,
    head: branch,
    author: 'keepup[bot]',
    stagesApplied: ['2026-09-22'],
    ci: { state: 'none', url: null },
    checkedAt: '2026-11-01T09:00:00.000Z',
    bodyDigest: bodyDigest(w.fake.repo(ORG, 'anything-llm')?.pulls[0].body),
    patchIds: stagePatchIds(spec, ['2026-09-22']),
  });
  assert.equal(objects.org, ORG);
  assert.deepEqual(objects.app, { slug: 'keepup', url: 'https://github.com/apps/keepup', bot: 'keepup[bot]' });
  assert.deepEqual(objects.forks, { 'anything-llm': `https://github.com/${ORG}/anything-llm` });
});

test('no request ever targets an upstream owner', async () => {
  const w = await world({}, MEASURED_RESULT);
  await w.run({ all: true });
  await w.run({ all: true, waitCi: false });
  assert.deepEqual(upstreamRequests(w.fake), []);
  assert.ok(w.fake.gitRequests.every((r) => r.path.startsWith(`/${ORG}/`)), 'git only touched the fork');
  assert.ok(w.fake.gitRequests.some((r) => r.authorized));
});

test('a spec cannot steer the App at an upstream: the client refuses before sending', async () => {
  const w = await world();
  const client = createAppClient(requireAppConfig(w.env, w.root), w.env);
  const count = w.fake.requests.length;
  await assert.rejects(client.request('POST /repos/{owner}/{repo}/pulls', { owner: 'Mintplex-Labs', repo: 'anything-llm', title: 'x', head: 'a', base: 'b' }), /never writes to an upstream/);
  await assert.rejects(client.request('GET /repos/{owner}/{repo}', { owner: 'mezmo', repo: 'aura' }), /never writes to an upstream/);
  await assert.rejects(client.request('POST /repos/{owner}/{repo}/issues', { owner: 'random', repo: 'other', title: 'x' }), /only writes to keepup-demo/);
  assert.equal(w.fake.requests.length, count, 'nothing left the process');
});

test('the clone is blobless, and the token never lands in .git/config, git output or errors', async () => {
  const w = await world();
  await w.run();
  const config = readFileSync(join(w.root, 'tmp/forks/anything-llm/.git/config'), 'utf8');
  assert.match(config, /partialclonefilter = blob:none/);
  assert.ok(!/ghs_|extraheader|Authorization/i.test(config), config);
  const tokens = [...w.fake.installationTokens];
  assert.ok(tokens.length > 0);
  for (const token of tokens) assert.ok(!config.includes(token));
  assert.ok(w.fake.gitRequests.filter((r) => r.authorized).length > 0, 'git really sent the token');
  assert.equal(w.fake.gitRequests.filter((r) => !r.authorized).length, 0, 'git never tried without it');
});

test('a patch that does not apply names the patch and leaves the remote alone', async () => {
  const w = await world();
  writeFileSync(join(w.root, 'lab/06-models/patches/0001.patch'), readFileSync(join(w.root, 'lab/06-models/patches/0001.patch'), 'utf8').replace('"GPT-5 Mini"', '"Something Else"'));
  await assert.rejects(w.run(), /0001\.patch/);
  assert.equal(w.fake.pushes().length, 0);
});

test('a patch that is not format-patch output is refused', async () => {
  const w = await world();
  writeFileSync(join(w.root, 'lab/06-models/patches/0001.patch'), 'not a patch at all\n');
  await assert.rejects(w.run(), /0001\.patch has no subject/);
});
