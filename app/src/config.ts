// The App's settings, loaded through lab/shared/env.ts and validated in one place.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { EXIT_NEEDS_KEY, loadEnv, REPO_ROOT } from '../../lab/shared/env.ts';
import { registerEnvSecrets, registerSecret } from './secrets.ts';

export { EXIT_NEEDS_KEY };
export type Env = Record<string, string | undefined>;

export const SETUP_COMMAND = 'npm run setup -- --org <name>';

export class NeedsSetupError extends Error {
  readonly missing: string[];
  readonly command: string;
  constructor(missing: string[], command: string = SETUP_COMMAND, detail?: string) {
    super(detail ?? `Missing ${missing.join(', ')} in .env. Run: ${command}`);
    this.name = 'NeedsSetupError';
    this.missing = missing;
    this.command = command;
  }
}

/** The command line was wrong, as opposed to the world. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface AppConfig {
  appId: string;
  slug: string;
  keyPath: string;
  installationId: number;
  org: string;
}

export interface Urls {
  api: string;
  web: string;
  git: string;
}

/** Where to find the repo root: tests point this at a temp dir, so no real .env is ever read. */
export function repoRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.KEEPUP_ROOT ?? REPO_ROOT;
}

export function loadConfigEnv(root: string, env: NodeJS.ProcessEnv): Env {
  const merged = loadEnv(root, env);
  registerEnvSecrets(merged);
  return merged;
}

const APP_KEYS = ['DEMO_ORG', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID'] as const;

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function appSettingsUrl(org: string | undefined, slug: string | undefined): string {
  return org && slug ? `https://github.com/organizations/${org}/settings/apps/${slug}` : 'the App\'s settings page on GitHub';
}

/** The key is gone but the App isn't. Registering another App wouldn't help: it would be a second App, with nothing pointing at it. */
export function keyLostError(org: string | undefined, slug: string | undefined): NeedsSetupError {
  const url = appSettingsUrl(org, slug);
  const message = `The private key file named by GITHUB_APP_PRIVATE_KEY_PATH doesn't exist. The App is still there, so generate a new key at ${url}, save it outside the repo, and put its path in .env. Starting over with a new App is a deliberate choice: npm run setup -- --org ${org ?? '<name>'} --new-app`;
  return new NeedsSetupError(['GITHUB_APP_PRIVATE_KEY_PATH'], url, message);
}

export function requireAppConfig(env: Env, root: string = REPO_ROOT): AppConfig {
  const missing = APP_KEYS.filter((k) => !env[k]);
  if (missing.length) throw new NeedsSetupError([...missing]);
  const keyPath = expandHome(env.GITHUB_APP_PRIVATE_KEY_PATH as string);
  if (isInside(root, keyPath)) {
    throw new Error('GITHUB_APP_PRIVATE_KEY_PATH points inside the repo. Move the key out of the repo and update the path in .env.');
  }
  if (!existsSync(keyPath)) {
    throw keyLostError(env.DEMO_ORG, env.GITHUB_APP_SLUG);
  }
  const installationId = Number(env.GITHUB_APP_INSTALLATION_ID);
  if (!Number.isInteger(installationId) || installationId <= 0) throw new Error('GITHUB_APP_INSTALLATION_ID must be a whole number.');
  return { appId: env.GITHUB_APP_ID as string, slug: env.GITHUB_APP_SLUG as string, keyPath, installationId, org: env.DEMO_ORG as string };
}

export function readPrivateKey(keyPath: string): string {
  let pem: string;
  try {
    pem = readFileSync(keyPath, 'utf8');
  } catch (e) {
    throw new Error(`Can't read the App's private key file (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
  }
  if (!pem.includes('PRIVATE KEY')) throw new Error("The App's private key file isn't a PEM private key.");
  registerSecret(pem);
  return pem;
}

/** An overridden URL must be loopback, so a stray variable can never send a token to another host. */
function urlOverride(name: string, value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`${name} isn't a URL.`);
  }
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`${name} may only point at this machine; tests use it.`);
  return value;
}

export function resolveUrls(env: Env): Urls {
  return {
    api: urlOverride('KEEPUP_GITHUB_API_URL', env.KEEPUP_GITHUB_API_URL, 'https://api.github.com'),
    web: urlOverride('KEEPUP_GITHUB_WEB_URL', env.KEEPUP_GITHUB_WEB_URL, 'https://github.com'),
    git: urlOverride('KEEPUP_GIT_BASE_URL', env.KEEPUP_GIT_BASE_URL, 'https://github.com/'),
  };
}

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost';
}
