// Real git repos for tests: a small history, a base commit in the past, and
// real patches made with `git format-patch`. Nothing here touches the network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Upstream Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.test',
  GIT_COMMITTER_NAME: 'Upstream Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.test',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commit(dir: string, message: string, date: string): string {
  git(dir, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: dir,
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(dir, 'rev-parse', 'HEAD');
}

const MODELS_V1 = `const fallback = [\n  { name: "GPT-5", id: "gpt-5" },\n  { name: "GPT-5 Mini", id: "gpt-5-mini" },\n];\nmodule.exports = { fallback };\n`;
const MODELS_V2 = MODELS_V1.replace('];', '  { name: "GPT-6 Sol", id: "gpt-6-sol" },\n];');
const MODELS_V3 = MODELS_V2.replace('];', '  { name: "GPT-6 Luna", id: "gpt-6-luna" },\n];');
const MODELS_V4 = MODELS_V3.replace('];', '  { name: "GPT-6.1 Sol", id: "gpt-6.1-sol" },\n];');

export const PATCH_SUBJECTS = ['Add GPT-6 Sol', 'Add GPT-6 Luna', 'Add GPT-6.1 Sol'];

export interface RepoFixture {
  /** A bare repo holding main, which has moved on past baseCommit. */
  bare: string;
  baseCommit: string;
  mainTip: string;
  /** Absolute paths to real format-patch output, oldest first. */
  patches: string[];
}

/** Builds the history once per test file; callers copy `bare` with `cloneBare`. */
export function createRepoFixture(parent: string = mkdtempSync(join(tmpdir(), 'keepup-repo-'))): RepoFixture {
  const work = join(parent, 'work');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  write(work, 'server/utils/helpers/customModels.js', MODELS_V1);
  write(work, '.github/workflows/run-tests.yaml', 'name: tests\non: [pull_request]\njobs: {}\n');
  write(work, '.github/workflows/lint.yaml', 'name: lint\non: [pull_request]\njobs: {}\n');
  write(work, '.github/workflows/docker.yaml', 'name: docker\non: [push]\njobs: {}\n');
  write(work, '.github/workflows/cla.yml', 'name: CLA\non: [pull_request_target]\njobs: {}\n');
  write(work, '.github/workflows/metrics.yml', 'name: metrics\non:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}\n');
  write(work, 'README.md', '# a product\n');
  commit(work, 'first commit', '2026-09-01T09:00:00Z');
  write(work, 'README.md', '# a product\n\nIt chats with documents.\n');
  const baseCommit = commit(work, 'docs: say what it does', '2026-09-21T09:00:00Z');

  git(work, 'checkout', '-q', '-b', 'patches');
  write(work, 'server/utils/helpers/customModels.js', MODELS_V2);
  commit(work, `${PATCH_SUBJECTS[0]}\n\nGPT-6 Sol shipped on 22 Sep.`, '2026-11-01T01:00:00Z');
  write(work, 'server/utils/helpers/customModels.js', MODELS_V3);
  commit(work, `${PATCH_SUBJECTS[1]}\n\nGPT-6 Luna shipped on 22 Sep.`, '2026-11-01T02:00:00Z');
  write(work, 'server/utils/helpers/customModels.js', MODELS_V4);
  commit(work, `${PATCH_SUBJECTS[2]}\n\nGPT-6.1 Sol shipped on 29 Sep.`, '2026-11-01T03:00:00Z');
  const out = join(parent, 'patches');
  git(work, 'format-patch', '-q', baseCommit, '-o', out);
  const patches = readdirSync(out).sort().map((f) => join(out, f));

  git(work, 'checkout', '-q', 'main');
  write(work, 'README.md', '# a product\n\nIt chats with documents and agents.\n');
  const mainTip = commit(work, 'docs: later upstream work', '2026-10-30T09:00:00Z');

  const bare = join(parent, 'source.git');
  git(parent, 'clone', '-q', '--bare', '--no-local', work, bare);
  return { bare, baseCommit, mainTip, patches };
}

/** GitHub keeps a fork network's objects together, which is why GET /commits/{sha} on a fork answers for a commit only its parent holds. */
export function shareObjects(bare: string, parentBare: string): void {
  writeFileSync(join(bare, 'objects', 'info', 'alternates'), `${join(parentBare, 'objects')}\n`);
}

/** A private copy of a bare repo, set up the way GitHub serves one. */
export function cloneBare(source: string, target: string): string {
  mkdirSync(dirname(target), { recursive: true });
  git(dirname(target), 'clone', '-q', '--bare', '--no-local', source, target);
  git(target, 'config', 'http.receivepack', 'true');
  git(target, 'config', 'uploadpack.allowFilter', 'true');
  git(target, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(target, 'config', 'receive.denyNonFastForwards', 'true');
  git(target, 'config', 'receive.denyDeletes', 'true');
  return target;
}
