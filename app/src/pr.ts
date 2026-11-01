// npm run pr: opens and updates one pull request from its lab/<dir>/pr.json.
// What has been done is read from GitHub each time, so a rerun or a crash converges.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readCi, waitForCi } from './ci.ts';
import { requireAppConfig, resolveUrls, type Env } from './config.ts';
import { assertDemoRepo, assertPublicText } from './guard.ts';
import { applyPatches, ensureClone, fetchBranch, pushRef, type GitContext } from './git.ts';
import { baseCommitStanding, createAppClient, getAppInfo, getBotIdentity, getInstallationToken, holdsBaseCommit, isNotCovered, isStatus, notCoveredLine } from './github.ts';
import { stagePatchIds } from './patch-ids.ts';
import { assertPublicSafe } from './secrets.ts';
import { bodyDigest, readObjects, recordsFor, updateObjects, withFork, withPr, type CiRecord, type PrRecord } from './objects.ts';
import { appliedFrom, assertSameChange, clearDefaultBranchWorkflows, createBranch, ensureBaseBranch, getRef, remoteCommits, stageSubjects, type RemoteCommit } from './pr-branch.ts';
import { PrStateError, type PrDeps, type PrOptions, type PrOutcome, type Pull, type Run } from './pr-types.ts';
import type { PrSpec, Stage } from './specs.ts';
import { formatDate, labOf, renderBody, renderTitle, type LabView } from './template.ts';

export { PrStateError };
export type { PrDeps, PrOptions, PrOutcome };

const CI_WAIT_MS = 20 * 60_000;

function ciWait(env: Env): number {
  const wanted = Number(env.KEEPUP_CI_WAIT_MS);
  return Number.isFinite(wanted) && wanted > 0 ? wanted : CI_WAIT_MS;
}

export function createPrDeps(root: string, env: Env, overrides: Partial<PrDeps> = {}): PrDeps {
  const config = requireAppConfig(env, root);
  return {
    root, env, org: config.org, slug: config.slug,
    octokit: createAppClient(config, env),
    gitBaseUrl: resolveUrls(env).git,
    sleep: (ms) => delay(ms).then(() => undefined),
    now: () => new Date(),
    nowMs: () => Date.now(),
    ciTimeoutMs: ciWait(env),
    ciNoneTimeoutMs: 3 * 60_000,
    ciPollMs: 30_000,
    gateWindowMs: 90_000,
    gatePollMs: 10_000,
    log: () => undefined,
    ...overrides,
  };
}

const isMerged = (pull: Pull): boolean => Boolean(pull.merged_at);
const stateOf = (pull: Pull): string => (isMerged(pull) ? 'merged' : pull.state);

/** Which stages this call must end up having applied. */
function targetStages(spec: PrSpec, opts: PrOptions): Stage[] {
  if (opts.update && opts.all) throw new PrStateError('--update and --all ask for different things. Pick one.');
  if (opts.all) return spec.stages;
  if (opts.update) {
    const at = spec.stages.findIndex((s) => s.date === opts.update);
    if (at < 0) throw new PrStateError(`No stage dated ${opts.update} in PR ${spec.id}. Its stages are ${spec.stages.map((s) => s.date).join(', ')}.`);
    return [spec.stages[at]];
  }
  return [spec.stages[0]];
}

/** Everything this call could send, checked before the first write, because a commit on a public fork has no undo. A secret only known at runtime can't be caught when the spec loads. */
function preflight(spec: PrSpec, targets: Stage[], lab: LabView, opts: PrOptions, org: string): void {
  if (lab.unreadable) throw new PrStateError(`PR ${spec.id} waits, because ${lab.problem}. Running the lab replaces it.`);
  for (const stage of targets) {
    assertPublicText(renderTitle(stage, lab, opts), `The title of PR ${spec.id}`, org);
    for (const file of stage.patchFiles) assertPublicSafe(readFileSync(file, 'utf8'), `The patch ${basename(file)}`);
  }
  assertPublicText(renderBody(spec, { org, applied: targets, lab, allowUnmeasured: opts.allowUnmeasured }), `The body of PR ${spec.id}`, org);
}

async function readSubjects(spec: PrSpec): Promise<Map<string, string[]>> {
  const subjects = await stageSubjects(spec);
  const all = [...subjects.values()].flat();
  const repeated = all.find((s, i) => all.indexOf(s) !== i);
  if (repeated) throw new PrStateError(`Two patches in PR ${spec.id} share the subject "${repeated}". Applied stages are detected by subject, so each must be unique.`);
  return subjects;
}

async function verifyFork(run: Run): Promise<{ url: string; defaultBranch: string }> {
  const { owner, repo, spec, deps } = run;
  let data;
  try {
    ({ data } = await deps.octokit.request('GET /repos/{owner}/{repo}', { owner, repo }));
  } catch (e) {
    if (isStatus(e, 404)) throw new PrStateError(`${owner}/${repo} doesn't exist, or the App can't see it. Run: npm run setup -- --org ${owner}`);
    throw e;
  }
  if (!data.fork) throw new PrStateError(`${owner}/${repo} isn't a fork, so keepup won't touch it.`);
  if (data.parent?.full_name !== spec.upstream) {
    throw new PrStateError(`${owner}/${repo} is forked from ${data.parent?.full_name ?? 'nothing GitHub reports'}, not ${spec.upstream}.`);
  }
  try {
    await deps.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref: spec.baseCommit });
  } catch (e) {
    if (isStatus(e, 404) || isStatus(e, 422)) throw new PrStateError(`Base commit ${spec.baseCommit} doesn't resolve on ${owner}/${repo}. Was the fork made with full history?`);
    throw e;
  }
  const standing = await baseCommitStanding(deps.octokit, owner, repo, spec.baseCommit, data.default_branch);
  if (!holdsBaseCommit(standing)) throw new PrStateError(`Base commit ${spec.baseCommit} isn't in ${owner}/${repo}'s history: its ${data.default_branch} is ${standing} it. GitHub resolves any commit in the fork network, so the fork itself doesn't hold this one. Press "Sync fork" on the repo's page, or delete the fork and run: npm run setup -- --org ${owner}`);
  return { url: data.html_url, defaultBranch: data.default_branch };
}

async function findPull(run: Run): Promise<Pull | null> {
  const pulls = await run.deps.octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
    owner: run.owner, repo: run.repo, state: 'all', head: `${run.owner}:${run.spec.branch}`, per_page: 100,
  });
  const pull = pulls.find((p) => p.state === 'open') ?? pulls[0] ?? null;
  if (pull && pull.user?.login !== run.identity.login) {
    throw new PrStateError(`Pull request #${pull.number} on ${run.spec.branch} was opened by ${pull.user?.login ?? 'someone unknown'}, not ${run.identity.login}. Leaving it alone.`);
  }
  return pull;
}

const appliedStages = (run: Run, onRemote: RemoteCommit[]): Stage[] => appliedFrom(run.spec.stages, run.subjects, onRemote.map((c) => c.subject));

/** Applies what's missing of one stage on the branch tip, and pushes it as one push. */
async function pushStage(run: Run, stage: Stage, start: string, onRemote: RemoteCommit[]): Promise<void> {
  const { spec, git, identity } = run;
  const existing = await getRef(run, spec.branch);
  if (!existing) await createBranch(run, spec.branch, start);
  const tip = existing ?? start;
  const present = new Set(onRemote.map((c) => c.subject));
  const wanted = run.subjects.get(stage.date) ?? [];
  const patches = stage.patchFiles.map((file, index) => ({ file, index })).filter((_, i) => !present.has(wanted[i]));
  const dir = await ensureClone(git);
  await fetchBranch(git, dir, spec.branch);
  const sha = await applyPatches(git, dir, { tip, patches, date: stage.date, identity });
  await pushRef(git, dir, sha, spec.branch);
  run.deps.log(`Pushed ${patches.length} commit${patches.length === 1 ? '' : 's'} dated ${formatDate(stage.date)} to ${spec.branch}.`);
}

function desired(run: Run, applied: Stage[]): { title: string; body: string } {
  const { spec, deps, lab, opts } = run;
  const title = renderTitle(applied[applied.length - 1], lab, opts);
  const body = renderBody(spec, { org: deps.org, applied, lab, allowUnmeasured: opts.allowUnmeasured, baseExtraCommits: run.baseExtraCommits });
  assertPublicText(title, `The title of PR ${spec.id}`, deps.org);
  assertPublicText(body, `The body of PR ${spec.id}`, deps.org);
  return { title, body };
}

async function openPull(run: Run, want: { title: string; body: string }): Promise<number> {
  const { data } = await run.deps.octokit.request('POST /repos/{owner}/{repo}/pulls', {
    owner: run.owner, repo: run.repo, title: want.title, body: want.body, head: run.spec.branch, base: run.spec.baseBranch,
  });
  return data.number;
}

async function postMissingComments(run: Run, number: number, applied: Stage[]): Promise<number> {
  const wanted = applied.flatMap((s) => (s.comment ? [s.comment] : []));
  if (wanted.length === 0) return 0;
  const existing = await run.deps.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: run.owner, repo: run.repo, issue_number: number, per_page: 100 });
  const mine = new Set(existing.filter((c) => c.user?.login === run.identity.login).map((c) => c.body));
  const missing = wanted.filter((c) => !mine.has(c));
  missing.forEach((c) => assertPublicText(c, `A comment on PR ${run.spec.id}`, run.deps.org));
  for (const body of missing) await run.deps.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: run.owner, repo: run.repo, issue_number: number, body });
  return missing.length;
}

interface SyncResult { pull: Pull; opened: boolean; edited: boolean; commented: number }

/** Brings the pull request in line with what's on the branch. A closed or merged one is only read. */
async function syncPull(run: Run, found: Pull | null, applied: Stage[]): Promise<SyncResult | null> {
  if (applied.length === 0) return null;
  const { owner, repo, deps } = run;
  const get = async (n: number): Promise<Pull> => (await deps.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: n })).data;
  if (found && found.state !== 'open') return { pull: await get(found.number), opened: false, edited: false, commented: 0 };
  const want = desired(run, applied);
  const number = found?.number ?? (await openPull(run, want));
  const opened = !found;
  const edited = Boolean(found && (found.title !== want.title || found.body !== want.body));
  if (edited) await deps.octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: number, title: want.title, body: want.body });
  const commented = await postMissingComments(run, number, applied.slice(1));
  return { pull: await get(number), opened, edited, commented };
}

function checkOrder(run: Run, stage: Stage, applied: Stage[], pull: Pull | null): void {
  const { spec } = run;
  const earlier = spec.stages.slice(0, spec.stages.indexOf(stage));
  const missing = earlier.filter((s) => !applied.includes(s));
  if (missing.length) throw new PrStateError(`Stage ${stage.date} comes after ${missing.map((s) => s.date).join(', ')}, which ${missing.length === 1 ? "hasn't" : "haven't"} been applied. Replay order matters: apply them first, or use --all.`);
  if (pull && pull.state !== 'open') throw new PrStateError(`Pull request #${pull.number} is ${stateOf(pull)}, so stage ${stage.date} can't be added to it.`);
}

async function buildRun(spec: PrSpec, opts: PrOptions, deps: PrDeps, lab: LabView): Promise<Run> {
  const identity = await getBotIdentity(deps.octokit, deps.slug);
  const git: GitContext = {
    root: deps.root, org: deps.org, fork: spec.fork, gitBaseUrl: deps.gitBaseUrl, env: deps.env,
    token: () => getInstallationToken(deps.octokit),
    allowedRefs: [spec.branch, spec.baseBranch],
  };
  return { spec, deps, opts, lab, owner: deps.org, repo: spec.fork, identity, git, subjects: await readSubjects(spec), baseExtraCommits: 1 };
}

/**
 * Waiting on CI writes nothing to GitHub. So with the stage already on the branch it needs no rendered words, and a
 * lab that hasn't run can't stop CI being read and recorded. Null when there's still something to open.
 */
async function waitOnly(spec: PrSpec, opts: PrOptions, deps: PrDeps, lab: LabView): Promise<PrOutcome | null> {
  if (!opts.waitCi || opts.update || opts.all) return null;
  const run = await buildRun(spec, opts, deps, lab);
  const pull = await findPull(run);
  if (!pull) return null;
  const tip = await getRef(run, spec.branch);
  const applied = appliedStages(run, await remoteCommits(run, tip, pull));
  if (!applied.includes(spec.stages[0])) return null;
  const fork = await verifyFork(run);
  const previous = recordsFor(readObjects(deps.root), deps.org).prs[spec.id];
  const { ci, timedOut } = await settleCi(run, tip ?? pull.head.sha);
  await record({ ...run, baseExtraCommits: previous?.baseExtraCommits ?? 1 }, pull, applied, ci, fork.url, previous?.patchIds);
  return { id: spec.id, number: pull.number, url: pull.html_url, opened: false, pushedStages: [], edited: false, commented: 0, ci, ciTimedOut: timedOut, state: stateOf(pull) };
}

interface Progress { pull: SyncResult | null; opened: boolean; edited: boolean; commented: number; pushed: string[] }

async function applyTargets(run: Run, targets: Stage[], start: string): Promise<Progress> {
  const { spec } = run;
  const progress: Progress = { pull: null, opened: false, edited: false, commented: 0, pushed: [] };
  let pull: Pull | null = await findPull(run);
  const merge = (result: SyncResult | null) => {
    if (!result) return;
    progress.pull = result;
    progress.opened = progress.opened || result.opened;
    progress.edited = progress.edited || result.edited;
    progress.commented += result.commented;
    pull = result.pull;
  };
  const tip = await getRef(run, spec.branch);
  let onRemote = await remoteCommits(run, tip, pull);
  if (tip && (!pull || pull.state === 'open')) await assertSameChange(run, onRemote, run.subjects);
  for (const stage of targets) {
    if (appliedStages(run, onRemote).includes(stage)) continue;
    checkOrder(run, stage, appliedStages(run, onRemote), pull);
    await pushStage(run, stage, start, onRemote);
    progress.pushed.push(stage.date);
    onRemote = await remoteCommits(run, await getRef(run, spec.branch), pull);
    merge(await syncPull(run, pull, appliedStages(run, onRemote)));
  }
  if (progress.pushed.length === 0) merge(await syncPull(run, pull, appliedStages(run, onRemote)));
  return progress;
}

async function settleCi(run: Run, sha: string): Promise<{ ci: CiRecord; timedOut: boolean }> {
  const { deps, owner, repo, opts } = run;
  if (!opts.waitCi) return { ci: await readCi(deps.octokit, owner, repo, sha), timedOut: false };
  return waitForCi(deps.octokit, owner, repo, sha, { timeoutMs: deps.ciTimeoutMs, noneTimeoutMs: deps.ciNoneTimeoutMs, pollMs: deps.ciPollMs, sleep: deps.sleep, nowMs: deps.nowMs, log: deps.log });
}

async function record(run: Run, pull: Pull, applied: Stage[], ci: CiRecord, forkUrl: string, patchIds: PrRecord['patchIds'] = stagePatchIds(run.spec, applied.map((s) => s.date))): Promise<void> {
  const { deps, spec, identity } = run;
  const app = await getAppInfo(deps.octokit, identity.login);
  const entry: PrRecord = {
    number: pull.number, url: pull.html_url, title: pull.title, state: stateOf(pull),
    base: pull.base.ref, head: pull.head.ref, author: pull.user?.login ?? 'unknown',
    stagesApplied: applied.map((s) => s.date), ci, checkedAt: deps.now().toISOString(), bodyDigest: bodyDigest(pull.body),
    ...(spec.ciWorkflow ? { baseExtraCommits: run.baseExtraCommits } : {}),
    ...(patchIds ? { patchIds } : {}),
  };
  updateObjects(deps.root, (o) => withPr(withFork({ ...recordsFor(o, deps.org), org: deps.org, app }, spec.fork, forkUrl), spec.id, entry));
}

export async function openOrUpdate(spec: PrSpec, opts: PrOptions, deps: PrDeps): Promise<PrOutcome> {
  try {
    return await openOrUpdateFork(spec, opts, deps);
  } catch (e) {
    if (isNotCovered(e)) throw new PrStateError(notCoveredLine(deps.org, spec.fork, deps.env.GITHUB_APP_INSTALLATION_ID));
    throw e;
  }
}

async function openOrUpdateFork(spec: PrSpec, opts: PrOptions, deps: PrDeps): Promise<PrOutcome> {
  assertDemoRepo(deps.org, spec.fork, deps.env);
  const targets = targetStages(spec, opts);
  const lab = labOf(spec, deps.root);
  const waited = await waitOnly(spec, opts, deps, lab);
  if (waited) return waited;
  preflight(spec, targets, lab, opts, deps.org);
  const built = await buildRun(spec, opts, deps, lab);
  const fork = await verifyFork(built);
  const base = await ensureBaseBranch(built);
  await clearDefaultBranchWorkflows(built, fork.defaultBranch);
  const run: Run = { ...built, baseExtraCommits: base.extraCommits || 1 };
  const progress = await applyTargets(run, targets, base.start);
  if (!progress.pull) throw new PrStateError(`Nothing is on ${spec.branch} yet, so there's no pull request to report.`);
  const { pull } = progress.pull;
  const tip = await getRef(run, spec.branch);
  const applied = appliedStages(run, await remoteCommits(run, tip, pull));
  // The pull request object can still hold the commit before this push. The branch can't.
  const { ci, timedOut } = await settleCi(run, tip ?? pull.head.sha);
  await record(run, pull, applied, ci, fork.url);
  return {
    id: spec.id, number: pull.number, url: pull.html_url, opened: progress.opened, pushedStages: progress.pushed,
    edited: progress.edited, commented: progress.commented, ci, ciTimedOut: timedOut, state: stateOf(pull),
  };
}
