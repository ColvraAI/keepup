// site/data/pulse.json: the real count, by source and by day, and the feed.
// The total is computed from the records and checked against the briefs' README.
import { allSources, changelogEntries, loadRecords } from '../../src/db.ts';
import type { DbRecord } from '../../src/search.ts';
import { countsAsDatabaseRecord, entryToRow } from './changelog.ts';
import { buildFeed, type FeedItem } from './feed.ts';
import { recordDate, SOURCES, type DateWindow, type DbRow } from './sources.ts';

export { recordDate, SOURCES, type DateWindow, type DbRow };

export interface SourceCount { id: string; label: string; count: number; in_window: number; providers?: Record<string, number> }
export interface ReadmeCounts { total: number; bySource: Record<string, number> }

export interface Pulse {
  window: DateWindow;
  total: number;
  in_window: number;
  outside_window: { count: number; by_source: Record<string, number>; note: string; items: { source: string; name: string; date: string; url: string }[] };
  by_source: SourceCount[];
  by_day: { days: string[]; by_source: Record<string, number[]>; totals: number[] };
  registry_publishers: RegistryPublishers;
  feed: FeedItem[];
}

export interface RegistryPublishers { threshold: number; publishers: number; records: number }

/** A publisher with this many registry entries or more is a mass publisher, as in data/briefs/README.md. */
const MASS_PUBLISHER = 50;

const PROVIDERS = ['openai', 'anthropic', 'gemini'];

function toRow(record: DbRecord): DbRow {
  return { ...record, kind: record.kind ?? '', name: record.name ?? '', url: record.url ?? '', description: record.description ?? '', released: record.released ?? null };
}

/** Everything through src/db.ts, plus the changelog entries the stated count rests on (see changelog.ts). */
export function readRows(dbDir: string): DbRow[] {
  const jsonl = allSources(dbDir).filter((source) => source !== 'changelog');
  return [...loadRecords(jsonl, dbDir).map(toRow), ...changelogEntries(dbDir).filter(countsAsDatabaseRecord).map(entryToRow)];
}

function daysOf(window: DateWindow): string[] {
  const start = Date.parse(`${window.from}T00:00:00Z`);
  const end = Date.parse(`${window.to}T00:00:00Z`);
  return Array.from({ length: (end - start) / 86_400_000 + 1 }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

function byDay(rows: DbRow[], window: DateWindow): Pulse['by_day'] {
  const days = daysOf(window);
  const dated = rows.flatMap((r) => {
    const { date, in_window } = recordDate(r, window);
    return in_window && date ? [{ source: r.source, date }] : [];
  });
  const counts = dated.reduce((map, d) => {
    const key = `${d.source}|${d.date}`;
    return map.set(key, (map.get(key) ?? 0) + 1);
  }, new Map<string, number>());
  const by_source = Object.fromEntries(SOURCES.map((s) => [s.id, days.map((d) => counts.get(`${s.id}|${d}`) ?? 0)]));
  const totals = days.map((_, i) => SOURCES.reduce((n, s) => n + by_source[s.id][i], 0));
  return { days, by_source, totals };
}

function bySource(rows: DbRow[], window: DateWindow): SourceCount[] {
  return SOURCES.map(({ id, label }) => {
    const mine = rows.filter((r) => r.source === id);
    const counted = { id, label, count: mine.length, in_window: mine.filter((r) => recordDate(r, window).in_window).length };
    if (id !== 'changelog') return counted;
    return { ...counted, providers: Object.fromEntries(PROVIDERS.map((p) => [p, mine.filter((r) => r.provider === p).length])) };
  });
}

function outsideWindow(rows: DbRow[], window: DateWindow): Pulse['outside_window'] {
  const outside = rows.filter((r) => !recordDate(r, window).in_window);
  const by_source = outside.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.source]: (acc[r.source] ?? 0) + 1 }), {});
  const dates = outside.map((r) => recordDate(r, window).date ?? '').sort();
  const span = dates.length ? `${dates[0].slice(0, 4)} to ${dates.at(-1)?.slice(0, 4)}` : '';
  return {
    count: outside.length,
    by_source,
    note: outside.length
      ? `${outside.length} of the records are dated outside the window (${span}). They are in the count data/briefs/README.md states, and not in by_day or the feed.`
      : 'Every record is dated inside the window.',
    items: outside.map((r) => ({ source: r.source, name: r.name, date: recordDate(r, window).date ?? '', url: r.url })),
  };
}

export function registryPublishers(rows: DbRow[], threshold = MASS_PUBLISHER): RegistryPublishers {
  const names = rows.filter((r) => r.source === 'mcp-registry').map((r) => (typeof r.registry_name === 'string' ? r.registry_name : r.name).split('/')[0]);
  const counts = names.reduce((map, name) => map.set(name, (map.get(name) ?? 0) + 1), new Map<string, number>());
  const mass = [...counts.values()].filter((value) => value >= threshold);
  return { threshold, publishers: mass.length, records: mass.reduce((sum, value) => sum + value, 0) };
}

export function buildPulse(rows: DbRow[], window: DateWindow): Pulse {
  const outside_window = outsideWindow(rows, window);
  return {
    window,
    total: rows.length,
    in_window: rows.length - outside_window.count,
    outside_window,
    by_source: bySource(rows, window),
    by_day: byDay(rows, window),
    registry_publishers: registryPublishers(rows),
    feed: buildFeed(rows, window),
  };
}

export function parseReadmeCounts(readme: string): ReadmeCounts {
  const total = readme.match(/^([\d,]+) things, fetched/m);
  if (!total) throw new Error('data/briefs/README.md no longer states a total ("<n> things, fetched ..."), so the pulse has nothing to reconcile against.');
  const rows = [...readme.matchAll(/^\| ([^|]+?) \| ([\d,]+) \|/gm)];
  return {
    total: Number(total[1].replaceAll(',', '')),
    bySource: Object.fromEntries(rows.map((m) => [m[1], Number(m[2].replaceAll(',', ''))])),
  };
}

/** The engine counts by the same records: if the two ever part, the screen would show two different totals. */
export function assertAgreesWithEngine(pulse: Pick<Pulse, 'total' | 'in_window'>, info: { records: number }): void {
  if (pulse.in_window !== info.records || pulse.total !== info.records) {
    throw new Error(`The pulse (${pulse.total} records, ${pulse.in_window} in the window) disagrees with src/db.ts (${info.records}).`);
  }
}

export function assertReconciles(total: number, bySourceCounts: readonly { label: string; count: number }[], stated: ReadmeCounts): void {
  if (total !== stated.total) {
    throw new Error(`The database has ${total} records, and data/briefs/README.md states ${stated.total}. Find out which is wrong before the pulse shows either.`);
  }
  const wrong = bySourceCounts.filter((s) => stated.bySource[s.label] !== s.count);
  if (wrong.length) {
    const detail = wrong.map((s) => `${s.label}: computed ${s.count}, README ${stated.bySource[s.label] ?? 'nothing'}`).join('; ');
    throw new Error(`Per-source counts disagree with data/briefs/README.md. ${detail}`);
  }
}
