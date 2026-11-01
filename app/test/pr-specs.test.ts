// The ways a pull request's real state can differ from what its spec and lab say.
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bodyDigest, readObjects } from '../src/objects.ts';
import { createPrDeps, openOrUpdate, PrStateError } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import { renderTitle, labOf } from '../src/template.ts';
import { git } from './fake-repos.ts';
import { world } from './pr-world.ts';
import { createWorld, installSpec, ORG, recordFor, repoFixture, specJson } from './world.ts';

test('a patch regenerated under the same subject is refused loudly, and nothing is pushed', async () => {
  const w = await world();
  await w.run();
  const before = w.fake.pushes().length;
  const patch = join(w.root, 'lab/06-models/patches/0001.patch');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('gpt-6-sol', 'gpt-6-sol-regenerated'));
  await assert.rejects(w.run({ all: true }), (e: unknown) => {
    assert.ok(e instanceof PrStateError);
    assert.match(e.message, /same subject as commit [0-9a-f]{40}.*but a different change/);
    assert.match(e.message, /never force-pushes/);
    return true;
  });
  assert.equal(w.fake.pushes().length, before);
  assert.deepEqual(w.fake.requests.filter((r) => r.method === 'PATCH'), [], 'nor is the pull request edited as if it were fine');
});

test('an unchanged patch passes the check on every rerun, with the blobs fetched lazily', async () => {
  const w = await world();
  await w.run({ all: true });
  const pushes = w.fake.pushes().length;
  await w.run({ all: true });
  await w.run({ all: true });
  assert.equal(w.fake.pushes().length, pushes);
  assert.equal(w.fake.gitRequests.filter((r) => !r.authorized).length, 0);
});

test('a merged pull request whose branch is gone is only read, with no content check to fail', async () => {
  const w = await world();
  await w.run();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  const pull = fork.pulls[0];
  pull.state = 'closed';
  pull.merged_at = '2026-11-01T10:00:00Z';
  git(fork.bare, 'config', '--unset', 'receive.denyDeletes');
  git(fork.bare, 'update-ref', '-d', `refs/heads/${pull.head}`);
  const patch = join(w.root, 'lab/06-models/patches/0001.patch');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('gpt-6-sol', 'gpt-6-sol-regenerated'));
  await w.run();
  assert.equal(readObjects(w.root).prs['06'].state, 'merged');
});

test('two pull requests on one fork stay apart: each finds its own by branch', async () => {
  const w = await createWorld();
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(w.root, fix, { overrides: { stages: [stages[0]] } });
  installSpec(w.root, fix, {
    labDir: 'lab/02-other',
    overrides: { id: '02', spec: 'docs/prs/02.md', branch: 'keepup/2026-09-30-other', stages: [{ ...stages[0], date: '2026-09-30', title: 'A different change', patches: ['patches/0001.patch'] }] },
  });
  const run = (id: string) => openOrUpdate(findSpec(id, w.root), {}, createPrDeps(w.root, w.env, { sleep: async () => undefined }));
  const first = await run('06');
  const firstTitle = w.fake.repo(ORG, 'anything-llm')?.pulls[0].title;
  const second = await run('02');
  const pulls = w.fake.repo(ORG, 'anything-llm')?.pulls ?? [];
  assert.equal(pulls.length, 2);
  assert.notEqual(first.number, second.number);
  assert.equal(pulls[0].title, firstTitle, 'the first keeps its words');
  assert.equal(pulls[1].title, 'A different change');
  await run('06');
  assert.equal(pulls[0].title, firstTitle);
  assert.equal(pulls[1].title, 'A different change');
});

test('what goes in the file is what the API said, not what this code could have built', async () => {
  const w = await world();
  const marker = 'from-the-api';
  w.fake.apiMarker = marker;
  w.fake.botLoginOverride = 'KeepUp[bot]';
  await w.run();
  const record = readObjects(w.root).prs['06'];
  const spec = findSpec('06', w.root);
  assert.equal(record.url, `https://github.com/${ORG}/anything-llm/pull/1#${marker}`);
  assert.equal(record.title, `${renderTitle(spec.stages[0], labOf(spec, w.root))} ${marker}`);
  assert.equal(record.author, `KeepUp[bot]#${marker}`, 'the pull request\'s own author, not who we are');
  assert.equal(record.base, `${spec.baseBranch}#${marker}`);
  assert.equal(record.head, `${spec.branch}#${marker}`);
  const sent = w.fake.repo(ORG, 'anything-llm')?.pulls[0].body;
  assert.equal(record.bodyDigest, bodyDigest(`${sent}\n<!-- ${marker} -->`), 'the digest of the body GitHub returned, not the one we rendered');
  const objects = readObjects(w.root);
  assert.equal(objects.forks['anything-llm'], `https://github.com/${ORG}/anything-llm#${marker}`);
  assert.equal(objects.app?.url, `https://github.com/apps/${w.fake.options.slug}#${marker}`);
  assert.equal(objects.app?.bot, 'KeepUp[bot]');
});

test('two patches with one subject are refused: a stage could count as applied with its commit never pushed', async () => {
  const w = await world();
  const second = join(w.root, 'lab/06-models/patches/0002.patch');
  const first = readFileSync(join(w.root, 'lab/06-models/patches/0001.patch'), 'utf8');
  const subject = first.match(/^Subject: \[PATCH[^\]]*\] (.*)$/m)?.[1];
  writeFileSync(second, readFileSync(second, 'utf8').replace(/^Subject: \[PATCH([^\]]*)\] .*$/m, `Subject: [PATCH$1] ${subject}`));
  await assert.rejects(w.run(), (e: unknown) => e instanceof PrStateError && /share the subject/.test(e.message));
  assert.equal(w.fake.pushes().length, 0);
});

test('recordFor really is what a run leaves, or the go tests built on it mean nothing', async () => {
  const w = await world();
  await w.run({ all: true });
  const real = readObjects(w.root).prs['06'];
  const built = recordFor(w.root, '06');
  assert.equal(built.title, real.title);
  assert.equal(built.bodyDigest, real.bodyDigest);
});
