// The dashboard's side of `keepup change`: find the repo at the run's commit, stream the steps, and open a pull request on a click.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_SCANS, runChangeCommand } from '../../../src/change-cli.ts';
import { resolveCommit } from '../../../src/change-git.ts';
import { runMeasureCommand, runWithMeasurement } from '../../../src/measure-cli.ts';
import type { Run } from '../../../src/run-shape.ts';
import { type Env } from '../config.ts';
import { appIsConfigured, openLivePr } from '../live-pr.ts';
import { existingChange, savedChanges } from './saved.ts';
import type { Emit } from './server.ts';

const FETCH_LIMIT_MS = 120_000;

type Scans = { readRun: (repo: string) => Record<string, unknown> | null; clonePath: (repo: string) => string | null };
export type ChangesConfig = { root: string; scans: Scans; env: () => Env };

/** A commit fetched alone sits on no ref, and a clone of this folder copies refs, so it gets a branch. */
const PINNED_REF = 'refs/heads/keepup-pinned';

function publishedRun(root: string, repo: string): Run | null {
  const dir = join(root, 'data', 'runs');
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Run);
  return runs.find((run) => run.repo === repo && run.usage && !run.provider_only) ?? null;
}

function holds(path: string, commit: string): boolean {
  try {
    return existsSync(path) && resolveCommit(path, commit) === commit;
  } catch {
    return false;
  }
}

/** One commit, fetched into tmp/live-scans with nothing checked out: a published run's repo may not be on this machine. */
function fetchPinned(root: string, repo: string, commit: string): string {
  const dir = join(root, 'tmp', 'live-scans', `pinned-${commit.slice(0, 12)}`);
  if (holds(dir, commit)) return dir;
  mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, timeout: FETCH_LIMIT_MS, stdio: 'ignore' }).status === 0;
  if (!git('init', '-q', '--template=') || !git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, commit) || !git('update-ref', PINNED_REF, commit)) throw new Error(`Couldn’t fetch ${repo} at ${commit.slice(0, 7)}.`);
  return dir;
}

function pathFor(root: string, repo: string, commit: string): string {
  const name = repo.split('/')[1] ?? repo;
  const local = [join(root, 'tmp', name), join(root, 'tmp', 'scan-repos', name)].find((path) => holds(path, commit));
  return local ?? fetchPinned(root, repo, commit);
}

export function createChanges(config: ChangesConfig) {
  const { root, scans } = config;

  const runFor = (repo: string): Run & { commit: string } => {
    const run = (scans.readRun(repo) as unknown as Run | null) ?? publishedRun(root, repo);
    if (!run) throw new Error('Check that repo again first: its run has been cleaned up.');
    if (!run.commit) throw new Error(`This run was read from uncommitted changes${run.base_commit ? ` on top of ${run.base_commit.slice(0, 7)}` : ''}, so it has no commit to work from. Commit them, or check the repo again.`);
    return run as Run & { commit: string };
  };

  const change = async (repo: string, rank: number, emit: Emit, signal: AbortSignal): Promise<void> => {
    const run = runFor(repo);
    const made = existingChange(LIVE_SCANS, repo, run.commit, rank);
    if (made) {
      emit({ type: 'change', change: made });
      emit({ type: 'done' });
      return;
    }
    const clone = scans.clonePath(repo);
    const path = clone && holds(clone, run.commit) ? clone : pathFor(root, repo, run.commit);
    if (signal.aborted) return;
    const result = await runChangeCommand({ path, run, rank, base: LIVE_SCANS, onStep: (name, detail) => emit({ type: 'step', name, detail }) });
    emit({ type: 'change', change: result });
    emit({ type: 'done' });
  };

  const measure = async (repo: string, rank: number, emit: Emit, signal: AbortSignal): Promise<void> => {
    const run = runFor(repo);
    const clone = scans.clonePath(repo);
    const path = clone && holds(clone, run.commit as string) ? clone : pathFor(root, repo, run.commit as string);
    if (signal.aborted) return;
    const result = await runMeasureCommand({ path, run, rank, base: LIVE_SCANS, onStep: (name, detail) => emit({ type: 'step', name, detail }) });
    const dir = join(root, 'data', 'runs');
    const file = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name)).find((path2) => { const held = JSON.parse(readFileSync(path2, 'utf8')) as Run; return held.repo === repo && held.commit === run.commit && !held.provider_only; }) : undefined;
    if (file) writeFileSync(file, `${JSON.stringify(runWithMeasurement(JSON.parse(readFileSync(file, 'utf8')) as Run, result), null, 1)}\n`);
    emit({ type: 'measure', measure: result });
    emit({ type: 'done' });
  };

  return {
    change,
    measure,
    openPr: (changeId: string) => openLivePr({ root, base: LIVE_SCANS, changeId, env: config.env() }),
    readRun: scans.readRun,
    savedChanges: (repo: string) => savedChanges(LIVE_SCANS, repo),
    appConfigured: () => appIsConfigured(config.env(), root),
  };
}
