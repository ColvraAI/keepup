// Prices come from data/db (the 31 Oct fetch), never from memory. A cost in a
// lab table prints the price's source and date next to it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REPO_ROOT } from './env.ts';

export interface Price {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  source: string;
  fetched: string;
}

export const DB_FETCHED = '2026-10-31';

export function readJsonlGz(path: string): Record<string, unknown>[] {
  const text = gunzipSync(readFileSync(path)).toString('utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** A price by OpenRouter model id such as "openai/gpt-6-luna". Throws rather than guessing. */
export function openRouterPrice(modelId: string, root: string = REPO_ROOT): Price {
  const rows = readJsonlGz(join(root, 'data', 'db', 'openrouter.jsonl.gz'));
  const row = rows.find((r) => r.model_id === modelId);
  if (!row) throw new Error(`no OpenRouter price for ${modelId} in data/db`);
  const input = row.price_in_per_m;
  const output = row.price_out_per_m;
  if (typeof input !== 'number' || typeof output !== 'number') throw new Error(`no numeric price for ${modelId}`);
  return { model: modelId, inputPerMTok: input, outputPerMTok: output, source: `OpenRouter (${row.url})`, fetched: DB_FETCHED };
}

/** Dollars for a run, from token counts and a price. */
export function costUsd(price: Pick<Price, 'inputPerMTok' | 'outputPerMTok'>, tokens: { input: number; output: number }): number {
  return (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1_000_000;
}
