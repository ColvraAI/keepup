// The /repos/{owner}/{repo} half of the fake, backed by real bare repos.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firePullEvent } from './fake-actions.ts';
import { cloneBare, shareObjects } from './fake-repos.ts';
import type { FakeGitHub, FakePull, FakeRepo, FakeRoute, FakeThread, Reply, RouteContext } from './fake-github.ts';

const run = promisify(execFile);
const ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

async function gitIn(repo: FakeRepo, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd: repo.bare, env: ENV, maxBuffer: 1 << 26 });
    return stdout;
  } catch {
    return null;
  }
}

const notFound: Reply = { status: 404, body: { message: 'Not Found', status: '404' } };
const R = '^/repos/([^/]+)/([^/]+)';

function route(method: string, suffix: string, handler: (ctx: RouteContext, repo: FakeRepo, m: RegExpMatchArray) => Promise<Reply> | Reply): FakeRoute {
  return {
    method,
    pattern: new RegExp(`${R}${suffix}$`),
    handler: (ctx, m) => {
      if (ctx.request.auth === 'none' && method !== 'GET') return { status: 401, body: { message: 'Requires authentication' } };
      const repo = ctx.repo(m[1], m[2]);
      if (!repo) return notFound;
      // A public fork the installation doesn't cover still answers reads. Only a write shows it.
      if (method !== 'GET' && ctx.request.auth === 'installation' && repo.name === ctx.fake.hideFromInstallation) return { status: 403, body: { message: 'Resource not accessible by integration' } };
      return handler(ctx, repo, m);
    },
  };
}

function htmlUrl(repo: FakeRepo): string {
  return `https://github.com/${repo.owner}/${repo.name}`;
}

function repoJson(fake: FakeGitHub, repo: FakeRepo): Record<string, unknown> {
  const parent = repo.parent ? fake.repo(...(repo.parent.split('/') as [string, string])) : undefined;
  return {
    id: 1, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: false,
    fork: repo.fork, html_url: fake.marked(htmlUrl(repo)), default_branch: 'main', has_issues: repo.hasIssues,
    ...(parent ? { parent: { full_name: `${parent.owner}/${parent.name}` }, source: { full_name: `${parent.owner}/${parent.name}` } } : {}),
  };
}

async function refSha(repo: FakeRepo, ref: string): Promise<string | null> {
  const out = await gitIn(repo, 'rev-parse', '--verify', '--quiet', `refs/${ref}^{commit}`);
  return out ? out.trim() : null;
}

async function resolveCommit(repo: FakeRepo, ref: string): Promise<string | null> {
  const out = await gitIn(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  return out ? out.trim() : null;
}

async function commitJson(repo: FakeRepo, sha: string): Promise<Record<string, unknown> | null> {
  const out = await gitIn(repo, 'show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', sha);
  if (!out) return null;
  const [an, ae, ad, cn, ce, cd, message] = out.split('\0');
  return {
    sha, html_url: `${htmlUrl(repo)}/commit/${sha}`,
    commit: { message: message.trimEnd(), author: { name: an, email: ae, date: ad }, committer: { name: cn, email: ce, date: cd } },
  };
}

function refJson(repo: FakeRepo, ref: string, sha: string): Record<string, unknown> {
  return { ref: `refs/${ref}`, node_id: 'x', url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${ref}`, object: { type: 'commit', sha, url: 'x' } };
}

async function createRef(ctx: RouteContext, repo: FakeRepo): Promise<Reply> {
  const { ref, sha } = ctx.request.body as { ref: string; sha: string };
  if (!ref.startsWith('refs/') || ref.split('/').length < 3) return { status: 422, body: { message: `${ref} is not a valid ref name.` } };
  const name = ref.slice('refs/'.length);
  if (await refSha(repo, name)) return { status: 422, body: { message: 'Reference already exists' } };
  if (!(await resolveCommit(repo, sha))) return { status: 422, body: { message: 'Object does not exist' } };
  await gitIn(repo, 'update-ref', ref, sha);
  return { status: 201, body: refJson(repo, name, sha) };
}

async function compare(repo: FakeRepo, basehead: string, query: Record<string, string>): Promise<Reply> {
  const [baseRef, headRef] = basehead.split('...');
  const base = await resolveCommit(repo, baseRef);
  const head = await resolveCommit(repo, headRef);
  if (!base || !head) return notFound;
  const counts = await gitIn(repo, 'rev-list', '--left-right', '--count', `${base}...${head}`);
  const [behind, ahead] = (counts ?? '0 0').trim().split(/\s+/).map(Number);
  const status = base === head ? 'identical' : behind === 0 ? 'ahead' : ahead === 0 ? 'behind' : 'diverged';
  const shas = ((await gitIn(repo, 'rev-list', '--reverse', `${base}..${head}`)) ?? '').trim().split('\n').filter(Boolean);
  const perPage = Number(query.per_page ?? 30);
  const page = Number(query.page ?? 1);
  const commits = await Promise.all(shas.slice((page - 1) * perPage, page * perPage).map((s) => commitJson(repo, s)));
  return { status: 200, body: { status, ahead_by: ahead, behind_by: behind, total_commits: shas.length, commits, files: [] } };
}

async function contents(repo: FakeRepo, path: string, ref: string): Promise<Reply> {
  const sha = await resolveCommit(repo, ref || 'main');
  if (!sha) return { status: 404, body: { message: `No commit found for the ref ${ref}` } };
  const listed = ((await gitIn(repo, 'ls-tree', sha, `${path}/`)) ?? '').trim().split('\n').filter(Boolean);
  if (listed.length) {
    return { status: 200, body: listed.map((line) => {
      const [meta, entry] = line.split('\t');
      return { name: entry.split('/').pop(), path: entry, sha: 'x', type: meta.split(' ')[1] === 'tree' ? 'dir' : 'file' };
    }) };
  }
  const buffer = await new Promise<Buffer | null>((resolve) => {
    execFile('git', ['show', `${sha}:${path}`], { cwd: repo.bare, env: ENV, encoding: 'buffer' }, (e, out) => resolve(e ? null : out));
  });
  if (!buffer) return notFound;
  return { status: 200, body: { type: 'file', encoding: 'base64', name: path.split('/').pop(), path, sha: 'x', content: buffer.toString('base64') } };
}

async function pullJson(repo: FakeRepo, pull: FakePull, marker: string | null = null): Promise<Record<string, unknown>> {
  const tip = await refSha(repo, `heads/${pull.head}`);
  const mark = (value: string) => (marker ? `${value}#${marker}` : value);
  return {
    number: pull.number, title: marker ? `${pull.title} ${marker}` : pull.title, body: marker ? `${pull.body}\n<!-- ${marker} -->` : pull.body, state: pull.state, merged_at: pull.merged_at,
    user: { login: mark(pull.user), type: 'Bot' }, html_url: mark(`${htmlUrl(repo)}/pull/${pull.number}`),
    head: { ref: mark(pull.head), sha: repo.lagPullHead && pull.openedSha ? pull.openedSha : (tip ?? pull.headSha), repo: { full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: mark(pull.base), sha: (await refSha(repo, `heads/${pull.base}`)) ?? '' },
    created_at: pull.created_at,
    updated_at: pull.updated_at ?? pull.created_at,
  };
}

function nextNumber(repo: FakeRepo): number {
  return repo.threads.length + repo.pulls.length + 1;
}

async function createPull(ctx: RouteContext, repo: FakeRepo): Promise<Reply> {
  const { title, head, base, body } = ctx.request.body as { title: string; head: string; base: string; body: string };
  if (ctx.fake.failNextPullCreate) {
    const message = ctx.fake.failNextPullCreate;
    ctx.fake.failNextPullCreate = null;
    return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message }] } };
  }
  if (!title) return { status: 422, body: { message: 'Validation Failed', errors: [{ field: 'title', code: 'missing_field' }] } };
  const headSha = await refSha(repo, `heads/${head}`);
  const baseSha = await refSha(repo, `heads/${base}`);
  if (!headSha || !baseSha) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: headSha ? 'base' : 'head', code: 'invalid' }] } };
  if (repo.pulls.some((p) => p.head === head && p.state === 'open')) {
    return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner}:${head}.` }] } };
  }
  if (headSha === baseSha) {
    return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }] } };
  }
  const pull: FakePull = { number: nextNumber(repo), title, body, state: 'open', user: ctx.actor, created_at: new Date().toISOString(), comments: [], head, headSha, base, merged_at: null, openedSha: headSha };
  repo.pulls.push(pull);
  await firePullEvent(ctx.fake, repo, pull);
  return { status: 201, body: await pullJson(repo, pull, ctx.fake.apiMarker) };
}

function threadJson(fake: FakeGitHub, repo: FakeRepo, t: FakeThread, kind: 'issues' | 'pull'): Record<string, unknown> {
  return {
    number: t.number, title: t.title, body: t.body, state: t.state, user: { login: t.user },
    html_url: fake.marked(`${htmlUrl(repo)}/${kind === 'pull' ? 'pull' : 'issues'}/${t.number}`),
    ...(kind === 'pull' ? { pull_request: { url: 'x' } } : {}),
  };
}

function findThread(repo: FakeRepo, n: number): FakeThread | undefined {
  return [...repo.threads, ...repo.pulls].find((t) => t.number === n);
}

async function forkRepo(ctx: RouteContext, source: FakeRepo): Promise<Reply> {
  const { organization, default_branch_only } = (ctx.request.body ?? {}) as { organization?: string; default_branch_only?: boolean };
  const owner = organization ?? ctx.actor;
  const existing = ctx.fake.repo(owner, source.name);
  if (existing) return { status: 202, body: repoJson(ctx.fake, existing) };
  if (default_branch_only !== false) return { status: 422, body: { message: 'the fake expects default_branch_only false' } };
  const bare = cloneBare(source.bare, ctx.fake.barePath(owner, source.name));
  shareObjects(bare, source.bare);
  const fork: FakeRepo = {
    owner, name: source.name, bare, fork: true, parent: `${source.owner}/${source.name}`, hasIssues: false,
    actionsEnabled: true, gateOpen: false, workflowRuntime: true, permissionsPutOpensGate: source.permissionsPutOpensGate, lagPullHead: false,
    workflows: [], runs: [], threads: [], pulls: [], checks: [], statuses: [],
    notReadyPolls: source.notReadyPolls, notFoundPolls: source.notFoundPolls,
  };
  ctx.fake.repos.set(`${owner}/${source.name}`.toLowerCase(), fork);
  return { status: 202, body: repoJson(ctx.fake, fork) };
}

function setWorkflow(repo: FakeRepo, id: number, state: string): Reply {
  const known = repo.workflows.some((w) => w.id === id);
  if (!known) return notFound;
  repo.workflows = repo.workflows.map((w) => (w.id === id ? { ...w, state } : w));
  return { status: 204 };
}

export const repoRoutes: FakeRoute[] = [
  route('POST', '/forks', forkRepo),
  route('GET', '', (ctx, repo) => {
    if (repo.notFoundPolls > 0) {
      repo.notFoundPolls -= 1;
      return notFound;
    }
    return { status: 200, body: repoJson(ctx.fake, repo) };
  }),
  route('PATCH', '', (ctx, repo) => {
    const { has_issues } = ctx.request.body as { has_issues?: boolean };
    if (has_issues !== undefined) repo.hasIssues = has_issues;
    return { status: 200, body: repoJson(ctx.fake, repo) };
  }),
  route('GET', '/actions/permissions', (_c, repo) => ({ status: 200, body: { enabled: repo.actionsEnabled, allowed_actions: 'all' } })),
  route('PUT', '/actions/permissions', (ctx, repo) => {
    if (ctx.fake.denyActionsPermissions) return { status: 409, body: { message: 'Actions is disabled by the organization' } };
    repo.actionsEnabled = (ctx.request.body as { enabled: boolean }).enabled;
    if (repo.permissionsPutOpensGate && repo.actionsEnabled) repo.gateOpen = true;
    return { status: 204 };
  }),
  route('GET', '/actions/workflows', (_c, repo) => ({ status: 200, body: { total_count: repo.workflows.length, workflows: repo.workflows } })),
  route('GET', '/actions/workflows/([^/]+)', (_c, repo, m) => {
    const found = repo.workflows.find((w) => String(w.id) === m[3] || w.path.endsWith(`/${decodeURIComponent(m[3])}`));
    return found ? { status: 200, body: found } : notFound;
  }),
  route('PUT', '/actions/workflows/(\\d+)/disable', (ctx, repo, m) => (ctx.fake.denyWorkflowSwitch ? { status: 403, body: { message: 'Resource not accessible' } } : setWorkflow(repo, Number(m[3]), 'disabled_manually'))),
  // A real report: on a fork still behind the button this returns nothing and changes nothing.
  route('PUT', '/actions/workflows/(\\d+)/enable', (_c, repo, m) => {
    const current = repo.workflows.find((w) => w.id === Number(m[3]));
    if (current?.state === 'disabled_fork' && !repo.gateOpen) return { status: 204 };
    return setWorkflow(repo, Number(m[3]), 'active');
  }),
  route('GET', '/actions/runs', (ctx, repo) => {
    const { head_sha } = ctx.request.query;
    const runs = repo.runs.filter((r) => !head_sha || !r.head_sha || r.head_sha === head_sha);
    const perPage = Number(ctx.request.query.per_page ?? 30);
    return { status: 200, body: { total_count: runs.length, workflow_runs: runs.slice(0, perPage) } };
  }),
  route('GET', '/commits', async (_c, repo) => {
    if (repo.notReadyPolls > 0) {
      repo.notReadyPolls -= 1;
      return { status: 409, body: { message: 'Git Repository is empty.' } };
    }
    const tip = await refSha(repo, 'heads/main');
    if (!tip) return { status: 409, body: { message: 'Git Repository is empty.' } };
    return { status: 200, body: [await commitJson(repo, tip)] };
  }),
  route('GET', '/commits/([^/]+)/check-runs', async (_c, repo, m) => {
    const sha = await resolveCommit(repo, decodeURIComponent(m[3]));
    const checks = repo.checks.filter((c) => !c.head_sha || c.head_sha === sha);
    return { status: 200, body: { total_count: checks.length, check_runs: checks } };
  }),
  route('GET', '/commits/([^/]+)/status', (_c, repo) => {
    const failed = repo.statuses.some((s) => s.state === 'failure' || s.state === 'error');
    const pending = repo.statuses.length === 0 || repo.statuses.some((s) => s.state === 'pending');
    return { status: 200, body: { state: failed ? 'failure' : pending ? 'pending' : 'success', statuses: repo.statuses, total_count: repo.statuses.length, sha: 'x' } };
  }),
  route('GET', '/commits/([^/]+)', async (_c, repo, m) => {
    if (repo.notReadyPolls > 0 || repo.singleCommitReadsAsCopying) return { status: 409, body: { message: 'Git Repository is empty.' } };
    const sha = await resolveCommit(repo, decodeURIComponent(m[3]));
    if (!sha) return { status: 422, body: { message: `No commit found for SHA: ${m[3]}` } };
    return { status: 200, body: await commitJson(repo, sha) };
  }),
  route('GET', '/git/ref/(.+)', async (_c, repo, m) => {
    const ref = decodeURIComponent(m[3]);
    const sha = await refSha(repo, ref);
    return sha ? { status: 200, body: refJson(repo, ref, sha) } : notFound;
  }),
  route('POST', '/git/refs', createRef),
  route('GET', '/compare/(.+)', (ctx, repo, m) => compare(repo, decodeURIComponent(m[3]), ctx.request.query)),
  route('GET', '/contents/(.+)', (ctx, repo, m) => contents(repo, decodeURIComponent(m[3]), ctx.request.query.ref ?? '')),
  route('GET', '/pulls', async (ctx, repo) => {
    const { head, state = 'open' } = ctx.request.query;
    const wanted = repo.pulls.filter((p) => (state === 'all' || p.state === state) && (!head || `${repo.owner}:${p.head}` === head));
    return { status: 200, body: await Promise.all(wanted.map((p) => pullJson(repo, p, ctx.fake.apiMarker))) };
  }),
  route('POST', '/pulls', createPull),
  route('GET', '/pulls/(\\d+)/commits', async (_c, repo, m) => {
    const pull = repo.pulls.find((p) => p.number === Number(m[3]));
    if (!pull) return notFound;
    const shas = ((await gitIn(repo, 'rev-list', '--reverse', `${pull.base}..${pull.headSha}`)) ?? '').trim().split('\n').filter(Boolean);
    return { status: 200, body: await Promise.all(shas.map((s) => commitJson(repo, s))) };
  }),
  route('GET', '/pulls/(\\d+)', async (ctx, repo, m) => {
    const pull = repo.pulls.find((p) => p.number === Number(m[3]));
    return pull ? { status: 200, body: await pullJson(repo, pull, ctx.fake.apiMarker) } : notFound;
  }),
  route('PATCH', '/pulls/(\\d+)', async (ctx, repo, m) => {
    const pull = repo.pulls.find((p) => p.number === Number(m[3]));
    if (!pull) return notFound;
    const wasClosed = pull.state === 'closed';
    if (ctx.fake.failNextReopen && (ctx.request.body as { state?: string }).state === 'open') {
      ctx.fake.failNextReopen = false;
      pull.state = 'closed';
      return { status: 422, body: { message: 'Validation Failed' } };
    }
    Object.assign(pull, ctx.request.body as { title?: string; body?: string; state?: string });
    if (wasClosed && pull.state === 'open') await firePullEvent(ctx.fake, repo, pull);
    return { status: 200, body: await pullJson(repo, pull, ctx.fake.apiMarker) };
  }),
  route('GET', '/issues/(\\d+)/comments', (_c, repo, m) => {
    const thread = findThread(repo, Number(m[3]));
    if (!thread) return notFound;
    return { status: 200, body: thread.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.user } })) };
  }),
  route('POST', '/issues/(\\d+)/comments', (ctx, repo, m) => {
    const thread = findThread(repo, Number(m[3]));
    if (!thread) return notFound;
    const comment = { id: thread.comments.length + 1, body: (ctx.request.body as { body: string }).body, user: ctx.actor };
    thread.comments.push(comment);
    return { status: 201, body: { ...comment, user: { login: comment.user } } };
  }),
  route('GET', '/issues/(\\d+)', (ctx, repo, m) => {
    const thread = repo.threads.find((t) => t.number === Number(m[3]));
    return thread ? { status: 200, body: threadJson(ctx.fake, repo, thread, 'issues') } : notFound;
  }),
  route('GET', '/issues', (ctx, repo) => {
    if (!repo.hasIssues) return { status: 410, body: { message: 'Issues are disabled for this repo' } };
    const all = [...repo.threads.map((t) => threadJson(ctx.fake, repo, t, 'issues')), ...repo.pulls.map((p) => threadJson(ctx.fake, repo, p, 'pull'))];
    return { status: 200, body: all };
  }),
  route('POST', '/issues', (ctx, repo) => {
    if (!repo.hasIssues) return { status: 410, body: { message: 'Issues are disabled for this repo' } };
    const { title, body } = ctx.request.body as { title: string; body: string };
    const issue: FakeThread = { number: nextNumber(repo), title, body, state: 'open', user: ctx.actor, created_at: new Date().toISOString(), comments: [] };
    repo.threads.push(issue);
    return { status: 201, body: threadJson(ctx.fake, repo, issue, 'issues') };
  }),
  route('PATCH', '/issues/(\\d+)', (ctx, repo, m) => {
    const issue = repo.threads.find((t) => t.number === Number(m[3]));
    if (!issue) return notFound;
    Object.assign(issue, ctx.request.body as { body?: string; title?: string });
    return { status: 200, body: threadJson(ctx.fake, repo, issue, 'issues') };
  }),
];
