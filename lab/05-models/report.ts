// Turns what the harness saved into outcomes and the table. Every word in a cell comes
// from a raw file; a run that didn't do what it should is reported, never smoothed over.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Price } from '../shared/prices.ts';
import { costUsd } from '../shared/prices.ts';
import type { LabStatus } from '../shared/result.ts';
import type { BinaryInfo } from '../shared/aura-binary.ts';
import { MINIMAL_PROMPT, WORKER_NAME, type LabCase } from './cases.ts';

type Json = Record<string, unknown>;

export interface RawCase { startupFailed?: boolean; httpStatus?: string; response?: string; log: string }
export interface TokenUsage { input: number; output: number }
/** Requests the worker sent right after a tool call, and how many of them sent a thinking block back. */
export interface ToolLoop { followUps: number; withThinking: number }

/** A case the keys at hand couldn't run: it's absent from the table, and a line says why. */
export interface NotRun { label: string; missingKeys: readonly string[] }

export interface CaseOutcome {
  id: LabCase['id'];
  label: string;
  model: string;
  kind: 'answer' | 'error' | 'no_response';
  detail: string;
  usage: TokenUsage | null;
  workerRequest?: Json;
  toolLoop?: ToolLoop;
}

/** How the binary in the table relates to the fork. A test checks it against the repo's history. */
export const RELEASE_VS_BASE = 'The base commit adds only CI, docs and tests to this release, so this binary is the base commit\'s own code.';

const KEY_SHAPES = [/\bsk-ant-[A-Za-z0-9_-]+/g, /\bsk-[A-Za-z0-9_-]{20,}/g];
const PROVIDER_ERROR_PREFIX = 'The upstream model provider (';
const WORKER_MARK = `orchestration.worker="${WORKER_NAME}"`;

export function scrub(text: string, secrets: readonly string[]): string {
  const withoutValues = secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[scrubbed]'), text);
  return KEY_SHAPES.reduce((out, shape) => out.replace(shape, '[scrubbed]'), withoutValues);
}

/** The writer for raw outputs: nothing reaches `to` without passing through scrub. */
export function scrubTree(from: string, to: string, secrets: readonly string[]): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    if (statSync(source).isDirectory()) scrubTree(source, join(to, name), secrets);
    else writeFileSync(join(to, name), scrub(readFileSync(source, 'utf8'), secrets));
  }
}

const readIfThere = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

export function readRawCase(dir: string): RawCase {
  return {
    startupFailed: existsSync(join(dir, 'startup_failed.txt')),
    httpStatus: readIfThere(join(dir, 'http_status.txt'))?.trim(),
    response: readIfThere(join(dir, 'response.json')),
    log: readIfThere(join(dir, 'server.log')) ?? '',
  };
}

/** The requests AURA logged at trace level: its own record of what it sent Anthropic. */
export function anthropicRequests(log: string): { worker: boolean; body: Json }[] {
  return [...log.matchAll(/^(.*)Anthropic completion request: (\{\n[\s\S]*?\n\})$/gm)].map((m) => ({
    worker: m[1].includes(WORKER_MARK),
    body: JSON.parse(m[2]) as Json,
  }));
}

function lastErrorLine(log: string): string {
  const errors = log.split('\n').filter((line) => /\bERROR\b|^Error:/.test(line));
  return errors[errors.length - 1] ?? 'the server did not start, and logged no error';
}

function parseChat(response: string | undefined): { content: string; usage: TokenUsage | null } | null {
  try {
    const parsed = JSON.parse(response ?? '') as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const { prompt_tokens: input, completion_tokens: output } = parsed.usage ?? {};
    // AURA reports zeros when it didn't count: that's no usage, not a free request.
    const counted = typeof input === 'number' && typeof output === 'number' && input + output > 0;
    return { content, usage: counted ? { input, output } : null };
  } catch {
    return null;
  }
}

function latestAssistantBlocks(request: Json): Json[] {
  const messages = Array.isArray(request.messages) ? (request.messages as Json[]) : [];
  const content = messages.filter((m) => m.role === 'assistant').at(-1)?.content;
  return Array.isArray(content) ? (content as Json[]) : [];
}

function toolLoopOf(requests: readonly Json[]): ToolLoop {
  const toolTurns = requests.map(latestAssistantBlocks).filter((blocks) => blocks.some((b) => b.type === 'tool_use'));
  const withThinking = toolTurns.filter((blocks) => blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));
  return { followUps: toolTurns.length, withThinking: withThinking.length };
}

/** A coordinator can write a fine answer after its worker failed, so the log decides. */
function workerVerdict(log: string): { failure: string | null; request?: Json; toolLoop?: ToolLoop } {
  const requests = anthropicRequests(log).filter((r) => r.worker).map((r) => r.body);
  if (!log.includes(WORKER_MARK) || !requests.length) return { failure: `the coordinator replied, but the request never reached the Claude worker ${WORKER_NAME}` };
  const seen = { request: requests[requests.length - 1], toolLoop: toolLoopOf(requests) };
  const outcomes = [...log.matchAll(/Outcome: (\d+) of (\d+) tasks succeeded/g)];
  const last = outcomes[outcomes.length - 1];
  if (last && last[1] === last[2] && Number(last[2]) > 0) return { failure: null, ...seen };
  const logged = log.match(new RegExp(`${WORKER_MARK}.*aura::logging: error="(.*)"$`, 'm'));
  return { failure: logged?.[1] ?? `the Claude worker ${WORKER_NAME} did not finish its task`, ...seen };
}

export function readOutcome(labCase: LabCase, raw: RawCase): CaseOutcome {
  const base = { id: labCase.id, label: labCase.label, model: labCase.model, usage: null };
  if (raw.startupFailed || !raw.httpStatus) return { ...base, kind: 'no_response', detail: lastErrorLine(raw.log) };
  if (raw.httpStatus !== '200') return { ...base, kind: 'error', detail: `HTTP ${raw.httpStatus}: ${raw.response ?? ''}` };
  const chat = parseChat(raw.response);
  if (!chat) return { ...base, kind: 'error', detail: `AURA's reply was not a chat completion: ${raw.response ?? ''}` };
  const answered = { ...base, usage: chat.usage };
  if (chat.content.startsWith(PROVIDER_ERROR_PREFIX)) return { ...answered, kind: 'error', detail: chat.content };
  if (!chat.content.trim()) return { ...answered, kind: 'error', detail: 'AURA returned an empty answer' };
  if (!labCase.orchestrated) return { ...answered, kind: 'answer', detail: chat.content };
  const verdict = workerVerdict(raw.log);
  const withRequest = verdict.request ? { ...answered, workerRequest: verdict.request, toolLoop: verdict.toolLoop } : answered;
  if (verdict.failure) return { ...withRequest, kind: 'error', detail: verdict.failure };
  return { ...withRequest, kind: 'answer', detail: chat.content };
}

export function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const short = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return short.replace(/\|/g, '\\|');
}

function didWhatItShould(labCase: LabCase, outcome: CaseOutcome | undefined): boolean {
  if (outcome?.kind !== labCase.expect) return false;
  return labCase.expect !== 'error' || labCase.errorProof.every((proof) => proof.test(outcome.detail));
}

/** The cases that were meant to run and didn't do what they should. */
export function missedCases(cases: readonly LabCase[], outcomes: readonly CaseOutcome[]): readonly LabCase[] {
  return cases.filter((c) => !didWhatItShould(c, outcomes.find((o) => o.id === c.id)));
}

/** `cases` are the ones that ran. `missingKeys` kept the others from running, which makes it partial however well these went. */
export function decide(cases: readonly LabCase[], outcomes: readonly CaseOutcome[], missingKeys: readonly string[] = []): { status: LabStatus; needs?: string } {
  const misses = missedCases(cases, outcomes);
  if (!misses.length && !missingKeys.length) return { status: 'measured' };
  const rerun = misses.length ? [`a rerun, because ${misses.map((m) => m.id).join(' and ')} did not do what it should; see lab/05-models/out/`] : [];
  const keys = missingKeys.length ? [missingKeys.join(' and ')] : [];
  return { status: 'partial', needs: [...keys, ...(keys.length && rerun.length ? [`and ${rerun[0]}`] : rerun)].join(', ') };
}

function cell(outcome: CaseOutcome | undefined): string {
  if (!outcome) return 'not run';
  if (outcome.kind === 'answer') return `${outcome.model}: answered "${oneLine(outcome.detail)}"`;
  const word = outcome.kind === 'error' ? 'error' : 'no response';
  return `${outcome.model}: ${word}. ${oneLine(outcome.detail)}`;
}

function tableRows(cases: readonly LabCase[], outcomes: readonly CaseOutcome[]): string[] {
  const after = cases.filter((c) => c.column === 'after');
  return after.map((c) => {
    const before = cases.find((b) => b.column === 'before' && b.file === c.file);
    const outcomeOf = (id: string | undefined) => outcomes.find((o) => o.id === id);
    return `| ${c.label} | ${cell(outcomeOf(before?.id))} | ${cell(outcomeOf(c.id))} |`;
  });
}

function toolLoopSentence(loop: ToolLoop | undefined): string {
  if (!loop?.followUps) return 'The worker made no follow-up request after a tool call in this run, so sending thinking blocks back was not exercised.';
  return `${loop.withThinking} of the worker's ${loop.followUps} follow-up requests after a tool call sent a thinking block back. Anthropic says to pass them back unchanged in tool-use loops, including empty ones; the log doesn't show the blocks in the replies themselves.`;
}

function workerLine(outcomes: readonly CaseOutcome[]): string[] {
  const worker = outcomes.find((o) => o.workerRequest);
  const request = worker?.workerRequest;
  if (!request) return [];
  const temperature = 'temperature' in request ? `temperature ${String(request.temperature)}` : 'no temperature';
  return [`AURA's own trace log shows what it sent the Claude worker: model ${String(request.model)}, thinking ${JSON.stringify(request.thinking)}, output_config ${JSON.stringify(request.output_config)}, ${temperature}. ${toolLoopSentence(worker?.toolLoop)}`];
}

const sumUsage = (list: readonly TokenUsage[]): TokenUsage => list.reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output }), { input: 0, output: 0 });

function pricedLine(usage: readonly TokenUsage[], price: Price): string {
  if (!usage.length) return 'AURA reported no token usage for the minimal example, so its runs aren\'t priced.';
  const total = sumUsage(usage);
  return `Cost of the minimal example's runs: $${costUsd(price, total).toFixed(6)}, from ${total.input} input and ${total.output} output tokens at $${price.inputPerMTok}/$${price.outputPerMTok} per MTok (${price.source}, fetched ${price.fetched}).`;
}

function mixedLine(usage: readonly TokenUsage[]): string {
  if (!usage.length) return 'The reasoning run mixes OpenAI and Claude tokens, so one price couldn\'t cover it, and AURA reported no token usage for the reasoning run; it isn\'t priced.';
  const total = sumUsage(usage);
  return `The reasoning run mixes OpenAI and Claude tokens (${total.input} input, ${total.output} output), so one price can't cover it and it isn't priced.`;
}

function costLine(cases: readonly LabCase[], outcomes: readonly CaseOutcome[], price: Price): string[] {
  const usageOf = (priced: boolean): TokenUsage[] => cases.filter((c) => c.priced === priced).flatMap((c) => outcomes.find((o) => o.id === c.id)?.usage ?? []);
  const hasMixed = cases.some((c) => !c.priced);
  return [pricedLine(usageOf(true), price), ...(hasMixed ? [mixedLine(usageOf(false))] : [])];
}

function testSetLine(cases: readonly LabCase[]): string {
  const prompts = [...new Set(cases.map((c) => c.prompt))];
  const parts = prompts.map((p) => `"${p}" for the ${p === MINIMAL_PROMPT ? 'minimal' : 'reasoning'} example`);
  return `n = 1 chat request per cell, sent to AURA's OpenAI-compatible endpoint. Test set: ${parts.join(' and ')}, written for this lab.`;
}

export function renderBody(cases: readonly LabCase[], outcomes: readonly CaseOutcome[], binary: BinaryInfo, price: Price, notRun: readonly NotRun[] = []): string {
  const notes = [
    testSetLine(cases),
    ...notRun.map((n) => `Not run: ${n.label}. It also needs ${n.missingKeys.join(' and ')}, so it has no row here.`),
    `AURA ${binary.tag} release binary ${binary.asset}, sha256 ${binary.sha256} checked against the release's checksums.txt, run in Docker. ${RELEASE_VS_BASE} "before" is the file at the base commit; "after" is the base commit plus this pull request's patches. Raw outputs: lab/05-models/out/.`,
    ...workerLine(outcomes),
    ...costLine(cases, outcomes, price),
  ];
  return ['| | before | after |', '| --- | --- | --- |', ...tableRows(cases, outcomes), '', ...notes.flatMap((n) => [n, ''])].join('\n').trim();
}

/** Dry run only: the claim in the pull request holds only if the changed block is what failed. */
export function probeProblems(outcomes: readonly CaseOutcome[]): string[] {
  const probe = outcomes.find((o) => o.id === 'probe-display-summarized');
  if (!probe || probe.detail.includes('cannot be modified')) return [];
  return [`${probe.id}: expected the changed thinking block to fail, got: ${oneLine(probe.detail)}`];
}

/** Dry run only: the fake always hands out a thinking block, so a follow-up without one means rig dropped it. */
export function emptyThinkingProblems(outcomes: readonly CaseOutcome[]): string[] {
  const probe = outcomes.find((o) => o.id === 'probe-empty-thinking');
  if (!probe) return ['probe-empty-thinking did not run'];
  if (!probe.toolLoop?.followUps) return ['probe-empty-thinking: the worker made no follow-up request after a tool call, so the claim went unchecked'];
  if (probe.toolLoop.withThinking === 0) return [];
  return ['probe-empty-thinking: the worker sent the thinking block back, so the sentence about rig dropping it comes out of the pull request'];
}

/** Dry run only: the request AURA built from the TOML must be the one the file promises. */
export function requestProblems(outcomes: readonly CaseOutcome[]): string[] {
  return outcomes.filter((o) => o.workerRequest).flatMap((o) => {
    const request = o.workerRequest as Json;
    const thinking = request.thinking as { type?: unknown } | undefined;
    const config = request.output_config as { effort?: unknown } | undefined;
    const checks: [boolean, string][] = [
      [request.model === o.model, `sent model ${String(request.model)}`],
      [thinking?.type === 'adaptive', `sent thinking ${JSON.stringify(request.thinking)}`],
      [config?.effort === 'high', `sent output_config ${JSON.stringify(request.output_config)}`],
      [!('temperature' in request), 'sent a temperature'],
    ];
    return checks.filter(([ok]) => !ok).map(([, problem]) => `${o.id}: ${problem}`);
  });
}
