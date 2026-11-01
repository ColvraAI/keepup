// What the plugin path remembers between keepup commands, in the plugin's data folder: the prepared files, and a log of
// the searches and reads that really happened, so a brief's coverage line is written from what ran and not from what a model says ran.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const LOG = 'session-log.jsonl';
const SEARCHES_PER_JOB = 2;

export interface SessionLog {
  readonly searches: number;
  readonly reads: number;
}

/** A plugin's data folder is shared by every repo, so in a session each project gets its own: two open repos must never read each other's files. */
function ownFolder(dir: string, env: NodeJS.ProcessEnv): string {
  if (env.KEEPUP_PLUGIN !== '1') return dir;
  const project = realpathSync(env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const safeName = basename(project).replace(/[^\w.-]/g, '-');
  return join(dir, 'repos', `${safeName}-${createHash('sha256').update(project).digest('hex').slice(0, 10)}`);
}

export function dataDir(given?: string, env: NodeJS.ProcessEnv = process.env): string {
  return ownFolder(given ?? env.CLAUDE_PLUGIN_DATA ?? join(homedir(), '.keepup'), env);
}

export function resetLog(dir: string): void {
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, LOG), { force: true });
}

/** Never gets in the way: a log that can't be written means a brief claims less, not that a command fails. */
export function logEvent(dir: string | undefined, kind: 'search' | 'read', detail: string): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, LOG), `${JSON.stringify({ kind, detail, at: new Date().toISOString() })}\n`);
  } catch {
    // Nothing to do.
  }
}

export function readLog(dir: string): SessionLog {
  const path = join(dir, LOG);
  if (!existsSync(path)) return { searches: 0, reads: 0 };
  const kinds = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [(JSON.parse(line) as { kind?: string }).kind];
    } catch {
      return [];
    }
  });
  return { searches: kinds.filter((kind) => kind === 'search').length, reads: kinds.filter((kind) => kind === 'read').length };
}

/** At least two searches for every job, and at least one read. Otherwise a run hasn't earned the database's count. */
export function coverageHolds(log: SessionLog, jobs: number): boolean {
  return jobs > 0 && log.searches >= jobs * SEARCHES_PER_JOB && log.reads > 0;
}
