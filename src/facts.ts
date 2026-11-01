// The inventory: everything deterministic that "Reading your code" shows. Offline, and every
// piece of text in the result has been through the mask.
import { commitDate, listRepoFiles, repoName, type RepoFile, type RepoFiles } from './git-files.ts';
import { type CodeContext, contextFor } from './code-context.ts';
import { matchesAnyGlob } from './glob.ts';
import { lockedVersion, type LockFile, type LockIndex, nearestLock, parseLockFile } from './lockfiles.ts';
import { type Manifest, parseManifest } from './manifests.ts';
import { maskText } from './mask.ts';
import { findModelIds, mayHoldModelId, type ModelRoute, type Provider, providerOf } from './model-ids.ts';
import { type LineRef, loadSignals, runSignalsCounted, SCAN_BUDGET_MS, type SignalResult, type SignalSpec } from './signals.ts';

const README_LINES = 80;
const README_CHARS = 6000;
const CALL_SITE_LIMIT = 40;
const SIGNAL_SAMPLES = 4;
const MAX_MODEL_TEXT = 200;
/** Far more than any real repo has. A file of nothing but model names can't blow up a run. */
const MAX_DISTINCT_MODEL_IDS = 3000;
const MAX_PLACES_PER_ID = 400;
const AI_CALL_SIGNALS = /^(?:llm_call|sdk_|raw_http_llm)/;
const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  py: 'Python', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', rb: 'Ruby', cs: 'C#', swift: 'Swift', php: 'PHP', ex: 'Elixir', exs: 'Elixir', scala: 'Scala',
  toml: 'TOML', yaml: 'YAML', yml: 'YAML', json: 'JSON', md: 'Markdown', html: 'HTML', css: 'CSS', scss: 'CSS', sh: 'Shell', sql: 'SQL', vue: 'Vue', svelte: 'Svelte',
};

export interface Step {
  readonly name: string;
  readonly detail: string;
  readonly ms: number;
}

export interface ModelPlace {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly context: CodeContext;
  readonly commented: boolean;
  readonly route: ModelRoute;
  readonly test_block_line?: number;
}

export interface ModelId {
  readonly id: string;
  readonly provider: Provider;
  readonly places: readonly ModelPlace[];
}

export interface LanguageShare {
  readonly language: string;
  readonly files: number;
  readonly lines: number;
  readonly share: number;
}

export interface CallSite extends LineRef {
  readonly signal: string;
}

export interface Facts {
  readonly version: 1;
  readonly repo: string;
  readonly commit: string | null;
  readonly commit_date: string | null;
  readonly languages: readonly LanguageShare[];
  readonly manifests: readonly Manifest[];
  readonly readme: { readonly file: string; readonly head: string } | null;
  readonly ai_call_sites: readonly CallSite[];
  readonly signals: Readonly<Record<string, SignalResult>>;
  readonly model_ids: readonly ModelId[];
  readonly steps: readonly Step[];
  /** over_time: files this inventory never reached, because the read ran out of time. Only there when that happened. */
  readonly checked: { readonly files: number; readonly lines: number; readonly over_time?: number };
}

function timed<T>(steps: Step[], name: string, work: () => T, detail: (result: T) => string): T {
  const started = performance.now();
  const result = work();
  steps.push({ name, detail: detail(result), ms: Math.round(performance.now() - started) });
  return result;
}

function withLocked(manifest: Manifest, locks: ReadonlyMap<string, LockIndex>): Manifest {
  const lock = nearestLock(manifest.file, locks);
  if (!lock) return manifest;
  return { ...manifest, dependencies: manifest.dependencies.map((dep) => {
    const locked = lockedVersion(lock, dep.name, dep.spec);
    return locked ? { ...dep, locked } : dep;
  }) };
}

function readManifests(files: readonly RepoFile[], lockFiles: readonly LockFile[]): Manifest[] {
  const locks = new Map(lockFiles.map((lock) => [lock.path, parseLockFile(lock)]));
  return files.flatMap((file) => {
    const manifest = parseManifest(file.path, maskText(file.text));
    return manifest ? [withLocked(manifest, locks)] : [];
  });
}

function readReadme(files: readonly RepoFile[]): Facts['readme'] {
  const candidates = files.filter((file) => /^readme(?:\.[a-z]+)?$/i.test(file.path));
  const preferred = candidates.find((file) => /\.md$/i.test(file.path)) ?? candidates[0];
  if (!preferred) return null;
  return { file: preferred.path, head: maskText(preferred.text).split('\n').slice(0, README_LINES).join('\n').slice(0, README_CHARS) };
}

function measureLanguages(files: readonly RepoFile[]): LanguageShare[] {
  const tally = new Map<string, { files: number; lines: number }>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXT[file.path.split('.').pop()?.toLowerCase() ?? ''];
    if (!language) continue;
    const entry = tally.get(language) ?? { files: 0, lines: 0 };
    tally.set(language, { files: entry.files + 1, lines: entry.lines + file.text.split('\n').length });
  }
  const total = [...tally.values()].reduce((sum, entry) => sum + entry.lines, 0) || 1;
  return [...tally]
    .map(([language, entry]) => ({ language, ...entry, share: Math.round((entry.lines / total) * 1000) / 1000 }))
    .sort((a, b) => b.lines - a.lines);
}

function modelPlacesIn(file: RepoFile): (ModelPlace & { id: string })[] {
  const masked = maskText(file.text);
  const at = contextFor(file.path, masked);
  const out: (ModelPlace & { id: string })[] = [];
  masked.split('\n').forEach((text, index) => {
    if (!mayHoldModelId(text)) return;
    for (const { id, route } of findModelIds(text)) {
      out.push({ id, file: file.path, line: index + 1, text: text.trim().slice(0, MAX_MODEL_TEXT), route, ...at(index + 1) });
    }
  });
  return out;
}

function addPlace(byId: Map<string, ModelPlace[]>, id: string, place: ModelPlace): void {
  const places = byId.get(id);
  if (places) { if (places.length < MAX_PLACES_PER_ID) places.push(place); return; }
  if (byId.size < MAX_DISTINCT_MODEL_IDS) byId.set(id, [place]);
}

function findAllModelIds(files: readonly RepoFile[], spec: SignalSpec): ModelId[] {
  const globs = [...spec.code_globs, ...spec.config_globs];
  const byId = new Map<string, ModelPlace[]>();
  for (const file of files) {
    if (!matchesAnyGlob(file.path, globs)) continue;
    for (const { id, ...place } of modelPlacesIn(file)) addPlace(byId, id, place);
  }
  return [...byId]
    .map(([id, places]) => ({ id, provider: providerOf(id), places }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function callSitesFrom(signals: Readonly<Record<string, SignalResult>>): CallSite[] {
  const sites = Object.entries(signals)
    .filter(([name]) => AI_CALL_SIGNALS.test(name))
    .flatMap(([signal, result]) => result.samples.map((sample) => ({ signal, ...sample })));
  return sites.sort((a, b) => Number(b.signal === 'llm_call') - Number(a.signal === 'llm_call')).slice(0, CALL_SITE_LIMIT);
}

function withFewerSamples(signals: Readonly<Record<string, SignalResult>>): Record<string, SignalResult> {
  return Object.fromEntries(Object.entries(signals).map(([name, result]) => [name, { ...result, samples: result.samples.slice(0, SIGNAL_SAMPLES) }]));
}

export interface FactsOptions {
  readonly commit?: string;
  readonly spec?: SignalSpec;
  /** Files already listed, so a caller that also scans them doesn't read the repo twice. */
  readonly listed?: RepoFiles;
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

export function buildFacts(path: string, options: FactsOptions = {}): Facts {
  const steps: Step[] = [];
  const spec = options.spec ?? loadSignals();
  const listed = timed(steps, 'List files', () => options.listed ?? listRepoFiles(path, { commit: options.commit }), (r) => {
    const skipped = Object.values(r.skipped).reduce((sum, count) => sum + count, 0);
    return `${plural(r.files.length, 'file')} to read, ${skipped.toLocaleString('en-US')} skipped (vendored, generated, minified, binary or over 2 MB)${r.skipped.over_budget ? `, and ${plural(r.skipped.over_budget, 'file')} over the read budget` : ''}`;
  });
  const { files, commit } = listed;
  const manifests = timed(steps, 'Read manifests', () => readManifests(files, listed.locks ?? []), (r) => `${plural(r.length, 'manifest')}, ${r.reduce((sum, m) => sum + m.dependencies.length, 0).toLocaleString('en-US')} declared dependencies`);
  const readme = timed(steps, 'Read the README', () => readReadme(files), (r) => r ? r.file : 'none found');
  const languages = timed(steps, 'Measure languages', () => measureLanguages(files), (r) => r.slice(0, 3).map((l) => `${l.language} ${Math.round(l.share * 100)}%`).join(', ') || 'none recognised');
  const budget = listed.deadline === undefined ? SCAN_BUDGET_MS : listed.deadline - performance.now();
  const counted = timed(steps, 'Run signals', () => runSignalsCounted(files, spec, spec.signals, CALL_SITE_LIMIT, budget), (r) => `${Object.keys(r.results).length} of ${spec.signals.length} signals fired${r.over_time ? `, ${plural(r.over_time, 'file')} over the time budget` : ''}`);
  const signals = counted.results;
  const overTime = (listed.skipped.over_time ?? 0) + counted.over_time;
  const modelIds = timed(steps, 'Find model ids', () => findAllModelIds(files, spec), (r) => `${plural(r.length, 'distinct model id')} in ${plural(r.reduce((sum, m) => sum + m.places.length, 0), 'place')}`);
  return {
    version: 1,
    repo: repoName(path),
    commit,
    commit_date: commit ? new Date(commitDate(path, commit)).toISOString().slice(0, 10) : null,
    languages,
    manifests,
    readme,
    ai_call_sites: callSitesFrom(signals),
    signals: withFewerSamples(signals),
    model_ids: modelIds,
    steps,
    checked: { files: files.length, lines: files.reduce((sum, file) => sum + file.text.split('\n').length, 0), ...(overTime ? { over_time: overTime } : {}) },
  };
}
