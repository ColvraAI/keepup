// Octokit clients for the two identities. Every request passes the guard before it
// leaves the process, so a wrong owner fails here even if a caller forgets to check.
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';
import { isLoopback, readPrivateKey, resolveUrls, type AppConfig, type Env } from './config.ts';
import { assertRequestAllowed, type Identity } from './guard.ts';
import { redact, registerSecret } from './secrets.ts';

export type Client = InstanceType<typeof Octokit>;

export interface BotIdentity { login: string; id: number; name: string; email: string }
export interface AppInfo { slug: string; url: string; bot: string }

const safeLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message: string) => process.stderr.write(`${redact(message)}\n`),
  error: (message: string) => process.stderr.write(`${redact(message)}\n`),
};

function baseOptions(api: string) {
  const local = isLoopback(api);
  return {
    baseUrl: api,
    userAgent: 'keepup-demo',
    log: safeLog,
    // Local tests have no rate limits, and the throttler's one-second write gap would slow them for nothing.
    ...(local ? { retry: { enabled: false }, throttle: { enabled: false } } : {}),
  };
}

function withGuard(octokit: Client, env: Env, identity: Identity): Client {
  octokit.hook.before('request', (options) => {
    const parsed = octokit.request.endpoint.parse(options);
    const path = new URL(parsed.url, 'https://api.github.com').pathname;
    assertRequestAllowed({ method: parsed.method, path, body: parsed.body }, env, identity);
  });
  return octokit;
}

/** Authenticates as the App installation. Tokens are minted and refreshed by @octokit/auth-app. */
export function createAppClient(config: AppConfig, env: Env): Client {
  const { api } = resolveUrls(env);
  const privateKey = readPrivateKey(config.keyPath);
  const octokit = new Octokit({
    ...baseOptions(api),
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey, installationId: config.installationId },
  });
  return withGuard(octokit, env, 'app');
}

/** The App itself, before an installation exists: setup uses it to find the installation. */
export function createAppJwtClient(appId: string, keyPath: string, env: Env): Client {
  const { api } = resolveUrls(env);
  const octokit = new Octokit({ ...baseOptions(api), authStrategy: createAppAuth, auth: { appId, privateKey: readPrivateKey(keyPath) } });
  return withGuard(octokit, env, 'app');
}

/** Setup's identity: the person's own gh token. Only setup.ts may call this. */
export function createPersonClient(token: string, env: Env): Client {
  registerSecret(token);
  const { api } = resolveUrls(env);
  return withGuard(new Octokit({ ...baseOptions(api), auth: token }), env, 'person');
}

/** A short-lived installation token for git over HTTPS. */
export async function getInstallationToken(octokit: Client): Promise<string> {
  const { token } = (await octokit.auth({ type: 'installation' })) as { token: string };
  registerSecret(token);
  return token;
}

/** Commits are authored as <slug>[bot] <id+slug[bot]@users.noreply.github.com>, so GitHub links them to the App. */
export async function getBotIdentity(octokit: Client, slug: string): Promise<BotIdentity> {
  const login = `${slug}[bot]`;
  const { data } = await octokit.request('GET /users/{username}', { username: login });
  const id = Number(data.id);
  return { login: data.login, id, name: data.login, email: `${id}+${data.login}@users.noreply.github.com` };
}

/** What GitHub says the App is. Goes in data/github-objects.json; never built by hand. */
export async function getAppInfo(octokit: Client, bot: string): Promise<AppInfo> {
  const { data } = await octokit.request('GET /app');
  if (!data?.slug) throw new Error('GitHub returned no slug for this App.');
  return { slug: data.slug, url: data.html_url, bot };
}

export function isStatus(e: unknown, status: number): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: number }).status === status;
}

/** GitHub's answer to a write from an App whose installation doesn't reach the repo, or lacks a permission. A public repo still answers its reads. */
export function isNotCovered(e: unknown): boolean {
  return isStatus(e, 403) && /resource not accessible by integration/i.test(describeApiError(e));
}

export function installationPage(org: string, installationId?: string | number): string {
  return `https://github.com/organizations/${org}/settings/installations${installationId ? `/${installationId}` : ''}`;
}

export function notCoveredLine(org: string, repo: string, installationId?: string | number): string {
  return `The App can't reach ${org}/${repo}: it's not on the installation, or a permission hasn't been accepted. Add it at ${installationPage(org, installationId)}, then run this again.`;
}

/** Where a base commit stands on a fork. GET /commits/{sha} answers 200 for anything in the fork network, so only the fork's own branch can say whether it holds it. */
export async function baseCommitStanding(octokit: Client, owner: string, repo: string, sha: string, branch: string): Promise<string> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', { owner, repo, basehead: `${sha}...${branch}`, per_page: 1 });
  return data.status;
}

export const holdsBaseCommit = (standing: string): boolean => standing === 'ahead' || standing === 'identical';

/** The fields of a 422 that say why, without the request (which holds headers). */
export function describeApiError(e: unknown): string {
  const err = e as { status?: number; message?: string; response?: { data?: { message?: string; errors?: { message?: string; code?: string; field?: string }[] } } };
  const details = (err.response?.data?.errors ?? []).map((x) => x.message ?? [x.field, x.code].filter(Boolean).join(' ')).filter(Boolean);
  const main = err.response?.data?.message ?? err.message ?? String(e);
  return redact(`${err.status ?? 'error'}: ${[main, ...details].join(' · ')}`);
}
