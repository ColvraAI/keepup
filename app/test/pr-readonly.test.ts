// Waiting on CI writes nothing, so nothing about a lab can stop it. And what a person is told after that.
import { strict as assert } from 'node:assert';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main as prMain } from '../src/cli/pr.ts';
import { runGo, type GoStep } from '../src/go.ts';
import { readObjects } from '../src/objects.ts';
import { createPrDeps, openOrUpdate } from '../src/pr.ts';
import { rerunCi } from '../src/pr-gate.ts';
import { findSpec } from '../src/specs.ts';
import { computeStatus } from '../src/status.ts';
import { pressActionsButton } from './fake-actions.ts';
import { aura, auraWorld, quick } from './aura-world.ts';
import { NOT_RUN_RESULT, ORG, writeText, createWorld, installSpec, type World } from './world.ts';

const TITLE = { title: 'Add servers · {{lab.title_number}}', titleUnmeasured: 'Add servers' };

async function unmeasuredAura(gateOpen: boolean): Promise<World> {
  const w = await auraWorld(gateOpen);
  const path = join(w.root, 'lab/04-mcp/pr.json');
  const { readFileSync } = await import('node:fs');
  const json = JSON.parse(readFileSync(path, 'utf8')) as { stages: Record<string, unknown>[] };
  writeFileSync(path, JSON.stringify({ ...json, stages: json.stages.map((s) => ({ ...s, ...TITLE })) }));
  writeText(join(w.root, 'lab/04-mcp/result.md'), NOT_RUN_RESULT.replace('06-models', '04-mcp'));
  writeText(join(w.root, 'lab/04-mcp/run.ts'), '');
  return w;
}

const sinks = { out: () => undefined, err: () => undefined };

/** go's real decisions, running the real pull request code against the fake. */
function realRunner(w: World) {
  return async (step: GoStep): Promise<number> => (step.script === 'pr' ? prMain(step.args, { root: w.root, env: w.env, io: sinks }, quick()) : 0);
}

test('the sequence: go opens one unmeasured, the button, plain go: CI is recorded, and status moves on', async () => {
  const w = await unmeasuredAura(false);
  await runGo({ allowUnmeasured: true, skipLabs: true }, { root: w.root, env: w.env, log: () => undefined, runner: realRunner(w) });
  const repo = aura(w);
  assert.equal(readObjects(w.root).prs['04'].ci.state, 'none');
  const before = await computeStatus({ root: w.root, env: w.env });
  assert.match(before.next.command, /fix Actions on aura/);
  await pressActionsButton(repo);
  const lines: string[] = [];
  await runGo({ skipLabs: true }, { root: w.root, env: w.env, log: (l) => lines.push(l), runner: realRunner(w) });
  assert.equal(repo.runs.length, 1);
  assert.equal(readObjects(w.root).prs['04'].ci.state, 'success', lines.join('\n'));
  const after = await computeStatus({ root: w.root, env: w.env });
  assert.doesNotMatch(after.next.command, /fix Actions on aura/);
});

test('a run go has just confirmed stops status naming the button, even before CI finishes', async () => {
  const w = await unmeasuredAura(false);
  await openOrUpdate(findSpec('04', w.root), { allowUnmeasured: true }, createPrDeps(w.root, w.env, quick()));
  const repo = aura(w);
  await pressActionsButton(repo);
  const spec = findSpec('04', w.root);
  await rerunCi(spec, createPrDeps(w.root, w.env, quick()));
  repo.runs = repo.runs.map((r) => ({ ...r, status: 'in_progress', conclusion: null }));
  repo.checks = [];
  assert.equal(await prMain(['04', '--check-actions'], { root: w.root, env: w.env, io: sinks }, quick()), 0);
  assert.equal(readObjects(w.root).prs['04'].ci.state, 'pending');
  assert.doesNotMatch((await computeStatus({ root: w.root, env: w.env })).next.command, /fix Actions/);
});

test('--wait-ci on an open pull request with nothing to push sends nothing, however the lab stands', async () => {
  const w = await unmeasuredAura(true);
  const spec = findSpec('04', w.root);
  await openOrUpdate(spec, { allowUnmeasured: true }, createPrDeps(w.root, w.env, quick()));
  const writes = w.fake.writeRequests().filter((r) => !r.path.endsWith('/access_tokens')).length;
  const pushes = w.fake.pushes().length;
  const outcome = await openOrUpdate(spec, { waitCi: true }, createPrDeps(w.root, w.env, quick()));
  assert.equal(outcome.ci.state, 'success');
  assert.equal(w.fake.writeRequests().filter((r) => !r.path.endsWith('/access_tokens')).length, writes);
  assert.equal(w.fake.pushes().length, pushes);
  const record = readObjects(w.root).prs['04'];
  assert.equal(record.ci.state, 'success');
  assert.equal(record.title, 'Add servers', 'the title on GitHub, as it is');
});

test('--wait-ci with nothing open yet still opens, and still refuses without a number', async () => {
  const w = await unmeasuredAura(true);
  await assert.rejects(openOrUpdate(findSpec('04', w.root), { waitCi: true }, createPrDeps(w.root, w.env, quick())), /isn't measured/);
  assert.deepEqual(aura(w).pulls, []);
});

test('a result that cannot be read stops its pull request even with --allow-unmeasured, and no parser text goes public', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix, { overrides: { stages: [{ ...(JSON.parse(JSON.stringify({ date: '2026-09-22', patches: ['patches/0001.patch'], title: 'No number', whatShipped: 'x', whatThisChanges: 'y', comment: null }))) }] } });
  writeText(join(w.root, 'lab/06-models/result.md'), '---\nlab: 06-models\n6.2x faster on 60 messages\n---\n');
  await assert.rejects(openOrUpdate(findSpec('06', w.root), { allowUnmeasured: true }, createPrDeps(w.root, w.env, quick())), /PR 06 waits, because .*can't be read/);
  assert.equal(w.fake.pushes().length, 0);
  assert.deepEqual(w.fake.writeRequests().filter((r) => !r.path.endsWith('/access_tokens')), []);
});

test('a result disqualified by its manifest prints a fixed sentence in public, not why', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix, { overrides: { stages: [{ date: '2026-09-22', patches: ['patches/0001.patch'], title: 'No number', whatShipped: 'x', whatThisChanges: 'y', comment: null }] } });
  rmSync(join(w.root, 'lab/06-models/out/manifest.json'));
  await openOrUpdate(findSpec('06', w.root), { allowUnmeasured: true }, createPrDeps(w.root, w.env, quick()));
  const { body } = w.fake.repo(ORG, 'anything-llm')?.pulls[0] ?? { body: '' };
  assert.match(body, /Not measured yet: needs a lab run/);
  assert.doesNotMatch(body, /saved run|manifest|its result/);
});
