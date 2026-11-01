// Reads db/levers and db/patterns as data. No lever or pattern lives in code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './signals.ts';

export interface Lever {
  readonly id: string;
  readonly name: string;
  readonly pattern: string;
  readonly kind: string;
  readonly providers?: readonly string[];
  readonly effects: readonly string[];
  readonly gain: string;
  readonly proof: string;
  readonly source: string;
  readonly how: string;
  readonly replaces?: string;
  readonly trade_offs?: readonly string[];
  readonly needs?: string;
  readonly price?: string;
  readonly models?: readonly string[];
  /** A model still live on the provider's page, to move to while the successor can't be taken yet. */
  readonly bridge?: { readonly model: string; readonly until: string; readonly what: string };
  readonly checked?: string;
  readonly checked_by?: string;
  /** huge: the few levers with independent numbers and a cheap change, which lead. long_tail: everything else, found and said, never leading. */
  readonly tier?: 'huge' | 'long_tail';
  readonly audience?: 'product' | 'team';
  readonly install?: string;
  readonly gain_vendor?: string;
  readonly gain_independent?: string;
  readonly gain_model?: { readonly formula?: string; readonly inputs?: readonly unknown[]; readonly type?: string };
  readonly test_recipe?: { readonly what_to_compare?: string; readonly samples?: number; readonly can_run_with?: readonly string[] };
}

export interface PatternMeta {
  readonly id: string;
  readonly name: string;
  readonly why: string;
  readonly status: 'live' | 'info';
  /** A repo-wide absence, such as no test set: raised once, however many calls fire it. */
  readonly absence?: boolean;
  /** What the judge needs to know for this pattern alone. */
  readonly judge_note?: string;
}

function readJsonFiles<T>(dir: string, prefix: RegExp): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => prefix.test(name) && name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
      } catch (error) {
        throw new Error(`Can't read ${name}: ${(error as Error).message}`);
      }
    });
}

export function loadLevers(dir = join(REPO_ROOT, 'db', 'levers')): Lever[] {
  return readJsonFiles<Lever>(dir, /^ADV-/);
}

export function loadPatternMeta(dir = join(REPO_ROOT, 'db', 'patterns')): PatternMeta[] {
  return readJsonFiles<PatternMeta>(dir, /^PAT-/);
}

export type Recipe = 'prompt caching' | 'cheaper tier' | 'structured outputs' | 'decision model';

/** Only the change this lever makes. A recipe that tests something else would put another change's number on this one. */
export function recipesFor(lever: Pick<Lever, 'pattern' | 'gain_model'> | null): Recipe[] {
  if (!lever) return [];
  const formula = lever.gain_model?.formula ?? '';
  if (/hit_rate/.test(formula) || lever.pattern === 'PAT-prompt-caching-off') return ['prompt caching'];
  if (/decision_cost/.test(formula) || lever.pattern === 'PAT-label-picking-call') return ['decision model'];
  if (lever.pattern === 'PAT-hand-parsed-json') return ['structured outputs'];
  return lever.pattern === 'PAT-one-top-model' ? ['cheaper tier'] : [];
}

/** The Claude-only hard case: a lever tied to another provider never shows; a neutral lever (no providers) always can. */
export function leverAllowed(lever: Pick<Lever, 'providers'>, providerOnly: string | undefined): boolean {
  if (!providerOnly || !lever.providers?.length) return true;
  return lever.providers.includes(providerOnly);
}
