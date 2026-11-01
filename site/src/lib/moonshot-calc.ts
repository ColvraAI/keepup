// The goal plan. A static scan can't see traffic, so the volumes are assumptions a person can change,
// and everything computed from them is "projected". Prices and multipliers come from the data.
import type { Moonshot, MoonshotPrice, Pr } from './types';

export type Assumptions = {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheableShare: number;
  cacheHitRate: number;
  cheapShare: number;
};

/** Starting points to change on stage, not findings. The page marks each as an assumption. */
export const DEFAULT_ASSUMPTIONS: Assumptions = {
  messages: 100_000,
  inputTokens: 4_000,
  outputTokens: 400,
  cacheableShare: 0.6,
  cacheHitRate: 0.7,
  cheapShare: 0.3,
};

/** The model all the traffic is assumed to run on, and the one simple messages move to. Also assumptions. */
export const DEFAULT_BASE_MODEL = 'anthropic/claude-sonnet-5.5';
export const DEFAULT_CHEAP_MODEL = 'anthropic/claude-haiku-5.5';

export const GOAL_SHARE = 0.3;
const PER_MILLION = 1_000_000;

export type Plan = {
  baseline: number;
  routingSaved: number;
  cachingSaved: number;
  saved: number;
  share: number;
};

/** A null multiplier means the data holds no cache price for this model, so caching counts for nothing. */
export function planFor(a: Assumptions, base: MoonshotPrice, cheap: MoonshotPrice, cacheMultiplier: number | null): Plan {
  const baseline = (a.messages * (a.inputTokens * base.price_in_per_m + a.outputTokens * base.price_out_per_m)) / PER_MILLION;
  // A "smaller" model that costs more saves nothing: the plan wouldn't route to it.
  const routingSaved = Math.max(0,
    (a.messages * a.cheapShare * (a.inputTokens * (base.price_in_per_m - cheap.price_in_per_m) + a.outputTokens * (base.price_out_per_m - cheap.price_out_per_m))) / PER_MILLION);
  const cachingSaved = cacheMultiplier === null ? 0 :
    (a.messages * (1 - a.cheapShare) * a.inputTokens * a.cacheableShare * a.cacheHitRate * base.price_in_per_m * (1 - cacheMultiplier)) / PER_MILLION;
  const saved = routingSaved + cachingSaved;
  return { baseline, routingSaved, cachingSaved, saved, share: baseline > 0 ? saved / baseline : 0 };
}

export const shortModel = (price: MoonshotPrice): string => price.name.split(': ').at(-1) ?? price.name;

export function priceFor(moonshot: Moonshot, modelId: string): MoonshotPrice | null {
  return moonshot.prices.find((price) => price.model_id === modelId) ?? null;
}

/** The cache line that names this model, read from its provider's own changelog. */
export function cacheFor(moonshot: Moonshot, price: MoonshotPrice) {
  const short = shortModel(price).toLowerCase();
  const asId = short.replaceAll(' ', '-');
  return moonshot.cache.find((line) => line.models.some((model) => [short, asId].includes(model.toLowerCase()))) ?? null;
}

export function measuredLevers(prs: readonly Pr[]): Pr[] {
  return prs.filter((pr) => pr.upstream === 'Mintplex-Labs/anything-llm' && pr.effect.includes('cheaper'));
}
