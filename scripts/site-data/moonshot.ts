// site/data/moonshot.json: real inputs for the bonus screen. Prices come from the
// OpenRouter records, cache multipliers from lines the providers printed, and the
// fleet table from the replay and the runs. Outputs built on these are the site's,
// labelled projected, with the formula beside them.
import { cleanText, type ChangelogEntry } from './changelog.ts';
import type { DateWindow, DbRow } from './sources.ts';
import type { Replay } from './replay.ts';
import type { RunView } from './runs.ts';

export interface PriceInput { model_id: string; name: string; price_in_per_m: number; price_out_per_m: number; released: string | null; fetched: string; url: string; source: 'OpenRouter' }
export interface CacheQuote { provider: string; date: string; models: string[]; multiplier: number; printed: boolean; quote: string; url: string }
export interface FleetRow { repo: string; pinned_commit: string; prs_opened: number; prs_updated: number; held_back: number; watching: number; brief_only: number; findings: number; team_later: number; median_days_later: number | null; runs: number }

export interface Moonshot {
  label: string;
  prices: PriceInput[];
  missing_prices: string[];
  router_fallback: { model: string; where: string; url: string | null; price: PriceInput | null; note: string } | null;
  cache: CacheQuote[];
  fleet: FleetRow[];
}

export const MOONSHOT_MODELS = ['openai/gpt-6-luna', 'openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'];

const PRINTED_MULTIPLIER = /(\d*\.\d+)x the base input price/;
const CACHED_INPUT = /\$(\d*\.?\d+)\s+input,\s+\$(\d*\.?\d+)\s+cached input/;
const MODEL_NAME = /\b(?:Claude [A-Z][a-z]+ [\d.]+|GPT-[\d.]+ [A-Z][a-z]+)\b/g;
const round = (n: number): number => Math.round(n * 10_000) / 10_000;
// A sentence ends at a stop before a capital, a price, or a model's own line in a price list.
const SENTENCE_END = /(?<=\.)\s+(?=[A-Z$])|(?<=:)\s+(?=GPT-)/;

function quoteFrom(entry: ChangelogEntry, line: string): CacheQuote | null {
  const printed = line.match(PRINTED_MULTIPLIER);
  const computed = line.match(CACHED_INPUT);
  if (!printed && !computed) return null;
  const multiplier = printed ? Number(printed[1]) : round(Number(computed?.[2]) / Number(computed?.[1]));
  const named = [...new Set(line.match(MODEL_NAME) ?? [])];
  const tagged = entry.tags.filter((t) => t.startsWith('gpt-') || t.startsWith('claude-'));
  return { provider: entry.provider, date: entry.date, models: named.length ? named : tagged, multiplier, printed: Boolean(printed), quote: line, url: entry.url };
}

export function cacheMultipliers(entries: ChangelogEntry[], window: DateWindow): CacheQuote[] {
  return entries
    .filter((e) => e.date >= window.from && e.date <= window.to)
    .flatMap((e) => cleanText(e.text).split(SENTENCE_END).flatMap((line) => quoteFrom(e, line) ?? []))
    .sort((a, b) => (a.provider === b.provider ? b.date.localeCompare(a.date) : a.provider.localeCompare(b.provider)));
}

function priceOf(rows: DbRow[], modelId: string, window: DateWindow): PriceInput | null {
  const row = rows.find((r) => r.source === 'openrouter' && r.model_id === modelId);
  if (!row || typeof row.price_in_per_m !== 'number' || typeof row.price_out_per_m !== 'number') return null;
  return { model_id: modelId, name: row.name, price_in_per_m: row.price_in_per_m, price_out_per_m: row.price_out_per_m, released: row.released, fetched: window.fetched, url: row.url, source: 'OpenRouter' };
}

export interface MoonshotInput {
  rows: DbRow[];
  entries: ChangelogEntry[];
  window: DateWindow;
  replay: Replay;
  runs: { runs: RunView[] };
  modelIds?: string[];
  fallback: { model: string; where: string; url?: string } | null;
}

function fleetOf(replay: Replay, runs: RunView[]): FleetRow[] {
  return replay.repos.map((r) => ({
    repo: r.repo,
    pinned_commit: r.pinned_commit,
    prs_opened: r.summary.prs_opened,
    prs_updated: r.summary.prs_updated,
    held_back: r.summary.held_back,
    watching: r.summary.watching,
    brief_only: r.summary.brief_only,
    findings: r.summary.findings,
    team_later: r.summary.team_later,
    median_days_later: r.summary.median_days_later,
    runs: runs.filter((run) => run.repo === r.repo).length,
  }));
}

function routerFallback(input: MoonshotInput): Moonshot['router_fallback'] {
  if (!input.fallback) return null;
  const { model, where, url } = input.fallback;
  const id = model.includes('/') ? model : `openai/${model}`;
  const price = priceOf(input.rows, id, input.window);
  return { model, where, url: url ?? null, price, note: price ? 'Price from OpenRouter in data/db.' : `${model} has no OpenRouter price in this database window, so it isn't priced here.` };
}

export function buildMoonshot(input: MoonshotInput): Moonshot {
  const ids = input.modelIds ?? MOONSHOT_MODELS;
  const found = ids.map((id) => ({ id, price: priceOf(input.rows, id, input.window) }));
  return {
    label: 'Prices are real. Volumes are assumptions you can change. Everything computed is projected.',
    prices: found.flatMap((f) => (f.price ? [f.price] : [])),
    missing_prices: found.filter((f) => !f.price).map((f) => f.id),
    router_fallback: routerFallback(input),
    cache: cacheMultipliers(input.entries, input.window),
    fleet: fleetOf(input.replay, input.runs.runs),
  };
}
