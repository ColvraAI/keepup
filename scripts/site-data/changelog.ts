// Provider changelog entries as database rows. src/changelogs.ts parses the pages;
// this decides which entries the database's stated count rests on, and how each one reads.
import type { ChangelogEntry, ChangelogProvider } from '../../src/changelogs.ts';
import type { DbRow } from './sources.ts';

export type { ChangelogEntry };

export const PROVIDER_LABEL: Record<ChangelogProvider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google' };

/** The pages leave a space where each link was: "GPT-6 Astra , our most". */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').trim();
}

/**
 * The database counts the entries dated in September or October 2026. The kit's
 * first count said 84 entries and 41,799 records because OpenAI's headings ("Oct 30")
 * carry no year, so 14 of its entries from 2023 to 2025 slipped in (D12, on the database's total).
 */
export function countsAsDatabaseRecord(entry: Pick<ChangelogEntry, 'provider' | 'date'>): boolean {
  const [year, month] = entry.date.split('-').map(Number);
  return year === 2026 && (month === 9 || month === 10);
}

const DEPRECATION = /\b(deprecat\w*|retir\w*|shut(s|ting)? down|shutdown|removal|sunset\w*)\b/i;
const NAME_LIMIT = 80;

function firstClause(text: string): string {
  const clause = text.split(/(?<=[a-z0-9)])[.:;](?:\s|$)/i)[0].trim();
  if (clause.length <= NAME_LIMIT) return clause;
  const cut = clause.slice(0, NAME_LIMIT);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export function entryToRow(entry: ChangelogEntry): DbRow {
  const text = cleanText(entry.text) || entry.tags.join(' ');
  return {
    source: 'changelog',
    kind: DEPRECATION.test(text) ? 'deprecation' : 'api-feature',
    provider: entry.provider,
    name: `${PROVIDER_LABEL[entry.provider]} · ${firstClause(text)}`,
    url: entry.url,
    description: text,
    released: entry.date,
    tags: entry.tags,
  };
}
