// Deterministic candidates: (a) each model id in the repo against the provider changelogs,
// (b) each declared dependency against what's newer. (b) reads the database by default, and
// asks the registries only when told to (--online).
import type { CatalogUse } from './catalog-use.ts';
import type { ModelId, ModelPlace } from './facts.ts';
import type { Dependency, Ecosystem } from './manifests.ts';
import type { LockedVersion } from './lockfiles.ts';
import type { Gain, SpecGain } from './release-notes.ts';
import { isDataFile } from './catalog-use.ts';
import { pathContext } from './code-context.ts';
import { findByDisplayName, findRetirement, type Retirement, type RetirementStatus, statusAsOf } from './retirements.ts';
import { registryInfo, type RegistryInfo } from './registry.ts';
import { allowsVersion, lowestVersionIn, majorsBehind, type SpecKind, specKind } from './semver.ts';

const CATALOG_MIN_IDS = 8;
const STALE_MONTHS = 18;
const NPM_CONCURRENCY = 8;
const PYPI_CONCURRENCY = 4;

export type NotLiveReason = 'test' | 'comment' | 'bedrock' | 'gateway' | 'docs' | 'catalog' | 'limits' | 'display' | 'exclusion' | 'tokenizer' | 'label' | 'example_script';

export interface NotLivePlace extends ModelPlace {
  readonly why: NotLiveReason;
}

/** A live place that sits in a table a picker or a lookup reads. */
export interface LivePlace extends ModelPlace {
  readonly catalog?: boolean;
}

/** Providers and servers that aren't the maker of the model id, named in the path: this id goes to them, not to the maker. */
const GATEWAY_PATH = /(?:^|[/._-])(?:lemonade|cometapi|openrouter|litellm|lmstudio|localai|\w*generic\w*|\w*compatible\w*|ollama|groq|fireworks\w*|together\w*|deepinfra|novita|azure\w*|bedrock|perplexity|mistral|xai|deepseek|cohere|foundry|dpais|ppio|moonshot\w*|nvidia\w*|giteeai|sambanova|apipie|textgenwebui|koboldcpp|oobabooga|vllm|tgi|cerebras|hyperbolic|siliconflow|zai|docker\w*)(?:[/._-]|$)/i;
/** A line that shows an id to a person rather than sending it. */
const TOKENIZER = /tiktoken|tokeni[sz]er|encoding_for_model/i;
/** A menu whose value is a number, with the model named only in its text: a token limit, not a model anyone sends. */
const LABEL_LINE = /<option\b[^>]*\bvalue=\{?["']?\d|^\s*[\d,]{3,}\s*\(/;
/** process.env.X ?? "id": the value sent when nothing is set, however many models the file names. */
const FALLBACK_LINE = /(?:\?\?|\|\|)\s*["'`]/;
const DISPLAY_LINE = /\bplaceholder\b|\bconsole\.\w+\(|\b(?:logger|log|tracing)(?:\.|::)\w+!?\(|\b(?:println|eprintln|info|warn|debug)!\(|\bhelpText\b|\bhint\b|\be\.g\.,? /;

export interface PlaceSignals {
  /** How a table's ids reach a call, if at all. Without it, a table counts as not sending anything. */
  readonly catalogUse?: CatalogUse;
  /** True when this line is on a list of models the code refuses. */
  readonly exclusionAt?: (file: string, line: number) => boolean;
  /** The provider a switch sends this line to, if a `case` right above names one. */
  readonly caseAt?: (file: string, line: number) => string | null;
  /** True for a developer's example script inside a source tree that nothing outside its folder loads. */
  readonly unloadedExample?: (file: string) => boolean;
  /** A replay rebuilds what was published, under the rules it was published with. */
  readonly exactIdsOnly?: boolean;
}

export interface ModelCheck {
  readonly kind: 'model';
  readonly model: string;
  readonly provider: Retirement['provider'];
  readonly status: RetirementStatus;
  readonly announced: string | null;
  readonly effective: string | null;
  readonly successors: readonly string[];
  readonly source: string;
  readonly sentence: string;
  readonly live_places: readonly LivePlace[];
  readonly not_live: readonly NotLivePlace[];
  /** The date is the provider's earliest, not a promise, so it's always said as "no earlier than". */
  readonly earliest?: boolean;
  /** An earliest date that has passed, so `effective` is null: it may be gone, and nobody has said it is. */
  readonly earliest_date?: string;
  readonly successors_from_page?: boolean;
  readonly page_source?: string;
  readonly routed_to?: string;
  readonly routed_sentence?: string;
  /** A pinned version whose base model is what the provider retired: gemini-1.5-flash-002 and gemini-1.5-flash. */
  readonly variant_of?: string;
}

const HASH_OR_SLASH_COMMENT = /^\s*(?:#|\/\/|\/\*|\*(?:\s|$))/;

/** What the program itself can see on one line: a comment, a test, display text, or an id going to someone other than its maker. */
export function placeSendsNothing(file: string, line: string): boolean {
  return HASH_OR_SLASH_COMMENT.test(line) || DISPLAY_LINE.test(line) || GATEWAY_PATH.test(file) || pathContext(file) === 'test' || pathContext(file) === 'docs';
}

const HASH_LANGUAGES = /\.(?:py|rb|toml|ya?ml|sh|bash|ex|exs|ini|cfg|conf)$/;

/** Where a comment starts on a line of code, outside any string; -1 if it has none. */
function commentStart(file: string, text: string): number {
  const marker = HASH_LANGUAGES.test(file) ? '#' : '//';
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (text.startsWith(marker, index)) return index;
  }
  return -1;
}

/** `model="claude-v1",  # "claude-2" for Claude 2`: nothing sends claude-2. */
export function onlyInTrailingComment(file: string, id: string, text: string): boolean {
  const start = commentStart(file, text);
  return start !== -1 && !text.slice(0, start).includes(id) && text.slice(start).includes(id);
}

function notLiveReason(id: string, place: ModelPlace, tables: ReadonlyMap<string, TableKind>, signals: PlaceSignals): NotLiveReason | null {
  if (place.context === 'test') return 'test';
  if (place.commented || onlyInTrailingComment(place.file, id, place.text)) return 'comment';
  if (place.context === 'docs') return 'docs';
  if (LABEL_LINE.test(place.text)) return 'label';
  if (place.route === 'bedrock') return 'bedrock';
  if (place.route === 'gateway' || GATEWAY_PATH.test(place.file)) return 'gateway';
  if (GATEWAY_PATH.test(`/${signals.caseAt?.(place.file, place.line) ?? ''}/`)) return 'gateway';
  if (TOKENIZER.test(place.file) || TOKENIZER.test(place.text)) return 'tokenizer';
  if (DISPLAY_LINE.test(place.text)) return 'display';
  if (signals.exclusionAt?.(place.file, place.line)) return 'exclusion';
  if (signals.unloadedExample?.(place.file)) return 'example_script';
  const table = tables.get(place.file);
  if (table === 'unused') return 'catalog';
  return table === 'limits' ? 'limits' : null;
}

type TableKind = 'picker' | 'limits' | 'unused';

/** A file naming many models is a lookup table or a picker: an id there is known, not necessarily sent. */
function catalogFiles(modelIds: readonly ModelId[]): Set<string> {
  const idsByFile = new Map<string, Set<string>>();
  for (const model of modelIds) {
    for (const place of model.places) idsByFile.set(place.file, (idsByFile.get(place.file) ?? new Set()).add(model.id));
  }
  return new Set([...idsByFile].filter(([, ids]) => ids.size >= CATALOG_MIN_IDS).map(([file]) => file));
}

/** What each table does. A JSON data file counts as a table however few ids it holds, since a data file sends nothing by itself. */
function tableKinds(modelIds: readonly ModelId[], signals: PlaceSignals): Map<string, TableKind> {
  const big = catalogFiles(modelIds);
  const files = new Set(modelIds.flatMap((model) => model.places.map((place) => place.file)));
  const tables = [...files].filter((file) => big.has(file) || isDataFile(file));
  return new Map(tables.map((file) => {
    const ids = modelIds.filter((model) => model.places.some((place) => place.file === file)).map((model) => model.id);
    return [file, signals.catalogUse ? signals.catalogUse(file, ids) : big.has(file) ? 'unused' : 'picker'];
  }));
}

/** A table entry is a choice a person makes. A fallback in the same file is what's sent when nobody chose. */
function livePlace(place: ModelPlace, tables: ReadonlyMap<string, TableKind>): LivePlace {
  return tables.get(place.file) === 'picker' && !FALLBACK_LINE.test(place.text) ? { ...place, catalog: true } : place;
}

/** An id only a gateway route names, such as anthropic/claude-sonnet-4, still means the family its maker retired. */
function retirementFor(model: ModelId, retirements: readonly Retirement[], exactIdsOnly = false): Retirement | null {
  const exact = findRetirement(model.id, retirements);
  if (exact) return exact;
  if (model.places.some((place) => place.route === 'gateway')) return findByDisplayName(model.id, retirements);
  return exactIdsOnly ? null : variantOf(model.id, retirements);
}

/** Google pins a version with a three-digit suffix. A base model that's gone takes its pinned versions with it. Nothing else counts as near. */
const GEMINI_PINNED = /^(gemini-.+)-\d{3}$/;

function variantOf(id: string, retirements: readonly Retirement[]): Retirement | null {
  const base = id.match(GEMINI_PINNED)?.[1];
  const row = base ? findRetirement(base, retirements) : null;
  return row && row.provider === 'gemini' && row.effective ? row : null;
}

function optionalFacts(retirement: Retirement, undated: boolean): Partial<ModelCheck> {
  return {
    ...(retirement.earliest ? { earliest: true } : {}),
    ...(undated && retirement.effective ? { earliest_date: retirement.effective } : {}),
    ...(retirement.successors_from_page ? { successors_from_page: true } : {}),
    ...(retirement.page_source ? { page_source: retirement.page_source } : {}),
    ...(retirement.routed_to ? { routed_to: retirement.routed_to, routed_sentence: retirement.routed_sentence } : {}),
  };
}

export function checkModels(modelIds: readonly ModelId[], retirements: readonly Retirement[], asOf: string, signals: PlaceSignals = {}): ModelCheck[] {
  const tables = tableKinds(modelIds, signals);
  return modelIds.flatMap((model): ModelCheck[] => {
    const retirement = retirementFor(model, retirements, signals.exactIdsOnly);
    if (!retirement) return [];
    const withReasons = model.places.map((place) => ({ place, why: notLiveReason(model.id, place, tables, signals) }));
    const status = statusAsOf(retirement, asOf);
    const undated = Boolean(retirement.earliest) && status === 'deprecated';
    return [{
      kind: 'model',
      model: model.id,
      provider: retirement.provider,
      status,
      announced: retirement.announced,
      effective: undated ? null : retirement.effective,
      successors: retirement.successors,
      source: retirement.source,
      sentence: retirement.sentence,
      live_places: withReasons.filter((entry) => entry.why === null).map((entry) => livePlace(entry.place, tables)),
      not_live: withReasons.flatMap((entry) => (entry.why ? [{ ...entry.place, why: entry.why }] : [])),
      ...optionalFacts(retirement, undated),
      ...(retirement.id && retirement.id !== model.id && GEMINI_PINNED.test(model.id) ? { variant_of: retirement.id } : {}),
    }];
  });
}

export type DependencyStatus = 'current' | 'allowed-by-range' | 'behind' | 'git' | 'no-data';

export interface DependencyCheck {
  readonly kind: 'dependency';
  readonly name: string;
  readonly ecosystem: Ecosystem;
  readonly status: DependencyStatus;
  readonly spec: string;
  readonly spec_kind: SpecKind;
  readonly latest: string | null;
  readonly latest_date: string | null;
  readonly declared_date: string | null;
  readonly majors_behind: number;
  readonly stale: boolean;
  readonly basis: 'registry' | 'database' | null;
  readonly source: string | null;
  readonly places: readonly { readonly file: string; readonly line: number; readonly spec: string }[];
  readonly error?: string;
  /** What the library's own release notes say the declared version misses. Set only by an online run. */
  readonly release_notes?: { readonly url: string; readonly gains: readonly Gain[]; readonly spec?: readonly SpecGain[] };
  /** What the repo's lockfile really installs, which can be far behind what the range allows. */
  readonly locked?: LockedVersion;
}

export interface DbPackageRecord {
  readonly package?: unknown;
  readonly version?: unknown;
  readonly updated?: unknown;
  readonly released?: unknown;
  readonly url?: unknown;
}

export interface DependencyCheckOptions {
  readonly records: readonly DbPackageRecord[];
  readonly asOf: string;
  readonly online?: boolean;
  readonly cacheDir?: string;
  readonly fetchImpl?: typeof fetch;
  readonly crateDelayMs?: number;
}

interface Latest {
  readonly latest: string;
  readonly latest_date: string | null;
  readonly declared_date: string | null;
  readonly basis: 'registry' | 'database';
  readonly source: string | null;
}

function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

function statusFor(dep: Dependency, latest: string): DependencyStatus {
  if (!allowsVersion(dep.spec, latest, dep.ecosystem)) return 'behind';
  const lowest = lowestVersionIn(dep.spec);
  return lowest === latest ? 'current' : 'allowed-by-range';
}

function checkFrom(dep: Dependency, places: DependencyCheck['places'], found: Latest | null, asOf: string, error?: string): DependencyCheck {
  const lowest = lowestVersionIn(dep.spec);
  const base = {
    kind: 'dependency' as const, name: dep.name, ecosystem: dep.ecosystem, spec: dep.spec, spec_kind: specKind(dep.spec, dep.ecosystem), places,
    ...(dep.locked ? { locked: dep.locked } : {}),
  };
  if (!found) {
    return { ...base, status: 'no-data', latest: null, latest_date: null, declared_date: null, majors_behind: 0, stale: false, basis: null, source: null, ...(error ? { error } : {}) };
  }
  return {
    ...base,
    status: statusFor(dep, found.latest),
    latest: found.latest,
    latest_date: found.latest_date,
    declared_date: found.declared_date,
    majors_behind: lowest ? majorsBehind(lowest, found.latest) : 0,
    stale: found.latest_date !== null && monthsBetween(found.latest_date, asOf) >= STALE_MONTHS,
    basis: found.basis,
    source: found.source,
  };
}

function fromDatabase(dep: Dependency, index: ReadonlyMap<string, DbPackageRecord>): Latest | null {
  const record = index.get(`${dep.ecosystem === 'npm' ? 'npm' : 'pypi'}:${dep.name}`);
  if (!record || typeof record.version !== 'string') return null;
  const date = (record.updated ?? record.released) as string | null | undefined;
  return { latest: record.version, latest_date: date ?? null, declared_date: null, basis: 'database', source: (record.url as string) ?? null };
}

function fromRegistry(dep: Dependency, info: RegistryInfo): Latest {
  const lowest = lowestVersionIn(dep.spec);
  return {
    latest: info.latest,
    latest_date: info.latest_date || null,
    declared_date: lowest ? info.version_dates[lowest] ?? null : null,
    basis: 'registry',
    source: info.source,
  };
}

function packageIndex(records: readonly DbPackageRecord[]): Map<string, DbPackageRecord> {
  return new Map(records.flatMap((record) => (typeof record.package === 'string' ? [[record.package, record] as const] : [])));
}

/** One entry per ecosystem, name and spec, listing every manifest that declares it. */
function groupDeclarations(deps: readonly Dependency[]): { dep: Dependency; places: DependencyCheck['places'] }[] {
  const groups = new Map<string, { dep: Dependency; places: { file: string; line: number; spec: string }[] }>();
  for (const dep of deps) {
    if (dep.source === 'path') continue;
    const key = `${dep.ecosystem}\0${dep.name}\0${dep.spec}\0${dep.source}`;
    const group = groups.get(key) ?? { dep, places: [] };
    groups.set(key, { dep: group.dep, places: [...group.places, { file: dep.file, line: dep.line, spec: dep.spec }] });
  }
  return [...groups.values()];
}

async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function checkOnline(group: { dep: Dependency; places: DependencyCheck['places'] }, options: DependencyCheckOptions): Promise<DependencyCheck> {
  try {
    const info = await registryInfo(group.dep, { cacheDir: options.cacheDir, fetchImpl: options.fetchImpl, today: options.asOf, crateDelayMs: options.crateDelayMs });
    return checkFrom(group.dep, group.places, fromRegistry(group.dep, info), options.asOf);
  } catch (error) {
    return checkFrom(group.dep, group.places, null, options.asOf, (error as Error).message);
  }
}

function gitCheck(group: { dep: Dependency; places: DependencyCheck['places'] }): DependencyCheck {
  return { ...checkFrom(group.dep, group.places, null, ''), status: 'git' };
}

/** Crates one at a time, because crates.io asks for one request a second; registry.ts waits between real requests. */
export async function checkDependencies(deps: readonly Dependency[], options: DependencyCheckOptions): Promise<DependencyCheck[]> {
  const groups = groupDeclarations(deps);
  const registryGroups = groups.filter((group) => group.dep.source === 'registry');
  const index = packageIndex(options.records);
  const online = async (ecosystem: Ecosystem, limit: number) =>
    mapLimited(registryGroups.filter((group) => group.dep.ecosystem === ecosystem), limit, (group) => checkOnline(group, options));
  const checked = options.online
    ? [...await online('npm', NPM_CONCURRENCY), ...await online('pypi', PYPI_CONCURRENCY), ...await online('crates', 1)]
    : registryGroups.map((group) => checkFrom(group.dep, group.places, fromDatabase(group.dep, index), options.asOf));
  return [...groups.filter((group) => group.dep.source === 'git').map(gitCheck), ...checked];
}
