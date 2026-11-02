// What go looks at once before it starts: whether Docker answers, which forks the App can reach, and,
// when a lab fails, the last lines of what it logged.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { requireAppConfig, type Env } from './config.ts';
import { createAppClient } from './github.ts';
import { redact } from './secrets.ts';

const DOCKER_WAIT_MS = 15_000;
const TAIL_LINES = 8;
const TAIL_WIDTH = 300;

/** Null when Docker answers. Every lab's real work happens in its sandbox. */
export async function dockerProblem(): Promise<string | null> {
  try {
    await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: DOCKER_WAIT_MS });
    return null;
  } catch {
    return "Docker isn't answering (docker info failed), and every lab runs in its sandbox. Start Docker Desktop, then run npm run go.";
  }
}

/** The repos the installation covers, or null when GitHub can't say right now: not knowing is no reason to hold anything. */
export async function readCoveredForks(root: string, env: Env): Promise<string[] | null> {
  try {
    const client = createAppClient(requireAppConfig(env, root), env);
    return (await client.paginate('GET /installation/repositories', { per_page: 100 })).map((r) => r.name);
  } catch {
    return null;
  }
}

/** A file's time comes from a coarser clock than Date.now(), so on Linux a log written just after a run starts can look older than the run. */
const FILE_CLOCK_SLACK_MS = 1000;

function logsUnder(dir: string, since: number): { path: string; at: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('sandbox.log'))
    .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    .filter((l) => l.at >= since - FILE_CLOCK_SLACK_MS);
}

/** The end of the log this lab's failed run wrote, so the real error is on screen. Empty when it wrote none. */
export function failedLabLines(root: string, id: string, since: number): string[] {
  const lab = join(root, 'lab');
  const dir = existsSync(lab) ? readdirSync(lab).find((d) => d.startsWith(`${id}-`)) : undefined;
  if (!dir) return [];
  const newest = logsUnder(join(lab, '.work', dir), since).sort((a, b) => b.at - a.at)[0];
  if (!newest) return [];
  const tail = readFileSync(newest.path, 'utf8').trimEnd().split('\n').slice(-TAIL_LINES).map((l) => `      | ${redact(l.slice(0, TAIL_WIDTH))}`);
  return [`      The end of ${relative(root, newest.path)}:`, ...tail];
}
