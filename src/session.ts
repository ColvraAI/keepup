// What the plugin path remembers between keepup commands, in the plugin's data folder: the prepared files, and a log of
// the searches, bundles and reads that really happened, so a brief's coverage line is written from what ran and not from what a model says ran.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const LOG = 'session-log.jsonl';
const SEARCHES_PER_JOB = 2;
const BUNDLE_READ = /^bundles\.(jobs|patterns)\.\d+$/;

/** What keepup bundles built, and how much of it the session really read. */
export interface BundleCoverage {
  readonly jobs: number;
  readonly jobs_read: number;
  /** The jobs in the profile, which is more than jobs when one matched nothing. */
  readonly job_total: number;
  readonly patterns: number;
  readonly patterns_read: number;
  readonly candidates_read: number;
  /** The jobs that matched nothing in the database, so they have no bundle. */
  readonly unmatched?: readonly string[];
}

export interface SessionLog {
  readonly searches: number;
  readonly reads: number;
  readonly bundles?: BundleCoverage;
}

/** What the program counted when it logged an event, never what a model says it did. */
type EventCounts = Readonly<Record<string, number | readonly string[]>>;

interface LogLine {
  readonly kind?: string;
  readonly detail?: string;
  readonly jobs?: number;
  readonly job_total?: number;
  readonly patterns?: number;
  readonly candidates?: number;
  readonly unmatched?: readonly string[];
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
export function logEvent(dir: string | undefined, kind: 'search' | 'read' | 'bundles', detail: string, counts: EventCounts = {}): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, LOG), `${JSON.stringify({ kind, detail, ...counts, at: new Date().toISOString() })}\n`);
  } catch {
    // Nothing to do.
  }
}

function logLines(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as LogLine];
    } catch {
      return [];
    }
  });
}

const isBundleRead = (line: LogLine): boolean => line.kind === 'read' && BUNDLE_READ.test(line.detail ?? '');

/** One bundle read twice is one bundle. */
function distinctReads(lines: readonly LogLine[], prefix: string): LogLine[] {
  const reads = lines.filter((line) => isBundleRead(line) && (line.detail ?? '').startsWith(prefix));
  return [...new Map(reads.map((line) => [line.detail, line])).values()];
}

/** Patterns are built once, by keepup prepare. Jobs are built again by each keepup bundles, so only what was read since the last one counts. */
function bundleCoverage(lines: readonly LogLine[]): BundleCoverage | undefined {
  const last = lines.findLastIndex((line) => line.kind === 'bundles');
  if (last === -1) return undefined;
  const built = lines[last];
  const jobReads = distinctReads(lines.slice(last), 'bundles.jobs.');
  return {
    jobs: built.jobs ?? 0,
    jobs_read: jobReads.length,
    job_total: built.job_total ?? 0,
    patterns: built.patterns ?? 0,
    patterns_read: distinctReads(lines, 'bundles.patterns.').length,
    candidates_read: jobReads.reduce((sum, line) => sum + (line.candidates ?? 0), 0),
    ...(built.unmatched?.length ? { unmatched: built.unmatched } : {}),
  };
}

export function readLog(dir: string): SessionLog {
  const lines = logLines(join(dir, LOG));
  const plainReads = lines.filter((line) => line.kind === 'read' && !isBundleRead(line)).length;
  const bundleReads = new Set(lines.filter(isBundleRead).map((line) => line.detail)).size;
  const bundles = bundleCoverage(lines);
  return { searches: lines.filter((line) => line.kind === 'search').length, reads: plainReads + bundleReads, ...(bundles ? { bundles } : {}) };
}

/** Every bundle the program built was read, and at least one was for a job, or, for a session that never built any, two searches a job. Otherwise a run hasn't earned the database's count: with no job bundle, nothing was compared with it. */
export function coverageHolds(log: SessionLog, jobs: number): boolean {
  if (log.bundles) return log.bundles.jobs > 0 && log.bundles.jobs_read >= log.bundles.jobs && log.bundles.patterns_read >= log.bundles.patterns && log.reads > 0;
  return jobs > 0 && log.searches >= jobs * SEARCHES_PER_JOB && log.reads > 0;
}

/** What a brief may say ran. Candidates and jobs appear only when the bundles really ran. */
export function coverageFacts(log: SessionLog): { readonly searches: number; readonly reads: number; readonly candidates?: number; readonly jobs?: number } {
  return { searches: log.searches, reads: log.reads, ...(log.bundles ? { candidates: log.bundles.candidates_read, jobs: log.bundles.job_total } : {}) };
}

/** Why a run hasn't earned the database's count, in what really ran. */
export function coverageShortfall(log: SessionLog, jobs: number): string {
  if (!log.bundles) return `${log.searches} searches ran for ${jobs} jobs, and it takes ${SEARCHES_PER_JOB} for each, with at least one read`;
  const { jobs_read, jobs: built, patterns_read, patterns, unmatched = [] } = log.bundles;
  if (built === 0) return `${unmatched.length ? `nothing in the database matched ${unmatched.join(', ')}, so ` : ''}no job bundle was built, and ${patterns_read} of ${patterns} pattern bundles read`;
  return `${jobs_read} of ${built} job bundles and ${patterns_read} of ${patterns} pattern bundles read, and it takes all of them`;
}
