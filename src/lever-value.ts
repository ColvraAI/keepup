// lever value = (cost today - frontier cost) x frequency - cost of change, for one finding. Pure: every input is passed in,
// printed beside the result and labelled. Frequency isn't in code, so it's assumed, and the person can change it.
import { estimateTokens, literalPromptNear, modelAtCall, namedPromptNear } from './call-prompt.ts';
import { recipesFor, type Lever } from './levers.ts';
import { hoursOf } from './rank.ts';
import { BATCH_DISCOUNT, CACHE_HIT_RATE, CACHE_READ, CACHE_WRITE, costAfter, costToday, effortWords, PAYBACK_MONTHS, ROI_FORMULA, roiLine, roiSum, type RoiKind } from './roi.ts';
import type { Finding, LeverRoi, LeverValue, RoiOption } from './run-shape.ts';

export const ASSUMED_CALLS_PER_MONTH = 10_000;
export const ASSUMED_HOURLY_USD = 100;
export const ASSUMED_MONTHS = 12;
export const ASSUMED_CACHE_HIT_RATE = CACHE_HIT_RATE;
export const ASSUMED_LABEL_OUTPUT_TOKENS = 20;
export const ASSUMED_OUTPUT_TOKENS = 300;
/** When no prompt can be read at all. It clears the usual cache minimum, and the person can change it. */
export const ASSUMED_INPUT_TOKENS = 2_000;
const MILLION = 1_000_000;

export type GainType = RoiKind;
/** How a pattern's gain turns into money. A lever's own gain_model.type wins over this. Levers not here have no money number. */
const GAIN_BY_PATTERN: Readonly<Record<string, GainType>> = { 'PAT-label-picking-call': 'substitute', 'PAT-prompt-caching-off': 'cache', 'PAT-scheduled-llm-no-batch': 'batch' };

export interface PriceRow {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly source: string;
  readonly date?: string;
}

export interface ValueInput {
  readonly gainType: GainType | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number;
  readonly price: PriceRow | null;
  readonly frontierInput?: number;
  readonly hours: number;
  readonly leverId: string;
  readonly tokensLabel: string;
  readonly cacheMinimum?: number;
  readonly noNumberReason?: string;
  readonly modelLabel?: string;
  /** The price is a labelled example, not this call's model, so no figure ranks on it. */
  readonly exampleOnly?: boolean;
  /** Why the sum is an example, when it isn't that the model is set at runtime. */
  readonly exampleWhy?: string;
}

function usd(value: number): string {
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
}

function perCall(input: ValueInput): { today: number; frontier: number; detail: string } | string {
  const { gainType, inputTokens, outputTokens, price } = input;
  if (!gainType) return input.noNumberReason ?? 'This lever has no cost formula yet.';
  if (inputTokens === null) return input.noNumberReason ?? 'The prompt this call passes is built at runtime, so there is no token count to read.';
  if (!price) return `No price on file for the model this call sends.`;
  if (input.exampleOnly && input.exampleWhy) return input.exampleWhy;
  if (input.exampleOnly) return "This call's model is set at runtime, so no one figure holds: the sum below is on a named model, as an example.";
  const today = (inputTokens * price.input + outputTokens * price.output) / MILLION;
  if (gainType === 'substitute') {
    if (input.frontierInput === undefined) return 'The lever gives no input price, so there is no number.';
    return { today, frontier: (inputTokens * input.frontierInput) / MILLION, detail: `decision call at $${input.frontierInput} per 1M input, output free (vendor price)` };
  }
  if (gainType === 'batch') return { today, frontier: today * BATCH_DISCOUNT, detail: `the batch price, ${BATCH_DISCOUNT * 100}% of standard (provider's list price)` };
  if (input.cacheMinimum && inputTokens < input.cacheMinimum) return `The only literal text keepup can read here is about ${inputTokens} tokens, under the ${input.cacheMinimum}-token cache minimum. Any longer prefix (system prompt, tools) is set at runtime, so there's no number from code.`;
  const cachedInput = inputTokens * price.input * (ASSUMED_CACHE_HIT_RATE * CACHE_READ + (1 - ASSUMED_CACHE_HIT_RATE) * CACHE_WRITE);
  return { today, frontier: (cachedInput + outputTokens * price.output) / MILLION, detail: `${ASSUMED_CACHE_HIT_RATE * 100}% cache hits (assumed), reads at ${CACHE_READ}x and writes at ${CACHE_WRITE}x input (provider's list price)` };
}

export function computeValue(input: ValueInput): LeverValue {
  const change = input.hours * ASSUMED_HOURLY_USD;
  const inputs: LeverValue['inputs'] = {
    calls_per_month: { value: ASSUMED_CALLS_PER_MONTH, label: 'assumed' },
    hourly_usd: { value: ASSUMED_HOURLY_USD, label: 'assumed' },
    months: { value: ASSUMED_MONTHS, label: 'assumed' },
    change_hours: { value: input.hours, label: 'assumed from the effort word' },
    ...(input.inputTokens === null ? {} : { input_tokens: { value: input.inputTokens, label: input.tokensLabel } }),
    ...(input.gainType && input.inputTokens !== null ? { output_tokens: { value: input.outputTokens, label: 'assumed' } } : {}),
    ...(input.price ? { model: { value: input.price.model, label: input.modelLabel ?? 'assumed' } } : {}),
  };
  const costs = perCall(input);
  if (typeof costs === 'string') return { status: 'no_number', lever: input.leverId, label: 'absent', inputs, reason: costs, formula: 'lever value = (cost today - frontier cost) x frequency - cost of change' };
  const gain = costs.today - costs.frontier;
  const monthly = gain * ASSUMED_CALLS_PER_MONTH;
  return {
    status: 'priced', lever: input.leverId, label: 'projected', inputs,
    today_per_call_usd: costs.today, frontier_per_call_usd: costs.frontier, change_cost_usd: change,
    monthly_gain_usd: monthly, value_usd: monthly * ASSUMED_MONTHS - change,
    break_even_calls_per_month: gain > 0 ? Math.ceil(change / (gain * ASSUMED_MONTHS)) : undefined,
    formula: `(${usd(costs.today)} - ${usd(costs.frontier)}) x ${ASSUMED_CALLS_PER_MONTH.toLocaleString('en-US')} calls a month x ${ASSUMED_MONTHS} months - ${input.hours} h x $${ASSUMED_HOURLY_USD} = ${monthly * ASSUMED_MONTHS - change < 0 ? '-' : ''}$${Math.abs(monthly * ASSUMED_MONTHS - change).toFixed(0)}; frontier: ${costs.detail}`,
  };
}

/** The same sum at another volume, which is what the dashboard's input does. */
export function recomputeAt(value: LeverValue, calls: number): LeverValue {
  if (value.status !== 'priced') return value;
  const gain = (value.today_per_call_usd as number) - (value.frontier_per_call_usd as number);
  const monthly = gain * calls;
  return { ...value, inputs: { ...value.inputs, calls_per_month: { value: calls, label: 'assumed' } }, monthly_gain_usd: monthly, value_usd: monthly * ASSUMED_MONTHS - (value.change_cost_usd as number) };
}

const SPEED = /(about |up to )?(\d+(?:\.\d+)?)x(?:-\d+x)? faster/gi;

/** The smallest "N x faster" on offer, word for word: it's a vendor's number, and it says so. */
export function speedClaim(texts: readonly string[]): LeverValue['speed'] {
  const claims = texts.flatMap((text) => [...text.matchAll(SPEED)].map((match) => ({ text: match[0], times: Number(match[2]) })));
  const best = [...claims].sort((a, b) => a.times - b.times)[0];
  return best ? { text: best.text, label: 'vendor claim' } : undefined;
}

export interface ValueContext {
  readonly levers: readonly Lever[];
  readonly files: ReadonlyMap<string, string>;
  /** Model ids in this repo, to price the call with. */
  readonly modelIds: readonly string[];
  readonly priceOf: (model: string) => PriceRow | null;
  /** A model to price with when nothing names one, and rank on. */
  readonly fallbackModel?: string;
  /** A named common model for one worked line when nothing names one. It's labelled example and never ranks. */
  readonly exampleModel?: string;
}

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|spec|e2e)\/|\.(?:test|spec)\./;
const NAMED_DEFAULT = /\b(?:default|fallback)\w*["']?\s*[:=]\s*["'`]([\w.:/-]+)["'`]|(?:\|\||\?\?|\bor\b)\s*["'`]([\w.:/-]+)["'`]/gi;

function defaultsIn(file: string, text: string, context: ValueContext): { id: string; place: string }[] {
  return [...text.matchAll(NAMED_DEFAULT)].flatMap((match) => {
    const id = match[1] ?? match[2];
    return context.modelIds.includes(id) && context.priceOf(id) ? [{ id, place: `${file}:${text.slice(0, match.index).split('\n').length}` }] : [];
  });
}

/** One default among these rows, or none: two providers with two defaults name neither. */
function namedDefault(rows: readonly { id: string; place: string }[]): { id: string; place: string } | null {
  return new Set(rows.map((row) => row.id)).size === 1 ? rows[0] : null;
}

type Basis = NonNullable<LeverRoi['basis']>;

const NEAR_LINES = 10;
const QUOTED = /["'`]([\w.:/-]+)["'`]/g;
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*)/;

/** Where `name` is given a quoted value in this file, as `const NAME = "id"` or `NAME = "id"`: the value and its line. */
function constantValue(text: string, name: string): { value: string; line: number } | null {
  const match = new RegExp(`^[ \\t]*(?:export\\s+)?(?:(?:const|let|var|final|static|readonly)\\s+)*${name.replace(/\$/g, '\\$')}\\s*(?::[^=\\n]+)?=\\s*["'\`]([\\w.:/-]+)["'\`]`, 'm').exec(text);
  return match ? { value: match[1], line: text.slice(0, match.index).split('\n').length } : null;
}

/**
 * The model id the code names at or a few lines from this line, nearest first: a quoted id, or a constant those lines pass
 * (to a helper such as getModel) whose value is one. A default or fallback is left to the default rules, which say so.
 */
function modelNamedNear(file: string, text: string, line: number, context: ValueContext): { id: string; place: string } | null {
  const lines = text.split('\n');
  const order = Array.from({ length: NEAR_LINES * 2 + 1 }, (_, index) => line + (index % 2 ? (index + 1) / 2 : -index / 2)).filter((at) => at >= 1 && at <= lines.length);
  for (const at of order) {
    const row = lines[at - 1];
    if (COMMENT.test(row)) continue;
    const quoted = [...row.matchAll(QUOTED)].map((match) => match[1]).find((id) => context.modelIds.includes(id));
    if (quoted && !new RegExp(NAMED_DEFAULT.source, 'i').test(row)) return { id: quoted, place: `${file}:${at}` };
    for (const name of new Set(row.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])) {
      const held = constantValue(text, name);
      if (held && held.line !== at && context.modelIds.includes(held.value) && !new RegExp(NAMED_DEFAULT.source, 'i').test(lines[held.line - 1])) return { id: held.value, place: `${file}:${held.line}` };
    }
  }
  return null;
}

function modelFor(file: string, line: number, context: ValueContext): { price: PriceRow | null; label: string; basis: Basis; why?: string } {
  const text = context.files.get(file) ?? '';
  const called = modelAtCall(text, line, context.files);
  if (called && context.priceOf(called)) return { price: context.priceOf(called), label: `read at ${file}`, basis: 'read' };
  const near = modelNamedNear(file, text, line, context);
  if (near && context.priceOf(near.id)) return { price: context.priceOf(near.id), label: `read at ${near.place}`, basis: 'read' };
  // The code names the model it sends, and there's no price for it: say which, and keep the sum an example that never ranks.
  const unpriced = called ? { id: called, place: file } : near;
  if (unpriced) {
    const example = context.exampleModel ? context.priceOf(context.exampleModel) : null;
    const label = `example: this call sends ${unpriced.id} (read at ${unpriced.place}), which has no price on file`;
    const why = `This call sends ${unpriced.id}, read at ${unpriced.place}, and there's no price on file for it, so the sum below is on a named model, as an example.`;
    return example ? { price: example, label, basis: 'example', why } : { price: null, label, basis: 'none' };
  }
  const fromDefault = (named: { id: string; place: string }) => ({ price: context.priceOf(named.id), label: `assumed: this call's model is set at runtime; the default named at ${named.place}`, basis: 'default' as const });
  const ownDefault = namedDefault(defaultsIn(file, text, context));
  if (ownDefault) return fromDefault(ownDefault);
  const here = context.modelIds.find((id) => text.includes(id) && context.priceOf(id));
  if (here) return { price: context.priceOf(here), label: `read at ${file}`, basis: 'read' };
  const repoDefault = namedDefault([...context.files].filter(([path]) => !TEST_FILE.test(path)).flatMap(([path, body]) => defaultsIn(path, body, context)));
  if (repoDefault) return fromDefault(repoDefault);
  if (context.fallbackModel) return { price: context.priceOf(context.fallbackModel), label: `assumed: this call's model is set at runtime`, basis: 'default' };
  const example = context.exampleModel ? context.priceOf(context.exampleModel) : null;
  return example ? { price: example, label: "example: this call's model is set at runtime", basis: 'example' } : { price: null, label: '', basis: 'none' };
}

function leverGainType(lever: Lever | undefined): GainType | null {
  if (!lever) return null;
  const formula = lever.gain_model?.formula ?? '';
  if (/hit_rate/.test(formula)) return 'cache';
  if (/decision_cost/.test(formula)) return 'substitute';
  if (/batch/i.test(formula)) return 'batch';
  return GAIN_BY_PATTERN[lever.pattern] ?? null;
}

export const DEFAULT_CACHE_MINIMUM = 1024;

export function cacheMinimumOf(lever: Pick<Lever, 'trade_offs'> | null | undefined): number | undefined {
  const line = (lever?.trade_offs ?? []).find((item) => /under the minimum/i.test(item));
  const match = line?.match(/([\d,]+) tokens/);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

function frontierOf(lever: Lever | undefined): number | undefined {
  const match = lever?.price?.match(/\$([\d.]+) per 1M (?:uncached )?input/i);
  return match ? Number(match[1]) : undefined;
}

const inMillions = (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;

function optionPrice(lever: Lever, kind: GainType, cacheMinimum: number | undefined): Pick<RoiOption, 'price_text' | 'input_per_m' | 'cache_minimum'> | null {
  if (kind === 'batch') return { price_text: `the batch price, ${BATCH_DISCOUNT * 100}% of standard` };
  if (kind === 'cache') return { price_text: `${CACHE_HIT_RATE * 100}% cache hits (assumed), reads at ${CACHE_READ}x and writes at ${CACHE_WRITE}x input`, ...(cacheMinimum ? { cache_minimum: cacheMinimum } : {}) };
  const input = frontierOf(lever);
  if (input === undefined) return null;
  return { price_text: `${inMillions(input)} per 1M input, output free`, input_per_m: input };
}

/** The levers this finding offers side by side, the lead one if it names no other, for those with a sum to do. */
function moneyLevers(finding: Finding, lead: Lever | undefined, levers: readonly Lever[]): { lever: Lever; name: string; kind: GainType }[] {
  const named = finding.options.flatMap((option) => {
    const lever = levers.find((item) => item.source === option.source || item.name === option.name);
    return lever ? [{ lever, name: option.name }] : [];
  });
  const chosen = named.length ? named : lead ? [{ lever: lead, name: lead.name }] : [];
  const unique = chosen.filter((item, index) => chosen.findIndex((other) => other.lever.id === item.lever.id) === index);
  return unique.flatMap(({ lever, name }) => {
    const kind = leverGainType(lever);
    return kind ? [{ lever, name, kind }] : [];
  });
}

const CHANGES_NOTHING_ON_THE_BILL = 'it changes what the product does, not what a call costs';
const NO_FORMULA = 'keepup has no cost formula for this lever';

function noMoneyRoi(finding: Finding, base: Pick<LeverRoi, 'tokens' | 'calls_per_month' | 'change_usd' | 'change_label' | 'effort'>): LeverRoi {
  const effects = finding.effect.join(', ');
  const words = effects.charAt(0).toUpperCase() + effects.slice(1);
  const why = finding.effect.includes('cheaper') ? NO_FORMULA : CHANGES_NOTHING_ON_THE_BILL;
  return { ...base, money: false, options: [], statement: `${words} · ${effortWords(finding.effort)} · no money figure: ${why}` };
}

interface RoiParts {
  readonly tokens: LeverRoi['tokens'];
  readonly model: { price: PriceRow | null; label: string; basis: Basis };
  readonly hours: number;
  readonly cacheMinimum: number | undefined;
}

function assumedLine(roi: Pick<LeverRoi, 'tokens' | 'change_label' | 'model'>): string {
  const model = roi.model ? [`today's model ${roi.model.id} at $${roi.model.input} in and $${roi.model.output} out per 1M (${roi.model.source}${roi.model.date ? `, ${roi.model.date}` : ''}), ${roi.model.label}`] : [];
  return `Assumed: ${ASSUMED_CALLS_PER_MONTH.toLocaleString('en-US')} calls a month; ${roi.tokens.input.toLocaleString('en-US')} input tokens (${roi.tokens.input_label}); ${roi.tokens.output} output tokens (${roi.tokens.output_label}); ${[...model, roi.change_label, `not worth it means no payback in ${PAYBACK_MONTHS} months`].join('; ')}.`;
}

function buildRoi(finding: Finding, lead: Lever | undefined, context: ValueContext, parts: RoiParts): LeverRoi {
  const changeUsd = parts.hours * ASSUMED_HOURLY_USD;
  const base = { effort: finding.effort, tokens: parts.tokens, calls_per_month: ASSUMED_CALLS_PER_MONTH, change_usd: changeUsd, change_label: `${parts.hours} h at $${ASSUMED_HOURLY_USD} an hour = $${changeUsd.toLocaleString('en-US')} to change` };
  const levers = moneyLevers(finding, lead, context.levers);
  const priced = levers.flatMap(({ lever, name, kind }) => {
    const price = optionPrice(lever, kind, kind === 'cache' ? parts.cacheMinimum : undefined);
    return price ? [{ lever, name, kind, price }] : [];
  });
  if (priced.length === 0) return noMoneyRoi(finding, base);
  const row = parts.model.price;
  const tag = parts.model.basis === 'example' ? 'projected, example' : 'projected';
  const options: RoiOption[] = priced.map(({ lever, name, kind, price }) => {
    const common = { name, lever: lever.id, kind, ...price, source: lever.source, ...(lever.checked ? { checked: lever.checked } : {}) };
    if (!row) return common;
    const today = costToday(parts.tokens.input, parts.tokens.output, row);
    const after = costAfter({ kind, input_per_m: price.input_per_m, cache_minimum: price.cache_minimum }, parts.tokens.input, parts.tokens.output, row);
    const sum = roiSum(today, after, ASSUMED_CALLS_PER_MONTH, changeUsd);
    return { ...common, today_per_call_usd: today, after_per_call_usd: after, monthly_usd: sum.monthly, payback_months: sum.payback_months, worth_above_calls: sum.worth_above_calls, line: roiLine(sum, ASSUMED_CALLS_PER_MONTH, finding.effort, tag) };
  });
  const model = row ? { id: row.model, input: row.input, output: row.output, source: row.source, ...(row.date ? { date: row.date } : {}), label: parts.model.label } : undefined;
  const enter = parts.model.basis === 'read' ? {} : { what_to_enter: `To get your own figure, enter the model this call really uses and your calls a month${row ? `; ${row.model} here is ${parts.model.basis === 'example' ? 'only an example' : "the code's default"}` : ''}.` };
  const withModel = { ...base, ...(model ? { model } : {}) };
  return { ...withModel, money: true, formula: ROI_FORMULA, basis: parts.model.basis, options, assumed: assumedLine(withModel), ...enter };
}

/** A vendor's number on an option says it's the vendor's, in the same line, whatever words the judge chose. */
function labelledOptions(finding: Finding, levers: readonly Lever[]): Finding['options'] {
  return finding.options.map((option) => {
    const lever = levers.find((item) => item.source === option.source || item.name === option.name);
    return lever?.proof === 'vendor claim' && /\d/.test(option.what) && !/This is a vendor claim/.test(option.what) ? { ...option, what: `${option.what.trimEnd()} This is a vendor claim.` } : option;
  });
}

/** Findings go in, the same findings with a value come out. A retired model is not a lever, and has none. */
export function withValues<T extends Finding>(findings: readonly T[], context: ValueContext): T[] {
  return findings.map((finding) => {
    if (finding.reach) return finding;
    const lever = context.levers.find((item) => item.id === finding.lever);
    const gainType = leverGainType(lever);
    const place = finding.where[0];
    const prompts = finding.where.flatMap((where) => {
      const text = context.files.get(where.file) ?? '';
      const found = literalPromptNear(text, where.line, context.files) ?? namedPromptNear(text, where.line, context.files);
      return found ? [{ ...found, file: found.file ?? where.file }] : [];
    });
    const prompt = [...prompts].sort((a, b) => b.chars - a.chars)[0];
    const model = place ? modelFor(place.file, place.line, context) : { price: null, label: '', basis: 'none' as const };
    const speed = speedClaim([lever?.gain_vendor ?? '', lever?.gain ?? '', ...finding.options.map((option) => option.what)]);
    const hours = hoursOf(finding.effort);
    const tokensLabel = prompt ? `estimate: ${prompt.chars.toLocaleString('en-US')} characters of literal prompt at ${prompt.file}:${prompt.line}, at 4 characters a token${prompt.placeholders.length ? `, with ${prompt.placeholders.join(', ')} filled at runtime and not counted` : ''}${prompt.runtime ? ', literal part only' : ''}; nothing else the call sends is counted` : '';
    const outputTokens = gainType === 'substitute' ? ASSUMED_LABEL_OUTPUT_TOKENS : ASSUMED_OUTPUT_TOKENS;
    const value = computeValue({
      gainType, inputTokens: prompt ? estimateTokens(prompt.text) : null,
      outputTokens,
      price: model.price, modelLabel: model.label, exampleOnly: model.basis === 'example', ...(model.why ? { exampleWhy: model.why } : {}), frontierInput: frontierOf(lever), hours, leverId: lever?.id ?? finding.lever ?? '',
      tokensLabel,
      cacheMinimum: cacheMinimumOf(lever) ?? undefined,
    });
    const words = lever?.gain_vendor ?? lever?.gain;
    // With no money number, the lever's own recorded rate is what's left to say, in its own words.
    const why = value.status === 'no_number' && words && !finding.why.includes(words) ? `${finding.why} ${words}` : finding.why;
    const tokens = { input: prompt ? estimateTokens(prompt.text) : ASSUMED_INPUT_TOKENS, input_label: tokensLabel || 'assumed: the prompt is built at runtime, so change this to yours', output: outputTokens, output_label: 'assumed' };
    const roi = buildRoi(finding, lever, context, { tokens, model, hours, cacheMinimum: cacheMinimumOf(lever) ?? undefined });
    const worked = value.status === 'no_number' && roi.money && roi.options.some((option) => option.line);
    return { ...finding, why, options: labelledOptions(finding, context.levers), ...(lever?.tier ? { tier: lever.tier } : {}), value: { ...value, roi, ...(worked ? { status: 'worked' as const, label: 'projected' as const } : {}), ...(recipesFor(lever ?? null).length ? { measurable: true } : {}), ...(speed ? { speed } : {}), ...(words ? { lever_gain: words } : {}) } };
  });
}
