// The whole run, in the five steps the real briefs were made with:
// facts, profile, candidates, judge, checks. Profile, candidates and judge are seams: pass a function and it
// replaces the default. With none passed, a run is the deterministic floor: no model, no network unless asked.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { caseLookup, catalogUse, exclusionLookup, unloadedExampleLookup } from './catalog-use.ts';
import { type Provenance, runJudgeChecks } from './check.ts';
import { runChecks } from './checks.ts';
import { allSources, changelogEntries, dbInfo, loadRecords, retirements } from './db.ts';
import { addReleaseNotes } from './dependency-notes.ts';
import { checkDependencies, checkModels, type DependencyCheck } from './exact-checks.ts';
import { buildFacts, type Facts, type Step } from './facts.ts';
import { findingsFromExact, type FloorResult } from './findings.ts';
import { listRepoFiles, type RepoFiles } from './git-files.ts';
import { loadLevers } from './levers.ts';
import { maskText, maskValue } from './mask.ts';
import { openRouterModelIds } from './registry.ts';
import { rankFindings } from './rank.ts';
import { valueContext } from './lever-prices.ts';
import { withValues } from './lever-value.ts';
import { recommendationsFor } from './team.ts';
import type { CheckSummary, Dropped, ExactResult, Finding, HeldBack, Profile, Run, Usage, Watching } from './run-shape.ts';
import { loadPatterns, scanFiles, type Hit } from './scan.ts';
import { type DbRecord, searchRecords, type SearchMatch, type SearchQuery } from './search.ts';
import { REPO_ROOT, SCAN_BUDGET_MS } from './signals.ts';
import { defang, oneLine, stripControl } from './text-safety.ts';

/** What the dashboard reads. Only a run someone chose to publish goes here. */
export const RUNS_DIR = join(REPO_ROOT, 'data', 'runs');

/** Outside the plugin, because its version folder is deleted after an update, and outside anything git commits. */
export function defaultRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, 'runs') : join(homedir(), '.keepup', 'runs');
}

export class NoFilesError extends Error {
  constructor(path: string) {
    super(`No files to read in ${path}. Is it a repo with a checkout? For a clone with no checkout, add --commit <sha>.`);
    this.name = 'NoFilesError';
  }
}

export interface PipelineContext {
  readonly path: string;
  readonly commit: string | null;
  readonly asOf: string;
  readonly facts: Facts;
  readonly hits: readonly Hit[];
  readonly exact: readonly ExactResult[];
  /** Every readable file at this commit, masked: the only repo text a model may ever be given. */
  readonly files: ReadonlyMap<string, string>;
}

export interface JudgeInput {
  readonly context: PipelineContext;
  readonly profile: Profile | null;
  readonly candidates: readonly SearchMatch[];
  /** What the exact checks already prove. A judge keeps, drops or adds to it. */
  readonly floor: FloorResult;
}

export interface JudgeResult {
  readonly findings: readonly Finding[];
  /** What the program proved under a judged finding, to fall back to if the judged one can't stand. */
  readonly exact_findings?: readonly Finding[];
  readonly watching: readonly Watching[];
  readonly held_back: readonly HeldBack[];
  /** Rows the program wrote itself, which skip the prose checks. */
  readonly trusted_held_back?: readonly HeldBack[];
  readonly usage?: Usage | null;
  /** Where every source a judge may cite came from. With it, step 5 also checks that each claim traces back. */
  readonly provenance?: Provenance;
  /** Things dropped before the checks, such as a citation in the profile that didn't hold up. */
  readonly dropped?: readonly Dropped[];
  readonly incomplete?: Run['incomplete'];
  readonly candidate_log?: unknown;
  readonly provider_only?: string;
}

export interface Seams {
  readonly profile?: (context: PipelineContext) => Promise<Profile | null>;
  readonly candidates?: (context: PipelineContext, profile: Profile | null, search: (query: SearchQuery) => readonly SearchMatch[]) => Promise<readonly SearchMatch[]>;
  readonly judge?: (input: JudgeInput) => Promise<JudgeResult>;
}

export interface RunOptions {
  /** A replay rebuilds what was published, under the rules it was published with. */
  readonly exactIdsOnly?: boolean;
  readonly commit?: string;
  readonly online?: boolean;
  readonly asOf?: string;
  readonly now?: string;
  readonly patternsDir?: string;
  readonly cacheDir?: string;
  readonly notesCacheDir?: string;
  readonly fetchImpl?: typeof fetch;
  /** The whole read's time budget, for a test. */
  readonly readBudgetMs?: number;
}

async function timedStep<T>(steps: Step[], name: string, work: () => Promise<T> | T, detail: (result: T) => string): Promise<T> {
  const started = performance.now();
  const result = await work();
  steps.push({ name, detail: detail(result), ms: Math.round(performance.now() - started) });
  return result;
}

function count(value: number, word: string): string {
  return `${value.toLocaleString('en-US')} ${word}`;
}

interface ExactInput {
  readonly facts: Facts;
  readonly records: readonly DbRecord[];
  readonly asOf: string;
  readonly files: ReadonlyMap<string, string>;
  readonly since: string;
}

async function dependencyChecks(input: ExactInput, options: RunOptions): Promise<DependencyCheck[]> {
  const declared = input.facts.manifests.flatMap((manifest) => manifest.dependencies);
  const checks = await checkDependencies(declared, { records: input.records, asOf: input.asOf, online: options.online, cacheDir: options.cacheDir, fetchImpl: options.fetchImpl });
  if (!options.online) return checks;
  return addReleaseNotes(checks, { since: input.since, registry: { cacheDir: options.cacheDir, fetchImpl: options.fetchImpl, today: input.asOf }, notes: { cacheDir: options.notesCacheDir, fetchImpl: options.fetchImpl } });
}

/** Only what a registry or the database really answered counts as checked. */
function dependencyDetail(checks: readonly DependencyCheck[]): string {
  const answered = checks.filter((check) => check.status !== 'no-data' && check.status !== 'git');
  const unchecked = checks.length - answered.length;
  const behind = checks.filter((check) => check.status === 'behind').length;
  return `${count(answered.length, 'dependencies')} checked, ${behind} behind${unchecked ? `, ${count(unchecked, 'more')} not checked` : ''}`;
}

async function exactChecks(input: ExactInput, options: RunOptions, steps: Step[]): Promise<ExactResult[]> {
  const signals = { catalogUse: catalogUse(input.files), exclusionAt: exclusionLookup(input.files), caseAt: caseLookup(input.files), unloadedExample: unloadedExampleLookup(input.files), exactIdsOnly: options.exactIdsOnly };
  const models = await timedStep(steps, 'Check model ids against provider changelogs and deprecation pages', () => checkModels(input.facts.model_ids, retirements(), input.asOf, signals), (r) => count(r.length, 'ids retired, retiring or deprecated'));
  const dependencies = await timedStep(
    steps,
    options.online ? 'Check dependencies against the registries' : 'Check dependencies against the database',
    () => dependencyChecks(input, options),
    (r) => dependencyDetail(r),
  );
  return [...models, ...dependencies];
}

function sourceTextReader(records: readonly DbRecord[]): (url: string) => string {
  let byUrl: Map<string, string> | null = null;
  return (url) => {
    if (!byUrl) {
      byUrl = new Map();
      for (const record of records) if (record.url) byUrl.set(record.url, `${byUrl.get(record.url) ?? ''}\n${JSON.stringify(record)}`);
      for (const entry of changelogEntries()) byUrl.set(entry.url, `${byUrl.get(entry.url) ?? ''}\n${entry.date} ${entry.text}`);
    }
    return byUrl.get(url) ?? '';
  };
}

function lineReader(files: ReadonlyMap<string, string>): (file: string, line: number) => string {
  return (file, line) => files.get(file)?.split('\n')[line - 1] ?? '';
}

function distinctPatterns(hits: readonly Hit[]): number {
  return new Set(hits.map((hit) => hit.pattern)).size;
}

interface Checked {
  readonly findings: readonly Finding[];
  readonly watching: readonly Watching[];
  readonly held_back: readonly HeldBack[];
  readonly checks: CheckSummary;
}

function checkJudged(judged: JudgeResult, files: ReadonlyMap<string, string>, records: readonly DbRecord[]): Checked {
  const trusted = judged.trusted_held_back ?? [];
  if (judged.provenance) return runJudgeChecks({ findings: judged.findings, exact_findings: judged.exact_findings, watching: judged.watching, held_back: judged.held_back, trusted_held_back: trusted, files, provenance: judged.provenance });
  return { ...runChecks({ findings: judged.findings, files, sourceText: sourceTextReader(records) }), watching: judged.watching, held_back: [...trusted, ...judged.held_back] };
}

/** A library can't be "no action needed" in one row while a kept finding needs it moved. */
function withoutRowsFindingsNeed(rows: readonly HeldBack[], findings: readonly Finding[], exact: readonly ExactResult[]): HeldBack[] {
  const needed = findings.map((finding) => `${finding.title} ${finding.why} ${finding.options.map((option) => `${option.name} ${option.what} ${option.needs}`).join(' ')}`).join('\n');
  const names = exact.flatMap((item) => (item.kind === 'dependency' ? [item.name] : []));
  const scoped = (row: HeldBack) => row.thing.match(/^@[\w.-]+\/[\w.-]+/)?.[0];
  return rows.filter((row) => !names.some((name) => row.thing.startsWith(name) && needed.includes(name)) && !(scoped(row) && needed.includes(scoped(row) as string)));
}

/** Where it sends from comes before the tables that merely offer it, so a brief opens on the real place. */
function codeBeforeTables(findings: readonly Finding[], exact: readonly ExactResult[]): Finding[] {
  const tablePlaces = new Set(exact.flatMap((item) => (item.kind === 'model' ? item.live_places.filter((place) => place.catalog).map((place) => `${place.file}:${place.line}`) : [])));
  const isTable = (place: Finding['where'][number]) => tablePlaces.has(`${place.file}:${place.line}`);
  return findings.map((finding) => ({ ...finding, where: [...finding.where.filter((place) => !isTable(place)), ...finding.where.filter(isTable)] }));
}

/** What a repo stopped this run from reading, in words a founder can read. A run that couldn't finish never reads as a clean one. */
function stoppedEarly(listed: RepoFiles, facts: Facts, scanOverTime: number): Run['incomplete'] {
  const late = Math.max(facts.checked.over_time ?? 0, scanOverTime);
  const big = listed.skipped.over_budget;
  if (!late && !big) return undefined;
  const skipped = [...(late ? [`${count(late, 'files')} not read: the time budget ran out`] : []), ...(big ? [`${count(big, 'files')} not read: the read budget ran out`] : [])];
  return { reason: late ? 'The read stopped at its time budget, so this covers only what it reached.' : 'The read stopped at its size budget, so this covers only what it reached.', skipped };
}

function mergedIncomplete(a: Run['incomplete'], b: Run['incomplete']): Run['incomplete'] {
  if (!a || !b) return a ?? b;
  return { reason: `${a.reason} ${b.reason}`, skipped: [...a.skipped, ...b.skipped] };
}

/** A dropped finding's place comes from a model's reply, so it's only said if that's a file keepup really read. */
export function knownWhere(item: Dropped, files: ReadonlyMap<string, string>): Dropped {
  const { where, ...rest } = item;
  if (where === undefined) return item;
  const file = where.match(/^(.*):\d+$/)?.[1];
  return file !== undefined && files.has(file) ? { ...rest, where: oneLine(where) } : rest;
}

export async function runPipeline(path: string, options: RunOptions = {}, seams: Seams = {}): Promise<Run> {
  const db = dbInfo();
  const asOf = options.asOf ?? db.fetched;
  const listed = listRepoFiles(path, { commit: options.commit, budgetMs: options.readBudgetMs });
  if (listed.files.length === 0 && !listed.skipped.over_time) throw new NoFilesError(path);
  const facts = buildFacts(path, { commit: options.commit, listed });
  const steps: Step[] = [...facts.steps];
  const files = new Map(listed.files.map((file) => [file.path, maskText(file.text)]));
  const records = loadRecords(allSources());
  const scanned = await timedStep(steps, 'Run patterns', () => scanFiles(listed.files, loadPatterns(options.patternsDir), listed.deadline === undefined ? SCAN_BUDGET_MS : listed.deadline - performance.now()), (r) => `${count(r.hits.length, 'hits')} in ${count(r.checked.files, 'files')}`);
  const { hits } = scanned;
  const exact = await exactChecks({ facts, records, asOf, files, since: db.window.since }, options, steps);
  const context: PipelineContext = { path, commit: listed.commit, asOf, facts, hits, exact, files };

  const profile = seams.profile ? await timedStep(steps, 'Understand the product', () => seams.profile!(context), (r) => (r ? `${r.jobs.length} AI jobs` : 'no profile')) : null;
  const search = (query: SearchQuery) => searchRecords(records, query).matches;
  const candidates = seams.candidates ? await timedStep(steps, 'Search the database', () => seams.candidates!(context, profile, search), (r) => count(r.length, 'candidates')) : [];
  const openRouterIds = options.online && exact.some((item) => item.kind === 'model' && item.not_live.some((place) => place.route === 'gateway')) ? await openRouterModelIds({ cacheDir: options.cacheDir, fetchImpl: options.fetchImpl }) : null;
  const floor = findingsFromExact(exact, { lineText: lineReader(files), window: db.window, levers: loadLevers(), asOf, retirements: retirements(), changelog: changelogEntries(), files, openRouterIds });
  const judged: JudgeResult = seams.judge
    ? await timedStep(steps, 'Judge each candidate against the code', () => seams.judge!({ context, profile, candidates, floor }), (r) => `${r.findings.length} fit, ${r.held_back.length} held back`)
    : floor;

  const checked = await timedStep(steps, 'Check every claim', () => checkJudged(judged, files, records), (r) => `${r.checks.passed} checks passed, ${r.checks.dropped.length} findings dropped`);
  const ranked = rankFindings(withValues(checked.findings, valueContext(facts, files)), asOf);
  const incomplete = mergedIncomplete(stoppedEarly(listed, facts, scanned.checked.over_time ?? 0), judged.incomplete);

  return {
    version: 1,
    repo: facts.repo,
    commit: listed.commit,
    ...(listed.base_commit ? { base_commit: listed.base_commit } : {}),
    commit_date: facts.commit_date,
    scanned_at: options.now ?? new Date().toISOString(),
    as_of: asOf,
    db,
    ran: { search: Boolean(seams.candidates) && profile !== null, judge: Boolean(seams.judge), online: Boolean(options.online) },
    steps,
    facts,
    pattern_hits: hits,
    exact,
    profile,
    candidates_considered: candidates.length + exact.length + distinctPatterns(hits),
    findings: codeBeforeTables(ranked.findings, exact),
    watching: checked.watching,
    held_back: withoutRowsFindingsNeed(checked.held_back, checked.findings, exact),
    checks: { passed: checked.checks.passed, dropped: [...(judged.dropped ?? []), ...checked.checks.dropped].map((item) => knownWhere(item, files)) },
    rank_explanation: ranked.explanation,
    usage: judged.usage ?? null,
    ...(incomplete ? { incomplete } : {}),
    ...(judged.candidate_log ? { candidate_log: judged.candidate_log } : {}),
    ...(judged.provider_only ? { provider_only: judged.provider_only } : {}),
    ...(floor.moves?.length ? { moves: floor.moves } : {}),
    recommendations: recommendationsFor(facts, files, records, { levers: loadLevers(), hits }),
  };
}

/** <name>.json, named after the repo unless told otherwise. */
export function runFileName(run: Pick<Run, 'repo'>, name?: string): string {
  const base = name ?? run.repo.split('/').pop() ?? run.repo;
  return `${base.replace(/[^A-Za-z0-9._-]/g, '-')}.json`;
}

export class WouldReplaceJudgedRunError extends Error {
  constructor(path: string) {
    super(`${path} holds a judged run, and this one has no judge. Name another --out, or add --force.`);
    this.name = 'WouldReplaceJudgedRunError';
  }
}

function isJudgedRunFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return Boolean((JSON.parse(readFileSync(path, 'utf8')) as Run).usage);
  } catch {
    return false;
  }
}

/** What goes on disk: every string masked once more, model replies included, and any rejected link dead. */
export function safeRun(run: Run): Run {
  const masked = maskValue(run);
  return { ...masked, checks: { ...masked.checks, dropped: masked.checks.dropped.map((item) => ({ ...item, what: defang(item.what), why: defang(item.why), ...(item.where === undefined ? {} : { where: stripControl(item.where) }) })) } };
}

export interface WriteOptions {
  readonly name?: string;
  /** A folder, or a file when it ends in .json. */
  readonly out?: string;
  readonly force?: boolean;
}

export function writeRun(run: Run, options: WriteOptions = {}): string {
  const out = options.out ?? defaultRunsDir();
  const path = out.endsWith('.json') ? out : join(out, runFileName(run, options.name));
  if (!run.usage && !options.force && isJudgedRunFile(path)) throw new WouldReplaceJudgedRunError(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(safeRun(run), null, 1)}\n`);
  return path;
}
