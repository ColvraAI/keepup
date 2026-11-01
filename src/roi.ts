// The ROI sum and its one plain line. Pure, with no imports: site/src/lib/roi.ts is this file byte for byte, so the
// dashboard's calculator and the brief can't disagree, and test/lever-roi.test.ts holds them equal.
export const ROI_FORMULA = 'monthly saving = (cost per call today − cost per call after) × calls a month; payback = cost of change ÷ monthly saving';
/** A change that takes longer than this to pay back is called not worth it. It's an assumption, and printed as one. */
export const PAYBACK_MONTHS = 12;
export const CACHE_HIT_RATE = 0.9;
export const CACHE_READ = 0.1;
export const CACHE_WRITE = 1.25;
export const BATCH_DISCOUNT = 0.5;
const MILLION = 1_000_000;

export type RoiKind = 'substitute' | 'cache' | 'batch';
export interface RoiPrice { readonly input: number; readonly output: number }
export interface RoiOptionPrice { readonly kind: RoiKind; readonly input_per_m?: number; readonly cache_minimum?: number }
export interface RoiSum { readonly monthly: number; readonly saves: boolean; readonly payback_months: number | null; readonly worth_above_calls: number | null }

export function costToday(inputTokens: number, outputTokens: number, price: RoiPrice): number {
  return (inputTokens * price.input + outputTokens * price.output) / MILLION;
}

/** What a call costs after the change. A prompt under a cache's minimum never hits it, so it costs the same. */
export function costAfter(option: RoiOptionPrice, inputTokens: number, outputTokens: number, price: RoiPrice): number {
  const today = costToday(inputTokens, outputTokens, price);
  if (option.kind === 'substitute') return (inputTokens * (option.input_per_m ?? 0)) / MILLION;
  if (option.kind === 'batch') return today * BATCH_DISCOUNT;
  if (option.cache_minimum && inputTokens < option.cache_minimum) return today;
  return (inputTokens * price.input * (CACHE_HIT_RATE * CACHE_READ + (1 - CACHE_HIT_RATE) * CACHE_WRITE) + outputTokens * price.output) / MILLION;
}

export function roiSum(today: number, after: number, calls: number, changeUsd: number): RoiSum {
  const gain = today - after;
  const monthly = gain * calls;
  return { monthly, saves: gain > 0, payback_months: monthly > 0 ? changeUsd / monthly : null, worth_above_calls: gain > 0 ? Math.ceil(changeUsd / (gain * PAYBACK_MONTHS)) : null };
}

export function effortWords(effort: string): string {
  const word = effort.toLowerCase();
  if (word.startsWith('hours')) return "a few hours' work";
  if (word.startsWith('a day or more')) return 'a day or more of work';
  if (word.startsWith('a day')) return "a day's work";
  return word;
}

function moneyWords(value: number): string {
  if (value < 0.01) return 'less than $0.01';
  return value < 1 ? `about $${value.toFixed(2)}` : `about $${Math.round(value).toLocaleString('en-US')}`;
}

function paybackWords(months: number): string {
  const whole = Math.ceil(months);
  return `pays back in ${whole} month${whole === 1 ? '' : 's'}`;
}

/** Saving a month, cost of the change, and payback, or a plain "not worth it". */
export function roiLine(sum: RoiSum, calls: number, effort: string, tag: string): string {
  const work = effortWords(effort);
  if (!sum.saves) return `No saving at these prices, at any volume · ${work} · not worth it [${tag}]`;
  const pays = sum.payback_months !== null && sum.payback_months <= PAYBACK_MONTHS;
  return `Saves ${moneyWords(sum.monthly)} a month at ${calls.toLocaleString('en-US')} calls · ${work} · ${pays ? paybackWords(sum.payback_months as number) : `not worth it below ${(sum.worth_above_calls as number).toLocaleString('en-US')} calls a month`} [${tag}]`;
}
