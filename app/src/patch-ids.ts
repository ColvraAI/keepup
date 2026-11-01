// What a stage's patches change, as git sees it: the same patch-id D29 compares against the fork.
// Recorded when a pull request is written, so go and status can see a patch that moved since, with no network.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { PrSpec } from './specs.ts';

export function patchIdSync(patchFile: string): string {
  const result = spawnSync('git', ['patch-id', '--stable'], {
    input: readFileSync(patchFile), cwd: tmpdir(), encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (result.status !== 0) throw new Error(`git patch-id couldn't read ${patchFile}.`);
  return result.stdout.split(/\s+/)[0] ?? '';
}

export function stagePatchIds(spec: PrSpec, dates: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(spec.stages.filter((s) => dates.includes(s.date)).map((s) => [s.date, s.patchFiles.map(patchIdSync)]));
}

/** False when a stage's patch on disk isn't what was recorded when it went to the fork, or the record predates this. */
export function patchesCurrent(spec: PrSpec, record: { stagesApplied: string[]; patchIds?: Record<string, string[]> }): boolean {
  const now = stagePatchIds(spec, record.stagesApplied);
  return Object.entries(now).every(([date, ids]) => JSON.stringify(record.patchIds?.[date]) === JSON.stringify(ids));
}
