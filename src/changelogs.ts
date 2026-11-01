// Parses the three provider changelog pages into one dated entry per heading.
// Each page has its own date format, and OpenAI's has no year on the heading, only on the month above it.
import { isoDate } from './dates.ts';

export type ChangelogProvider = 'openai' | 'anthropic' | 'gemini';

export interface ChangelogEntry {
  readonly provider: ChangelogProvider;
  readonly date: string;
  readonly url: string;
  readonly change: string | null;
  readonly tags: readonly string[];
  readonly text: string;
}

const FULL_DATE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?, (20\d\d)$/;
const OPENAI_MONTH = /^(January|February|March|April|May|June|July|August|September|October|November|December), (20\d\d)$/;
const OPENAI_DAY = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})$/;
const OPENAI_CHANGES = new Set(['Feature', 'Update', 'Fix', 'Announcement']);
const PAGE_START: Record<ChangelogProvider, RegExp> = {
  openai: /^Upcoming deprecations can be found/,
  anthropic: /^For updates to Claude Code/,
  gemini: /^This page documents updates to the Gemini API/,
};
const PAGE_END: Record<ChangelogProvider, RegExp> = {
  openai: /^Ask AI$/,
  anthropic: /^Was this page helpful\?/,
  gemini: /^Last updated 20\d\d-\d\d-\d\d|^Except as otherwise noted/,
};

/** Page body lines, with icon characters and non-breaking spaces gone and each line trimmed. */
function bodyLines(provider: ChangelogProvider, page: string): string[] {
  const lines = page.split('\n').map((line) => line.replace(/[-]/g, '').replace(/ /g, ' ').trim());
  const start = lines.findIndex((line) => PAGE_START[provider].test(line));
  const body = start === -1 ? lines : lines.slice(start + 1);
  const end = body.findIndex((line) => PAGE_END[provider].test(line));
  return (end === -1 ? body : body.slice(0, end)).filter(Boolean);
}

interface Draft {
  readonly date: string;
  readonly lines: string[];
}

function groupByHeading(lines: readonly string[], headingDate: (line: string) => string | null): Draft[] {
  return lines.reduce<Draft[]>((drafts, line) => {
    const date = headingDate(line);
    if (date) return [...drafts, { date, lines: [] }];
    drafts.at(-1)?.lines.push(line);
    return drafts;
  }, []);
}

/** OpenAI: a month heading sets the year; then Day, change type, tag lines, then the sentences. */
function openaiEntry(draft: Draft, url: string): ChangelogEntry {
  const change = OPENAI_CHANGES.has(draft.lines[0]) ? draft.lines[0] : null;
  const rest = change ? draft.lines.slice(1) : draft.lines;
  const firstProse = rest.findIndex((line) => line.includes(' '));
  const tags = firstProse === -1 ? rest : rest.slice(0, firstProse);
  const prose = firstProse === -1 ? [] : rest.slice(firstProse);
  return { provider: 'openai', date: draft.date, url, change, tags, text: prose.join(' ') };
}

/** Stamps each day heading with the year of the month heading above it, and removes the month headings. */
function dayHeadingsWithYears(lines: readonly string[]): string[] {
  let year = '';
  return lines.flatMap((line) => {
    const month = line.match(OPENAI_MONTH);
    if (month) { year = month[2]; return []; }
    const day = line.match(OPENAI_DAY);
    return [day && year ? `${day[1]} ${day[2]}, ${year}` : line];
  });
}

function fullDateHeading(line: string): string | null {
  const match = line.match(FULL_DATE);
  return match ? isoDate(match[1], match[2], match[3]) : null;
}

export function parseChangelog(provider: ChangelogProvider, page: string): ChangelogEntry[] {
  const url = page.match(/^SOURCE (\S+)/)?.[1] ?? '';
  const lines = bodyLines(provider, page);
  if (provider === 'openai') return groupByHeading(dayHeadingsWithYears(lines), fullDateHeading).map((draft) => openaiEntry(draft, url));
  return groupByHeading(lines, fullDateHeading).map((draft) => ({
    provider, date: draft.date, url, change: null, tags: [], text: draft.lines.join(' ').replace(/\s+/g, ' ').trim(),
  }));
}

/**
 * How the kit got 84: OpenAI's "Oct 30" headings carry no year, so counting Sep and Oct without
 * reading the month heading above also takes in 14 entries from 2023 to 2025. Kept here so the
 * number can be reconciled, not to be used as a count.
 */
export function yearBlindWindowCount(entries: readonly ChangelogEntry[], since = '2026-09-01', until = '2026-10-31'): number {
  const fromMonth = since.slice(5, 7);
  const toMonth = until.slice(5, 7);
  return entries.filter((entry) => {
    if (entry.provider !== 'openai') return entry.date >= since && entry.date <= until;
    const month = entry.date.slice(5, 7);
    return month >= fromMonth && month <= toMonth;
  }).length;
}
