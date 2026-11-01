// Step 5 for the plugin: when Claude Code is the judge, it writes its findings to a file and this checks them, the same
// way src/check.ts checks the API judge. What it prints is what survives, so a brief only holds what got through.
import { type Provenance, runJudgeChecks } from './check.ts';
import { changelogEntries, loadRecords, allSources, retirements } from './db.ts';
import { recordUrls } from './judge-bundles.ts';
import { loadLevers } from './levers.ts';
import { droppedDetail, droppedCategory, noAiCode, renderSummary } from './brief.ts';
import { rankFindings } from './rank.ts';
import { valueContext } from './lever-prices.ts';
import { withValues } from './lever-value.ts';
import { coverageHolds, type SessionLog } from './session.ts';
import { listRepoFiles } from './git-files.ts';
import { maskText } from './mask.ts';
import { knownWhere, type RunOptions, runPipeline } from './pipeline.ts';
import { unrecognisedOnLists } from './list-ids.ts';
import { stemsOf } from './judge.ts';
import { loadPinnedSources, moveFacts } from './pinned-sources.ts';
import type { Dropped, Finding, FindingOption, HeldBack, Run, Watching, Where } from './run-shape.ts';

export interface VerifyInput {
  readonly findings?: readonly Finding[];
  readonly watching?: readonly Watching[];
  readonly held_back?: readonly HeldBack[];
  /** The AI jobs the judge named, so the program can tell if each really got its searches. */
  readonly jobs?: readonly unknown[];
}

export interface VerifyOutput {
  readonly version: 1;
  readonly findings: readonly Finding[];
  readonly watching: readonly Watching[];
  readonly held_back: readonly HeldBack[];
  readonly dropped: readonly { readonly where?: string; readonly category: string; readonly detail?: string }[];
  /** The one screen a founder reads, written by the same renderer as a full run. Only set when asked for. */
  readonly brief?: string;
}

const SHAPES: readonly (readonly [keyof VerifyInput, readonly string[]])[] = [
  ['findings', ['title', 'effect', 'proof', 'effort', 'where', 'why', 'options', 'sources']],
  ['watching', ['thing', 'why', 'source']],
  ['held_back', ['thing', 'reason']],
];

/** What a model hands over is checked at the door, and the message says what shape was wanted, so it can fix it. */
export function checkInputShape(input: VerifyInput): void {
  for (const [field, needs] of SHAPES) {
    const rows = input[field] ?? [];
    if (!Array.isArray(rows)) throw new Error(`"${field}" has to be a list.`);
    for (const [index, row] of rows.entries()) {
      const missing = needs.filter((key) => !row || typeof row !== 'object' || (row as unknown as Record<string, unknown>)[key] === undefined);
      if (missing.length) throw new Error(`"${field}" item ${index + 1} needs ${missing.join(', ')}. Each item is an object with ${needs.join(', ')}.`);
    }
  }
}

/** The same text the online pipeline read: the database, the levers and the provider pages, and what it fetched, pinned. */
function databaseProvenance(): Pick<Provenance, 'allowed' | 'textFor' | 'retiredIds' | 'programText'> {
  const texts = new Map<string, string>();
  const add = (url: string, text: string) => texts.set(url, `${texts.get(url) ?? ''}\n${text}`);
  for (const record of loadRecords(allSources())) for (const url of recordUrls(record)) add(url, JSON.stringify(record));
  for (const entry of changelogEntries()) add(entry.url, `${entry.date} ${entry.text}`);
  for (const lever of loadLevers()) {
    add(lever.source, JSON.stringify(lever));
    add(lever.id, JSON.stringify(lever));
  }
  for (const row of retirements()) {
    add(row.source, row.sentence);
    if (row.page_source) add(row.page_source, `${row.id ?? ''} ${row.successors.join(' ')}`);
  }
  const pinned = loadPinnedSources().sources;
  for (const [url, text] of Object.entries(pinned)) add(url, text);
  const moves = moveFacts();
  for (const move of moves) add(move.url, move.text);
  const retiredIds = new Set([...retirements().flatMap((row) => (row.id ? [row.id] : [])), ...loadLevers().flatMap((lever) => lever.models ?? [])]);
  return { allowed: new Set(texts.keys()), textFor: (url) => texts.get(url) ?? '', retiredIds, programText: moves.flatMap((move) => [move.text, pinned[move.url] ?? '', pinned[move.from_url] ?? '']).join('\n') };
}

const isText = (value: unknown): value is string => typeof value === 'string';

/** One value where a list was wanted is read as a list of one. Anything else isn't what verify takes. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

function placeOf(raw: unknown): Where | null {
  if (!raw || typeof raw !== 'object') return null;
  const { file, line, text } = raw as Record<string, unknown>;
  const number = typeof line === 'string' && /^\d+$/.test(line) ? Number(line) : line;
  return isText(file) && typeof number === 'number' && Number.isInteger(number) && isText(text) ? { file, line: number, text } : null;
}

function optionOf(raw: unknown): FindingOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, what, needs, source } = raw as Record<string, unknown>;
  return isText(name) && isText(what) && isText(source) && (needs === undefined || needs === null || isText(needs)) ? { name, what, needs: needs ?? '', source } : null;
}

/** What the program proved stays on a finding with its title: a model can add a place, never lose one. */
function withProvedPlaces(places: readonly Where[], proved: Finding | undefined): Where[] {
  const seen = new Set((proved?.where ?? []).map((place) => `${place.file}:${place.line}`));
  return [...(proved?.where ?? []), ...places.filter((place) => !seen.has(`${place.file}:${place.line}`))];
}

/** A floor finding's options are what its sources name. A model's own "just move to the successor" can't sit beside a warning that it may break. */
function withProvedOptions(options: readonly FindingOption[], proved: Finding | undefined): readonly FindingOption[] {
  return proved?.options.length ? proved.options : options;
}

/** What goes on to the checks, field by field. A field verify doesn't know stays behind, and so does anything only the program may say. */
function rebuiltFinding(raw: Finding, proved: Finding | undefined, leverIds: ReadonlySet<string>): Finding | string {
  const effect = listOf(raw.effect);
  const sources = listOf(raw.sources);
  const where = listOf(raw.where).map(placeOf);
  const options = listOf(raw.options).map(optionOf);
  if (!isText(raw.title)) return 'its shape: "title" has to be text';
  if (!isText(raw.why) || !isText(raw.effort) || !isText(raw.proof)) return 'its shape: "why", "effort" and "proof" have to be text';
  if (!effect.every(isText)) return 'its shape: "effect" has to be a list of words';
  if (!sources.every(isText)) return 'its shape: "sources" has to be a list of links';
  if (where.some((place) => place === null)) return 'its shape: "where" has to be a list of file, line and text';
  if (options.some((option) => option === null)) return 'its shape: "options" has to be a list of name, what, needs and source';
  return {
    title: raw.title,
    effect,
    proof: raw.proof,
    effort: proved?.sdk_unverified ? proved.effort : raw.effort,
    where: withProvedPlaces(where as Where[], proved),
    why: proved?.why ?? raw.why,
    options: withProvedOptions(options as FindingOption[], proved),
    sources: [...new Set([...sources, ...(proved?.sources ?? [])])],
    lever: isText(raw.lever) && leverIds.has(raw.lever) ? raw.lever : null,
    pr: null,
    deadline: proved?.deadline ?? (isText(raw.deadline) ? raw.deadline : null),
    evidence: proved?.evidence ?? [],
    ...(proved?.reach ? { reach: proved.reach } : {}),
    ...(proved?.sdk_unverified ? { sdk_unverified: proved.sdk_unverified } : {}),
  };
}

interface Sorted<T> {
  readonly kept: T[];
  readonly dropped: Dropped[];
}

/** Anything a model supplies as evidence is ignored. A floor finding gets its evidence back from the program, by its exact title. */
function withProgramEvidence(findings: readonly Finding[], floor: readonly Finding[]): Sorted<Finding> {
  const proved = new Map(floor.map((finding) => [finding.title, finding]));
  const leverIds = new Set(loadLevers().map((lever) => lever.id));
  const rebuilt = findings.map((finding) => ({ finding, result: rebuiltFinding(finding, proved.get(finding.title), leverIds) }));
  return {
    kept: rebuilt.flatMap(({ result }) => (typeof result === 'string' ? [] : [result])),
    dropped: rebuilt.flatMap(({ finding, result }) => (typeof result === 'string' ? [{ what: String(finding.title), why: result }] : [])),
  };
}

function rowsOfShape<T extends object>(rows: readonly T[], fields: readonly (keyof T)[], rebuild: (row: T) => T): Sorted<T> {
  const fits = (row: T) => fields.every((field) => isText(row[field]));
  return {
    kept: rows.filter(fits).map(rebuild),
    dropped: rows.filter((row) => !fits(row)).map(() => ({ what: 'a row', why: `its shape: ${fields.map(String).join(', ')} have to be text` })),
  };
}

function publicDropped(items: readonly Dropped[], files: ReadonlyMap<string, string>): VerifyOutput['dropped'] {
  return items.map((item) => knownWhere(item, files)).map((item) => {
    const detail = droppedDetail(item);
    return { ...(item.where ? { where: item.where } : {}), category: droppedCategory(item), ...(detail ? { detail } : {}) };
  });
}

export function maskedFileMap(path: string, commit?: string): ReadonlyMap<string, string> {
  return new Map(listRepoFiles(path, { commit }).files.map((file) => [file.path, maskText(file.text)]));
}

function jobsOf(input: VerifyInput): number {
  return Array.isArray(input.jobs) ? input.jobs.length : 0;
}

function briefFor(floorRun: Run, checked: ReturnType<typeof runJudgeChecks>, ranked: readonly Finding[], input: VerifyInput, log: SessionLog, files: ReadonlyMap<string, string>): string {
  const covered = coverageHolds(log, jobsOf(input));
  const brief = renderSummary({
    ...floorRun,
    profile: null,
    findings: [...ranked],
    watching: checked.watching,
    held_back: checked.held_back,
    checks: checked.checks,
    ran: { search: covered, judge: true, online: false },
    coverage: { searches: log.searches, reads: log.reads },
    unrecognised: unrecognisedOnLists(floorRun.facts.model_ids, files),
  });
  if (covered || (noAiCode(floorRun) && ranked.length === 0)) return brief;
  return `${brief}Not checked against the database: ${log.searches} searches ran for ${jobsOf(input)} jobs, and it takes 2 for each, with at least one read.\n`;
}

export interface VerifyOptions extends RunOptions {
  /** With this, the output carries the brief, and its coverage line is written from this log. */
  readonly log?: SessionLog;
}

export async function verifyFindings(path: string, input: VerifyInput, options: VerifyOptions = {}): Promise<VerifyOutput> {
  checkInputShape(input);
  const floorRun = await runPipeline(path, options);
  const files = maskedFileMap(path, options.commit);
  const base = databaseProvenance();
  const exactSources = floorRun.exact.flatMap((item) => [...(item.source ? [item.source] : []), ...(item.kind === 'dependency' && item.release_notes ? [item.release_notes.url] : [])]);
  const provenance: Provenance = {
    ...base,
    allowed: new Set([...base.allowed, ...exactSources]),
    knownIds: new Set(floorRun.facts.model_ids.map((model) => model.id)),
    repoText: floorRun.facts.manifests.flatMap((manifest) => manifest.dependencies.map((dep) => `${dep.name} ${dep.spec}`)).join('\n'),
  };
  const findings = withProgramEvidence(input.findings ?? [], floorRun.findings);
  const watching = rowsOfShape(input.watching ?? [], ['thing', 'why', 'source'], ({ thing, why, source }) => ({ thing, why, source }));
  const heldBack = rowsOfShape(input.held_back ?? [], ['thing', 'reason'], ({ thing, reason, date, source }) => ({ thing, reason, date: isText(date) ? date : null, source: isText(source) ? source : null }));
  const atTheDoor = [...findings.dropped, ...watching.dropped, ...heldBack.dropped];
  const judged = runJudgeChecks({
    findings: findings.kept,
    watching: watching.kept,
    held_back: heldBack.kept,
    files,
    provenance: { ...provenance, leverNames: new Map(loadLevers().map((lever) => [lever.id, lever.name])), repoFiles: new Set([...files.keys()].map((file) => (file.split('/').pop() ?? file).toLowerCase())), repoStems: stemsOf(files.keys()) },
  });
  const checked = { ...judged, checks: { ...judged.checks, dropped: [...atTheDoor, ...judged.checks.dropped].map((item) => knownWhere(item, files)) } };
  // The saved findings carry the brief's numbers and ROI, because a person says yes to a number, and the pull request prints the ROI.
  const ranked = rankFindings(withValues(checked.findings, valueContext(floorRun.facts, files)), floorRun.as_of).findings;
  return { version: 1, findings: ranked, watching: checked.watching, held_back: checked.held_back, dropped: publicDropped(checked.checks.dropped, files), ...(options.log ? { brief: briefFor(floorRun, checked, ranked, input, options.log, files) } : {}) };
}

/** A masked, numbered window of one file: the only way the plugin path reads code. */
export function showLines(files: ReadonlyMap<string, string>, file: string, line: number, radius: number): string | null {
  const text = files.get(file);
  if (text === undefined) return null;
  const lines = text.split('\n');
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  return maskText(lines.slice(from - 1, to).map((value, index) => `${from + index}| ${value.slice(0, 300)}`).join('\n'));
}
