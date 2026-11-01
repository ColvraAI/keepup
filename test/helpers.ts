// Shared test helpers. Fixture repos live as plain folders under test/fixtures/repos,
// because a nested .git can't be committed; each test gets its own throwaway git repo.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');
export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const PATTERNS = join(FIXTURES, 'patterns');

/** npm run verify is the mode that means it: a missing clone fails loudly there, and only a plain npm test may skip. */
export function skipWithoutClone(clone: string): false | string {
  return !process.env.KEEPUP_VERIFY && !existsSync(join(ROOT, clone)) && `no clone at ${clone}; npm run clones fetches it`;
}

export function assertCloneThere(clone: string): void {
  if (!existsSync(join(ROOT, clone))) throw new Error(`${clone} is missing, so this can't be verified. Run npm run clones.`);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_AUTHOR_DATE: '2026-10-30T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-30T12:00:00Z',
    },
  }).trim();
}

export interface FixtureRepo {
  path: string;
  commit: string;
  cleanup: () => void;
}

/** `extra` adds files made at test time, such as one too big to keep in the repo. */
export function fixtureRepo(name: string, extra: Record<string, string> = {}): FixtureRepo {
  const path = mkdtempSync(join(tmpdir(), `keepup-${name.replaceAll('/', '-')}-`));
  cpSync(join(FIXTURES, 'repos', name), path, { recursive: true });
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(path, file), text);
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'add', '-A');
  git(path, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  return { path, commit: git(path, 'rev-parse', 'HEAD'), cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
