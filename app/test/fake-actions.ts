// How the fake models GitHub Actions on a fork, from what real forks were seen doing:
// - A new fork lists no workflows, and asking for one by file name is a 404.
// - A push to its default branch registers every workflow as `active`, and runs none of them.
// - Until the Actions tab button is pressed, no event produces a run, and pressing it replays nothing.
// - Pressing it registers the workflows, with scheduled ones reading `disabled_fork`.
// - pull_request_target workflows always come from the default branch, since 8 Dec 2025, whatever the
//   pull request's base is; pull_request ones come from the merge.
// GET /actions/permissions says enabled: true the whole time, which is why it isn't evidence of anything.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FakeGitHub, FakePull, FakeRepo, FakeRun, FakeWorkflow } from './fake-github.ts';

const run = promisify(execFile);
const ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

async function git(repo: FakeRepo, ...args: string[]): Promise<string> {
  try {
    return (await run('git', args, { cwd: repo.bare, env: ENV, maxBuffer: 1 << 26 })).stdout;
  } catch {
    return '';
  }
}

interface WorkflowFile { path: string; content: string }

export async function workflowFiles(repo: FakeRepo, ref: string): Promise<WorkflowFile[]> {
  const list = (await git(repo, 'ls-tree', '--name-only', ref, '.github/workflows/')).trim().split('\n').filter(Boolean);
  return Promise.all(list.map(async (path) => ({ path, content: await git(repo, 'show', `${ref}:${path}`) })));
}

/** What a merge of head into base would hold: the base's files, changed by what the head changed. */
async function mergedFiles(repo: FakeRepo, base: string, head: string): Promise<WorkflowFile[]> {
  const changes = (await git(repo, 'diff', '--name-status', `${base}...${head}`, '--', '.github/workflows/')).trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const dropped = new Set(changes.filter(([s]) => s === 'D').map(([, p]) => p));
  const changed = new Set(changes.filter(([s]) => s !== 'D').map(([, p]) => p));
  const fromBase = (await workflowFiles(repo, base)).filter((f) => !dropped.has(f.path) && !changed.has(f.path));
  const fromHead = (await workflowFiles(repo, head)).filter((f) => changed.has(f.path));
  return [...fromBase, ...fromHead];
}

const fileOf = (path: string) => path.split('/').pop() ?? path;
const DEFAULT_BRANCH = 'refs/heads/main';
const TARGET = /\bpull_request_target\b/;
const PULL = /\bpull_request\b(?!_target)/;

const conclude = (repo: FakeRepo, path: string): string => repo.workflowConclusion?.(fileOf(path)) ?? (/cla/.test(fileOf(path)) ? 'failure' : 'success');

function addRun(fake: FakeGitHub, repo: FakeRepo, path: string, sha: string, event: string): void {
  fake.runCounter += 1;
  const id = fake.runCounter;
  const html_url = `https://github.com/${repo.owner}/${repo.name}/actions/runs/${id}`;
  const conclusion = conclude(repo, path);
  const entry: FakeRun = { id, name: fileOf(path), path, event, status: 'completed', conclusion, head_sha: sha, html_url, run_number: id, created_at: new Date(Date.now() + id).toISOString(), check_suite_id: 5000 + id };
  repo.runs = [...repo.runs, entry];
  repo.checks = [...repo.checks, { name: fileOf(path), status: 'completed', conclusion, html_url, details_url: html_url, head_sha: sha, check_suite: { id: 5000 + id } }];
}

/** A pull request event, the way Actions sees it: nothing at all while the gate is closed. */
export async function firePullEvent(fake: FakeGitHub, repo: FakeRepo, pull: FakePull): Promise<void> {
  if (!repo.workflowRuntime || !repo.gateOpen) return;
  const head = (await git(repo, 'rev-parse', `refs/heads/${pull.head}`)).trim();
  const base = (await git(repo, 'rev-parse', `refs/heads/${pull.base}`)).trim();
  if (!head || !base) return;
  for (const f of await workflowFiles(repo, DEFAULT_BRANCH)) if (TARGET.test(f.content)) addRun(fake, repo, f.path, head, 'pull_request_target');
  for (const f of await mergedFiles(repo, base, head)) if (PULL.test(f.content)) addRun(fake, repo, f.path, head, 'pull_request');
}

/** After a push: open pull requests on that branch move to the new tip, which is a synchronize event. */
export async function afterPush(fake: FakeGitHub, repo: FakeRepo, refs: string[] = []): Promise<void> {
  if (repo.workflowRuntime && refs.includes(DEFAULT_BRANCH)) await registerByDefaultBranchPush(repo);
  for (const pull of repo.pulls.filter((p) => p.state === 'open')) {
    const tip = (await git(repo, 'rev-parse', `refs/heads/${pull.head}`)).trim();
    if (tip && tip !== pull.headSha) {
      pull.headSha = tip;
      pull.updated_at = new Date().toISOString();
      await firePullEvent(fake, repo, pull);
    }
  }
}

async function registerWorkflows(repo: FakeRepo, stateOf: (f: WorkflowFile) => string): Promise<void> {
  const files = await workflowFiles(repo, DEFAULT_BRANCH);
  const known = new Map(repo.workflows.map((w) => [w.path, w]));
  repo.workflows = files.map((f, i): FakeWorkflow => known.get(f.path) ?? { id: 1000 + i, name: fileOf(f.path), path: f.path, state: stateOf(f) });
}

/** A commit landing on the fork's default branch. */
export const registerByDefaultBranchPush = (repo: FakeRepo): Promise<void> => registerWorkflows(repo, () => 'active');

/** A person pressing "I understand my workflows, go ahead and enable them". */
export async function pressActionsButton(repo: FakeRepo): Promise<void> {
  repo.gateOpen = true;
  await registerWorkflows(repo, (f) => (/\bschedule\b/.test(f.content) ? 'disabled_fork' : 'active'));
}
