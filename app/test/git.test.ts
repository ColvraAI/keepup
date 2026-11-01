import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPatches, commitFile, ensureClone, fetchBranch, GitError, patchIdOfCommit, patchIdOfFile, pushRef, readPatchMessage, type GitContext } from '../src/git.ts';
import { GuardError } from '../src/guard.ts';
import { git, PATCH_SUBJECTS } from './fake-repos.ts';
import { gitSpy } from './git-spy.ts';
import { createWorld, ORG, type World } from './world.ts';

const identity = { login: 'keepup[bot]', id: 1, name: 'keepup[bot]', email: '1+keepup[bot]@users.noreply.github.com' };

async function context(w: World, token?: string): Promise<GitContext> {
  const real = token ?? `ghs_canary_git_token`;
  w.fake.installationTokens.add(real);
  return {
    root: w.root, org: ORG, fork: 'anything-llm', gitBaseUrl: w.fake.gitUrl, env: { DEMO_ORG: ORG },
    token: async () => real, allowedRefs: ['keepup/branch', 'replay/base'],
  };
}

test('readPatchMessage takes the subject and body from format-patch output', async () => {
  const w = await createWorld();
  assert.deepEqual(await readPatchMessage(w.fix.patches[0]), { subject: PATCH_SUBJECTS[0], body: 'GPT-6 Sol shipped on 22 Sep.' });
});

test('a push to any other ref is refused before git runs', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  const before = w.fake.pushes().length;
  for (const ref of ['main', 'refs/heads/main', 'replay/other', 'keepup/branch:main']) {
    await assert.rejects(pushRef(ctx, dir, w.fix.mainTip, ref), GuardError);
  }
  assert.equal(w.fake.pushes().length, before);
  assert.equal(git(w.fake.repo(ORG, 'anything-llm')?.bare as string, 'rev-parse', 'refs/heads/main'), w.fix.mainTip);
});

test('a push to an org other than the demo org is refused before git runs', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  await assert.rejects(pushRef({ ...ctx, org: 'mezmo' }, dir, w.fix.mainTip, 'keepup/branch'), GuardError);
  await assert.rejects(pushRef({ ...ctx, org: 'someone-else' }, dir, w.fix.mainTip, 'keepup/branch'), GuardError);
  assert.equal(w.fake.pushes().length, 0);
});

test('never force-pushes: a non-fast-forward fails on this side, with the server willing to take it', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  const bare = w.fake.repo(ORG, 'anything-llm')?.bare as string;
  git(bare, 'config', '--unset', 'receive.denyNonFastForwards');
  git(bare, 'update-ref', 'refs/heads/keepup/branch', w.fix.mainTip);
  await assert.rejects(pushRef(ctx, dir, w.fix.baseCommit, 'keepup/branch'), (e: unknown) => {
    assert.ok(e instanceof GitError);
    assert.match(e.message, /rejected|non-fast-forward|fetch first/i);
    return true;
  });
  assert.equal(git(bare, 'rev-parse', 'refs/heads/keepup/branch'), w.fix.mainTip, 'a forced push would have moved it back');
  assert.deepEqual(w.fake.pushedRefs, [], 'nothing went on the wire');
});

test('a refspec dressed up as a commit id is refused before git runs', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  const spy = gitSpy();
  await spy.around(async () => {
    for (const sha of ['+HEAD', `+${w.fix.mainTip}`, 'HEAD', w.fix.mainTip.slice(0, 12)]) await assert.rejects(pushRef(ctx, dir, sha, 'keepup/branch'), GuardError, sha);
  });
  assert.deepEqual(spy.argv().filter((a) => a[0] === 'push'), []);
});

test('what git really runs: a plain push, no token in its arguments, and no key in its environment', async () => {
  const w = await createWorld();
  const ctx = { ...(await context(w)), env: { DEMO_ORG: ORG, OPENAI_API_KEY: 'sk-canary-env-0123456789' } };
  const spy = gitSpy();
  const canary = { OPENAI_API_KEY: 'sk-canary-env-0123456789', SENTRY_ACCESS_TOKEN: 'canary-sentry-env-0123', GITHUB_TOKEN: 'canary-github-env-0123' };
  const saved = { ...process.env };
  Object.assign(process.env, canary);
  try {
    await spy.around(async () => {
      const dir = await ensureClone(ctx);
      await pushRef(ctx, dir, w.fix.mainTip, 'keepup/branch');
    });
  } finally {
    for (const key of Object.keys(canary)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const pushes = spy.argv().filter((a) => a[0] === 'push');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].slice(0, 2), ['push', '-q']);
  assert.deepEqual(pushes[0].slice(3), [`${w.fix.mainTip}:refs/heads/keepup/branch`]);
  for (const args of spy.argv()) {
    const joined = args.join(' ');
    assert.ok(!/--force|--force-with-lease|(^| )-f( |$)/.test(joined), joined);
    assert.ok(!args.some((a) => a.startsWith('+')), joined);
    assert.ok(!joined.includes('ghs_canary_git_token') && !joined.includes('x-access-token'), joined);
  }
  assert.deepEqual(w.fake.pushedRefs.map((r) => r.ref), ['refs/heads/keepup/branch']);
  const dump = spy.envDump();
  for (const value of Object.values(canary)) assert.ok(!dump.includes(value), value);
  const names = spy.envNames();
  const allowed = /^(PATH|TMPDIR|HOME|LANG|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/;
  assert.deepEqual(names.filter((n) => !allowed.test(n)), []);
  assert.match(dump, /^GIT_TERMINAL_PROMPT=0$/m);
  assert.match(dump, /^GIT_CONFIG_NOSYSTEM=1$/m);
  assert.match(dump, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
  const helper = dump.match(/^GIT_CONFIG_KEY_(\d+)=credential\.helper$/m);
  assert.ok(helper, 'the person\'s keychain is switched off');
  assert.match(dump, new RegExp(`^GIT_CONFIG_VALUE_${helper[1]}=$`, 'm'));
  assert.ok(dump.includes('core.hooksPath'));
});

test('no git command line ever carries the token, in any form, and git never sees the person\'s home', async () => {
  const w = await createWorld();
  const token = 'ghs_canary_argv_token';
  const ctx = await context(w, token);
  const spy = gitSpy();
  const source = join(w.root, 'ci.yml');
  writeFileSync(source, 'name: ci\n');
  await spy.around(async () => {
    const dir = await ensureClone(ctx);
    await fetchBranch(ctx, dir, 'main');
    const sha = await applyPatches(ctx, dir, { tip: w.fix.baseCommit, patches: [{ file: w.fix.patches[0], index: 0 }], date: '2026-09-22', identity });
    await patchIdOfCommit(ctx, dir, sha);
    await commitFile(ctx, dir, { tip: sha, source, target: '.github/workflows/keepup-ci.yml', message: 'ci: add', identity, date: '2026-09-22T11:59:00Z' });
    await pushRef(ctx, dir, sha, 'keepup/branch');
  });
  const seen = new Set(spy.argv().map((a) => a[0]));
  for (const needed of ['clone', 'fetch', 'checkout', 'commit', 'push', 'show']) assert.ok(seen.has(needed), `the spy saw ${[...seen].join(', ')}`);
  const base64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  for (const args of spy.argv()) {
    const joined = args.join(' ');
    for (const form of [token, base64, 'x-access-token']) assert.ok(!joined.includes(form), joined);
    assert.ok(!/extraheader/i.test(joined), joined);
    assert.ok(!/authorization/i.test(joined), joined);
  }
  const homes = new Set(spy.envDump().split('\n').filter((l) => l.startsWith('HOME=')));
  assert.deepEqual([...homes], [`HOME=${tmpdir()}`], 'a throwaway home, so the person\'s git config and keychain stay out of it');
  assert.ok(!readFileSync(join(w.root, 'tmp/forks/anything-llm/.git/config'), 'utf8').includes(base64));
});

test('patch ids tell a regenerated change from the same one', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  const sha = await applyPatches(ctx, dir, { tip: w.fix.baseCommit, patches: [{ file: w.fix.patches[0], index: 0 }], date: '2026-09-22', identity });
  assert.equal(await patchIdOfCommit(ctx, dir, sha), await patchIdOfFile(dir, w.fix.patches[0]));
  assert.notEqual(await patchIdOfCommit(ctx, dir, sha), await patchIdOfFile(dir, w.fix.patches[1]));
});

test('a clone cached from another org never pushes there', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  git(dir, 'remote', 'set-url', 'origin', `${w.fake.gitUrl}other-org/anything-llm.git`);
  await ensureClone(ctx);
  assert.equal(git(dir, 'remote', 'get-url', 'origin'), `${w.fake.gitUrl}${ORG}/anything-llm.git`);
  git(dir, 'remote', 'set-url', 'origin', `${w.fake.gitUrl}other-org/anything-llm.git`);
  await pushRef(ctx, dir, w.fix.mainTip, 'keepup/branch');
  assert.ok(w.fake.pushes().every((p) => p.path.startsWith(`/${ORG}/`)));
  assert.equal(git(w.fake.repo(ORG, 'anything-llm')?.bare as string, 'rev-parse', 'refs/heads/keepup/branch'), w.fix.mainTip);
});

test('repo hooks never run during a push', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  const hook = join(w.root, 'env-dump');
  (await import('node:fs')).writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), `#!/bin/sh\nenv > ${hook}\n`, { mode: 0o755 });
  await pushRef(ctx, dir, w.fix.mainTip, 'keepup/branch');
  assert.ok(!(await import('node:fs')).existsSync(hook), 'a hook would see the environment, so hooks are off');
});

test('a bad token fails with a clear message that does not carry the token', async () => {
  const w = await createWorld();
  const ctx = { ...(await context(w)), token: async () => 'ghs_canary_wrong_token' };
  await assert.rejects(ensureClone(ctx), (e: unknown) => {
    assert.ok(e instanceof GitError);
    assert.ok(!e.message.includes('ghs_canary_wrong_token'), e.message);
    assert.ok(!e.message.includes(Buffer.from('x-access-token:ghs_canary_wrong_token').toString('base64')), e.message);
    return true;
  });
});

test('commitFile can remove files in the same commit', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  const source = join(w.root, 'ci.yml');
  writeFileSync(source, 'name: ci\n');
  const sha = await commitFile(ctx, dir, { tip: w.fix.baseCommit, source, target: '.github/workflows/keepup-ci.yml', remove: ['.github/workflows/cla.yml', '.github/workflows/not-there.yml'], message: 'ci: add', identity, date: '2026-09-22T11:59:00Z' });
  const listed = git(dir, 'ls-tree', '--name-only', sha, '.github/workflows/').split('\n');
  assert.ok(listed.includes('.github/workflows/keepup-ci.yml'));
  assert.ok(!listed.includes('.github/workflows/cla.yml'));
  assert.ok(listed.includes('.github/workflows/run-tests.yaml'), 'only what was named');
});

test('commitFile adds one file, authored by the bot at the given date, and re-clones fine', async () => {
  const w = await createWorld();
  const ctx = await context(w);
  const dir = await ensureClone(ctx);
  const source = join(w.root, 'ci.yml');
  (await import('node:fs')).writeFileSync(source, 'name: ci\n');
  const sha = await commitFile(ctx, dir, { tip: w.fix.baseCommit, source, target: '.github/workflows/keepup-ci.yml', message: 'ci: add\n\nbody', identity, date: '2026-09-22T11:59:00Z' });
  assert.equal(git(dir, 'show', '-s', '--format=%an|%cn|%aI|%s', sha), 'keepup[bot]|keepup[bot]|2026-09-22T11:59:00+00:00|ci: add');
  assert.equal(git(dir, 'show', `${sha}:.github/workflows/keepup-ci.yml`), 'name: ci');
  assert.equal(await ensureClone(ctx), dir, 'the cache is reused');
  await fetchBranch(ctx, dir, 'main');
  assert.equal(git(dir, 'rev-parse', 'refs/remotes/origin/main'), w.fix.mainTip);
  assert.ok(!readFileSync(join(dir, '.git/config'), 'utf8').includes('ghs_canary_git_token'));
});
