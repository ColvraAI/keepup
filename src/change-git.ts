// The temporary clone a change goes into. Plumbing only: no checkout, no working tree, so no filter, hook, symlink or
// file from the repo ever gets a chance to run. 
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoFile } from './change-checks.ts';

const GIT_LIMIT_MS = 120_000;
const MAX_OUTPUT = 64_000_000;
const SAFE_CONFIG = ['core.hooksPath=/dev/null', 'core.symlinks=false', 'core.fsmonitor=false', 'core.attributesFile=/dev/null', 'diff.external=', 'commit.gpgsign=false'];
const IDENTITY = { GIT_AUTHOR_NAME: 'keepup', GIT_AUTHOR_EMAIL: 'keepup@users.noreply.github.com', GIT_COMMITTER_NAME: 'keepup', GIT_COMMITTER_EMAIL: 'keepup@users.noreply.github.com' };

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra };
}

function git(cwd: string, args: readonly string[], options: { input?: string; env?: Record<string, string> } = {}): string {
  const config = SAFE_CONFIG.flatMap((item) => ['-c', item]);
  const result = spawnSync('git', [...config, ...args], { cwd, input: options.input, env: cleanEnv(options.env), encoding: 'utf8', timeout: GIT_LIMIT_MS, maxBuffer: MAX_OUTPUT });
  if (result.error) throw new Error(`git ${args[0]} couldn't run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr ?? '').trim().slice(0, 300)}`);
  return result.stdout;
}

export function resolveCommit(path: string, commit: string | undefined): string {
  return git(path, ['rev-parse', '--verify', `${commit ?? 'HEAD'}^{commit}`]).trim();
}

/** A file's bytes and mode at a commit, read from git and never from a working tree. */
export function readAtCommit(path: string, commit: string, file: string): RepoFile {
  const listed = git(path, ['ls-tree', commit, '--', file]).trim();
  if (!listed) return { text: '', mode: null, binary: false };
  const mode = listed.split(/\s/)[0] ?? null;
  const result = spawnSync('git', ['show', `${commit}:${file}`], { cwd: path, env: cleanEnv(), timeout: GIT_LIMIT_MS, maxBuffer: MAX_OUTPUT });
  if (result.status !== 0) throw new Error(`Can't read ${file} at ${commit}.`);
  const text = result.stdout.toString('utf8');
  return { text, mode, binary: result.stdout.includes(0), notUtf8: !Buffer.from(text, 'utf8').equals(result.stdout) };
}

export function slugFrom(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'change';
}

export interface Committed {
  readonly sha: string;
  readonly diff: string;
  readonly patch: string;
}

export interface CommitInput {
  readonly source: string;
  readonly clone: string;
  readonly commit: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly files: ReadonlyMap<string, string>;
  readonly at: Date;
}

/** One commit on a new branch in a new clone. The source repo is only read, and nothing is pushed. */
export function commitInClone(input: CommitInput): Committed {
  const { source, clone, commit, branch, files } = input;
  mkdirSync(join(clone, '..'), { recursive: true });
  git(join(clone, '..'), ['clone', '--quiet', '--no-checkout', '--template=', ...SAFE_CONFIG.flatMap((item) => ['-c', item]), source, clone]);
  git(clone, ['read-tree', commit]);
  for (const [file, text] of files) {
    const blob = git(clone, ['hash-object', '-w', '--no-filters', '--stdin'], { input: text }).trim();
    git(clone, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
  }
  const tree = git(clone, ['write-tree']).trim();
  const date = input.at.toISOString();
  const env = { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const sha = git(clone, ['commit-tree', tree, '-p', commit, '-F', '-'], { input: `${input.title}\n\n${input.body}\n`, env }).trim();
  git(clone, ['update-ref', `refs/heads/${branch}`, sha]);
  return {
    sha,
    diff: git(clone, ['diff', '--no-ext-diff', '--no-textconv', commit, sha]),
    patch: git(clone, ['format-patch', '-1', '--stdout', '--no-ext-diff', '--no-textconv', sha]),
  };
}
