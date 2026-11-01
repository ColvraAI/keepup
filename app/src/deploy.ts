// npm run deploy: puts the built site on Vercel and records the address in data/site.json,
// but only once that address really answers. The token travels in the environment, not in argv.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NeedsSetupError, type Env } from './config.ts';
import { writeFileAtomic } from './objects.ts';

/** D30: an exact version, run through npx, so nothing is added to this repo's dependencies. */
export const VERCEL_CLI = 'vercel@65.9.0';
const SITE_OUTPUT = join('site', 'out');
const TOKEN_URL = 'https://vercel.com/account/tokens';

export interface DeployDeps {
  root: string;
  env: Env;
  log: (line: string) => void;
  /** Runs the CLI with the token in its environment, and returns what it printed to stdout. */
  runVercel: (args: string[], token: string, cwd: string) => Promise<string>;
  /** The status the address answers with. */
  statusOf: (url: string) => Promise<number>;
}

export function realRunVercel(args: string[], token: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', VERCEL_CLI, ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, VERCEL_TOKEN: token }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.on('error', (e) => reject(new Error(`Couldn't run the Vercel CLI (${e.message}).`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`The Vercel CLI failed with exit ${code}. Its message is above.`))));
  });
}

export async function realStatusOf(url: string): Promise<number> {
  return (await fetch(url, { redirect: 'follow' })).status;
}

function urlFrom(stdout: string): string {
  const url = stdout.trim().split(/\s+/).reverse().find((word) => /^https:\/\/\S+$/.test(word));
  if (!url) throw new Error("The Vercel CLI printed no deployment address, so nothing was recorded.");
  return url;
}

export async function runDeploy(deps: DeployDeps): Promise<{ url: string }> {
  const token = deps.env.VERCEL_TOKEN;
  if (!token) throw new NeedsSetupError(['VERCEL_TOKEN'], TOKEN_URL, `Missing VERCEL_TOKEN in .env. Make one at ${TOKEN_URL}.`);
  const output = join(deps.root, SITE_OUTPUT);
  if (!existsSync(output)) throw new NeedsSetupError(['a built site'], 'npm --prefix site run build', `${SITE_OUTPUT} doesn't exist, so there's nothing to deploy. Build the site first: npm --prefix site run build`);
  deps.log(`Deploying ${SITE_OUTPUT} to Vercel…`);
  const url = urlFrom(await deps.runVercel(['deploy', SITE_OUTPUT, '--prod', '--yes'], token, deps.root));
  const status = await deps.statusOf(url);
  if (status !== 200) throw new Error(`Vercel deployed to ${url}, but it answers ${status}, so data/site.json wasn't written. If the project has Deployment Protection on, turn it off for this site.`);
  writeFileAtomic(join(deps.root, 'data', 'site.json'), `${JSON.stringify({ url }, null, 2)}\n`);
  deps.log(`Live at ${url}. Written to data/site.json.`);
  return { url };
}
