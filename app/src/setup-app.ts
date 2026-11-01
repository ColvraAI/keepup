// The App half of setup: register it once, install it, and check what GitHub says about both.
// A stored value is only a claim. Each one is confirmed with the App's own key before it's relied on.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { expandHome, keyLostError, loadConfigEnv, NeedsSetupError, requireAppConfig, resolveUrls, type Env } from './config.ts';
import { createAppClient, createAppJwtClient, getAppInfo, getBotIdentity, isStatus, type Client } from './github.ts';
import { recordsFor, updateObjects, withFork, type GithubObjects } from './objects.ts';
import { registerSecret } from './secrets.ts';
import { updateEnvFile } from './setup-env.ts';
import { FORKS } from './setup-forks.ts';
import { formPage, START_PATH, type LocalServer } from './setup-server.ts';

export interface SetupOptions {
  org: string;
  appName?: string;
  force?: boolean;
  overwriteEnv?: boolean;
  newApp?: boolean;
}

export interface SetupDeps {
  root: string;
  env: Env;
  keyDir?: string;
  /** Where a key goes if keyDir fails at the one moment GitHub hands it over. Outside the repo. */
  keyFallbackDirs?: string[];
  ghToken: () => Promise<string | null>;
  openBrowser: (url: string) => Promise<void>;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  pollMs?: number;
  forkTimeoutMs?: number;
  flowTimeoutMs?: number;
}

export interface Ctx {
  options: SetupOptions;
  deps: SetupDeps;
  env: Env;
  envPath: string;
  keyDir: string;
  person: Client;
  login: string | null;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  pollMs: number;
  flowTimeoutMs: number;
}

export function reloadEnv(ctx: Ctx): Env {
  return { ...ctx.deps.env, ...loadConfigEnv(ctx.deps.root, {}), DEMO_ORG: ctx.options.org };
}

function buildManifest(options: SetupOptions, server: LocalServer): string {
  const base = JSON.parse(readFileSync(join(REPO_ROOT, 'app', 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const homepage = `https://github.com/${options.org}`;
  // No setup_url: this server is gone once setup exits, and the App would send every later install to a dead page.
  return JSON.stringify({ ...base, name: options.appName ?? base.name, url: homepage, hook_attributes: { url: homepage, active: false }, redirect_url: server.redirectUrl });
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NeedsSetupError(['a browser step'], 'npm run setup', message)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

function saveKey(keyDir: string, slug: string, id: number, pem: string): string {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const preferred = join(keyDir, `${slug}.private-key.pem`);
  const path = existsSync(preferred) ? join(keyDir, `${slug}-${id}.private-key.pem`) : preferred;
  writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return path;
}

/** GitHub hands the key over once, so this is checked before the browser opens rather than found out after. */
function assertKeyDirWritable(keyDir: string): void {
  const probe = join(keyDir, `.keepup-probe-${process.pid}`);
  try {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, '', { mode: 0o600 });
    rmSync(probe);
  } catch (e) {
    throw new Error(`Setup can't write the App's private key to ${keyDir} (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}). Nothing was registered. GitHub shows a key only once, so fix that folder first, then run setup again.`);
  }
}

interface SavedKey { path: string; fallback: boolean }

/** The key's one chance. If its folder fails now, a fallback file keeps it, with the same mode, still outside the repo. */
function saveKeySomewhere(ctx: Ctx, slug: string, id: number, pem: string): SavedKey | null {
  try {
    return { path: saveKey(ctx.keyDir, slug, id, pem), fallback: false };
  } catch {
    for (const dir of ctx.deps.keyFallbackDirs ?? [homedir(), tmpdir()]) {
      try {
        return { path: saveKey(dir, `keepup-recovered-${slug}`, id, pem), fallback: true };
      } catch {
        // The next folder, then the honest message.
      }
    }
    return null;
  }
}

function appSettings(ctx: Ctx, slug: string): string {
  return `${resolveUrls(ctx.env).web}/organizations/${ctx.options.org}/settings/apps/${slug}`;
}

/** The address goes in the log first, so a browser that won't open, or opens the wrong profile, costs nothing. */
async function openForPerson(ctx: Ctx, url: string): Promise<void> {
  const who = ctx.login ? ` signed in to GitHub as ${ctx.login}` : '';
  ctx.log(`If the page doesn't open, or opens in the wrong browser, open this in a browser${who}: ${url}`);
  try {
    await ctx.deps.openBrowser(url);
  } catch {
    ctx.log("Couldn't open a browser from here. Open that address yourself; setup is waiting.");
  }
}

/** Throws instead of answering when the App exists but its key doesn't: another App wouldn't fix that. */
function appInEnv(ctx: Ctx): boolean {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_PATH } = reloadEnv(ctx);
  if (!GITHUB_APP_ID) return false;
  if (GITHUB_APP_SLUG && GITHUB_APP_PRIVATE_KEY_PATH && existsSync(expandHome(GITHUB_APP_PRIVATE_KEY_PATH))) return true;
  throw keyLostError(ctx.options.org, GITHUB_APP_SLUG);
}

export async function registerApp(ctx: Ctx, server: LocalServer): Promise<void> {
  const { org, newApp } = ctx.options;
  if (!newApp && appInEnv(ctx)) {
    ctx.log('The App is already registered. Skipping.');
    return;
  }
  assertKeyDirWritable(ctx.keyDir);
  const { web } = resolveUrls(ctx.env);
  server.setForm(formPage(`${web}/organizations/${org}/settings/apps/new?state=${server.state}`, buildManifest(ctx.options, server)));
  ctx.log('Opening your browser to create the App. Press "Create GitHub App" there.');
  ctx.log(`If GitHub says the name is taken, an earlier try may have left that App: delete it on its page under https://github.com/organizations/${org}/settings/apps, then run setup again. Only if the name is someone else's, use --app-name <another name>, which puts that name on every pull request.`);
  await openForPerson(ctx, `${server.url}${START_PATH}`);
  const code = await withTimeout(server.code(), ctx.flowTimeoutMs, "GitHub didn't come back from the App creation page in time. Run: npm run setup, and finish the page in your browser.");
  const { data } = await ctx.person.request('POST /app-manifests/{code}/conversions', { code });
  for (const secret of [data.pem, data.client_secret, data.webhook_secret]) registerSecret(secret);
  const slug = data.slug ?? '';
  const saved = saveKeySomewhere(ctx, slug, data.id, data.pem);
  if (!saved) {
    updateEnvFile(ctx.envPath, { DEMO_ORG: org, GITHUB_APP_ID: String(data.id), GITHUB_APP_SLUG: slug, GITHUB_APP_INSTALLATION_ID: '' }, { overwrite: true });
    throw new Error(`The App ${slug} was registered, but its private key couldn't be saved anywhere, and GitHub won't show it again. Generate a new key at ${appSettings(ctx, slug)}, then set GITHUB_APP_PRIVATE_KEY_PATH in .env. Or delete the App there and run setup again.`);
  }
  const keyPath = saved.path;
  if (saved.fallback) ctx.log(`The key couldn't go in ${ctx.keyDir}, so it's at ${keyPath}, with mode 0600, and .env points there. Move it somewhere lasting and update .env. The App's page is ${appSettings(ctx, slug)}.`);
  // A new App replaces all of this together, so .env can't end up with half of one App and half of another.
  updateEnvFile(ctx.envPath, { DEMO_ORG: org, GITHUB_APP_ID: String(data.id), GITHUB_APP_SLUG: slug, GITHUB_APP_PRIVATE_KEY_PATH: keyPath, GITHUB_APP_INSTALLATION_ID: '' }, { overwrite: true });
  ctx.log(`Registered the App as ${data.slug}. Its private key is saved outside the repo with mode 0600.`);
  if (newApp) ctx.log('Leave --new-app off from now on: it registers another App each time.');
}

function appJwt(ctx: Ctx): { client: Client; appId: number } {
  const env = reloadEnv(ctx);
  return { client: createAppJwtClient(env.GITHUB_APP_ID as string, expandHome(env.GITHUB_APP_PRIVATE_KEY_PATH as string), env), appId: Number(env.GITHUB_APP_ID) };
}

/** Who owns the App in .env, or null when GitHub says it no longer exists. */
export async function appOwner(ctx: Ctx): Promise<string | null> {
  const { client } = appJwt(ctx);
  try {
    const { data } = await client.request('GET /app');
    return (data?.owner as { login?: string } | null)?.login ?? null;
  } catch (e) {
    if (isStatus(e, 401) || isStatus(e, 404)) return null;
    throw e;
  }
}

async function confirmInstallation(client: Client, appId: number, org: string, id: number): Promise<boolean> {
  try {
    const { data } = await client.request('GET /app/installations/{installation_id}', { installation_id: id });
    const login = (data.account as { login?: string } | null)?.login;
    return data.app_id === appId && login?.toLowerCase() === org.toLowerCase();
  } catch (e) {
    if (isStatus(e, 404)) return false;
    throw e;
  }
}

async function pollForInstallation(ctx: Ctx, client: Client): Promise<number | null> {
  try {
    const { data } = await client.request('GET /orgs/{org}/installation', { org: ctx.options.org });
    return data.id;
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

async function waitForInstallation(ctx: Ctx, client: Client): Promise<number> {
  const started = ctx.nowMs();
  for (;;) {
    const found = await pollForInstallation(ctx, client);
    if (found) return found;
    if (ctx.nowMs() - started >= ctx.flowTimeoutMs) throw new NeedsSetupError(['GITHUB_APP_INSTALLATION_ID'], 'npm run setup', "The App isn't installed on the org yet. Finish the install page in your browser, then run: npm run setup");
    await ctx.sleep(ctx.pollMs);
  }
}

export async function ensureInstalled(ctx: Ctx): Promise<void> {
  const env = reloadEnv(ctx);
  const { org } = ctx.options;
  if ((await appOwner(ctx)) === null) {
    throw new NeedsSetupError(['a working App'], `npm run setup -- --org ${org} --new-app`, `GitHub doesn't recognise the App in .env, so it was deleted or its key was replaced. Start over with: npm run setup -- --org ${org} --new-app`);
  }
  const { client, appId } = appJwt(ctx);
  const stored = Number(env.GITHUB_APP_INSTALLATION_ID);
  if (stored && (await confirmInstallation(client, appId, org, stored))) {
    ctx.log('The App is already installed. Checking it covers the forks.');
    return;
  }
  if (stored) ctx.log(`Installation ${stored} in .env isn't on GitHub any more. Looking for the current one.`);
  const existing = await pollForInstallation(ctx, client);
  const id = existing ?? (await (async () => {
    const { web } = resolveUrls(ctx.env);
    ctx.log(`Opening the install page. Pick ${org} and all repositories, then press Install.`);
    await openForPerson(ctx, `${web}/apps/${env.GITHUB_APP_SLUG}/installations/new`);
    return waitForInstallation(ctx, client);
  })());
  updateEnvFile(ctx.envPath, { GITHUB_APP_INSTALLATION_ID: String(id) }, { overwrite: true });
  ctx.log(`Installed. Installation ${id} saved to .env.`);
}

export async function verifyInstallation(ctx: Ctx): Promise<string[]> {
  const env = reloadEnv(ctx);
  const config = requireAppConfig(env, ctx.deps.root);
  const app = createAppClient(config, env);
  const repos = await app.paginate('GET /installation/repositories', { per_page: 100 });
  const names = repos.map((r) => r.name);
  const missing = FORKS.filter((f) => !names.includes(f.name)).map((f) => f.name);
  const identity = await getBotIdentity(app, config.slug);
  const info = await getAppInfo(app, identity.login);
  const forks = await Promise.all(FORKS.filter((f) => names.includes(f.name)).map(async (f) => [f.name, (await app.request('GET /repos/{owner}/{repo}', { owner: config.org, repo: f.name })).data.html_url] as const));
  updateObjects(ctx.deps.root, (o) => forks.reduce<GithubObjects>((acc, [name, url]) => withFork(acc, name, url), { ...recordsFor(o, config.org), org: config.org, app: info }));
  ctx.log(`Written to data/github-objects.json: the App and ${forks.length} fork${forks.length === 1 ? '' : 's'}, as GitHub reports them.`);
  return missing.length ? [`The installation doesn't cover ${missing.join(' and ')}. Add ${missing.length === 1 ? 'it' : 'them'} at https://github.com/organizations/${config.org}/settings/installations/${config.installationId}`] : [];
}
