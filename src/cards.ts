// A model's record says little beyond its task and downloads, so the judge also reads its model card:
// its primary source, fetched only when a run is online, cached, masked, bounded and treated as untrusted text.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './candidates.ts';
import { maskText } from './mask.ts';
import { REPO_ROOT } from './signals.ts';

export const DEFAULT_CARD_CACHE = join(REPO_ROOT, 'tmp', 'card-cache');
const CARD_CHARS = 3500;
const PER_JOB = 4;
const TIMEOUT_MS = 15_000;
const SAFE_MODEL_ID = /^[\w.-]+\/[\w.-]+$/;

/** Far more than a card's useful start, and it bounds every pass below. */
const RAW_CARD_CHARS = 64_000;

/** The words of a card: no front matter, HTML or link targets, so the budget goes on what it says. Bounded, so a hostile page stays linear. */
export function cardText(raw: string): string {
  return raw
    .slice(0, RAW_CARD_CHARS)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<[^<>\n]{1,500}>/g, ' ')
    .replace(/!?\[([^\[\]\n]{0,500})\]\([^()\n]{0,1000}\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export interface CardOptions {
  readonly fetchImpl?: typeof fetch;
  readonly cacheDir?: string;
}

async function fetchCard(modelId: string, options: CardOptions): Promise<string | null> {
  if (!SAFE_MODEL_ID.test(modelId)) return null;
  const cacheDir = options.cacheDir ?? DEFAULT_CARD_CACHE;
  const path = join(cacheDir, `${encodeURIComponent(modelId)}.txt`);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  try {
    const response = await (options.fetchImpl ?? fetch)(`https://huggingface.co/${modelId}/raw/main/README.md`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'keepup-demo/0.1 (model card)' } });
    if (!response.ok) return null;
    const card = maskText(cardText(await response.text())).slice(0, CARD_CHARS);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, card);
    return card;
  } catch {
    return null;
  }
}

function strongestModels(candidates: readonly Candidate[]): Set<Candidate> {
  const byJob = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.record.source === 'huggingface') byJob.set(candidate.job, [...(byJob.get(candidate.job) ?? []), candidate]);
  }
  const downloads = (candidate: Candidate) => Number(candidate.record.downloads ?? 0);
  return new Set([...byJob.values()].flatMap((group) => [...group].sort((a, b) => downloads(b) - downloads(a)).slice(0, PER_JOB)));
}

/** A card that can't be fetched just isn't there: the record still stands. */
export async function withCards(candidates: readonly Candidate[], options: CardOptions = {}): Promise<Candidate[]> {
  const chosen = strongestModels(candidates);
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    const card = chosen.has(candidate) ? await fetchCard(String(candidate.record.name), options) : null;
    out.push(card ? { ...candidate, card } : candidate);
  }
  return out;
}
