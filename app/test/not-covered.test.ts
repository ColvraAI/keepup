// A public fork the installation doesn't cover answers every read. Only a write shows it, and the answer should say what to do.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createPrDeps, openOrUpdate } from '../src/pr.ts';
import { rerunCi } from '../src/pr-gate.ts';
import { findSpec } from '../src/specs.ts';
import { computeStatus } from '../src/status.ts';
import { quick } from './aura-world.ts';
import { world } from './pr-world.ts';
import { createWorld, installSpec, ORG, specJson } from './world.ts';

const ADD_IT = /can't reach keepup-demo\/anything-llm.*settings\/installations\/777/s;

test('the first write names the installation page, instead of a raw 403', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  w.fake.hideFromInstallation = 'anything-llm';
  await assert.rejects(openOrUpdate(findSpec('06', w.root), {}, createPrDeps(w.root, w.env, quick())), ADD_IT);
  assert.equal(w.fake.pushes().length, 0);
});

test('so does a push, when the branches are already there', async () => {
  const w = await world();
  await w.run();
  w.fake.hideFromInstallation = 'anything-llm';
  await assert.rejects(w.run({ update: (specJson(w.fix.baseCommit).stages as { date: string }[])[1].date }), ADD_IT);
});

test('and --rerun-ci', async () => {
  const w = await world();
  await w.run();
  w.fake.hideFromInstallation = 'anything-llm';
  await assert.rejects(rerunCi(findSpec('06', w.root), createPrDeps(w.root, w.env, quick())), ADD_IT);
  assert.equal(w.fake.repo(ORG, 'anything-llm')?.pulls[0].state, 'open');
});

test('status --live names the installation before the button, even with a pull request open there', async () => {
  const w = await world();
  w.fake.addRepo(ORG, 'aura', w.fix.bare, { fork: true, parent: 'mezmo/aura' });
  await w.run();
  w.fake.hideFromInstallation = 'anything-llm';
  const status = await computeStatus({ root: w.root, env: w.env, live: true, nowMs: () => Date.now() + 600_000 });
  assert.match(status.next.command, /add anything-llm to the installation/);
});
