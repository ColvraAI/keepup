// The free path's evidence: what the pipeline shows its judge, built by the program and offline, so the session's own Claude
// only has to judge. keepup prepare writes what needs no model, and keepup bundles adds a bundle per job from the session's profile.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCandidates, type Candidate } from './candidates.ts';
import { declaredPackages } from './claude.ts';
import { allSources, loadRecords } from './db.ts';
import { promptParts } from './bundle-parts.ts';
import { RETIRED_PATTERN, type Bundle, jobBundle } from './judge-bundles.ts';
import { JUDGE_SYSTEM } from './judge-schema.ts';
import { candidatesFor, floorItemsFor, repoBundles } from './judge.ts';
import { loadLevers, loadPatternMeta } from './levers.ts';
import { libraryFacts } from './library-moves.ts';
import { maskText, maskValue } from './mask.ts';
import type { PipelineContext } from './pipeline.ts';
import { parseProfile, verifyContextOf, verifyProfile } from './profile.ts';
import { sessionPrefix } from './repo-text.ts';
import type { Dropped, Run } from './run-shape.ts';
import { searchRecords } from './search.ts';
import { logEvent } from './session.ts';
import { stackLock } from './stack-lock.ts';
import { oneLine } from './text-safety.ts';
import { maskedFileMap } from './verify.ts';

const BUNDLES_FILE = 'bundles.json';
const PROFILE_FILE = 'profile.json';
const FLOOR_FILE = 'floor.json';

/** A bundle as the session reads it. Its links aren't kept: verify checks a source against the whole database. */
export interface SessionBundle {
  readonly id: string;
  readonly kind: Bundle['kind'];
  readonly prompt: string;
  readonly candidates?: number;
}

export interface SessionBundles {
  readonly version: 1;
  /** The repo and commit keepup prepare read, so a job's quotes are checked against the same text. */
  readonly root: string;
  readonly commit: string | null;
  readonly prefix: string;
  readonly rules: string;
  readonly floor: SessionBundle | null;
  /** The rest of a floor too long to print as one. */
  readonly floor_rest?: readonly SessionBundle[];
  readonly patterns: readonly SessionBundle[];
  readonly jobs: readonly SessionBundle[];
}

/** One bundle, or, if it's too long to print as one, its parts, each a bundle of its own to read. A job's candidates count on its last part, the one reached by reading the others. */
function toSession({ id, kind, prompt }: Bundle, candidates?: number): SessionBundle[] {
  const counted = candidates === undefined ? {} : { candidates };
  const parts = promptParts(prompt);
  if (parts.length === 1) return [{ id, kind, prompt, ...counted }];
  return parts.map((text, index) => ({
    id: `${id} (part ${index + 1} of ${parts.length})`,
    kind,
    prompt: `Part ${index + 1} of ${parts.length} of one bundle, split so that each prints whole. Read them all, then judge them together, as one bundle.\n\n${text}`,
    ...(index === parts.length - 1 ? counted : {}),
  }));
}

function contextOf(run: Run, path: string, files: ReadonlyMap<string, string>): PipelineContext {
  return { path, commit: run.commit, asOf: run.as_of, facts: run.facts, hits: run.pattern_hits, exact: run.exact, files };
}

/** Retirements take one line in a brief, so the floor says them and no pattern bundle is spent on them. */
export function prepareBundles(path: string, floor: Run, commit?: string): SessionBundles {
  const context = contextOf(floor, path, maskedFileMap(path, commit));
  const levers = loadLevers();
  const changelog = loadRecords(allSources().filter((source) => source === 'changelog'));
  const patterns = loadPatternMeta().filter((pattern) => pattern.id !== RETIRED_PATTERN);
  const built = repoBundles(context, { patterns, changelog }, floorItemsFor(context, maskValue(floor.findings), levers), levers);
  const [first = null, ...rest] = built.floor ? toSession(built.floor) : [];
  return { version: 1, root: realpathSync(path), commit: commit ?? null, prefix: maskText(sessionPrefix(context)), rules: JUDGE_SYSTEM, floor: first, floor_rest: rest, patterns: built.patterns.flatMap((bundle) => toSession(bundle)), jobs: [] };
}

/** Repo text is masked where it's read, in the file map and above. Masked again here it would hit a public lever's id, and a finding needs that id to be priced. */
export function writeBundles(dir: string, bundles: SessionBundles): void {
  writeFileSync(join(dir, BUNDLES_FILE), `${JSON.stringify(bundles, null, 1)}\n`);
}

function readPrepared<T>(dir: string, file: string): T {
  const path = join(dir, file);
  if (!existsSync(path)) throw new Error(`${file} isn't there yet. Run keepup prepare first.`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const isText = (value: unknown): value is string => typeof value === 'string';
const safeLine = (text: string): string => oneLine(maskText(text));

export interface BundlesResult {
  readonly jobs: readonly SessionBundle[];
  readonly dropped: readonly Dropped[];
  /** Jobs that stood up but matched nothing in the database, so they have no bundle. */
  readonly unmatched: readonly string[];
  readonly patterns: number;
  readonly floor: boolean;
  readonly floor_rest?: number;
  /** Each pattern bundle's path, name and size, for the report. */
  readonly pattern_list?: readonly { readonly path: string; readonly id: string; readonly chars: number }[];
}

function candidatesByJob(context: PipelineContext, profile: ReturnType<typeof verifyProfile>['profile']): readonly Candidate[] {
  const records = loadRecords(allSources());
  return buildCandidates(profile, (query) => searchRecords(records, query).matches, { lock: stackLock(context.facts), declaredPackages: declaredPackages(context) }).candidates;
}

/** The pipeline's step 3 and its job bundles, on the session's profile. Offline: no card, no registry. */
export async function runBundles(input: { readonly path: string; readonly text: string; readonly dir: string }): Promise<BundlesResult> {
  const raw = parseProfile(input.text);
  const prepared = readPrepared<SessionBundles>(input.dir, BUNDLES_FILE);
  if (prepared.root !== realpathSync(input.path)) throw new Error(`What's in ${input.dir} was prepared for another repo. Run keepup prepare on this one first.`);
  const context = contextOf(readPrepared<Run>(input.dir, FLOOR_FILE), input.path, maskedFileMap(input.path, prepared.commit ?? undefined));
  const { profile, dropped } = verifyProfile(raw, verifyContextOf(context));
  const counts = { patterns: prepared.patterns.length, floor: prepared.floor !== null, floor_rest: prepared.floor_rest?.length ?? 0, pattern_list: pathsOf('patterns', prepared.patterns) };
  if (profile.jobs.length === 0) return { jobs: [], dropped, unmatched: [], ...counts };
  const candidates = candidatesByJob(context, profile);
  const facts = await libraryFacts(context, { online: false });
  const built = profile.jobs.map((job) => {
    const shown = candidatesFor(job, candidates);
    const bundle = jobBundle(job, shown, context.files, facts);
    return { job: job.job, parts: bundle ? toSession(bundle, shown.length) : [] };
  });
  const jobs = built.flatMap(({ parts }) => parts);
  const unmatched = built.flatMap(({ job, parts }) => (parts.length ? [] : [job]));
  writeBundles(input.dir, { ...prepared, jobs });
  writeFileSync(join(input.dir, PROFILE_FILE), `${JSON.stringify(maskValue({ version: 1, ...profile, stack_lock: [...profile.stack_lock, ...stackLock(context.facts).rules], dropped }), null, 1)}\n`);
  logEvent(input.dir, 'bundles', 'keepup bundles', { jobs: jobs.length, job_total: profile.jobs.length, patterns: prepared.patterns.length, candidates: jobs.reduce((sum, job) => sum + (job.candidates ?? 0), 0), unmatched: unmatched.map(safeLine) });
  return { jobs, dropped, unmatched, ...counts };
}

function readingOrder(result: BundlesResult): string {
  const range = (name: string, count: number) => (count === 1 ? `bundles.${name}.0` : `bundles.${name}.0 to bundles.${name}.${count - 1}`);
  const parts = [...(result.patterns ? [range('patterns', result.patterns)] : []), ...(result.jobs.length ? [range('jobs', result.jobs.length)] : []), ...(result.floor ? ['bundles.floor'] : []), ...(result.floor_rest ? [range('floor_rest', result.floor_rest)] : [])];
  return parts.length ? `Read each with its own keepup get, in this order: ${parts.join(', then ')}.` : 'There are no bundles to read.';
}

function jobLine(job: SessionBundle, index: number): string {
  const name = safeLine(job.id.replace(/^Job: /, ''));
  return `bundles.jobs.${index}: ${job.candidates === undefined ? '' : `${job.candidates} candidates for `}${name}, ${job.prompt.length} chars`;
}

/** Every dropped citation is printed, so the session can fix it and run this again. */
export function bundlesReport(result: BundlesResult): string {
  const dropped = result.dropped.map((item) => `dropped: ${safeLine(item.what)}: ${safeLine(item.why)}`);
  if (result.jobs.length === 0 && result.unmatched.length === 0) return [...dropped, 'keepup: no job stood up, so nothing was written. Fix what\'s above and run keepup bundles again.'].join('\n');
  return [
    ...dropped,
    ...(result.pattern_list ?? []).map(({ path, id, chars }) => `${path}: ${safeLine(id)}, ${chars} chars`),
    ...result.jobs.map(jobLine),
    ...result.unmatched.map((job) => `no bundle: nothing in the database matched ${safeLine(job)}. Better search_terms would help.`),
    readingOrder(result),
  ].join('\n');
}

const pathsOf = (name: string, bundles: readonly SessionBundle[]) => bundles.map((bundle, index) => ({ path: `bundles.${name}.${index}`, id: bundle.id, chars: bundle.prompt.length, ...(bundle.candidates === undefined ? {} : { candidates: bundle.candidates }) }));

export interface BundlePart {
  readonly text: string;
  /** One fence for text that's all data. A bundle has its own fences around its repo text, and what's outside them is keepup's own question, which a fence would say isn't addressed to the reader. */
  readonly fence: boolean;
  /** For the session log: this was a bundle, read whole. */
  readonly read?: Readonly<Record<string, number>>;
}

function bundleIndex(all: SessionBundles): string {
  const chars = { prefix: all.prefix.length, rules: all.rules.length, floor: all.floor?.prompt.length ?? 0 };
  return JSON.stringify({ prefix: 'bundles.prefix', rules: 'bundles.rules', floor: all.floor ? 'bundles.floor' : null, floor_rest: pathsOf('floor_rest', all.floor_rest ?? []), patterns: pathsOf('patterns', all.patterns), jobs: pathsOf('jobs', all.jobs), chars }, null, 1);
}

/** What keepup get prints for part of bundles.json, or nothing when it's a plain field. One bundle at a time, whole, never a list of them. */
export function bundlePart(fields: readonly string[], value: unknown): BundlePart | null {
  const [first, index, ...rest] = fields;
  if (first === undefined) return { text: bundleIndex(value as SessionBundles), fence: true };
  if (rest.length > 0) return null;
  if (first === 'rules' && index === undefined) return value === JUDGE_SYSTEM ? { text: JUDGE_SYSTEM, fence: false } : null;
  if (first === 'prefix' && index === undefined) return isText(value) ? { text: value, fence: true } : null;
  if (first === 'floor' && index === undefined) return value ? { text: (value as SessionBundle).prompt, fence: false } : null;
  if (first !== 'patterns' && first !== 'jobs' && first !== 'floor_rest') return null;
  if (index === undefined) return { text: JSON.stringify(pathsOf(first, value as SessionBundle[]), null, 1), fence: true };
  const bundle = value as SessionBundle;
  if (first === 'floor_rest') return { text: bundle.prompt, fence: false };
  return { text: bundle.prompt, fence: false, read: bundle.candidates === undefined ? {} : { candidates: bundle.candidates } };
}
