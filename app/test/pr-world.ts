// A world with one spec installed, and a run() that opens or updates its pull request.
import { createPrDeps, openOrUpdate, type PrOptions } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import { createWorld, installSpec, MEASURED_RESULT, type World } from './world.ts';

export async function world(overrides: Record<string, unknown> = {}, result: string | null = MEASURED_RESULT, id = '06'): Promise<World & { run: (o?: PrOptions) => ReturnType<typeof openOrUpdate>; id: string }> {
  const w = await createWorld();
  installSpec(w.root, w.fix, { overrides, result });
  const deps = () => createPrDeps(w.root, w.env, { sleep: async () => undefined, now: () => new Date('2026-11-01T09:00:00Z') });
  return { ...w, id, run: (o = {}) => openOrUpdate(findSpec(id, w.root), o, deps()) };
}
