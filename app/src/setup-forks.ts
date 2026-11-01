// Setup's work on the forks: make them, turn Issues and the right Actions on, and turn the rest off.
import type { Client } from './github.ts';
import { baseCommitStanding, holdsBaseCommit, isStatus } from './github.ts';
import { UPSTREAM_REPOS } from './guard.ts';
import { listSpecs, type PrSpec } from './specs.ts';

export const FORKS = UPSTREAM_REPOS.map((full) => {
  const [owner, name] = full.split('/') as [string, string];
  return { upstream: full, owner, name };
});

/** The workflows that do the demo's work. Everything else on a fork needs upstream's secrets and is turned off. */
export const WORKFLOW_ALLOWLIST: Record<string, readonly string[]> = {
  'anything-llm': ['run-tests.yaml', 'lint.yaml'],
  aura: ['keepup-ci.yml'],
};

export interface ForkContext {
  person: Client;
  org: string;
  root: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  pollMs: number;
  forkTimeoutMs: number;
}

async function readRepo(ctx: ForkContext, name: string) {
  try {
    return (await ctx.person.request('GET /repos/{owner}/{repo}', { owner: ctx.org, repo: name })).data;
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

async function isReady(ctx: ForkContext, name: string): Promise<boolean> {
  if (!(await readRepo(ctx, name))) return false;
  try {
    await ctx.person.request('GET /repos/{owner}/{repo}/commits', { owner: ctx.org, repo: name, per_page: 1 });
    return true;
  } catch (e) {
    if (isStatus(e, 404) || isStatus(e, 409)) return false;
    throw e;
  }
}

async function waitForFork(ctx: ForkContext, fork: { upstream: string; owner: string; name: string }): Promise<void> {
  const started = ctx.nowMs();
  while (!(await isReady(ctx, fork.name))) {
    if (ctx.nowMs() - started >= ctx.forkTimeoutMs) throw new Error(`The fork of ${fork.upstream} isn't ready yet. GitHub says forks can take over five minutes. Run setup again in a while; it picks up here.`);
    await ctx.sleep(ctx.pollMs);
  }
}

export async function ensureFork(ctx: ForkContext, fork: { upstream: string; owner: string; name: string }): Promise<'made' | 'existed'> {
  const existing = await readRepo(ctx, fork.name);
  if (existing) {
    if (!existing.fork || existing.parent?.full_name !== fork.upstream) throw new Error(`${ctx.org}/${fork.name} already exists and isn't a fork of ${fork.upstream}. Rename or remove it, then run setup again.`);
    // An earlier run may have stopped while GitHub was still copying it.
    await waitForFork(ctx, fork);
    return 'existed';
  }
  ctx.log(`Forking ${fork.upstream} into ${ctx.org}, with full history…`);
  await ctx.person.request('POST /repos/{owner}/{repo}/forks', { owner: fork.owner, repo: fork.name, organization: ctx.org, default_branch_only: false });
  await waitForFork(ctx, fork);
  return 'made';
}

export async function ensureIssuesOn(ctx: ForkContext, name: string): Promise<void> {
  const repo = await readRepo(ctx, name);
  if (repo?.has_issues) return;
  await ctx.person.request('PATCH /repos/{owner}/{repo}', { owner: ctx.org, repo: name, has_issues: true });
  ctx.log(`Turned Issues on for ${ctx.org}/${name}.`);
}

/**
 * Sent every time, because a fork whose Actions tab still has the button also reports enabled: true.
 * One person reports that this call clears the button; nobody has confirmed it, so the manual step stays.
 */
export async function ensureActionsOn(ctx: ForkContext, name: string): Promise<string | null> {
  const params = { owner: ctx.org, repo: name };
  const { data } = await ctx.person.request('GET /repos/{owner}/{repo}/actions/permissions', params);
  try {
    await ctx.person.request('PUT /repos/{owner}/{repo}/actions/permissions', { ...params, enabled: true, allowed_actions: 'all' });
  } catch (e) {
    if (!isStatus(e, 403) && !isStatus(e, 409)) throw e;
    return `GitHub wouldn't turn Actions on for ${ctx.org}/${name}, so no CI can run there. An org setting may forbid it: check https://github.com/organizations/${ctx.org}/settings/actions, then run setup again.`;
  }
  if (!data.enabled) ctx.log(`Turned Actions on for ${ctx.org}/${name}.`);
  return null;
}

const fileName = (path: string) => path.split('/').pop() ?? path;

async function setWorkflow(ctx: ForkContext, name: string, id: number, action: 'enable' | 'disable'): Promise<boolean> {
  const params = { owner: ctx.org, repo: name, workflow_id: id };
  try {
    if (action === 'enable') await ctx.person.request('PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable', params);
    else await ctx.person.request('PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable', params);
    return true;
  } catch (e) {
    if (isStatus(e, 403) || isStatus(e, 404) || isStatus(e, 422)) return false;
    throw e;
  }
}

/**
 * A best-effort tidy-up, not a guarantee. A fresh fork lists no workflows, so there's often nothing to act on:
 * on AURA, the replay base and the default branch are what keep a stray workflow off a pull request (pr-branch.ts).
 * Returns the Actions page unless a run proves the fork's gate is open. Workflow state can't prove that.
 */
export async function configureWorkflows(ctx: ForkContext, name: string): Promise<string | null> {
  const allow = WORKFLOW_ALLOWLIST[name] ?? [];
  const params = { owner: ctx.org, repo: name, per_page: 100 };
  const workflows = await ctx.person.paginate('GET /repos/{owner}/{repo}/actions/workflows', params);
  // Deleted workflows, and dynamic ones GitHub runs itself (dependabot, CodeQL), have no file to switch.
  for (const w of workflows.filter((x) => x.state !== 'deleted' && x.path.startsWith('.github/'))) {
    const allowed = allow.includes(fileName(w.path));
    if (allowed && w.state !== 'active') await setWorkflow(ctx, name, w.id, 'enable');
    if (!allowed && w.state !== 'disabled_manually' && (await setWorkflow(ctx, name, w.id, 'disable'))) {
      ctx.log(`Turned off ${fileName(w.path)} on ${ctx.org}/${name}: it can't pass without upstream's secrets.`);
    }
  }
  const { data } = await ctx.person.request('GET /repos/{owner}/{repo}/actions/runs', { owner: ctx.org, repo: name, per_page: 1 });
  return data.total_count > 0 ? null : `https://github.com/${ctx.org}/${name}/actions`;
}

/** A fork made before a base commit shipped answers for it anyway, through its network, and doesn't hold it. Only its own branch says. */
async function baseCommitProblem(ctx: ForkContext, spec: PrSpec): Promise<string | null> {
  const repo = await readRepo(ctx, spec.fork);
  if (!repo) return null;
  const standing = await baseCommitStanding(ctx.person, ctx.org, spec.fork, spec.baseCommit, repo.default_branch);
  if (holdsBaseCommit(standing)) return null;
  return `PR ${spec.id}: base commit ${spec.baseCommit} DOES NOT RESOLVE in ${ctx.org}/${spec.fork}'s own history: its ${repo.default_branch} is ${standing} it, so the fork is older than the commit. Press "Sync fork" on its page, or delete the fork, then run setup again.`;
}

/** Every base commit in the specs must be held by its fork. Returns one problem per one that isn't. */
export async function verifyBaseCommits(ctx: ForkContext): Promise<string[]> {
  const { specs, invalid } = listSpecs(ctx.root);
  for (const broken of invalid) ctx.log(`Skipping a broken spec: ${broken.message}`);
  const problems: string[] = [];
  for (const spec of specs) {
    try {
      await ctx.person.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner: ctx.org, repo: spec.fork, ref: spec.baseCommit });
      const stale = await baseCommitProblem(ctx, spec);
      if (stale) {
        ctx.log(`!!! ${stale}`);
        problems.push(stale);
      }
    } catch (e) {
      if (isStatus(e, 409)) {
        problems.push(`${ctx.org}/${spec.fork} is still being copied, so base commit ${spec.baseCommit} can't be checked yet. Run setup again in a while; it picks up here.`);
        continue;
      }
      if (!isStatus(e, 404) && !isStatus(e, 422)) throw e;
      const problem = `PR ${spec.id}: base commit ${spec.baseCommit} DOES NOT RESOLVE on ${ctx.org}/${spec.fork}. That pull request can't open until this is fixed.`;
      ctx.log(`!!! ${problem}`);
      problems.push(problem);
    }
  }
  if (specs.length === 0) ctx.log('No lab/<dir>/pr.json yet, so no base commits to check. Run setup again once they exist.');
  return problems;
}
