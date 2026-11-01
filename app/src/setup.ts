// npm run setup: the one-time setup. The only code allowed to use the person's own gh token.
// Each step checks first, so a rerun skips what's done and picks up where it stopped.
import { execFile } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfigEnv, NeedsSetupError, type Env } from './config.ts';
import { createPersonClient, isStatus, type Client } from './github.ts';
import { isUpstreamOwner } from './guard.ts';
import { readObjects } from './objects.ts';
import { registerSecret } from './secrets.ts';
import { appOwner, ensureInstalled, registerApp, verifyInstallation, type Ctx, type SetupDeps, type SetupOptions } from './setup-app.ts';
import { updateEnvFile } from './setup-env.ts';
import { configureWorkflows, ensureActionsOn, ensureFork, ensureIssuesOn, FORKS, verifyBaseCommits, type ForkContext } from './setup-forks.ts';
import { startLocalServer } from './setup-server.ts';

export { updateEnvFile };
export type { SetupDeps, SetupOptions };

const FORK_POLL_MS = 5000;
const FORK_CLICK_TIMEOUT_MS = 5 * 60_000;
const EXPECTED_REPO = /^(anything-llm|aura|keepup-.*)$/;
export const ORG_CREATE_URL = 'https://github.com/account/organizations/new';

export class SetupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupRefused';
  }
}

export interface SetupResult { manual: string[]; problems: string[] }

/** Reads the token only when asked. It goes to Octokit and nowhere else. */
/**
 * A person's click on "Open pull request" for a repo with no fork yet: the same fork setup makes, with the same token rule.
 * The guard allows this call for this one repo, into the demo org only.
 */
export async function forkForClick(click: { token: string; env: Env; org: string; root: string; owner: string; name: string; sleep: (ms: number) => Promise<void> }): Promise<void> {
  const upstream = `${click.owner}/${click.name}`;
  const person = createPersonClient(click.token, { ...click.env, KEEPUP_FORK_ONCE: upstream });
  await ensureFork({ person, org: click.org, root: click.root, log: () => undefined, sleep: click.sleep, nowMs: () => Date.now(), pollMs: FORK_POLL_MS, forkTimeoutMs: FORK_CLICK_TIMEOUT_MS }, { upstream, owner: click.owner, name: click.name });
}

export async function readGhToken(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('gh', ['auth', 'token']);
    const token = stdout.trim();
    registerSecret(token);
    return token || null;
  } catch {
    return null;
  }
}

export async function openInBrowser(url: string): Promise<void> {
  await promisify(execFile)(platform() === 'darwin' ? 'open' : 'xdg-open', [url]);
}

/** KEEPUP_NOT_DEMO_ORGS in .env: orgs you own that must never hold the demo, comma-separated. Empty unless you set it. */
function notDemoOrgs(env: Env): string[] {
  return (env.KEEPUP_NOT_DEMO_ORGS ?? '').split(',').map((org) => org.trim().toLowerCase()).filter(Boolean);
}

function refuseWrongOrg(org: string, env: Env): void {
  if (notDemoOrgs(env).includes(org.toLowerCase())) throw new SetupRefused(`${org} is in KEEPUP_NOT_DEMO_ORGS, so it can't be the demo org. Create a new one: ${ORG_CREATE_URL}`);
  if (isUpstreamOwner(org)) throw new SetupRefused(`${org} is an upstream owner. The demo lives on forks in its own org: ${ORG_CREATE_URL}`);
}

const NEW_APP_HINT = 'An App in .env belongs to the org that registered it, so a new org gets its own: pass --new-app, which registers one and replaces the App id, slug, key path and installation in .env together, and forgets the old org\'s pull requests and issues in data/github-objects.json.';

function refuseOrgConflict(options: SetupOptions, env: Env): void {
  const current = env.DEMO_ORG;
  if (!current || current.toLowerCase() === options.org.toLowerCase() || options.newApp) return;
  if (options.overwriteEnv) return;
  throw new SetupRefused(`.env already says ${current} as DEMO_ORG, and you asked for ${options.org}. ${env.GITHUB_APP_ID ? NEW_APP_HINT : 'Pass --overwrite-env if you mean to switch.'}`);
}

/** --overwrite-env can only move .env to an org the App really belongs to. */
async function refuseAppFromAnotherOrg(ctx: Ctx, previous: string | undefined): Promise<void> {
  const { org, newApp } = ctx.options;
  if (newApp || !previous || previous.toLowerCase() === org.toLowerCase() || !ctx.env.GITHUB_APP_ID) return;
  const owner = await appOwner(ctx).catch(() => null);
  if (owner?.toLowerCase() !== org.toLowerCase()) throw new SetupRefused(`The App in .env belongs to ${owner ?? 'an account GitHub would not name'}, not ${org}. ${NEW_APP_HINT}`);
}

async function readLogin(person: Client): Promise<string | null> {
  try {
    return (await person.request('GET /user')).data.login;
  } catch {
    return null;
  }
}

async function checkOrg(person: Client, options: SetupOptions, log: (l: string) => void): Promise<void> {
  const { org, force } = options;
  try {
    await person.request('GET /orgs/{org}', { org });
  } catch (e) {
    if (isStatus(e, 404)) throw new NeedsSetupError(['the demo org'], ORG_CREATE_URL, `There's no org named ${org}. Create it at ${ORG_CREATE_URL}, then run setup again.`);
    throw e;
  }
  const notAdmin = new SetupRefused(`You need to be an admin of ${org} to register the App, and gh's token needs read:org (gh auth refresh -s read:org). Ask an owner, or create your own org: ${ORG_CREATE_URL}`);
  const membership = await person.request('GET /user/memberships/orgs/{org}', { org }).catch((e: unknown) => {
    if (isStatus(e, 403) || isStatus(e, 404)) throw notAdmin;
    throw e;
  });
  if (membership.data.role !== 'admin' || membership.data.state !== 'active') throw notAdmin;
  const repos = await person.paginate('GET /orgs/{org}/repos', { org, per_page: 100 });
  const unrelated = repos.map((r) => r.name).filter((n) => !EXPECTED_REPO.test(n));
  if (unrelated.length && !force) throw new SetupRefused(`${org} holds repos that aren't the demo's (${unrelated.join(', ')}), so it may not be the demo org. Use an empty org, or pass --force if it really is.`);
  log(`${org}: you're an admin, and it's fit for the demo.`);
}

async function ensureOrgLine(ctx: Ctx): Promise<void> {
  updateEnvFile(ctx.envPath, { DEMO_ORG: ctx.options.org }, { overwrite: ctx.options.overwriteEnv || ctx.options.newApp });
}

function makeContext(options: SetupOptions, deps: SetupDeps, person: Client, env: Env, login: string | null): Ctx {
  return {
    options, deps, env, person, login,
    envPath: join(deps.root, '.env'),
    keyDir: deps.keyDir ?? join(homedir(), '.config', 'keepup'),
    log: deps.log,
    sleep: deps.sleep ?? ((ms) => delay(ms).then(() => undefined)),
    nowMs: deps.nowMs ?? (() => Date.now()),
    pollMs: deps.pollMs ?? 5000,
    flowTimeoutMs: deps.flowTimeoutMs ?? 15 * 60_000,
  };
}

function manualStep(url: string): string {
  return `Open ${url}. If GitHub shows "I understand my workflows, go ahead and enable them", press it: workflows don't run on a fork until someone does. Setup has asked the API to enable Actions, but GitHub doesn't report whether that clears the button, and nothing can tell until a pull request exists, so look at the page. Once pull requests are open, npm run status -- --live checks for real runs.`;
}

async function setUpForks(ctx: Ctx): Promise<SetupResult> {
  const forkCtx: ForkContext = {
    person: ctx.person, org: ctx.options.org, root: ctx.deps.root, log: ctx.log, sleep: ctx.sleep, nowMs: ctx.nowMs,
    pollMs: ctx.pollMs, forkTimeoutMs: ctx.deps.forkTimeoutMs ?? 10 * 60_000,
  };
  const manual: string[] = [];
  const problems: string[] = [];
  for (const fork of FORKS) {
    const made = await ensureFork(forkCtx, fork);
    if (made === 'existed') ctx.log(`${ctx.options.org}/${fork.name} already exists as a fork. Skipping.`);
    await ensureIssuesOn(forkCtx, fork.name);
    const refused = await ensureActionsOn(forkCtx, fork.name);
    if (refused) problems.push(refused);
    const page = await configureWorkflows(forkCtx, fork.name);
    if (page && !refused) manual.push(manualStep(page));
  }
  return { manual, problems: [...problems, ...(await verifyBaseCommits(forkCtx))] };
}

export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const fileEnv = loadConfigEnv(deps.root, {});
  const stored = { ...fileEnv, ...deps.env };
  refuseWrongOrg(options.org, stored);
  refuseOrgConflict(options, stored);
  const token = await deps.ghToken();
  if (!token) throw new NeedsSetupError(['a gh login'], 'gh auth login', "gh isn't logged in. Run: gh auth login, then run setup again.");
  const env: Env = { ...stored, DEMO_ORG: options.org };
  const person = createPersonClient(token, env);
  const ctx = makeContext(options, deps, person, env, await readLogin(person));
  await checkOrg(ctx.person, options, ctx.log);
  await refuseAppFromAnotherOrg(ctx, stored.DEMO_ORG);
  const server = await startLocalServer();
  try {
    await registerApp(ctx, server);
    await ensureOrgLine(ctx);
    const forks = await setUpForks(ctx);
    await ensureInstalled(ctx);
    const coverage = await verifyInstallation(ctx);
    const result = { manual: forks.manual, problems: [...forks.problems, ...coverage] };
    setupSummary(result, deps.root).forEach((line) => ctx.log(line));
    return result;
  } finally {
    await server.close();
  }
}

export function setupSummary(result: SetupResult, root: string): string[] {
  const objects = readObjects(root);
  return [
    ...(objects.app ? [`The App: ${objects.app.url}`] : []),
    ...Object.values(objects.forks).map((url) => `Fork: ${url}`),
    ...result.problems.map((p) => `Problem: ${p}`),
    ...result.manual.map((m, i) => `Final step ${i + 1}: ${m}`),
    result.problems.length ? 'Next: fix the problems above, then run setup again.' : 'Next: npm run go',
  ];
}
