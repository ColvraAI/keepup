// npm run data: reads the real sources and writes site/data/*.json, so site/ is
// self-contained. Nothing here is typed by hand: see docs/contracts.md.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lab/shared/env.ts';
import { registerEnvSecrets } from '../app/src/secrets.ts';
import { changelogEntries, dbInfo } from '../src/db.ts';
import { readTimeline } from './replay-summary.ts';
import { localShaResolver } from './site-data/links.ts';
import { buildManifest, type GithubObjectsLite, type SiteManifest } from './site-data/manifest.ts';
import { buildMoonshot, type Moonshot } from './site-data/moonshot.ts';
import { assertAgreesWithEngine, assertReconciles, buildPulse, parseReadmeCounts, readRows, type Pulse } from './site-data/pulse.ts';
import { buildPrs, type PrObjects, type PrView } from './site-data/prs.ts';
import { buildReplay, type Replay } from './site-data/replay.ts';
import { modelPrices } from '../src/lever-prices.ts';
import type { PriceRow } from '../src/lever-value.ts';
import { routerFallbackModel } from './site-data/router-fallback.ts';
import { buildRuns, type RunView } from './site-data/runs.ts';
import { buildWeekly, type IssueMap, type Weekly } from './site-data/weekly.ts';

export interface SiteData {
  pulse: Pulse;
  replay: Replay;
  runs: { runs: RunView[]; model_prices: PriceRow[] };
  prs: { prs: PrView[] };
  weekly: Weekly | null;
  moonshot: Moonshot;
  manifest: SiteManifest;
  problems: string[];
}

type Objects = Omit<GithubObjectsLite, 'prs' | 'issues'> & PrObjects & IssueMap;

/** data/github-objects.json is the only source of "this is on GitHub". No file means nothing is. */
function readObjects(root: string): Objects {
  const path = join(root, 'data', 'github-objects.json');
  const parsed = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Partial<Objects> : {};
  return { forks: {}, prs: {}, issues: {}, ...parsed };
}

export async function buildAll(root: string, builtAt: string): Promise<SiteData> {
  const timeline = readTimeline(root);
  const window = timeline.window;
  const objects = readObjects(root);
  const dbDir = join(root, 'data', 'db');
  const entries = [...changelogEntries(dbDir)];
  const rows = readRows(dbDir);
  const info = dbInfo(dbDir);

  const pulse = buildPulse(rows, window);
  assertReconciles(pulse.total, pulse.by_source, parseReadmeCounts(readFileSync(join(root, 'data', 'briefs', 'README.md'), 'utf8')));

  const anythingLlm = timeline.repos.find((r) => r.repo.endsWith('/anything-llm'));
  assertAgreesWithEngine(pulse, info);

  const resolve = localShaResolver(root);
  const prs = buildPrs(root, objects);
  const replay = buildReplay(timeline, objects, resolve, prs.prs);
  const runs = buildRuns(root, objects);
  const weeklyProblems: string[] = [];
  const weekly = await buildWeekly(root, objects, window, weeklyProblems);
  const moonshot = buildMoonshot({ rows, entries, window, replay, runs, fallback: anythingLlm ? routerFallbackModel(root, anythingLlm.repo, resolve(anythingLlm.repo, anythingLlm.pinned_commit)) : null });
  return {
    pulse, replay, runs: { runs: runs.runs, model_prices: modelPrices() }, prs: { prs: prs.prs }, weekly, moonshot,
    manifest: buildManifest(root, objects, info, builtAt),
    problems: [...runs.problems, ...prs.problems, ...weeklyProblems],
  };
}

function writeJson(dir: string, name: string, value: unknown): void {
  const path = join(dir, name);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(temp, path);
}

export function writeSiteData(dir: string, data: SiteData): void {
  mkdirSync(dir, { recursive: true });
  writeJson(dir, 'pulse.json', data.pulse);
  writeJson(dir, 'replay.json', data.replay);
  writeJson(dir, 'runs.json', data.runs);
  writeJson(dir, 'prs.json', data.prs);
  writeJson(dir, 'moonshot.json', data.moonshot);
  writeJson(dir, 'manifest.json', data.manifest);
  if (data.weekly) writeJson(dir, 'weekly.json', data.weekly);
  else rmSync(join(dir, 'weekly.json'), { force: true });
}

async function main(): Promise<void> {
  const root = join(import.meta.dirname, '..');
  registerEnvSecrets(loadEnv(root));
  const data = await buildAll(root, new Date().toISOString());
  writeSiteData(join(root, 'site', 'data'), data);
  const { pulse, prs, runs, weekly, replay } = data;
  const report = [
    `pulse: ${pulse.total} records, ${pulse.in_window} dated in the window, ${pulse.feed.length} in the feed`,
    `replay: ${replay.headline}`,
    `prs: ${prs.prs.length}, runs: ${runs.runs.length}, weekly: ${weekly ? `${weekly.briefs.length} from ${weekly.source}` : 'absent'}`,
    ...(pulse.outside_window.count ? [`note: ${pulse.outside_window.note}`] : []),
    ...data.problems.map((p) => `problem: ${p}`),
  ];
  process.stdout.write(`${report.join('\n')}\n`);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
