// Reads the real database in data/db. Lazy and cached per process: the MCP file is large, and
// most calls need only some of the sources. Personal fields are dropped as records come in.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isoDate, LONG_DATE_SOURCE } from './dates.ts';
import { type ChangelogEntry, type ChangelogProvider, parseChangelog, yearBlindWindowCount } from './changelogs.ts';
import { extractRetirements, type PageRow, type Retirement, type UndatedRow, withPageRows } from './retirements.ts';
import { type DbRecord, searchRecords, type SearchQuery, type SearchResult } from './search.ts';
import { REPO_ROOT } from './signals.ts';

const DEFAULT_DIR = join(REPO_ROOT, 'data', 'db');
const RETIRED_PATTERN = join(REPO_ROOT, 'db', 'patterns', 'PAT-retired-model-id.json');
const RECORD_DATES = join(REPO_ROOT, 'db', 'record-dates.json');
const WINDOW = { since: '2026-09-01', until: '2026-10-31' };
const CHANGELOG_PROVIDERS: readonly ChangelogProvider[] = ['openai', 'anthropic', 'gemini'];
const CHANGELOG = 'changelog';
const PERSONAL_FIELDS = new Set(['author', 'authors', 'owner', 'owner_handle', 'ownerHandle', 'maintainer', 'maintainers', 'publisher', 'publishers', 'email', 'emails', 'contributors']);
const DEADLINE_WORDS = new RegExp(LONG_DATE_SOURCE, 'g');
const DEPRECATION_WORDS = /\b(?:deprecat\w*|retir\w*|shut ?down|shuts down|sunset\w*)\b/i;

export interface Reconciliation {
  readonly changelog_in_window: number;
  readonly changelog_year_blind: number;
  readonly records_year_blind: number;
  readonly note: string;
}

export interface DbInfo {
  readonly fetched: string;
  readonly records: number;
  readonly by_source: Readonly<Record<string, number>>;
  readonly window: { readonly since: string; readonly until: string };
  readonly reconciliation: Reconciliation;
}

const sourceCache = new Map<string, readonly DbRecord[]>();
const changelogCache = new Map<string, readonly ChangelogEntry[]>();
const retirementCache = new Map<string, readonly Retirement[]>();

function readGzip(path: string): string {
  try {
    return gunzipSync(readFileSync(path)).toString('utf8');
  } catch (error) {
    throw new Error(`Can't read the database file ${path}: ${(error as Error).message}`);
  }
}

function withoutPersonalFields(record: DbRecord): DbRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !PERSONAL_FIELDS.has(key))) as DbRecord;
}

function jsonlSources(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl.gz')).map((name) => name.replace('.jsonl.gz', '')).sort();
}

function loadJsonl(source: string, dir: string): readonly DbRecord[] {
  return readGzip(join(dir, `${source}.jsonl.gz`))
    .split('\n')
    .filter(Boolean)
    .map((line) => withoutPersonalFields(JSON.parse(line) as DbRecord));
}

/** Every dated entry on the three pages, all years. The exact checks need the old ones too. */
export function changelogEntries(dir = DEFAULT_DIR): readonly ChangelogEntry[] {
  const cached = changelogCache.get(dir);
  if (cached) return cached;
  const entries = CHANGELOG_PROVIDERS.flatMap((provider) => parseChangelog(provider, readGzip(join(dir, `changelog-${provider}.txt.gz`))));
  changelogCache.set(dir, entries);
  return entries;
}

function deprecationPage(): { readonly models: readonly PageRow[]; readonly undated: readonly UndatedRow[] } {
  if (!existsSync(RETIRED_PATTERN)) return { models: [], undated: [] };
  const page = JSON.parse(readFileSync(RETIRED_PATTERN, 'utf8')) as { models?: PageRow[]; undated_successors?: UndatedRow[] };
  return { models: page.models ?? [], undated: page.undated_successors ?? [] };
}

export function retirements(dir = DEFAULT_DIR): readonly Retirement[] {
  const cached = retirementCache.get(dir);
  if (cached) return cached;
  const page = deprecationPage();
  const found = withPageRows(extractRetirements(changelogEntries(dir)), page.models, page.undated);
  retirementCache.set(dir, found);
  return found;
}

function deadlinesIn(text: string, after: string): string[] {
  const dates = [...text.matchAll(DEADLINE_WORDS)].map((match) => isoDate(match[1], match[2], match[3]));
  return [...new Set(dates)].filter((date) => date > after);
}

function changelogRecord(entry: ChangelogEntry): DbRecord {
  const deprecation = DEPRECATION_WORDS.test(entry.text);
  return {
    source: CHANGELOG,
    kind: deprecation ? 'deprecation' : 'api-feature',
    provider: entry.provider,
    name: `${entry.provider} ${entry.date}: ${entry.text.slice(0, 80)}`,
    url: entry.url,
    description: entry.text,
    released: entry.date,
    tags: entry.tags,
    deadline: deadlinesIn(entry.text, entry.date),
  };
}

function loadChangelogWindow(dir: string): readonly DbRecord[] {
  return changelogEntries(dir).filter((entry) => entry.date >= WINDOW.since && entry.date <= WINDOW.until).map(changelogRecord);
}

function loadSource(source: string, dir: string): readonly DbRecord[] {
  const key = `${dir}\0${source}`;
  const cached = sourceCache.get(key);
  if (cached) return cached;
  const rows = source === CHANGELOG ? loadChangelogWindow(dir) : loadJsonl(source, dir);
  sourceCache.set(key, rows);
  return rows;
}

export function allSources(dir = DEFAULT_DIR): string[] {
  return [...jsonlSources(dir), CHANGELOG];
}

export function loadRecords(sources: readonly string[] = allSources(), dir = DEFAULT_DIR): readonly DbRecord[] {
  return sources.flatMap((source) => loadSource(source, dir));
}

/** The date of the newest file, from its gzip header. Not the file's own mtime, which a copy would change. */
export function fetchedDate(dir = DEFAULT_DIR): string {
  const stamps = readdirSync(dir)
    .filter((name) => name.endsWith('.gz'))
    .map((name) => {
      const path = join(dir, name);
      const seconds = readFileSync(path).readUInt32LE(4);
      return seconds > 0 ? seconds * 1000 : statSync(path).mtimeMs;
    });
  return new Date(Math.max(...stamps)).toISOString().slice(0, 10);
}

export function dbInfo(dir = DEFAULT_DIR): DbInfo {
  const sources = allSources(dir);
  const counts = sources.map((source) => [source, loadSource(source, dir).length] as const);
  const bySource = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  const records = counts.reduce((sum, [, count]) => sum + count, 0);
  const inWindow = bySource[CHANGELOG];
  const yearBlind = yearBlindWindowCount(changelogEntries(dir), WINDOW.since, WINDOW.until);
  return {
    fetched: fetchedDate(dir),
    records,
    by_source: bySource,
    window: WINDOW,
    reconciliation: {
      changelog_in_window: inWindow,
      changelog_year_blind: yearBlind,
      records_year_blind: records - inWindow + yearBlind,
      note: `${yearBlind - inWindow} of the ${yearBlind} changelog entries counted without the year are OpenAI's Sep and Oct entries from earlier years; ${inWindow} are in the window.`,
    },
  };
}

/** A record's date as a day, keeping whether it had a time on it, which is all a count by date compares. */
export function dateKey(record: Pick<DbRecord, 'released' | 'updated'>): string {
  const date = String(record.released || record.updated || '');
  return date.length > 10 ? `${date.slice(0, 10)}T` : date;
}

export interface RecordDates {
  readonly fetched: string;
  readonly records: number;
  readonly dates: Readonly<Record<string, number>>;
}

/** How many records carry each date, computed from every record. scripts/pin-replay.ts writes it to db/record-dates.json. */
export function computeRecordDates(dir = DEFAULT_DIR): RecordDates {
  const dates = new Map<string, number>();
  const records = loadRecords(allSources(dir), dir);
  for (const record of records) {
    const key = dateKey(record);
    if (key) dates.set(key, (dates.get(key) ?? 0) + 1);
  }
  return { fetched: fetchedDate(dir), records: records.length, dates: Object.fromEntries([...dates].sort(([a], [b]) => a.localeCompare(b))) };
}

/** The saved counts when they match this database, so the weekly line needn't read every record to count them. */
export function recordDates(dir = DEFAULT_DIR): RecordDates {
  const fetched = fetchedDate(dir);
  if (dir === DEFAULT_DIR && existsSync(RECORD_DATES)) {
    const saved = JSON.parse(readFileSync(RECORD_DATES, 'utf8')) as RecordDates;
    if (saved.fetched === fetched) return saved;
  }
  return computeRecordDates(dir);
}

/** search.py's query. It reads only the sources the query names. */
export function query(q: SearchQuery, dir = DEFAULT_DIR): SearchResult {
  return searchRecords(loadRecords(q.sources?.length ? q.sources : allSources(dir), dir), q);
}
