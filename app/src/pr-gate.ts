// Forks don't run workflows until someone presses the button in the Actions tab. The API can't
// say whether it was pressed, and a pull request opened before that gets no run, ever. So the
// only evidence is a run on the pull request's own commit, and the only remedy is a new event.
import { readCi } from './ci.ts';
import { getBotIdentity, isNotCovered, isStatus, notCoveredLine } from './github.ts';
import { readObjects, recordsFor, updateObjects, withPr } from './objects.ts';
import { PrStateError, type PrDeps, type Pull } from './pr-types.ts';
import type { PrSpec } from './specs.ts';

export const actionsPage = (org: string, fork: string) => `https://github.com/${org}/${fork}/actions`;

export function buttonLine(org: string, fork: string): string {
  return `Open ${actionsPage(org, fork)}. If GitHub shows "I understand my workflows, go ahead and enable them", press it: workflows don't run on a fork until someone does. If there's no button and the tab says Actions is disabled, check https://github.com/organizations/${org}/settings/actions, then run npm run setup -- --org ${org}.`;
}

interface PrFacts { state: string; ci: { state: string } }

/** A fork already known to run workflows: a pull request on it has a CI state from somewhere. */
export function forksSeenRunning(specs: PrSpec[], prs: Record<string, PrFacts>): Set<string> {
  return new Set(specs.filter((s) => (prs[s.id]?.ci.state ?? 'none') !== 'none').map((s) => s.fork));
}

/** Forks with an open pull request, and no pull request that has ever shown a check. Oldest replay date first, as specs are. */
export function silentForks(specs: PrSpec[], prs: Record<string, PrFacts>): { fork: string; ids: string[] }[] {
  const running = forksSeenRunning(specs, prs);
  const silent = specs.filter((s) => prs[s.id]?.state === 'open' && prs[s.id].ci.state === 'none' && !running.has(s.fork));
  return [...new Set(silent.map((s) => s.fork))].map((fork) => ({ fork, ids: silent.filter((s) => s.fork === fork).map((s) => s.id) }));
}

async function findOpenPull(spec: PrSpec, deps: PrDeps): Promise<Pull> {
  const owner = deps.org;
  const pulls = await deps.octokit.paginate('GET /repos/{owner}/{repo}/pulls', { owner, repo: spec.fork, state: 'all', head: `${owner}:${spec.branch}`, per_page: 100 });
  const identity = await getBotIdentity(deps.octokit, deps.slug);
  const mine = pulls.filter((p) => p.user?.login === identity.login);
  const open = mine.find((p) => p.state === 'open');
  if (!open) throw new PrStateError(`PR ${spec.id} has no open pull request on ${spec.branch}${mine.length ? ` (it's ${mine[0].merged_at ? 'merged' : 'closed'})` : ''}, so there's nothing to run CI on.`);
  return open;
}

/** The pull request object can lag a push, so the branch itself says which commit is newest. */
export async function branchTip(spec: PrSpec, deps: PrDeps): Promise<string | null> {
  try {
    const { data } = await deps.octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner: deps.org, repo: spec.fork, ref: `heads/${spec.branch}` });
    return data.object.sha;
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

export interface GateCheck { running: boolean; number: number; sha: string; url: string; runs: number }

/** A run on the commit is real news: status and the next go must stop sending people to the button. What's recorded is what GitHub reports. */
async function recordFirstSight(spec: PrSpec, deps: PrDeps, sha: string): Promise<void> {
  const record = recordsFor(readObjects(deps.root), deps.org).prs[spec.id];
  if (!record || record.ci.state !== 'none') return;
  const ci = await readCi(deps.octokit, deps.org, spec.fork, sha);
  updateObjects(deps.root, (o) => withPr(o, spec.id, { ...record, ci, checkedAt: deps.now().toISOString() }));
}

/** Waits a bounded time for any workflow run on the pull request's newest commit. */
export async function checkActions(spec: PrSpec, deps: PrDeps): Promise<GateCheck> {
  const pull = await findOpenPull(spec, deps);
  const owner = deps.org;
  const sha = (await branchTip(spec, deps)) ?? pull.head.sha;
  const started = deps.nowMs();
  for (;;) {
    const { data } = await deps.octokit.request('GET /repos/{owner}/{repo}/actions/runs', { owner, repo: spec.fork, head_sha: sha, per_page: 1 });
    if (data.total_count > 0) {
      await recordFirstSight(spec, deps, sha);
      return { running: true, number: pull.number, sha, url: pull.html_url, runs: data.total_count };
    }
    if (deps.nowMs() - started >= deps.gateWindowMs) return { running: false, number: pull.number, sha, url: pull.html_url, runs: 0 };
    await deps.sleep(deps.gatePollMs);
  }
}

/** Closes and reopens the pull request, which fires a new `reopened` event. The App can't push: every stage is already there. */
export async function rerunCi(spec: PrSpec, deps: PrDeps): Promise<Pull> {
  const pull = await findOpenPull(spec, deps);
  const params = { owner: deps.org, repo: spec.fork, pull_number: pull.number };
  try {
    await deps.octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...params, state: 'closed' });
  } catch (e) {
    if (isNotCovered(e)) throw new PrStateError(notCoveredLine(deps.org, spec.fork, deps.env.GITHUB_APP_INSTALLATION_ID));
    throw e;
  }
  try {
    await deps.octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...params, state: 'open' });
  } catch (e) {
    throw new PrStateError(`Pull request #${pull.number} was closed to rerun CI and couldn't be reopened. Reopen it by hand: ${pull.html_url} (${(e as Error).message})`);
  }
  deps.log(`Closed and reopened #${pull.number}, which asks GitHub for a new CI run.`);
  return pull;
}
