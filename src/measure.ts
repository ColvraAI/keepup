// keepup measure's core: a real before-and-after on the literal prompt at a call site, on the person's own key. It says what
// goes to the provider before sending anything, runs the lever's recipe, keeps the raw results, and holds a hard dollar cap.
// A missing key is "not measured · needs X", with no number. Nothing from the repo is ever run.
import { randomBytes } from 'node:crypto';
import { estimateTokens, promptAtCall } from './call-prompt.ts';
import { cacheMinimumOf, DEFAULT_CACHE_MINIMUM } from './lever-value.ts';
import { recipesFor, type Lever, type Recipe } from './levers.ts';
import { maskText } from './mask.ts';
import type { Finding, Measurement, MeasurementRow } from './run-shape.ts';

export const MEASURE_MAX_USD = 0.25;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MILLION = 1_000_000;
const CHARS_PER_TOKEN = 3;
const CACHED_REPEATS = 3;
const TIER_RUNS = 3;
const PARSE_RUNS = 5;
const DECISION_RUNS = 5;
const MAX_OUTPUT = 1000;
/** Bumped when what a headline needs gets stricter, so an older row never reaches a title. */
export const MEASURE_RULES = 2;
/** Parse failures say nothing with fewer replies than this left once capped ones are set aside. */
const MIN_PARSE_REPLIES = 3;
const NOT_A_GAIN = 'Nothing to measure: this finding is a move off something going away, not a gain, so there is no before and after.';
const FENCE_STEP = /```|clean_?json|strip_?fence|removeprefix/i;
const FENCE = /^\s*```(?:json)?\s*|\s*```\s*$/g;
const PROBE = 'Give your normal answer to one short, typical input for these instructions. Invent the input yourself, first.';
const CACHE_PROBE = 'Reply with OK.';
const ANSWER_SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };

export interface MeasurePrice { readonly model: string; readonly input: number; readonly output: number; readonly cache_read: number; readonly cache_write: number; readonly source: string }
export { recipesFor, type Recipe };

export interface MeasureInput {
  readonly repo: string;
  readonly commit: string;
  readonly finding: Finding;
  readonly lever: Lever | null;
  /** Masked before anything else looks at it. */
  readonly text: string;
  readonly file?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly priceOf: (model: string) => MeasurePrice | null;
  /** current is this call's own model when it can be called here. own is what the code names, when it can't. */
  readonly models: { readonly current: string | null; readonly own?: string | null; readonly cheaper: string | null };
  /** The repo's other files, so a prompt defined elsewhere can be followed. */
  readonly others?: ReadonlyMap<string, string>;
  readonly fetchImpl?: typeof fetch;
  readonly onStep?: (name: string, detail: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: Date;
}

/** Thinking off for a test call, each model in its own way: a thought spends the output cap and returns no text. Where it can't be off, least effort. */
function thinkingOff(model: string): Record<string, unknown> {
  if (/^claude-sonnet-5-5/.test(model)) return { thinking: { type: 'between_tools' } };
  if (/^claude-(?:opus-5-5|fable|mythos)/.test(model)) return { output_config: { effort: 'low' } };
  if (/^claude-(?:haiku-5-5|opus-5|opus-4-[78]|sonnet-5)\b/.test(model)) return { thinking: { type: 'disabled' } };
  return {};
}

function requestBody(model: string, body: Record<string, unknown>): Record<string, unknown> {
  const off = thinkingOff(model);
  const config = { ...(off.output_config as object | undefined), ...(body.output_config as object | undefined) };
  return { model, max_tokens: MAX_OUTPUT, ...off, ...body, ...(Object.keys(config).length ? { output_config: config } : {}) };
}

interface Reply { readonly text: string; readonly stop: string; readonly usage: Record<string, number>; readonly ms: number; readonly usd: number }
class OverCap extends Error {}

interface Ledger { spent: number }
interface Ctx { readonly input: MeasureInput; readonly key: string; readonly ledger: Ledger; readonly system: string; readonly masked: string }

function costOf(usage: Record<string, number>, price: MeasurePrice): number {
  return ((usage.input_tokens ?? 0) * price.input + (usage.output_tokens ?? 0) * price.output + (usage.cache_creation_input_tokens ?? 0) * price.cache_write + (usage.cache_read_input_tokens ?? 0) * price.cache_read) / MILLION;
}

async function askClaude(ctx: Ctx, model: string, body: Record<string, unknown>): Promise<Reply> {
  const price = ctx.input.priceOf(model);
  if (!price) throw new Error(`No price on file for ${model}.`);
  const worst = (((ctx.system.length + PROBE.length) / CHARS_PER_TOKEN) * Math.max(price.input, price.cache_write) + MAX_OUTPUT * price.output) / MILLION;
  if (ctx.ledger.spent + worst > MEASURE_MAX_USD) throw new OverCap(`Stopped at the $${MEASURE_MAX_USD} cap with $${ctx.ledger.spent.toFixed(4)} spent.`);
  const started = performance.now();
  const response = await (ctx.input.fetchImpl ?? fetch)(ANTHROPIC_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ctx.key, 'anthropic-version': API_VERSION }, body: JSON.stringify(requestBody(model, body)), signal: AbortSignal.timeout(60_000) });
  const ms = Math.round(performance.now() - started);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`The Anthropic API answered ${response.status}: ${maskText(detail.error?.message ?? '')}`);
  }
  const reply = await response.json() as { content?: { type: string; text?: string }[]; stop_reason?: string; usage?: Record<string, number> };
  const usage = reply.usage ?? {};
  const usd = costOf(usage, price);
  ctx.ledger.spent += usd;
  return { text: (reply.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''), stop: reply.stop_reason ?? '', usage, ms, usd };
}

const message = (text: string) => [{ role: 'user', content: text }];
const percent = (value: number) => Math.round(value * 100);
const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const NOT_YOUR_TRAFFIC = 'One prompt on a fixed test input, not your traffic: it can\'t show your real hit rate, and it doesn\'t compare answers.';

const hitCap = (reply: Reply) => reply.stop === 'max_tokens';
const isEmpty = (reply: Reply) => !reply.text.trim() || reply.stop === 'refusal';

function notOwnModel(input: MeasureInput): string {
  const { own } = input.models;
  return own ? `This call sends ${own}, and keepup can only run this test on a Claude model with a price on file.` : 'This call\'s model is set at runtime, so there is no model of this repo\'s to test.';
}

async function cachingRow(ctx: Ctx): Promise<MeasurementRow> {
  const model = ctx.input.models.current as string;
  const raw: Reply[] = [];
  raw.push(await askClaude(ctx, model, { system: ctx.system, messages: message(CACHE_PROBE) }));
  const cached = [{ type: 'text', text: ctx.system, cache_control: { type: 'ephemeral' } }];
  for (let index = 0; index < CACHED_REPEATS; index += 1) raw.push(await askClaude(ctx, model, { system: cached, messages: message(CACHE_PROBE) }));
  const price = ctx.input.priceOf(model) as MeasurePrice;
  const inputCost = (usage: Record<string, number>) => costOf({ ...usage, output_tokens: 0 }, price);
  const before = inputCost(raw[0].usage);
  const repeats = raw.slice(2);
  const after = repeats.reduce((sum, reply) => sum + inputCost(reply.usage), 0) / repeats.length;
  const reads = repeats.reduce((sum, reply) => sum + (reply.usage.cache_read_input_tokens ?? 0), 0);
  const rawRows = raw.map(({ usage, ms, usd }) => ({ usage, ms, usd }));
  if (reads === 0) return { recipe: 'prompt caching', status: 'not measured', reason: `Not measurable from code: cache_read_input_tokens stayed 0 across ${repeats.length} repeats on ${model}, so this readable text doesn't reach the provider's cache minimum. It says nothing about a longer prefix set at runtime.`, raw: rawRows };
  return { recipe: 'prompt caching', status: 'measured', rules: MEASURE_RULES, n: raw.length, headline: `-${percent(1 - after / before)}% input cost`, summary: `On ${model}: $${before.toFixed(6)} input without caching, $${after.toFixed(6)} on each repeat, ${reads} tokens read from cache over ${repeats.length} repeats. n=${raw.length}.`, cannot_prove: NOT_YOUR_TRAFFIC, raw: rawRows };
}

/** Why this comparison can't carry a number, if it can't: a headline with an empty or cut-off reply behind it is only a price list. */
function tierBlocked(replies: readonly Reply[], verdict: string): string | null {
  if (replies.some(isEmpty)) return 'A reply came back empty, so there is no headline.';
  if (replies.some(hitCap)) return 'A reply hit the token cap, so there is no headline.';
  return /^yes\b/i.test(verdict.trim()) ? null : 'The check didn\'t say the two sets do the same job, so there is no headline.';
}

async function tierRow(ctx: Ctx): Promise<MeasurementRow> {
  const { cheaper } = ctx.input.models;
  const current = ctx.input.models.current as string;
  if (!cheaper) return { recipe: 'cheaper tier', status: 'not measured', reason: 'No cheaper Claude model has a price on file.' };
  const run = async (model: string) => {
    const replies: Reply[] = [];
    for (let index = 0; index < TIER_RUNS; index += 1) replies.push(await askClaude(ctx, model, { system: ctx.system, messages: message(PROBE) }));
    return replies;
  };
  const [today, tier] = [await run(current), await run(cheaper)];
  const avg = (rows: readonly Reply[]) => rows.reduce((sum, reply) => sum + reply.usd, 0) / rows.length;
  const judged = await askClaude(ctx, current, { system: 'Compare two sets of answers to the same instructions. Start with Yes or No, then say in one sentence whether the second set does the same job as the first. You see only these answers, so never claim more.', messages: message(`First:\n${today.map((reply) => reply.text).join('\n---\n')}\n\nSecond:\n${tier.map((reply) => reply.text).join('\n---\n')}`) });
  const cut = percent(1 - avg(tier) / avg(today));
  const blocked = tierBlocked([...today, ...tier], judged.text);
  return {
    recipe: 'cheaper tier', status: 'measured', rules: MEASURE_RULES, n: today.length + tier.length, ...(blocked ? {} : { headline: `${cut >= 0 ? '-' : '+'}${Math.abs(cut)}% cost on ${cheaper}` }),
    summary: `${current}: $${avg(today).toFixed(5)} a call, p50 ${median(today.map((reply) => reply.ms))} ms. ${cheaper}: $${avg(tier).toFixed(5)} a call, p50 ${median(tier.map((reply) => reply.ms))} ms. n=${today.length} each. Judged by ${current}: ${maskText(judged.text).slice(0, 300)}${blocked ? ` ${blocked}` : ''}`,
    cannot_prove: 'The input was invented by the model and there are only a few runs, so this can\'t prove quality on real work. It needs a test set for that.',
    raw: [...today, ...tier].map(({ usage, ms, usd, text, stop }) => ({ usage, ms, usd, stop, text: maskText(text).slice(0, 400) })),
  };
}

function parses(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** A repo's own cleanup, when it has one, so a fence it would strip isn't counted against it. */
function cleaned(text: string, stripsFences: boolean): string {
  return stripsFences ? text.replace(FENCE, '') : text;
}

async function structuredRow(ctx: Ctx): Promise<MeasurementRow> {
  const model = ctx.input.models.current as string;
  const instruct = `${ctx.system}\n\nAnswer as JSON.`;
  const stripsFences = FENCE_STEP.test(ctx.masked);
  const old: Reply[] = [];
  const strict: Reply[] = [];
  for (let index = 0; index < PARSE_RUNS; index += 1) old.push(await askClaude(ctx, model, { system: instruct, messages: message(PROBE) }));
  for (let index = 0; index < PARSE_RUNS; index += 1) strict.push(await askClaude(ctx, model, { system: instruct, messages: message(PROBE), output_config: { format: { type: 'json_schema', schema: ANSWER_SCHEMA } } }));
  const whole = (rows: readonly Reply[]) => rows.filter((reply) => !hitCap(reply));
  const failed = (rows: readonly Reply[], clean: boolean) => rows.filter((reply) => !parses(clean ? cleaned(reply.text, stripsFences) : reply.text)).length;
  const [oldWhole, strictWhole] = [whole(old), whole(strict)];
  const [before, after] = [failed(oldWhole, true), failed(strictWhole, false)];
  const capped = old.length + strict.length - oldWhole.length - strictWhole.length;
  const parser = stripsFences ? 'after the same kind of fence stripping your code does' : 'raw JSON.parse only';
  const enough = oldWhole.length >= MIN_PARSE_REPLIES && strictWhole.length >= MIN_PARSE_REPLIES;
  return {
    recipe: 'structured outputs', status: 'measured', rules: MEASURE_RULES, n: old.length + strict.length, ...(enough ? { headline: `${before} of ${oldWhole.length} parse failures to ${after} of ${strictWhole.length}, ${parser}` } : {}),
    summary: `Old parse, ${parser}: ${before} of ${oldWhole.length} replies failed. Strict schema: ${after} of ${strictWhole.length} failed. On ${model}.${capped ? ` ${capped} replies hit the token cap and aren't counted.` : ''}`,
    cannot_prove: `A one-field stand-in schema on a made-up input: it shows the parse step, not that your fields stay right. ${stripsFences ? 'It copies the kind of cleanup your code does, not your exact code.' : 'Your own parser was not run.'}`,
    raw: [...old, ...strict].map(({ usage, ms, usd, text, stop }) => ({ usage, ms, usd, stop, parsed: parses(text), text: maskText(text).slice(0, 400) })),
  };
}

/** Labels fixed in the text beside the call, such as enum: ["a", "b"]. Labels built at runtime can't be sent, and that's said. */
export function literalLabels(text: string): string[] {
  const list = text.match(/enum\s*[:=]\s*\[([^\]$.]+)\]/)?.[1] ?? text.match(/one of[:\s]+((?:["'`]?[\w-]+["'`]?,\s*)+(?:or\s+)?["'`]?[\w-]+)/i)?.[1];
  return list ? [...new Set(list.split(/,|\bor\b/).map((item) => item.replace(/["'`\s]/g, '')).filter(Boolean))] : [];
}

async function decisionRows(input: MeasureInput, prompt: string, masked: string): Promise<MeasurementRow[]> {
  const labels = literalLabels(masked);
  const keys: readonly (readonly [string, string])[] = [['OPENAI_API_KEY', 'OpenAI Decisions API'], ['TYPESAFE_API_KEY', 'TypeSafe Jev']];
  return Promise.all(keys.map(async ([key, name]): Promise<MeasurementRow> => {
    const recipe = `decision model: ${name}`;
    const secret = input.env[key];
    if (!secret) return { recipe, status: 'not measured', needs: key };
    if (labels.length < 2) return { recipe, status: 'not measured', reason: `The labels at this place are built at runtime, so there is nothing fixed to send to ${name}.` };
    const started: number[] = [];
    const url = key === 'OPENAI_API_KEY' ? 'https://api.openai.com/v1/decisions' : 'https://api.typesafe.ai/v1/systemone';
    const body = key === 'OPENAI_API_KEY'
      ? { model: 'gpt-6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], questions: [{ type: 'choice', name: 'label', instructions: 'Pick one.', choices: labels.map((value) => ({ value })) }] }
      : { model: 'jev-1.14', state: prompt, questions: { label: { type: 'choice', instructions: 'Pick one.', criteria: Object.fromEntries(labels.map((value) => [value, value])) } } };
    const statuses: number[] = [];
    for (let index = 0; index < DECISION_RUNS; index += 1) {
      const at = performance.now();
      const response = await (input.fetchImpl ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      statuses.push(response.status);
      started.push(Math.round(performance.now() - at));
    }
    const ok = statuses.filter((status) => status === 200).length;
    if (ok === 0) return { recipe, status: 'not measured', reason: `${name} answered ${statuses[0]} on every call.`, raw: statuses };
    return { recipe, status: 'measured', n: DECISION_RUNS, summary: `${ok} of ${DECISION_RUNS} calls answered, p50 ${median(started)} ms, on the labels at this place.`, cannot_prove: 'Latency only: no labelled set here, so agreement with your current call isn\'t measured.', raw: started };
  }));
}

function keyFor(recipe: Recipe): string {
  return recipe === 'decision model' ? 'OPENAI_API_KEY or TYPESAFE_API_KEY' : 'ANTHROPIC_API_KEY';
}

async function rowsFor(recipe: Recipe, ctx: Ctx | null, input: MeasureInput, prompt: string, masked: string): Promise<MeasurementRow[]> {
  if (recipe === 'decision model') return decisionRows(input, prompt, masked);
  if (!ctx) return [{ recipe, status: 'not measured', needs: keyFor(recipe) }];
  if (!input.models.current) return [{ recipe, status: 'not measured', reason: notOwnModel(input) }];
  try {
    if (recipe === 'prompt caching') return [await cachingRow(ctx)];
    if (recipe === 'structured outputs') return [await structuredRow(ctx)];
    return [await tierRow(ctx)];
  } catch (error) {
    if (error instanceof OverCap) return [{ recipe, status: 'not measured', reason: error.message }];
    return [{ recipe, status: 'not measured', reason: maskText((error as Error).message) }];
  }
}

/** Why nothing goes out at all, said before anything is sent. */
function refusalFor(input: MeasureInput, recipes: readonly Recipe[], place: Finding['where'][number] | undefined, found: ReturnType<typeof promptAtCall>): string | null {
  if (input.finding.reach || recipes.length === 0) return NOT_A_GAIN;
  const where = `${input.file ?? place?.file}:${place?.line}`;
  if (!found.prompt || found.prompt.runtime) return `The prompt at ${where} is not measurable from code: ${found.reason}. keepup sends nothing. Measure it from a logged request instead.`;
  if (recipes.includes('prompt caching')) {
    const tokens = estimateTokens(found.prompt.text);
    const minimum = cacheMinimumOf(input.lever) ?? DEFAULT_CACHE_MINIMUM;
    if (tokens < minimum) return `The prompt at ${where} is not measurable from code: only ${tokens} tokens are readable, under the ${minimum}-token cache minimum. Any longer prefix is set at runtime, and keepup sends nothing.`;
  }
  return null;
}

export async function measureFinding(input: MeasureInput): Promise<Measurement> {
  const step = input.onStep ?? (() => undefined);
  const masked = maskText(input.text);
  const place = input.finding.where[0];
  const found = promptAtCall(masked, place?.line ?? 1, input.others);
  const at = (input.now ?? new Date()).toISOString();
  const id = `measure-${input.commit.slice(0, 7)}-${input.finding.rank ?? 0}-${randomBytes(3).toString('hex')}`;
  const shell = { version: 1 as const, id, finding_rank: input.finding.rank ?? 0, lever: input.lever?.id ?? input.finding.lever, commit: input.commit, at, usd: 0, cap_usd: MEASURE_MAX_USD };
  const recipes = recipesFor(input.lever);
  const refused = refusalFor(input, recipes, place, found);
  if (refused || !found.prompt) {
    const said = refused ?? NOT_A_GAIN;
    step('Refused', said);
    return { ...shell, prompt: null, disclosure: 'Nothing was sent.', rows: [], refused: said };
  }
  const prompt = found.prompt;
  const file = prompt.file ?? input.file ?? place?.file ?? '';
  const key = input.env.ANTHROPIC_API_KEY;
  const providers = [...new Set(recipes.flatMap((recipe) => (recipe === 'decision model' ? [...(input.env.OPENAI_API_KEY ? ['OpenAI'] : []), ...(input.env.TYPESAFE_API_KEY ? ['TypeSafe'] : [])] : key ? ['Anthropic'] : [])))];
  const disclosure = `This sends ${prompt.chars.toLocaleString('en-US')} characters, the prompt this call passes, as written at ${file}:${prompt.line}, masked${prompt.placeholders.length ? `, with ${prompt.placeholders.join(', ')} left as written` : ''}, to ${providers.join(' and ') || 'no provider, because no key is set'} on your own key. Nothing else from the repo goes. Hard cap $${MEASURE_MAX_USD}.`;
  step('What goes to the provider', disclosure);
  const ledger: Ledger = { spent: 0 };
  const ctx: Ctx | null = key ? { input, key, ledger, system: prompt.text, masked } : null;
  const rows: MeasurementRow[] = [];
  for (const recipe of recipes) {
    step('Running', recipe);
    rows.push(...await rowsFor(recipe, ctx, input, prompt.text, masked));
  }
  return { ...shell, prompt: { file, line: prompt.line, chars: prompt.chars, placeholders: prompt.placeholders }, disclosure, rows, usd: ledger.spent };
}

/** What a change or pull request title may carry: a number measured under today's rules, for the recipe this change is. */
export function measuredTitleNumber(measurements: readonly Measurement[] | undefined, rank: number, recipes: readonly string[]): string | null {
  const row = (measurements ?? []).filter((item) => item.finding_rank === rank).flatMap((item) => item.rows).filter((item) => item.status === 'measured' && item.headline && (item.rules ?? 0) >= MEASURE_RULES && recipes.some((recipe) => item.recipe === recipe || item.recipe.startsWith(`${recipe}:`))).at(-1);
  return row ? `measured ${row.headline}, n=${row.n}` : null;
}

export function formatMeasurement(result: Measurement): string {
  const rows = result.rows.flatMap((row) => {
    if (row.status !== 'measured') return [`${row.recipe}: not measured · ${row.needs ? `needs ${row.needs}` : row.reason}`];
    return [`${row.recipe}: ${row.headline ? `${row.headline} ` : ''}[measured, n=${row.n}]`, `  ${row.summary}`, `  What this can't prove: ${row.cannot_prove}`];
  });
  return [`keepup measure · finding ${result.finding_rank} · ${result.commit.slice(0, 7)}`, ...(result.refused ? [`Refused: ${result.refused}`] : [result.disclosure, ...rows]), `Spent $${result.usd.toFixed(4)} of the $${result.cap_usd} cap.`].join('\n');
}
