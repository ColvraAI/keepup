// search.py in TypeScript: keyword retrieval with filters, ranked by term hits and traction.
// Pure over any list of records; db.ts feeds it.

export interface DbRecord {
  readonly source: string;
  readonly kind?: string;
  readonly name?: string;
  readonly url?: string;
  readonly description?: string | null;
  readonly released?: string | null;
  readonly updated?: string | null;
  readonly task?: string | null;
  readonly registry_name?: string | null;
  readonly keywords?: readonly string[] | null;
  readonly topics?: readonly string[] | null;
  readonly tags?: readonly string[] | unknown;
  readonly deadline?: readonly string[];
  readonly [key: string]: unknown;
}

export interface SearchQuery {
  readonly any?: readonly string[];
  readonly all?: readonly string[];
  readonly none?: readonly string[];
  readonly sources?: readonly string[];
  readonly kinds?: readonly string[];
  readonly tasks?: readonly string[];
  readonly since?: string;
  readonly min_signal?: number;
  readonly limit?: number;
  readonly fields?: readonly string[];
}

export interface SearchMatch {
  readonly score: number;
  readonly record: DbRecord;
}

export interface SearchResult {
  readonly total: number;
  readonly of: number;
  readonly matches: readonly SearchMatch[];
}

const DEFAULT_LIMIT = 25;
const TRACTION_WEIGHTS: readonly (readonly [string, number])[] = [
  ['stars', 1], ['downloads_week', 0.5], ['downloads', 0.05], ['likes', 3], ['points', 4], ['installs', 2],
];

function textOf(record: DbRecord): string {
  const tags = Array.isArray(record.tags) ? record.tags.join(' ') : '';
  return [
    record.name ?? '', record.description ?? '', (record.keywords ?? []).join(' '), (record.topics ?? []).join(' '),
    record.registry_name ?? '', record.task ?? '', tags,
  ].join(' ').toLowerCase();
}

export function signalOf(record: Readonly<Record<string, unknown>>): number {
  return TRACTION_WEIGHTS.reduce((best, [key, weight]) => {
    const value = record[key];
    return typeof value === 'number' && value > 0 ? Math.max(best, value * weight) : best;
  }, 0);
}

function termMatcher(term: string): RegExp {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
}

function passesFilters(record: DbRecord, query: SearchQuery): boolean {
  if (query.sources?.length && !query.sources.includes(record.source)) return false;
  if (query.kinds?.length && !query.kinds.includes(record.kind ?? '')) return false;
  if (query.tasks?.length && !query.tasks.includes(record.task ?? '')) return false;
  const date = record.released || record.updated || '';
  return !(query.since && date < query.since);
}

function scoreRecord(record: DbRecord, query: SearchQuery, matchers: Matchers): number | null {
  if (!passesFilters(record, query)) return null;
  const text = textOf(record);
  if (matchers.none.some((re) => re.test(text))) return null;
  if (!matchers.all.every((re) => re.test(text))) return null;
  const hits = matchers.any.filter((re) => re.test(text)).length;
  if (matchers.any.length > 0 && hits === 0) return null;
  const signal = signalOf(record);
  if (signal < (query.min_signal ?? 0)) return null;
  return hits * 10 + Math.log10(1 + signal);
}

interface Matchers {
  readonly any: readonly RegExp[];
  readonly all: readonly RegExp[];
  readonly none: readonly RegExp[];
}

export function searchRecords(rows: readonly DbRecord[], query: SearchQuery): SearchResult {
  const matchers: Matchers = {
    any: (query.any ?? []).map(termMatcher),
    all: (query.all ?? []).map(termMatcher),
    none: (query.none ?? []).map(termMatcher),
  };
  const matched: SearchMatch[] = [];
  for (const record of rows) {
    const score = scoreRecord(record, query, matchers);
    if (score !== null) matched.push({ score, record });
  }
  const sorted = matched.sort((a, b) => b.score - a.score);
  return { total: sorted.length, of: rows.length, matches: sorted.slice(0, query.limit ?? DEFAULT_LIMIT) };
}

/** Parses and checks a query from outside; throws a plain message when it's wrong. */
export function parseSearchQuery(json: string): SearchQuery {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`The query isn't JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('The query must be a JSON object.');
  const query = raw as Record<string, unknown>;
  for (const key of ['any', 'all', 'none', 'sources', 'kinds', 'tasks', 'fields']) {
    const value = query[key];
    if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
      throw new Error(`"${key}" must be a list of strings.`);
    }
  }
  return query as SearchQuery;
}
