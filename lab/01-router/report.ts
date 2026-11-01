// Turns the harness's raw output into the numbers and table of result.md. Every number
// here comes from a recorded response. Nothing in this file calls a provider.
import { costUsd } from '../shared/prices.ts';
import type { LabResult } from '../shared/result.ts';
import { accuracy, percentile } from '../shared/stats.ts';
import type { Rates } from './rates.ts';

export const LAB_NAME = '01-router';
const ACCURACY_DROP_LIMIT_POINTS = 2;
const CACHE_MIN_TOKENS_LABEL = '1,024';

export type VariantName = 'decisions' | 'jev';

export interface Variant {
  lab: string;
  resultFile: string;
  prFile: string;
  keys: string[];
  afterSetting: string;
  agentProvider: 'openai' | 'anthropic';
  treeName: string;
  afterLabel: string;
  notRun: string;
}

export const VARIANTS: Record<VariantName, Variant> = {
  decisions: {
    lab: LAB_NAME,
    resultFile: 'result.md',
    prFile: 'pr.json',
    keys: ['OPENAI_API_KEY'],
    afterSetting: 'decisions',
    agentProvider: 'openai',
    treeName: 'lab-wt-01',
    afterLabel: 'Decisions API on gpt-6-luna, agent as fallback',
    notRun: "Running this will measure accuracy, median and tail latency, and cost per thousand messages for the router's agent path and its Decisions path on the messages in testset.jsonl, and it needs OPENAI_API_KEY.",
  },
  jev: {
    lab: `${LAB_NAME}-jev`,
    resultFile: 'result-jev.md',
    prFile: 'pr-jev.json',
    keys: ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY'],
    afterSetting: 'jev',
    agentProvider: 'anthropic',
    treeName: 'lab-wt-01-jev',
    afterLabel: 'TypeSafe Jev, agent as fallback',
    notRun: "Running this will measure accuracy, median and tail latency, and cost per thousand messages for the router's agent path on Claude and its Jev path on the messages in testset.jsonl, and it needs ANTHROPIC_API_KEY and TYPESAFE_API_KEY.",
  },
};

export interface Rule {
  title: string;
  description: string;
}

export interface Message {
  id: string;
  text: string;
  expected: string;
}

export function parseTestset(text: string): { rules: Rule[]; messages: Message[] } {
  const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  for (const line of lines) {
    if (line.type !== 'rule' && line.type !== 'message') throw new Error(`testset line has an unknown type: ${line.type}`);
    if (line.type === 'rule' && (!line.title || !line.description)) throw new Error(`rule ${line.title} needs a title and a description`);
    if (line.type === 'message' && (!line.id || !line.text || !line.expected)) throw new Error(`message ${line.id} needs an id, text and an expected label`);
  }
  return {
    rules: lines.filter((line) => line.type === 'rule').map(({ title, description }) => ({ title, description })),
    messages: lines.filter((line) => line.type === 'message').map(({ id, text: body, expected }) => ({ id, text: body, expected })),
  };
}

/** The same rules with longer descriptions, one JSON object a line: enough for the cached form of the request. */
export function parseLongRules(text: string): Rule[] {
  const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  for (const line of lines) {
    if (!line.title) throw new Error('a long rule needs a title');
    if (!line.description) throw new Error(`long rule ${line.title} needs a description`);
  }
  return lines.map(({ title, description }) => ({ title, description }));
}

export interface Usage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

export interface RawCall {
  method: string;
  path: string;
  status: number;
  ms: number;
  request: unknown;
  response: string;
  usage: Usage | null;
}

export interface RawRecord {
  type: 'record';
  id: string;
  path: 'before' | 'after';
  expected: string;
  predicted: string | null;
  thrown: string | null;
  ms: number;
  calls: RawCall[];
  logs: string[];
}

export interface RawMeta {
  type: 'meta';
  real: boolean;
  variant: string;
  agentProvider: string;
  agentModel: string;
  tried: { model: string; status: number }[];
}

export interface RawLongForm {
  type: 'long_form_check';
  records: RawRecord[];
}

export interface Raw {
  meta: RawMeta;
  records: RawRecord[];
  longForm: RawLongForm | null;
}

export function parseRaw(text: string): Raw {
  const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const meta = lines.find((line) => line.type === 'meta');
  if (!meta) throw new Error('the raw output has no meta line, so the harness did not start properly');
  return {
    meta,
    records: lines.filter((line) => line.type === 'record'),
    longForm: lines.find((line) => line.type === 'long_form_check') ?? null,
  };
}

export interface RatesByRoute {
  decisions?: Rates;
  agent: Rates;
  jev?: Rates;
  /** The model onboarding preselects, when the agent ran on a substitute for it. */
  onboarding?: Rates;
}

function ratesOfCall(call: RawCall, rates: RatesByRoute): Rates {
  const chosen = call.path.startsWith('/v1/decisions') ? rates.decisions : call.path.startsWith('/v1/systemone') ? rates.jev : rates.agent;
  if (!chosen) throw new Error(`no price for a call to ${call.path}`);
  return chosen;
}

/**
 * Cached and cache-write tokens are inside `input`, so they're taken out before pricing the rest.
 * A call with no usage costs nothing here because it wasn't billed: it was rejected, or it's a
 * lookup. An answered call with no usage fails its record instead, so no table prices it.
 */
function callCost(call: RawCall, rates: RatesByRoute): number {
  if (!call.usage) return 0;
  const rate = ratesOfCall(call, rates);
  const { input, cached, cacheWrite, output } = call.usage;
  const plain = costUsd({ inputPerMTok: rate.input, outputPerMTok: rate.output }, { input: input - cached - cacheWrite, output });
  const cacheRead = costUsd({ inputPerMTok: rate.cached, outputPerMTok: 0 }, { input: cached, output: 0 });
  const write = costUsd({ inputPerMTok: rate.cacheWrite, outputPerMTok: 0 }, { input: cacheWrite, output: 0 });
  return plain + cacheRead + write;
}

/** A billed call that doesn't say what it cost: answered, with no tokens reported. Pricing it at zero would make a number nothing measured. */
const isUnpriced = (call: RawCall) => call.method === 'POST' && call.status < 400 && !(call.usage && call.usage.input + call.usage.output > 0);

/**
 * A record failed when no provider answered it, or when an answer can't be priced. A Decisions
 * error followed by a good agent call is the fallback working, so only the last call decides that.
 */
export function recordFailed(record: RawRecord): boolean {
  if (record.thrown || record.calls.length === 0 || record.calls.some(isUnpriced)) return true;
  return record.calls[record.calls.length - 1].status >= 400;
}

const isAgentCall = (call: RawCall) => call.path.startsWith('/v1/responses') || call.path.startsWith('/v1/messages');
/** A call to the decision model the after path tries first: Decisions, or Jev on the variant. */
const isModelCall = (call: RawCall) => call.path.startsWith('/v1/decisions') || call.path.startsWith('/v1/systemone');
const isRejected = (call: RawCall) => call.status >= 400;

export interface PathStats {
  n: number;
  ran: number;
  failed: number;
  unpriced: number;
  accuracy: number;
  p50: number;
  p95: number;
  totalUsd: number;
  costPer1000: number;
  fellBack: number;
  /** Messages the decision model answered, with no agent call behind it. */
  answeredByModel: number;
  modelCalls: number;
  modelRejected: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
}

export function pathStats(records: readonly RawRecord[], path: 'before' | 'after', rates: RatesByRoute): PathStats {
  const own = records.filter((record) => record.path === path);
  const calls = own.flatMap((record) => record.calls);
  const totalUsd = calls.reduce((sum, call) => sum + callCost(call, rates), 0);
  const failed = own.filter(recordFailed).length;
  return {
    n: own.length,
    ran: own.length - failed,
    failed,
    unpriced: calls.filter(isUnpriced).length,
    accuracy: accuracy(own),
    p50: percentile(own.map((record) => record.ms), 50),
    p95: percentile(own.map((record) => record.ms), 95),
    totalUsd,
    costPer1000: (totalUsd / own.length) * 1000,
    fellBack: own.filter((record) => record.calls.some(isAgentCall)).length,
    answeredByModel: own.filter((record) => !recordFailed(record) && record.calls.some(isModelCall) && !record.calls.some(isAgentCall)).length,
    modelCalls: calls.filter(isModelCall).length,
    modelRejected: calls.filter(isModelCall).filter(isRejected).length,
    cachedTokens: calls.reduce((sum, call) => sum + (call.usage?.cached ?? 0), 0),
    cacheWriteTokens: calls.reduce((sum, call) => sum + (call.usage?.cacheWrite ?? 0), 0),
    inputTokens: calls.reduce((sum, call) => sum + (call.usage?.input ?? 0), 0),
  };
}

/** The gain as the title prints it. One that rounds away to 1.0x or 0% isn't a gain, and never reaches a title. */
function printedGain(speedFactor: number, costFactor: number): string {
  const speed = speedFactor.toFixed(1);
  const cut = Math.round((1 - 1 / costFactor) * 100);
  const faster = Number(speed) > 1 ? `${speed}x faster` : null;
  const cheaper = cut > 0 ? `${cut}% cheaper` : null;
  if (faster && cheaper) return speedFactor >= costFactor ? faster : cheaper;
  return faster ?? cheaper ?? 'no faster or cheaper';
}

/** The bigger of the speed-up and the cost cut, compared as factors, with any real accuracy drop added. */
export function titleNumber(before: PathStats, after: PathStats, n: number): string {
  const gain = printedGain(before.p50 / after.p50, before.costPer1000 / after.costPer1000);
  const dropPoints = Math.round((before.accuracy - after.accuracy) * 100 * 1e6) / 1e6;
  const drop = dropPoints > ACCURACY_DROP_LIMIT_POINTS ? `, accuracy down ${Math.round(dropPoints)} points` : '';
  return `${gain} on ${n} test messages${drop}`;
}

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const ms = (value: number) => `${Math.round(value)} ms`;
const usd = (value: number) => `$${value.toFixed(4)}`;

function rateLine(rate: Rates): string {
  return `- ${rate.label}: $${rate.input} input, $${rate.cached} cached, $${rate.cacheWrite} cache write and $${rate.output} output per million tokens. Source: ${rate.source}, read ${rate.fetched}.`;
}

const modelName = (variant: Variant) => (variant.afterSetting === 'decisions' ? 'Decisions' : 'Jev');

function rejectedRow(after: PathStats, variant: Variant): string[] {
  return [`${modelName(variant)} calls rejected, status 400 or above`, 'not used', `${after.modelRejected} of ${after.modelCalls}`];
}

function measuredTable(before: PathStats, after: PathStats, meta: RawMeta, variant: Variant): string {
  const rows = [
    ['path', `agent on ${meta.agentModel}`, variant.afterLabel],
    ['n', String(before.n), String(after.n)],
    ['accuracy', percent(before.accuracy), percent(after.accuracy)],
    ['p50', ms(before.p50), ms(after.p50)],
    ['p95', ms(before.p95), ms(after.p95)],
    ['cost per 1,000 messages', usd(before.costPer1000), usd(after.costPer1000)],
    ['messages the agent had to answer', String(before.fellBack), String(after.fellBack)],
    rejectedRow(after, variant),
  ];
  const cacheRow = variant.afterSetting === 'decisions' ? [['cached tokens read', String(before.cachedTokens), String(after.cachedTokens)]] : [];
  return ['| | before | after |', '| --- | --- | --- |', ...[...rows, ...cacheRow].map(([name, a, b]) => `| ${name} | ${a} | ${b} |`)].join('\n');
}

/** The test set's own list can't be cached, so nothing in the table shows a discount. */
function cacheNotes(after: PathStats): string[] {
  return after.cachedTokens === 0 ? [`The test set's category list is too short for the ${CACHE_MIN_TOKENS_LABEL}-token minimum, so caching didn't apply to these numbers.`] : [];
}

/** Explicit mode alone means no caching, so the cached form is the request with a breakpoint in it. */
function usesCachedForm(call: RawCall): boolean {
  const input = (call.request as { input?: unknown } | null)?.input;
  if (!Array.isArray(input)) return false;
  return input.some((item) => Array.isArray(item?.content) && item.content.some((part: { prompt_cache_breakpoint?: unknown }) => Boolean(part?.prompt_cache_breakpoint)));
}

/** Why the check can't score the cached form, if it can't: the agent's answers aren't that form's. */
function longFormProblem(stats: PathStats, decisionCalls: readonly RawCall[]): string | null {
  const cachedForm = decisionCalls.filter(usesCachedForm).length;
  if (cachedForm < decisionCalls.length || decisionCalls.length === 0) return `only ${cachedForm} of ${decisionCalls.length} requests used the cached form, so this run says nothing about that form.`;
  if (stats.failed > 0) return `only ${stats.ran} of ${stats.n} messages ran, so it gives no accuracy for the cached form.`;
  if (stats.modelRejected > 0) return `${stats.modelRejected} of ${stats.modelCalls} requests were rejected, so it gives no accuracy for the cached form.`;
  if (stats.fellBack * 2 > stats.n) return `the agent answered ${stats.fellBack} of ${stats.n} messages, so it gives no accuracy for the cached form.`;
  return null;
}

/**
 * The table covers the short form of the request. A long list sends a different one, with
 * the descriptions in a shared prefix, so that form gets its own score against the same labels.
 */
function longFormNotes(raw: Raw, rates: RatesByRoute, shortList: PathStats): string[] {
  if (!raw.longForm) return [];
  const records = raw.longForm.records;
  const decisionCalls = records.flatMap((record) => record.calls).filter((call) => call.path.startsWith('/v1/decisions'));
  const stats = pathStats(records, 'after', rates);
  const name = 'Long-list check, not in the table:';
  const problem = longFormProblem(stats, decisionCalls);
  if (problem) return [`${name} ${problem}`];
  const scores = `accuracy ${percent(stats.accuracy)} against ${percent(shortList.accuracy)} for the short list, ${stats.fellBack} answered by the agent, p50 ${ms(stats.p50)}, ${usd(stats.costPer1000)} per 1,000 messages, ${stats.cachedTokens} of ${stats.inputTokens} input tokens read from the cache and ${stats.cacheWriteTokens} written to it`;
  return [`${name} the same ${stats.n} messages and labels through the cached form of the request, with each rule's short description followed by the same passage of neutral text (lab/01-router/testset-long-rules.jsonl): ${scores}. The messages ran back to back, so these cache reads are the best case: a router with more than 30 minutes between messages pays the write rate each time. This is one longer version of one rule list, so it doesn't show the threshold fits every long list.`];
}

const cutOf = (before: PathStats, after: PathStats) => {
  const share = Math.round((1 - after.costPer1000 / before.costPer1000) * 100);
  return share >= 0 ? `${share}% cut` : `${-share}% rise`;
};

/** A swap moves the cost baseline, so the note says how far, using the tokens this run recorded. */
function substituteCostNote(raw: Raw, rates: RatesByRoute, onboarding: string): string {
  const model = raw.meta.agentModel;
  const baseline = rates.onboarding;
  if (!baseline) throw new Error(`no price for ${onboarding}, the model the agent path should have used`);
  const repriced = { ...rates, agent: baseline };
  const before = pathStats(raw.records, 'before', repriced);
  const after = pathStats(raw.records, 'after', repriced);
  const measured = cutOf(pathStats(raw.records, 'before', rates), pathStats(raw.records, 'after', rates));
  const dearer = rates.agent.input > baseline.input && rates.agent.output > baseline.output;
  const compared = dearer ? `${model}, which costs more than ${onboarding}` : model;
  return `The cost row is measured against ${compared}, and shows a ${measured}. The same recorded tokens at ${onboarding}'s prices, in the list below, give ${usd(before.costPer1000)} before and ${usd(after.costPer1000)} after per 1,000 messages, a ${cutOf(before, after)}. That's arithmetic on this run's tokens, not a run on ${onboarding}.`;
}

function modelNotes(input: BuildInput): string[] {
  const { raw, onboarding, deprecation } = input;
  const model = raw.meta.agentModel;
  if (model === onboarding) return [`The agent path uses ${onboarding}, the model onboarding preselects at the base commit (server/models/systemSettings.js).`];
  const why = deprecation ? `OpenAI's deprecations page lists its shutdown on ${deprecation.shutdown} and names ${deprecation.substitute} as the substitute` : `the provider no longer serves it`;
  return [`The agent path uses ${model}, not ${onboarding}, the model onboarding preselects at the base commit (server/models/systemSettings.js): ${why}.`, substituteCostNote(raw, input.rates, onboarding)];
}

export interface BuildInput {
  raw: Raw;
  rates: RatesByRoute;
  measuredAt: string;
  variant: VariantName;
  onboarding: string;
  deprecation: { shutdown: string; substitute: string } | null;
}

function partialResult(input: BuildInput, before: PathStats, after: PathStats, config: Variant, needs: string): LabResult {
  const unpricedRow = before.unpriced + after.unpriced > 0 ? [['answered calls with no usage, so not priced', String(before.unpriced), String(after.unpriced)]] : [];
  const rows = [['messages that ran', `${before.ran} of ${before.n}`, `${after.ran} of ${after.n}`], rejectedRow(after, config), ...unpricedRow];
  const body = ['| | before | after |', '| --- | --- | --- |', ...rows.map(([name, a, b]) => `| ${name} | ${a} | ${b} |`)].join('\n');
  return { lab: config.lab, status: 'partial', measured_at: input.measuredAt, needs, body };
}

/**
 * The decision model has to have answered most messages. Otherwise the after path's p50 and
 * cost are the agent's own, and the gap between two agent runs would become the title. This
 * catches rejected calls, answers the code can't read, and a key that never reached the sandbox.
 */
function incompleteReason(before: PathStats, after: PathStats, config: Variant): string | null {
  const unpriced = before.unpriced + after.unpriced;
  if (unpriced > 0) return `a rerun where every answered call reports its usage, because ${unpriced} answered ${unpriced === 1 ? 'call' : 'calls'} had no usage and can't be priced, see the raw outputs in out/`;
  if (before.failed > 0 || after.failed > 0 || before.n !== after.n) return 'a rerun with no failed calls, see the raw outputs in out/';
  if (after.answeredByModel * 2 > after.n) return null;
  return `a rerun where the decision model answers most messages, because ${modelName(config)} answered ${after.answeredByModel} of ${after.n} and ${after.modelRejected} of ${after.modelCalls} calls were rejected, see the raw outputs in out/`;
}

export function buildResult(input: BuildInput): LabResult {
  const config = VARIANTS[input.variant];
  const before = pathStats(input.raw.records, 'before', input.rates);
  const after = pathStats(input.raw.records, 'after', input.rates);
  const reason = incompleteReason(before, after, config);
  if (reason) return partialResult(input, before, after, config, reason);
  const afterRates = config.afterSetting === 'decisions' ? input.rates.decisions : input.rates.jev;
  const prices = [input.rates.agent, input.rates.onboarding, afterRates].filter((rate) => rate !== undefined);
  const notes = [
    `Test set: lab/01-router/testset.jsonl. Measured ${input.measuredAt}. The setting stays off by default: ROUTER_CLASSIFIER=agent.`,
    ...modelNotes(input),
    ...(config.afterSetting === 'decisions' ? [...cacheNotes(after), ...longFormNotes(input.raw, input.rates, after)] : []),
    'Prices:',
    ...prices.map(rateLine),
  ];
  return {
    lab: config.lab,
    status: 'measured',
    measured_at: input.measuredAt,
    title_number: titleNumber(before, after, before.n),
    body: `${measuredTable(before, after, input.raw.meta, config)}\n\n${notes.join('\n')}`,
  };
}

/** Removes the key values and anything shaped like a key, before raw output is saved. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const withoutValues = secrets.filter(Boolean).reduce((clean, secret) => clean.split(secret).join('[scrubbed]'), text);
  return withoutValues.replace(/\bsk-[A-Za-z0-9_*-]{8,}/g, '[scrubbed]').replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [scrubbed]');
}
