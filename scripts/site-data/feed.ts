// The pulse feed: about 600 real items, picked by traction inside each source, so
// the 35,000 MCP servers don't drown everything. Personal fields never get past toItem.
import { isUnfit, oneLine, readable } from './feed-filter.ts';
import { recordDate, SOURCES, type DbRow, type DateWindow } from './sources.ts';
import { PROVIDER_LABEL } from './changelog.ts';

export interface Traction { metric: string; value: number }

export interface FeedItem {
  key: string;
  source: string;
  source_label: string;
  kind: string;
  provider?: string;
  name: string;
  description: string;
  date: string;
  date_kind: 'released' | 'updated';
  url: string;
  traction?: Traction;
}

interface TractionContext { npmDownloads: Map<string, number>; githubStars: Map<string, number> }

// How many of each source to show, and the least traction to be shown at all.
const QUOTA: Record<string, number> = { 'mcp-registry': 130, npm: 100, github: 90, huggingface: 60, openrouter: 40, changelog: 70, hn: 45, yc: 40, pypi: 25, skills: 4 };
const BAR: Record<string, number> = { 'mcp-registry': 1000, npm: 5000, github: 300, huggingface: 100, pypi: 500, hn: 20, skills: 1000 };
// A source whose records can reach us from the same owner many times over.
const OWNER_CAP: Record<string, number> = { 'mcp-registry': 1, npm: 2, github: 2, huggingface: 3, openrouter: 3 };
// The sources' own AI filters also let through words like "agent" in an HTTP proxy, so these must say it plainly.
const PLAINLY_AI = /(?<![\p{L}\p{N}])(ai|llm|llms|gpt|agentic|mcp|model context protocol|claude|codex|openai|anthropic|gemini|deepseek|qwen|rag|embedding|embeddings|prompt|prompts|copilot|inference|neural|chatbot|langchain|langfuse|llama|machine learning|deep learning|ai agents?|coding agents?|decision models?|jev|laya)(?![\p{L}\p{N}])/iu;
const LOOSELY_AI = /(?<![\p{L}\p{N}])(agent|agents|model|models|cursor|skill|skills)(?![\p{L}\p{N}])/iu;
const STALE = /^(deprecated|legacy|not the latest)\b/i;
const DESCRIPTION_PREFIX = 32;
const YC_RECENT_BATCH = /\b2026$/;
const VARIANT_MODEL = /(:batch|-pro|-latest)$|^~/;
const REGISTRY_SEARCH = 'https://registry.modelcontextprotocol.io/v0.1/servers?search=';

const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const isHttps = (v: unknown): v is string => typeof v === 'string' && v.startsWith('https://');
const githubRepo = (url: string): string => url.toLowerCase().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');

export function feedLink(row: DbRow): string | null {
  if (isHttps(row.url)) return row.url;
  if (row.source === 'mcp-registry') return `${REGISTRY_SEARCH}${encodeURIComponent(asString(row.registry_name) || row.name)}`;
  if (isHttps(row.hn_url)) return row.hn_url;
  if (isHttps(row.yc_url)) return row.yc_url;
  return null;
}

function mcpTraction(row: DbRow, ctx: TractionContext): Traction | null {
  const packages = Array.isArray(row.packages) ? (row.packages as string[]) : [];
  const downloads = Math.max(0, ...packages.map((p) => ctx.npmDownloads.get(p) ?? 0));
  if (downloads > 0) return { metric: 'npm downloads a week', value: downloads };
  const stars = ctx.githubStars.get(githubRepo(row.url));
  return stars ? { metric: 'stars', value: stars } : null;
}

export function tractionOf(row: DbRow, ctx: TractionContext): Traction | null {
  switch (row.source) {
    case 'mcp-registry': return mcpTraction(row, ctx);
    case 'github': return { metric: 'stars', value: asNumber(row.stars) };
    case 'npm': return { metric: 'downloads a week', value: asNumber(row.downloads_week) };
    case 'huggingface': return { metric: 'likes', value: asNumber(row.likes) };
    case 'pypi': return { metric: 'downloads', value: asNumber(row.downloads) };
    case 'hn': return { metric: 'points', value: asNumber(row.points) };
    case 'skills': return { metric: 'downloads', value: asNumber(row.downloads) };
    default: return null;
  }
}

function buildContext(rows: DbRow[]): TractionContext {
  return {
    npmDownloads: new Map(rows.filter((r) => r.source === 'npm').map((r) => [asString(r.package), asNumber(r.downloads_week)])),
    githubStars: new Map(rows.filter((r) => r.source === 'github').map((r) => [asString(r.repo).toLowerCase(), asNumber(r.stars)])),
  };
}

function describe(row: DbRow): string {
  if (row.source === 'huggingface') return [row.task, row.library].filter(Boolean).join(' · ');
  if (row.source === 'hn') return `${asString(row.hn_tag).toLowerCase() === 'launch_hn' ? 'Launch HN' : 'Show HN'} · ${asNumber(row.points)} points`;
  return row.description;
}

function belongs(row: DbRow): boolean {
  if (STALE.test(row.description)) return false;
  const text = `${row.name} ${row.description}`;
  if (row.source === 'github' || row.source === 'npm' || row.source === 'pypi') return PLAINLY_AI.test(text);
  if (row.source === 'hn') return PLAINLY_AI.test(text) || LOOSELY_AI.test(text);
  if (row.source === 'yc') return row.status === 'Active' && YC_RECENT_BATCH.test(asString(row.batch));
  if (row.source === 'openrouter') return !VARIANT_MODEL.test(asString(row.model_id));
  return true;
}

function clearsBar(row: DbRow, traction: Traction | null): boolean {
  const bar = BAR[row.source];
  return bar === undefined || (traction !== null && traction.value >= bar);
}

function ownerOf(row: DbRow): string {
  if (row.source === 'mcp-registry') return asString(row.registry_name).split('/')[0];
  if (row.source === 'npm') return row.name.startsWith('@') ? row.name.split('/')[0] : row.name;
  if (row.source === 'github') return asString(row.repo).split('/')[0];
  if (row.source === 'huggingface') return row.name.split('/')[0];
  if (row.source === 'openrouter') return asString(row.model_id).split('/')[0];
  return row.name;
}

/** The best record for each name and each description: the registry repeats itself across versions and publishers. */
function dedupe<T extends { row: DbRow; item: FeedItem }>(ranked: T[]): T[] {
  return ranked.reduce<{ kept: T[]; seen: Set<string> }>((state, c) => {
    const keys = [`n:${c.item.name.toLowerCase()}`, `d:${c.item.description.toLowerCase().slice(0, DESCRIPTION_PREFIX)}`];
    if (keys.some((k) => state.seen.has(k))) return state;
    return { kept: [...state.kept, c], seen: new Set([...state.seen, ...keys]) };
  }, { kept: [], seen: new Set() }).kept;
}

function capOwners<T extends { row: DbRow }>(ranked: T[]): T[] {
  return ranked.reduce<{ kept: T[]; seen: Map<string, number> }>((state, item) => {
    const cap = OWNER_CAP[item.row.source];
    const owner = ownerOf(item.row);
    const used = state.seen.get(owner) ?? 0;
    if (cap !== undefined && used >= cap) return state;
    return { kept: [...state.kept, item], seen: new Map(state.seen).set(owner, used + 1) };
  }, { kept: [], seen: new Map() }).kept;
}

const mondayOf = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};

/** Best first inside each week, one week at a time, so the feed covers the whole 60 days. */
export function roundRobinByWeek<T extends { date: string; score: number }>(items: T[], quota: number): T[] {
  const weeks = Object.values(Object.groupBy(items, (i) => mondayOf(i.date)))
    .map((group) => [...(group ?? [])].sort((a, b) => b.score - a.score));
  const deepest = Math.max(0, ...weeks.map((w) => w.length));
  const order = Array.from({ length: deepest }, (_, depth) => weeks.flatMap((w) => (w[depth] ? [w[depth]] : [])));
  return order.flat().slice(0, quota);
}

/** Newest first, and within a day, one from each source in turn. */
export function interleaveByDay<T extends { date: string; source: string; name: string }>(items: T[]): T[] {
  const days = Object.entries(Object.groupBy(items, (i) => i.date)).sort(([a], [b]) => b.localeCompare(a));
  return days.flatMap(([, group]) => {
    const list = group ?? [];
    const sources = [...new Set(list.map((i) => i.source))].sort();
    const queues = sources.map((s) => list.filter((i) => i.source === s));
    const deepest = Math.max(...queues.map((q) => q.length));
    return Array.from({ length: deepest }, (_, depth) => queues.flatMap((q) => (q[depth] ? [q[depth]] : []))).flat();
  });
}

const LABEL = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));

/** A registry name carries its publisher's handle, which is often a person's. The link still goes to the real record. */
function displayName(row: DbRow): string {
  const short = row.source === 'mcp-registry' && row.name === row.registry_name ? row.name.split('/').at(-1) : null;
  return oneLine(short || row.name, 100);
}

function toItem(row: DbRow, url: string, date: string, date_kind: 'released' | 'updated', traction: Traction | null): FeedItem {
  const name = displayName(row);
  return {
    key: `${row.source}:${name}`,
    source: row.source,
    source_label: LABEL[row.source] ?? row.source,
    kind: row.kind,
    ...(row.provider ? { provider: PROVIDER_LABEL[row.provider as keyof typeof PROVIDER_LABEL] } : {}),
    name,
    description: oneLine(describe(row)),
    date,
    date_kind,
    url,
    ...(traction ? { traction } : {}),
  };
}

interface Candidate { row: DbRow; item: FeedItem; date: string; score: number }

function candidatesOf(rows: DbRow[], window: DateWindow, ctx: TractionContext): Candidate[] {
  return rows.flatMap((row) => {
    const { date, date_kind, in_window } = recordDate(row, window);
    const url = feedLink(row);
    const description = describe(row);
    if (!in_window || !date || !url || !row.name.trim() || !description.trim()) return [];
    if (isUnfit(row.name, row.description) || !belongs(row)) return [];
    if (!readable(row.name) || !readable(description)) return [];
    const traction = tractionOf(row, ctx);
    if (!clearsBar(row, traction)) return [];
    return [{ row, date, item: toItem(row, url, date, date_kind, traction), score: traction?.value ?? Date.parse(date) }];
  });
}

export function buildFeed(rows: DbRow[], window: DateWindow): FeedItem[] {
  const candidates = candidatesOf(rows, window, buildContext(rows));
  const chosen = Object.entries(QUOTA).flatMap(([source, quota]) => {
    const ranked = candidates.filter((c) => c.row.source === source).sort((a, b) => b.score - a.score);
    return roundRobinByWeek(capOwners(dedupe(ranked)), quota).map((c) => c.item);
  });
  return interleaveByDay(chosen);
}
