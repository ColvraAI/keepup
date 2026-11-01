// The branches behind a pull request: the replay base with its CI commit, and what's already on the head.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitFile, ensureClone, fetchBranch, patchIdOfCommit, patchIdOfFile, pushRef, readPatchMessage, removeFiles, type GitContext } from './git.ts';
import { describeApiError, isStatus, type Client } from './github.ts';
import { PrStateError, type Pull, type RepoRun } from './pr-types.ts';
import { ciFileProblem, type PrSpec, type Stage } from './specs.ts';
import { CI_TARGET } from './template.ts';

const WORKFLOW_DIR = '.github/workflows';

export interface RemoteCommit { sha: string; subject: string }

export async function getRef(run: RepoRun, branch: string): Promise<string | null> {
  try {
    const { data } = await run.deps.octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner: run.owner, repo: run.repo, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

/** Creates a branch through REST. An old commit can't trip the workflow check this way, because nothing is pushed. */
export async function createBranch(run: RepoRun, branch: string, sha: string): Promise<void> {
  try {
    await run.deps.octokit.request('POST /repos/{owner}/{repo}/git/refs', { owner: run.owner, repo: run.repo, ref: `refs/heads/${branch}`, sha });
  } catch (e) {
    const exists = isStatus(e, 422) && /already exists/i.test(describeApiError(e));
    if (!exists) throw e;
  }
}

export async function compareCommits(run: RepoRun, base: string, head: string): Promise<{ status: string; commits: { sha: string; message: string }[] }> {
  const commits: { sha: string; message: string }[] = [];
  let status = '';
  for (let page = 1; ; page += 1) {
    const { data } = await run.deps.octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
      owner: run.owner, repo: run.repo, basehead: `${base}...${head}`, per_page: 100, page,
    });
    status = data.status;
    commits.push(...data.commits.map((c) => ({ sha: c.sha, message: c.commit.message })));
    if (data.commits.length < 100) return { status, commits };
  }
}

async function readFileAt(run: RepoRun, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await run.deps.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner: run.owner, repo: run.repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) throw new PrStateError(`${path} on ${ref} isn't a file.`);
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

async function listWorkflowFiles(run: RepoRun, ref: string): Promise<string[]> {
  try {
    const { data } = await run.deps.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner: run.owner, repo: run.repo, path: WORKFLOW_DIR, ref });
    return Array.isArray(data) ? data.filter((e) => e.type === 'file').map((e) => e.path) : [];
  } catch (e) {
    if (isStatus(e, 404)) return [];
    throw e;
  }
}

const CI_SUBJECT_PREFIX = 'ci:';

function ciMessage(spec: PrSpec, removing: string[]): string {
  const names = removing.map((p) => p.split('/').pop()).join(', ');
  const removed = removing.length ? `\nRemoves ${names}: they can't pass without upstream's secrets, and a pull_request workflow runs from the merge, so a file here would run on every pull request.` : '';
  return `ci: run this repo's tests on the replay base\n\nAdds ${spec.ciWorkflow} as ${CI_TARGET}, because this repo's own CI can't run on a fork.${removed}\nThis is the one change on this branch that isn't upstream's.`;
}

async function addCiCommit(run: RepoRun, tip: string, removing: string[]): Promise<string> {
  const { spec, deps, git, identity } = run;
  const dir = await ensureClone(git);
  await fetchBranch(git, dir, spec.baseBranch);
  const sha = await commitFile(git, dir, {
    tip,
    source: join(deps.root, spec.ciWorkflow as string),
    target: CI_TARGET,
    remove: removing,
    message: ciMessage(spec, removing),
    identity,
    date: `${spec.stages[0].date}T11:59:00Z`,
  });
  await pushRef(git, dir, sha, spec.baseBranch);
  return sha;
}

/**
 * The state GitHub reports for a fork's workflows says nothing reliable, so this doesn't depend on it:
 * with no other workflow file on the base, no pull_request workflow but ours can run from the merge.
 */
async function ensureCi(run: RepoRun, tip: string): Promise<string> {
  const { spec, deps } = run;
  if (!spec.ciWorkflow) return tip;
  const problem = ciFileProblem(deps.root, spec.ciWorkflow);
  if (problem) throw new PrStateError(problem);
  const wanted = readFileSync(join(deps.root, spec.ciWorkflow), 'utf8');
  const onBranch = await readFileAt(run, CI_TARGET, tip);
  if (onBranch !== null && onBranch !== wanted) throw new PrStateError(`${CI_TARGET} on ${spec.baseBranch} differs from ${spec.ciWorkflow}. keepup never rewrites a replay base; decide which is right by hand.`);
  const others = (await listWorkflowFiles(run, tip)).filter((p) => p !== CI_TARGET);
  return onBranch !== null && others.length === 0 ? tip : addCiCommit(run, tip, others);
}

export interface BaseBranch {
  tip: string;
  /** Where a head branch starts: the base commit plus the CI commit. A merge can move the tip past this, and a patch made at the base commit may not apply there. */
  start: string;
  extraCommits: number;
}

/** The base branch points at the base commit, plus the CI commit when the spec has one. */
export async function ensureBaseBranch(run: RepoRun): Promise<BaseBranch> {
  const { spec } = run;
  const existing = await getRef(run, spec.baseBranch);
  if (!existing) await createBranch(run, spec.baseBranch, spec.baseCommit);
  else {
    const { status } = await compareCommits(run, spec.baseCommit, existing);
    if (status !== 'identical' && status !== 'ahead') throw new PrStateError(`${spec.baseBranch} doesn't contain the base commit ${spec.baseCommit} (it's ${status}). keepup won't force it; fix the branch by hand.`);
  }
  const tip = await ensureCi(run, existing ?? spec.baseCommit);
  if (!spec.ciWorkflow) return { tip, start: spec.baseCommit, extraCommits: 0 };
  const { commits } = await compareCommits(run, spec.baseCommit, tip);
  const lastCi = commits.map((c) => c.message.startsWith(CI_SUBJECT_PREFIX)).lastIndexOf(true);
  return { tip, start: lastCi < 0 ? tip : commits[lastCi].sha, extraCommits: lastCi + 1 };
}

const DEFAULT_BRANCH_MESSAGE = `chore: remove upstream's workflows from this fork's default branch

GitHub always runs pull_request_target workflows from the default branch, whatever a pull request's base is, and scheduled and issue_comment ones from there too. Upstream's need its secrets, so on this fork they would fail on every pull request, and a failed check can't be cleared without a new commit.

This keeps the demo's CI on its replay base branches. This commit is the only change on this branch that isn't upstream's.`;

/**
 * A fork whose CI we replace has nothing to gain from upstream's workflows, and they run from its default branch
 * however clean the replay base is. So they go in one commit, before the first pull request. This is the one push to
 * a branch the spec doesn't name, which is why it gets its own context: the run's own still refuses it.
 */
export async function clearDefaultBranchWorkflows(run: RepoRun, defaultBranch: string): Promise<void> {
  const { spec, git, identity, deps } = run;
  if (!spec.ciWorkflow) return;
  const tip = await getRef(run, defaultBranch);
  if (!tip) throw new PrStateError(`${run.owner}/${run.repo} says its default branch is ${defaultBranch}, and that branch isn't there.`);
  const remove = await listWorkflowFiles(run, tip);
  if (remove.length === 0) return;
  const once: GitContext = { ...git, allowedRefs: [defaultBranch] };
  const dir = await ensureClone(once);
  await fetchBranch(once, dir, defaultBranch);
  const sha = await removeFiles(once, dir, { tip, remove, message: DEFAULT_BRANCH_MESSAGE, identity, date: deps.now().toISOString() });
  await pushRef(once, dir, sha, defaultBranch);
  deps.log(`Removed ${remove.length} of upstream's workflow files from ${defaultBranch} on ${run.owner}/${run.repo}.`);
}

export async function stageSubjects(spec: PrSpec): Promise<Map<string, string[]>> {
  const pairs = await Promise.all(spec.stages.map(async (s) => [s.date, await Promise.all(s.patchFiles.map(async (f) => (await readPatchMessage(f)).subject))] as const));
  return new Map(pairs);
}

const subjectOf = (message: string) => message.split('\n')[0].trim();

/** The commits on the remote branch. A merged pull request whose branch was deleted still lists its commits. */
export async function remoteCommits(run: RepoRun, tip: string | null, pull: Pull | null): Promise<RemoteCommit[]> {
  if (tip) return (await compareCommits(run, run.spec.baseCommit, tip)).commits.map((c) => ({ sha: c.sha, subject: subjectOf(c.message) }));
  if (!pull) return [];
  return pullCommits(run.deps.octokit, run.owner, run.repo, pull.number);
}

export async function pullCommits(octokit: Client, owner: string, repo: string, number: number): Promise<RemoteCommit[]> {
  const commits = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { owner, repo, pull_number: number, per_page: 100 });
  return commits.map((c) => ({ sha: c.sha, subject: subjectOf(c.commit.message) }));
}

export function appliedFrom(stages: Stage[], subjects: Map<string, string[]>, subjectsOnRemote: string[]): Stage[] {
  const present = new Set(subjectsOnRemote);
  return stages.filter((s) => (subjects.get(s.date) ?? []).every((subject) => present.has(subject)));
}

/**
 * A subject only names a patch. If a patch was regenerated under the same subject, the fork doesn't hold
 * what the lab measured. There's no force push to fix that with, so a person has to choose.
 */
export async function assertSameChange(run: RepoRun, onRemote: RemoteCommit[], subjects: Map<string, string[]>): Promise<void> {
  const { spec, git } = run;
  const wanted = spec.stages.flatMap((s) => s.patchFiles.map((file, i) => ({ file, subject: subjects.get(s.date)?.[i] })));
  const pairs = wanted.flatMap((w) => {
    const commit = onRemote.find((c) => c.subject === w.subject);
    return commit ? [{ file: w.file, commit }] : [];
  });
  if (pairs.length === 0) return;
  const dir = await ensureClone(git);
  await fetchBranch(git, dir, spec.branch);
  for (const { file, commit } of pairs) {
    if ((await patchIdOfCommit(git, dir, commit.sha)) !== (await patchIdOfFile(dir, file))) {
      throw new PrStateError(`PR ${spec.id}: ${file} has the same subject as commit ${commit.sha} on ${spec.branch} ("${commit.subject}"), but a different change. The lab's numbers may describe code the pull request doesn't hold. keepup never force-pushes: restore the patch, or give the new change a new subject in a later stage.`);
    }
  }
}
