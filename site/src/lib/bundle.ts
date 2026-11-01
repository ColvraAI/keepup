// Runs at build time only. Reads site/data (and a few files beside it), and passes the page
// exactly what it draws. Every item, date, price and number from the data starts here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseNotes } from './notes';
import type { Bundle, CheckLine, ReplayCheck, Run } from './types';

const SITE = process.cwd();
const ROOT = resolve(SITE, '..');
const MAX_SITES = 16;
const MAX_HITS = 12;
const MAX_WHERE = 6;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function dataFile<T>(name: string): T {
  return readJson<T>(join(SITE, 'data', name));
}

type RawWhere = { file: string; line: number; text?: string; permalink?: string };
type RawRun = Omit<Run, 'file' | 'name' | 'manifests' | 'languages' | 'files_checked' | 'lines_checked' | 'ai_call_sites' | 'ai_call_sites_total' | 'pattern_hits' | 'pattern_hits_total' | 'model_ids_total' | 'retired_models_total' | 'checks_passed' | 'checks_dropped' | 'provider_only'> & {
  provider_only?: string;
  checks: { passed: number; dropped: { what: string; why: string; where?: string; lever?: string }[] };
  pattern_hits: Run['pattern_hits'];
  exact: { kind: string; status?: string; live_places?: unknown[] }[];
  facts: {
    languages: Run['languages'];
    manifests: { file: string; kind: string; dependencies: unknown[]; permalink?: string }[];
    ai_call_sites: Run['ai_call_sites'];
    model_ids: unknown[];
    checked: { files: number; lines: number };
  };
};

const trimWhere = (where: RawWhere[]): RawWhere[] =>
  where.slice(0, MAX_WHERE).map(({ file, line, text, permalink }) => ({ file, line, text, permalink }));

function slimRun(file: string, run: RawRun): Run {
  return {
    file,
    name: file.replace(/\.json$/, ''),
    repo: run.repo,
    commit: run.commit,
    commit_date: run.commit_date,
    scanned_at: run.scanned_at,
    as_of: run.as_of,
    provider_only: run.provider_only ?? null,
    db: { fetched: run.db.fetched, records: run.db.records, by_source: run.db.by_source },
    ran: run.ran ?? null,
    steps: run.steps,
    profile: run.profile
      ? {
          one_liner: run.profile.one_liner,
          stack: run.profile.stack,
          stack_lock: run.profile.stack_lock,
          jobs: run.profile.jobs.map(({ job, how, where }) => ({ job, how, where: trimWhere(where) })),
        }
      : null,
    candidates_considered: run.candidates_considered,
    findings: run.findings.map((finding) => ({
      rank: finding.rank,
      title: finding.title,
      effect: finding.effect,
      proof: finding.proof,
      effort: finding.effort,
      where: trimWhere(finding.where),
      why: finding.why,
      sources: finding.sources,
      deadline: finding.deadline,
      pr: finding.pr,
      ...(finding.reach ? { reach: finding.reach } : {}),
      ...(finding.lever ? { lever: finding.lever } : {}),
      ...(finding.value ? { value: finding.value } : {}),
      ...(finding.tier ? { tier: finding.tier } : {}),
    })),
    recommendations: run.recommendations ?? [],
    measurements: run.measurements ?? [],
    exact: run.exact.map(({ kind, status, live_places }) => ({ kind, ...(status ? { status } : {}), live_places: live_places ?? [] })),
    dropped_levers: run.checks.dropped.filter((item) => item.lever).map(({ lever, where }) => ({ lever: lever as string, ...(where ? { where } : {}) })),
    ...(run.incomplete ? { incomplete: run.incomplete } : {}),
    watching: run.watching,
    held_back: run.held_back.map(({ thing, date, reason, source }) => ({ thing, date, reason, source })),
    checks_passed: run.checks.passed,
    checks_dropped: run.checks.dropped.length,
    usage: run.usage,
    manifests: run.facts.manifests.map((manifest) => ({
      file: manifest.file,
      kind: manifest.kind,
      dependencies: manifest.dependencies.length,
      permalink: manifest.permalink ?? null,
    })),
    languages: run.facts.languages.slice(0, 5),
    files_checked: run.facts.checked.files,
    lines_checked: run.facts.checked.lines,
    ai_call_sites: run.facts.ai_call_sites.slice(0, MAX_SITES),
    ai_call_sites_total: run.facts.ai_call_sites.length,
    pattern_hits: run.pattern_hits.slice(0, MAX_HITS),
    pattern_hits_total: run.pattern_hits.length,
    model_ids_total: run.facts.model_ids.length,
    retired_models_total: run.exact.filter((check) => check.kind === 'model').length,
  };
}

/** The presenter's notes are private to whoever presents, so a checkout without them has no notes pane. */
function readNotes(): Bundle['notes'] {
  const path = join(ROOT, 'docs', 'script.md');
  return existsSync(path) ? parseNotes(readFileSync(path, 'utf8')) : [];
}

function readChecks(): CheckLine[] {
  const path = join(ROOT, 'data', 'recorded', 'keepup-check.json');
  return existsSync(path) ? readJson<{ lines: CheckLine[] }>(path).lines : [];
}

function readReplayChecks(): ReplayCheck[] {
  const dir = join(ROOT, 'data', 'runs', 'replay-checks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const run = readJson<RawRun>(join(dir, file));
      return {
        file,
        repo: run.repo,
        commit: run.commit,
        as_of: run.as_of,
        usd: run.usage?.usd ?? 0,
        findings: run.findings.map(({ rank, title, deadline }) => ({ rank, title, deadline })),
      };
    });
}

function requestedAppName(): string | null {
  const path = join(ROOT, 'app', 'manifest.json');
  return existsSync(path) ? readJson<{ name?: string }>(path).name ?? null : null;
}

export function loadBundle(): Bundle {
  const runFile = dataFile<{ runs: { file: string; run: RawRun }[]; model_prices?: Bundle['modelPrices'] }>('runs.json');
  const runs = runFile.runs.map(({ file, run }) => slimRun(file, run));
  return {
    modelPrices: runFile.model_prices ?? [],
    pulse: dataFile<Bundle['pulse']>('pulse.json'),
    replay: dataFile<Bundle['replay']>('replay.json'),
    prs: dataFile<{ prs: Bundle['prs'] }>('prs.json').prs,
    runs,
    weekly: dataFile<{ briefs: Bundle['weekly'] }>('weekly.json').briefs,
    moonshot: dataFile<Bundle['moonshot']>('moonshot.json'),
    manifest: dataFile<Bundle['manifest']>('manifest.json'),
    checks: readChecks(),
    replayChecks: readReplayChecks(),
    notes: readNotes(),
    requestedAppName: requestedAppName(),
  };
}
