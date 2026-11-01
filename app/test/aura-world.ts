// A fork of the kind setup really makes, with AURA's spec on it: its CI file, and workflows that really run once its gate is open.
import { join } from 'node:path';
import { createPrDeps, openOrUpdate, type PrDeps } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import { createWorld, installSpec, ORG, writeText, type World } from './world.ts';

export const AURA_SPEC = { id: '04', spec: 'docs/prs/04.md', upstream: 'mezmo/aura', fork: 'aura', ciWorkflow: 'lab/ci/aura.yml', branch: 'keepup/2026-09-25-mcp' };
export const CI_FILE = 'name: keepup CI\non:\n  pull_request:\njobs: {}\n';

export const quick = (over: Partial<PrDeps> = {}) => {
  let clock = 0;
  return { sleep: async () => { clock += 10_000; }, nowMs: () => clock, now: () => new Date('2026-11-01T09:00:00Z'), ...over };
};

/** A fresh fork of the kind setup really makes: no workflows listed, gate closed, real runs once it opens. */
export async function auraWorld(gateOpen = true): Promise<World> {
  const w = await createWorld();
  const upstream = w.fake.addRepo('mezmo', 'aura', w.fix.bare);
  w.fake.addRepo(ORG, 'aura', upstream.bare, { fork: true, parent: 'mezmo/aura', workflowRuntime: true, gateOpen });
  installSpec(w.root, w.fix, { labDir: 'lab/04-mcp', overrides: AURA_SPEC });
  writeText(join(w.root, 'lab/ci/aura.yml'), CI_FILE);
  return w;
}

export function allmWorld(world: World, gateOpen: boolean): void {
  const fork = world.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.workflowRuntime = true;
  fork.gateOpen = gateOpen;
  fork.workflows = [];
}

export const aura = (w: World) => {
  const repo = w.fake.repo(ORG, 'aura');
  if (!repo) throw new Error('fixture');
  return repo;
};

export const open = (w: World, id: string, deps: Partial<PrDeps> = {}) => openOrUpdate(findSpec(id, w.root), {}, createPrDeps(w.root, w.env, quick(deps)));
