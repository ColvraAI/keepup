// status --live: asks GitHub instead of trusting data/github-objects.json, one fork at a time,
// so a fork the installation can't reach doesn't cost the view of the other one.
import { readCi } from './ci.ts';
import type { AppConfig } from './config.ts';
import { describeApiError, isStatus, type Client } from './github.ts';
import type { GithubObjects, PrRecord } from './objects.ts';
import { bodyDigest } from './objects.ts';
import { appliedFrom, pullCommits, stageSubjects } from './pr-branch.ts';
import { actionsPage, buttonLine } from './pr-gate.ts';
import { WORKFLOW_ALLOWLIST } from './setup-forks.ts';
import type { PrSpec } from './specs.ts';
import { FORK_NAMES } from './status-terms.ts';

/** running: a run proves it. unknown: nothing can tell before a pull request exists. waiting: just pushed. closed: no run where there should be one. */
export type GateState = 'running' | 'unknown' | 'waiting' | 'closed' | 'unreachable';
export interface ActionsLine { fork: string; ok: boolean; state: GateState; detail: string }
export interface LiveView { objects: GithubObjects; actions: ActionsLine[]; missingForks: string[]; notes: string[] }

/** How long after the last push a pull request with no runs starts to mean the gate is closed. */
const GRACE_MS = 60_000;

interface LiveHead { id: string; fork: string; sha: string; updatedAt: string | null; open: boolean }

const forkOf = (record: PrRecord, spec: PrSpec | undefined) => spec?.fork ?? record.url.split('/')[4];

async function branchSha(octokit: Client, org: string, fork: string, branch: string): Promise<string | null> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner: org, repo: fork, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

async function liveStages(octokit: Client, org: string, fork: string, spec: PrSpec | undefined, number: number, fallback: string[]): Promise<string[]> {
  if (!spec) return fallback;
  const onRemote = await pullCommits(octokit, org, fork, number);
  return appliedFrom(spec.stages, await stageSubjects(spec), onRemote.map((c) => c.subject)).map((s) => s.date);
}

async function readPull(octokit: Client, org: string, id: string, record: PrRecord, spec: PrSpec | undefined): Promise<{ record: PrRecord; head: LiveHead }> {
  const fork = forkOf(record, spec);
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: org, repo: fork, pull_number: record.number });
  const sha = (await branchSha(octokit, org, fork, data.head.ref)) ?? data.head.sha;
  const live: PrRecord = {
    ...record,
    title: data.title,
    state: data.merged_at ? 'merged' : data.state,
    author: data.user.login,
    base: data.base.ref,
    head: data.head.ref,
    stagesApplied: await liveStages(octokit, org, fork, spec, record.number, record.stagesApplied),
    ci: await readCi(octokit, org, fork, sha),
    bodyDigest: bodyDigest(data.body),
  };
  return { record: live, head: { id, fork, sha, updatedAt: data.updated_at ?? null, open: data.state === 'open' } };
}

async function issueExists(octokit: Client, org: string, fork: string, number: number): Promise<boolean> {
  try {
    await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner: org, repo: fork, issue_number: number });
    return true;
  } catch (e) {
    if (isStatus(e, 404) || isStatus(e, 410)) return false;
    throw e;
  }
}

const fileName = (path: string) => path.split('/').pop() ?? path;

/** Workflow state says little on a fork. It only tells which stray workflows are still switched on. */
async function strayWorkflows(octokit: Client, org: string, fork: string): Promise<string[]> {
  const allow = WORKFLOW_ALLOWLIST[fork] ?? [];
  const workflows = await octokit.paginate('GET /repos/{owner}/{repo}/actions/workflows', { owner: org, repo: fork, per_page: 100 });
  return workflows.filter((w) => w.path.startsWith('.github/') && !allow.includes(fileName(w.path)) && w.state === 'active').map((w) => fileName(w.path));
}

/** Runs are the only real evidence that the fork's Actions gate is open. */
async function gateLine(octokit: Client, org: string, fork: string, heads: LiveHead[], nowMs: number): Promise<ActionsLine> {
  const open = heads.filter((h) => h.open);
  const button = `${buttonLine(org, fork)} Then run npm run go, which reruns CI on what's already open.`;
  if (open.length === 0) return { fork, ok: false, state: 'unknown', detail: `The API can't tell until a pull request exists on it, so look at ${actionsPage(org, fork)}. ${buttonLine(org, fork)}` };
  const counts = await Promise.all(open.map(async (h) => (await octokit.request('GET /repos/{owner}/{repo}/actions/runs', { owner: org, repo: fork, head_sha: h.sha, per_page: 1 })).data.total_count));
  if (counts.some((c) => c > 0)) return { fork, ok: true, state: 'running', detail: `workflows ran on ${counts.filter((c) => c > 0).length} of ${open.length} open pull requests` };
  const newest = Math.max(...open.map((h) => (h.updatedAt ? Date.parse(h.updatedAt) : 0)));
  if (nowMs - newest < GRACE_MS) return { fork, ok: false, state: 'waiting', detail: 'just pushed, and no run has shown up yet. Look again in a minute.' };
  return { fork, ok: false, state: 'closed', detail: `Actions isn't running: no workflow run on any of ${open.length} open pull request${open.length === 1 ? '' : 's'} (${open.map((h) => h.id).join(', ')}). ${button}` };
}

async function actionsLine(octokit: Client, org: string, fork: string, heads: LiveHead[], nowMs: number): Promise<ActionsLine> {
  const gate = await gateLine(octokit, org, fork, heads, nowMs);
  const stray = await strayWorkflows(octokit, org, fork);
  if (stray.length === 0) return gate;
  // Only a note: a stray workflow does no harm where it can run (docs/contracts.md), so it says nothing about the gate and outranks nothing.
  return { ...gate, detail: `${gate.detail}; turn off ${stray.join(', ')}: run npm run setup -- --org ${org}` };
}

/** Reads what GitHub says, leaving the file's record in place for what it can't reach, and saying so. */
export async function readLiveView(octokit: Client, config: AppConfig, objects: GithubObjects, specs: PrSpec[], nowMs: number): Promise<LiveView> {
  const org = config.org;
  const reachable = (await octokit.paginate('GET /installation/repositories', { per_page: 100 })).map((r) => r.name);
  const missingForks = FORK_NAMES.filter((f) => !reachable.includes(f));
  const notes: string[] = [];
  const heads: LiveHead[] = [];
  const prs: Record<string, PrRecord> = { ...objects.prs };
  for (const [id, record] of Object.entries(objects.prs)) {
    const spec = specs.find((s) => s.id === id);
    if (!reachable.includes(forkOf(record, spec))) continue;
    try {
      const live = await readPull(octokit, org, id, record, spec);
      prs[id] = live.record;
      heads.push(live.head);
    } catch (e) {
      notes.push(`PR ${id}: couldn't read it from GitHub (${describeApiError(e)}), so this line is from the file.`);
    }
  }
  const issues: GithubObjects['issues'] = {};
  for (const [key, issue] of Object.entries(objects.issues)) {
    const fork = key.split('/')[0];
    if (!reachable.includes(fork) || (await issueExists(octokit, org, fork, issue.number))) issues[key] = issue;
    else notes.push(`The issue recorded for ${key} isn't on GitHub.`);
  }
  const actions = await Promise.all(FORK_NAMES.map(async (fork): Promise<ActionsLine> => {
    if (missingForks.includes(fork)) return { fork, ok: false, state: 'unreachable', detail: `the installation can't reach it: add it at https://github.com/organizations/${org}/settings/installations/${config.installationId}` };
    return actionsLine(octokit, org, fork, heads.filter((h) => h.fork === fork), nowMs);
  }));
  return { objects: { ...objects, prs, issues }, actions, missingForks, notes };
}
