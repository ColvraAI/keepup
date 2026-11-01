// npm run dashboard [-- --port <n>] [--rebuild]: builds the site if it's out of date, then serves
// it on 127.0.0.1 with the live-scan API. Never on 0.0.0.0.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv, REPO_ROOT } from '../../../lab/shared/env.ts';
import { createChanges } from '../dashboard/changes.ts';
import { createLiveScans, KEEP_FOR_JUDGE_MINUTES } from '../dashboard/live-scan.ts';
import { startDashboard } from '../dashboard/server.ts';

const DEFAULT_PORT = 4317;
const SITE = join(REPO_ROOT, 'site');
const OUT = join(SITE, 'out');
const INDEX = join(OUT, 'index.html');
const EXIT_FAILED = 1;

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce((newest, name) => Math.max(newest, newestMtime(join(path, name))), 0);
}

function labInputs(): string[] {
  const lab = join(REPO_ROOT, 'lab');
  if (!existsSync(lab)) return [];
  return readdirSync(lab)
    .map((name) => join(lab, name))
    .filter((path) => statSync(path).isDirectory())
    .flatMap((dir) => readdirSync(dir).filter((name) => /^(pr|result).*\.(json|md)$/.test(name)).map((name) => join(dir, name)));
}

/** A lab's result, a run or a new entry in github-objects.json shows up on the next start. */
function dataIsStale(): boolean {
  const built = newestMtime(join(SITE, 'data'));
  const inputs = [join(REPO_ROOT, 'data', 'runs'), join(REPO_ROOT, 'data', 'timeline.json'), join(REPO_ROOT, 'data', 'github-objects.json'), ...labInputs()];
  return inputs.some((path) => newestMtime(path) > built);
}

function needsBuild(): boolean {
  if (!existsSync(INDEX)) return true;
  const built = statSync(INDEX).mtimeMs;
  const sources = [join(SITE, 'src'), join(SITE, 'data'), join(REPO_ROOT, 'data', 'recorded'), join(REPO_ROOT, 'docs', 'script.md')];
  return sources.some((path) => newestMtime(path) > built);
}

function runStep(label: string, args: string[]): boolean {
  process.stdout.write(`${label}\n`);
  return spawnSync('npm', args, { cwd: REPO_ROOT, stdio: 'inherit' }).status === 0;
}

function build(): boolean {
  if (!existsSync(join(SITE, 'node_modules'))) {
    if (!runStep('Installing the site’s packages…', ['--prefix', 'site', 'install', '--ignore-scripts', '--no-audit', '--no-fund'])) return false;
  }
  return runStep('Building the site…', ['--prefix', 'site', 'run', 'build']);
}

function portFrom(value: string | undefined): number {
  const port = Number(value ?? process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port takes a number from 0 to 65535.');
  return port;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { port: { type: 'string' }, rebuild: { type: 'boolean' } } });
  const port = portFrom(values.port);
  if (dataIsStale() && !runStep('Refreshing the site’s data…', ['run', 'data'])) {
    process.stderr.write('The data step failed, so this serves the last good data. The output above says why.\n');
  }
  if ((values.rebuild || needsBuild()) && !build()) {
    process.stderr.write('The site didn’t build. The output above says why.\n');
    return EXIT_FAILED;
  }
  const scans = createLiveScans({ root: REPO_ROOT, keepup: join(REPO_ROOT, 'bin', 'keepup.ts'), judgeMaxUsd: process.env.KEEPUP_JUDGE_MAX_USD });
  const changes = createChanges({ root: REPO_ROOT, scans, env: () => loadEnv() });
  const dashboard = await startDashboard({
    root: OUT,
    port,
    scan: scans.scan,
    judge: scans.judge,
    keepMinutes: KEEP_FOR_JUDGE_MINUTES,
    judgeAvailable: () => Boolean(loadEnv().ANTHROPIC_API_KEY),
    change: changes.change,
    measure: changes.measure,
    openPr: changes.openPr,
    repos: scans.repos,
    readRun: changes.readRun,
    savedChanges: changes.savedChanges,
    appConfigured: changes.appConfigured,
  });
  process.stdout.write(`keepup dashboard: http://127.0.0.1:${dashboard.port}\nPresent mode:     http://127.0.0.1:${dashboard.port}/?present#pulse\n`);
  const stop = () => {
    scans.closeAll();
    dashboard.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

const code = await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT_FAILED;
});
if (code !== 0) process.exit(code);
