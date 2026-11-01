// The code a lab run exercises: the base commit plus the patches, in order.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

function git(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** tmp/lab-wt-<id>: a real worktree, for a real run. It replaces any earlier one. */
export function prepareWorktree(clone: string, dest: string, base: string, patches: readonly string[]): void {
  removeWorktree(clone, dest);
  git(['-C', clone, 'worktree', 'add', '--quiet', '--detach', dest, base]);
  for (const patch of patches) git(['apply', '--whitespace=nowarn', patch], dest);
}

export function removeWorktree(clone: string, dest: string): void {
  if (existsSync(dest)) git(['-C', clone, 'worktree', 'remove', '--force', dest]);
  git(['-C', clone, 'worktree', 'prune']);
}

/** The files a patch changes that must already exist at the base commit. New files aren't among them. */
export function changedPaths(patchText: string): string[] {
  return [...patchText.matchAll(/^--- a\/(.+)$/gm)].map((match) => match[1]);
}

/**
 * For a dry run: the named paths and every file the patches change, at the base commit, unpacked
 * outside the clone so nothing is written to it. The ceiling stops git finding this repo's own
 * .git above dest, where `git apply` would silently skip every path outside its current folder.
 */
export function prepareArchiveTree(clone: string, dest: string, base: string, patches: readonly string[], paths: readonly string[]): void {
  mkdirSync(dest, { recursive: true });
  const changed = patches.flatMap((patch) => changedPaths(readFileSync(patch, 'utf8')));
  const tar = join(dest, '.base.tar');
  git(['-C', clone, 'archive', `--output=${tar}`, base, '--', ...new Set([...paths, ...changed])]);
  execFileSync('tar', ['-xf', tar, '-C', dest]);
  rmSync(tar);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dest) };
  for (const patch of patches) git(['apply', '--whitespace=nowarn', patch], dest, env);
}
