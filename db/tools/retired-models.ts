// Builds db/patterns/PAT-retired-model-id.json from the providers' own deprecation pages.
// Nothing here is typed by hand: an id, a date and a successor all come from a table on
// the page. Exact ids only, never prefixes.
// Run: node db/tools/retired-models.ts <dir holding the three pages> <as-of date>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Model = { id: string; provider: string; date: string; successors: string[]; earliest: boolean; alias_of?: string };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Ids that are ordinary English words. As a bare string they can't be told from anything else,
// and all of them were shut down by 2024, so they stay out rather than make false alarms.
const AMBIGUOUS = new Set(['ada', 'babbage', 'curie', 'davinci']);
// A date further out than this isn't something a founder can act on yet.
const HORIZON_DAYS = 365;

export function parseDate(text: string): string | null {
  const t = text.replace(/‑/g, '-').trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[0];
  const long = t.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/);
  if (!long) return null;
  const month = MONTHS.indexOf(long[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  return `${long[3]}-${String(month + 1).padStart(2, '0')}-${long[2].padStart(2, '0')}`;
}

function cells(row: string): string[] {
  return row.replace(/\\\|/g, '¦').split('|').slice(1, -1).map((c) => c.trim());
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

const isModelId = (id: string): boolean => /^[a-z][\w.-]*$/.test(id) && !AMBIGUOUS.has(id);

function tableRows(md: string, isHeader: (c: string[]) => boolean): string[][] {
  const out: string[][] = [];
  let inside = false;
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) { inside = false; continue; }
    const c = cells(line);
    if (isHeader(c)) { inside = true; continue; }
    if (inside && !/^:?-+:?$/.test(c[0] ?? '')) out.push(c);
  }
  return out;
}

function rowsToModels(rows: string[][], provider: string, pick: (r: string[]) => [string, string, string] | null, earliest: boolean): Model[] {
  const seen = new Map<string, Model>();
  for (const row of rows) {
    const picked = pick(row);
    if (!picked) continue;
    const [dateCell, modelCell, successorCell] = picked;
    const date = parseDate(dateCell);
    if (!date || /training/i.test(modelCell)) continue;
    const successors = backticked(successorCell);
    for (const id of backticked(modelCell).filter(isModelId)) {
      if (!seen.has(id)) seen.set(id, { id, provider, date, successors, earliest });
    }
  }
  return [...seen.values()];
}

export function parseOpenAI(md: string): Model[] {
  const rows = tableRows(md, (c) => c[0] === 'Shutdown date');
  return rowsToModels(rows, 'openai', (r) => [r[0], r[1], r[r.length - 1]], false);
}

export function parseAnthropic(md: string): Model[] {
  const rows = tableRows(md, (c) => c[0] === 'Retirement date');
  return rowsToModels(rows, 'anthropic', (r) => [r[0], r[1], r[2]], false);
}

export function parseGemini(md: string): Model[] {
  const rows = tableRows(md, (c) => c[0] === '**Model**');
  const pick = (r: string[]): [string, string, string] | null => (r.length >= 4 ? [r[2], r[0], r[3]] : null);
  return rowsToModels(rows, 'google', pick, true).filter((m) => !/^(deep-research|antigravity)-/.test(m.id));
}

export type UndatedSuccessor = { id: string; provider: string; successors: string[] };

/** A row with no shutdown date can still name its replacement. It isn't a retirement, so it stays out of what a scan looks for. */
export function parseGeminiUndated(md: string): UndatedSuccessor[] {
  const rows = tableRows(md, (c) => c[0] === '**Model**').filter((r) => r.length >= 4 && parseDate(r[2]) === null);
  return rows.flatMap((r) => {
    const successors = [...new Set(backticked(r[3]))];
    return successors.length ? backticked(r[0]).filter(isModelId).map((id) => ({ id, provider: 'google', successors })) : [];
  });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A retired id is only news on a line that could send it. So the id must be quoted or assigned
// (prose like "<code>whisper-1</code>" or "4,096 (gpt-3.5-turbo)" is out) and comment lines are out.
// A Bedrock id such as anthropic.claude-sonnet-4-20250514-v1:0 never matches: the page's date
// applies to Anthropic-operated platforms, and Bedrock has its own lifecycle. A key in a lookup
// table ("gpt-4o": 128000 or "gpt-4o": {...}) describes a model rather than choosing one, so it's out.
export function idRegex(ids: string[]): string {
  const alt = ids.map(escapeRe).join('|');
  return `^(?!\\s*(?:#|//|\\*|/\\*|--))(?!.*(?:tiktoken|encoding_for_model|[Tt]okenizer)).*(?:["'\`](?:${alt})["'\`](?!\\s*:\\s*[\\d{\\[])|[=:]\\s*(?:${alt})\\s*(?:#.*)?$)`;
}

function noteFor(m: Model, asOf: string): string {
  const verb = m.date <= asOf ? 'shut down' : 'shuts down';
  const when = m.earliest ? `no earlier than ${m.date}, the provider's stated earliest date` : `on ${m.date}`;
  const next = m.successors.length ? `Provider's named successor: ${m.successors.join(' or ')}.` : 'The provider names no successor.';
  return `${m.provider}: ${verb} ${when}. ${next}`;
}

// One regex per provider, not one per date: every line of every file runs through these, and
// a hundred separate regexes made a big repo take minutes. Each id's date is in models.
function findByProvider(models: Model[]): { regex: string; note: string }[] {
  return [...new Set(models.map((m) => m.provider))].map((provider) => ({
    regex: idRegex(models.filter((m) => m.provider === provider).map((m) => m.id)),
    note: `An exact ${provider} id on its retirement list. The date and successor for each id are in models.`,
  }));
}

// The OpenAI deprecation page names snapshots. Each bare alias below is marked Deprecated on its
// own model page, with the named snapshot as its default, so it shuts down with that snapshot.
const OPENAI_ALIASES: Record<string, string> = {
  'gpt-4o': 'gpt-4o-2024-08-06',
  'gpt-4o-mini': 'gpt-4o-mini-2024-07-18',
  'gpt-4.1': 'gpt-4.1-2025-04-14',
  'gpt-4.1-mini': 'gpt-4.1-mini-2025-04-14',
};

function withAliases(models: Model[]): Model[] {
  const known = new Set(models.map((m) => m.id));
  const aliases = Object.entries(OPENAI_ALIASES).flatMap(([alias, snapshot]) => {
    const base = models.find((m) => m.id === snapshot);
    if (!base) throw new Error(`Snapshot ${snapshot} is not on the deprecation page: re-read ${alias}'s model page.`);
    return known.has(alias) ? [] : [{ ...base, id: alias, alias_of: snapshot }];
  });
  return [...models, ...aliases];
}

export const SOURCES: Record<string, string> = {
  openai: 'https://developers.openai.com/api/docs/deprecations',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
  google: 'https://ai.google.dev/gemini-api/docs/deprecations',
};

const SKIP_NEAR = ['#\\[cfg\\(test\\)\\]', '#\\[(tokio::)?test\\]', '\\bassert(_eq|_ne)?!\\(', '\\bdescribe\\(', '\\bit\\([\'"`]', '\\bexpect\\(', '\\bdef test_', '\\bassert ', '@pytest\\.', '\\bfunc Test[A-Z]', '(?:NO|NOT|UNSUPPORTED|DISABLED|BLOCKED|SUPPORT\\w*|SKIP|EXCLUDE\\w*)_\\w*MODELS', 'disabledModels|[Ff]ilteredModels', '\\bmodelRegistry\\b'];

export const TEST_FILES = ['**/__tests__/**', '**/test/**', '**/tests/**', '**/testdata/**', '**/fixtures/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*', '**/test-*', '**/conftest.py'];

// Places that mention a model without ever sending one: leaderboards, migrations, benchmarks and tokenizers.
const INERT_FILES = ['**/website/**', '**/docs/**', '**/benchmark/**', '**/benchmarks/**', '**/evals/**', '**/migrations/**', '**/*tiktoken*'];

function withinHorizon(date: string, asOf: string): boolean {
  return Date.parse(date) - Date.parse(asOf) <= HORIZON_DAYS * 86_400_000;
}

export function buildPattern(models: Model[], asOf: string, undated: UndatedSuccessor[] = []): Record<string, unknown> {
  const inScope = models.filter((m) => withinHorizon(m.date, asOf));
  return {
    id: 'PAT-retired-model-id',
    name: 'A retired or retiring model id',
    find: findByProvider(inScope),
    skip_if_near: SKIP_NEAR,
    skip_files: [...TEST_FILES, ...INERT_FILES],
    files: ['**/*.py', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.rs', '**/*.go', '**/*.toml', '**/*.yaml', '**/*.yml', '**/*.env.example', '**/.env.example'],
    why: "A model id on a provider's retirement list either already returns an error or will on a stated date. Age alone is never a finding: only an id the provider itself has dated.",
    status: 'live',
    effect: ['keeps working'],
    live_from: 'v0.1',
    models_as_of: asOf,
    models: inScope.map((m) => ({ ...m, note: noteFor(m, asOf), source: SOURCES[m.provider] })),
    undated_successors: undated.map((m) => ({ ...m, note: `${m.provider}: no shutdown date announced. Provider's named successor: ${m.successors.join(' or ')}.`, source: SOURCES[m.provider] })),
  };
}

function main(dir: string, asOf: string, out: string): void {
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
  const models = [
    ...parseAnthropic(read('anthropic-model-deprecations.md')),
    ...withAliases(parseOpenAI(read('deprecations.md'))),
    ...parseGemini(read('gemini-deprecations.md')),
  ];
  writeFileSync(out, JSON.stringify(buildPattern(models, asOf, parseGeminiUndated(read('gemini-deprecations.md'))), null, 2) + '\n');
}

if (process.argv[1] === import.meta.filename) {
  const [dir, asOf] = process.argv.slice(2);
  if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '')) throw new Error('Usage: node db/tools/retired-models.ts <pages dir> <yyyy-mm-dd>');
  main(dir, asOf, join(import.meta.dirname, '..', 'patterns', 'PAT-retired-model-id.json'));
}
