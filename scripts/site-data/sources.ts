// The database's sources, and how a record gets its one date. Shared by the pulse and the feed.
export interface DbRow {
  source: string;
  kind: string;
  name: string;
  url: string;
  description: string;
  released: string | null;
  updated?: string | null;
  [field: string]: unknown;
}

export interface DateWindow { from: string; to: string; fetched: string }

/** Labels are the ones in data/briefs/README.md's table, and assertReconciles holds them to it. */
export const SOURCES = [
  { id: 'mcp-registry', label: 'Official MCP Registry' },
  { id: 'npm', label: 'npm' },
  { id: 'github', label: 'GitHub' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'pypi', label: 'PyPI (via ecosyste.ms)' },
  { id: 'hn', label: 'Hacker News' },
  { id: 'yc', label: 'Y Combinator' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'changelog', label: 'Provider changelogs' },
  { id: 'skills', label: 'ClawHub skills' },
] as const;

const dayOf = (date: unknown): string | null => (typeof date === 'string' && date ? date.slice(0, 10) : null);
const within = (day: string | null, window: DateWindow): day is string => day !== null && day >= window.from && day <= window.to;

export function recordDate(row: DbRow, window: DateWindow): { date: string | null; date_kind: 'released' | 'updated'; in_window: boolean } {
  const released = dayOf(row.released);
  const updated = dayOf(row.updated);
  if (within(released, window)) return { date: released, date_kind: 'released', in_window: true };
  if (within(updated, window)) return { date: updated, date_kind: 'updated', in_window: true };
  return released ? { date: released, date_kind: 'released', in_window: false } : { date: updated, date_kind: 'updated', in_window: false };
}
