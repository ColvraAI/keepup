// The code a real lab run exercises: the base commit plus the patches, in order.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(args: readonly string[], cwd?: string): void {
  execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function removeWorktree(clone: string, dest: string): void {
  if (existsSync(dest)) git(['-C', clone, 'worktree', 'remove', '--force', dest]);
  git(['-C', clone, 'worktree', 'prune']);
}

/** tmp/lab-wt-04: a real worktree for a real run. It replaces any earlier one. */
export function prepareWorktree(clone: string, dest: string, base: string, patches: readonly string[]): void {
  removeWorktree(clone, dest);
  git(['-C', clone, 'worktree', 'add', '--quiet', '--detach', dest, base]);
  for (const patch of patches) git(['apply', '--whitespace=nowarn', patch], dest);
}
