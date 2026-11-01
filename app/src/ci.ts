// The state of a commit's checks, as GitHub reports it. Success is earned: at least
// one check succeeded and nothing failed or is still running.
import type { Client } from './github.ts';
import type { CiRecord } from './objects.ts';

const FAILING = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export interface CheckLike { status: string; conclusion: string | null; html_url: string | null; details_url: string | null; check_suite?: { id: number } | null }
export interface CombinedStatus { state: string; total_count: number; statuses: { state: string; target_url: string | null }[] }

const linkOf = (c: CheckLike | undefined): string | null => c?.html_url ?? c?.details_url ?? null;

export function summarise(checks: CheckLike[], combined: CombinedStatus): CiRecord {
  const hasStatuses = combined.total_count > 0;
  const failing = checks.find((c) => c.status === 'completed' && FAILING.has(c.conclusion ?? ''));
  const badStatus = hasStatuses ? combined.statuses.find((s) => s.state === 'failure' || s.state === 'error') : undefined;
  if (failing) return { state: 'failure', url: linkOf(failing) };
  if (badStatus) return { state: 'failure', url: badStatus.target_url };
  if (checks.length === 0 && !hasStatuses) return { state: 'none', url: null };
  const running = checks.find((c) => c.status !== 'completed');
  const pendingStatus = hasStatuses && combined.state === 'pending';
  if (running || pendingStatus) return { state: 'pending', url: linkOf(running ?? checks[0]) ?? combined.statuses[0]?.target_url ?? null };
  const passed = checks.find((c) => c.conclusion === 'success');
  if (passed || (hasStatuses && combined.state === 'success')) return { state: 'success', url: linkOf(passed) ?? combined.statuses[0]?.target_url ?? null };
  return { state: 'neutral', url: linkOf(checks[0]) };
}

export interface RunLike { id?: number; path: string; status: string | null; conclusion: string | null; html_url: string; run_number?: number; created_at?: string; check_suite_id?: number }

/** The workflow that actually runs each fork's tests. Other checks passing doesn't mean the tests did. */
export const REQUIRED_WORKFLOW: Record<string, string> = { 'anything-llm': 'run-tests.yaml', aura: 'keepup-ci.yml' };

const fileOfRun = (run: RunLike) => (run.path.split('@')[0].split('/').pop() ?? '');

export function readRuns(octokit: Client, owner: string, repo: string, sha: string): Promise<RunLike[]> {
  return octokit.paginate('GET /repos/{owner}/{repo}/actions/runs', { owner, repo, head_sha: sha, per_page: 100 });
}

function isNewer(run: RunLike, than: RunLike): boolean {
  const order = (run.created_at ?? '').localeCompare(than.created_at ?? '');
  return order !== 0 ? order > 0 : (run.id ?? 0) >= (than.id ?? 0);
}

/** A rerun leaves the older run in the list, so only the newest of a workflow's runs counts. */
export function newestRun(runs: RunLike[], file: string): RunLike | undefined {
  return runs.filter((r) => fileOfRun(r) === file).reduce<RunLike | undefined>((best, r) => (!best || isNewer(r, best) ? r : best), undefined);
}

const newestRuns = (runs: RunLike[]): RunLike[] => [...new Set(runs.map(fileOfRun))].flatMap((file) => newestRun(runs, file) ?? []);

/**
 * Each event on a commit makes a new check suite, and filter=latest keeps the older suites' check runs in the list.
 * So a check run from a superseded workflow run says nothing about this commit now. A check run no workflow run owns stays.
 */
function currentChecks<T extends CheckLike>(checks: T[], runs: RunLike[]): T[] {
  const newest = new Set(newestRuns(runs).map((r) => r.check_suite_id));
  const superseded = new Set(runs.map((r) => r.check_suite_id).filter((id) => id !== undefined && !newest.has(id)));
  return checks.filter((c) => c.check_suite?.id === undefined || !superseded.has(c.check_suite.id));
}

const notDone = (run: RunLike | undefined): RunLike | undefined => (run && run.status !== 'completed' ? run : undefined);

export interface CiReading {
  ci: CiRecord;
  /** The checks are green and the test workflow has no run on this commit: not yet, or, with a paths filter, never. */
  requiredMissing: boolean;
}

export async function readCiReading(octokit: Client, owner: string, repo: string, sha: string): Promise<CiReading> {
  const checks = await octokit.paginate('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { owner, repo, ref: sha, per_page: 100 });
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', { owner, repo, ref: sha });
  const runs = await readRuns(octokit, owner, repo, sha);
  const newest = newestRuns(runs);
  const current = currentChecks(checks, runs);
  // A queued run can come before its check runs do, and that's still not "no CI".
  const found = current.length ? current : newest.map((r) => ({ status: r.status ?? 'queued', conclusion: r.conclusion, html_url: r.html_url, details_url: null }));
  const ci = summarise(found, data);
  if (ci.state === 'failure' || ci.state === 'none') return { ci, requiredMissing: false };
  const required = REQUIRED_WORKFLOW[repo];
  const requiredRun = required ? newestRun(runs, required) : undefined;
  const running = notDone(requiredRun) ?? newest.find((r) => notDone(r));
  if (running) return { ci: { state: 'pending', url: running.html_url }, requiredMissing: false };
  if (ci.state !== 'success' || !required) return { ci, requiredMissing: false };
  if (!requiredRun) return { ci: { state: 'neutral', url: ci.url }, requiredMissing: true };
  return { ci: requiredRun.conclusion === 'success' ? ci : { state: 'neutral', url: ci.url }, requiredMissing: false };
}

export async function readCi(octokit: Client, owner: string, repo: string, sha: string): Promise<CiRecord> {
  return (await readCiReading(octokit, owner, repo, sha)).ci;
}

export const CI_DONE = new Set(['success', 'failure', 'neutral']);
const LOG_EVERY_MS = 60_000;

export interface WaitOptions {
  timeoutMs: number;
  /** How long to wait while GitHub reports no checks at all, or no run of the test workflow. A queued run already shows up, so silence this long means nothing is coming. */
  noneTimeoutMs?: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  log?: (line: string) => void;
}

export async function waitForCi(octokit: Client, owner: string, repo: string, sha: string, opts: WaitOptions): Promise<{ ci: CiRecord; timedOut: boolean }> {
  const started = opts.nowMs();
  const silenceLimit = Math.min(opts.noneTimeoutMs ?? opts.timeoutMs, opts.timeoutMs);
  let lastLog: { state: string; at: number } | null = null;
  for (;;) {
    const { ci, requiredMissing } = await readCiReading(octokit, owner, repo, sha);
    const now = opts.nowMs();
    const finished = requiredMissing ? now - started >= silenceLimit : CI_DONE.has(ci.state);
    if (finished) return { ci, timedOut: false };
    if (!requiredMissing && now - started >= (ci.state === 'none' ? silenceLimit : opts.timeoutMs)) return { ci, timedOut: true };
    if (!lastLog || lastLog.state !== ci.state || now - lastLog.at >= LOG_EVERY_MS) {
      opts.log?.(`CI on ${owner}/${repo}: ${requiredMissing ? "no run of the test workflow yet" : ci.state}${ci.url ? ` (${ci.url})` : ''}, ${Math.round((now - started) / 60_000)} min in.`);
      lastLog = { state: ci.state, at: now };
    }
    await opts.sleep(opts.pollMs);
  }
}
