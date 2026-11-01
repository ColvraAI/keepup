// Turns what the harness saved into result.md's table, and keeps keys out of anything
// written to disk. Every number here comes from a saved run or from git.
import { costUsd, type Price } from '../shared/prices.ts';
import type { LabResult } from '../shared/result.ts';

export const LAB_NAME = '06-models';
export const KEY_NAME = 'OPENAI_API_KEY';
export const TEAM_COMMIT = '5edf32b9';
/** The newest upstream commit the demo pins (data/timeline.json), which is where "never" stops. */
export const PINNED_COMMIT = '9caf2b4';
export const LIST_FILE = 'server/utils/helpers/customModels.js';
export const PROVIDER_FILE = 'server/utils/AiProviders/openAi/index.js';
/** OpenAI's deprecations page: shut down on 23 Oct 2026, and AnythingLLM's default at the base commit. */
export const SHUT_DOWN_MODEL = 'gpt-4.1-nano';

export const NOT_RUN_SENTENCE = `Not measured yet: one real request to each new model through AnythingLLM's own OpenAI provider on this fork will record whether it answers, the model id echoed back and the latency, and it needs ${KEY_NAME}.`;

export interface Release {
  model: string;
  date: string;
}

/** From the OpenAI changelog in data/db (22 Sep and 29 Sep entries). */
export const RELEASES: readonly Release[] = [
  { model: 'gpt-6-sol', date: '2026-09-22' },
  { model: 'gpt-6-luna', date: '2026-09-22' },
  { model: 'gpt-6.1-sol', date: '2026-09-29' },
];

export interface ModelRun {
  model: string;
  answered: boolean;
  echoedModel: string | null;
  latencyMs: number | null;
  appDurationSeconds: number | null;
  text: string | null;
  usage: { input: number; output: number } | null;
  temperatureSent: boolean;
  error: string | null;
  response: unknown;
}

export interface RawRun {
  fake: boolean;
  startedAt: string;
  finishedAt: string;
  systemPrompt: string;
  userPrompt: string;
  runs: ModelRun[];
}

const KEY_SHAPED = /\bsk-[A-Za-z0-9_*-]{8,}/g;

/** Every raw output passes through here before it's written. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const exact = secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
  return exact.replace(KEY_SHAPED, '[redacted]');
}

function checkRow(row: ModelRun): void {
  const bad = (field: string) => new Error(`raw.json: ${row.model} has a bad ${field}`);
  if (typeof row.answered !== 'boolean') throw bad('answered');
  if (!row.answered && typeof row.error !== 'string') throw bad('error');
  if (!row.answered) return;
  if (typeof row.echoedModel !== 'string') throw bad('echoedModel');
  if (typeof row.latencyMs !== 'number') throw bad('latencyMs');
  if (typeof row.usage?.input !== 'number' || typeof row.usage?.output !== 'number') throw bad('usage');
}

function parseJson(text: string): RawRun {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`raw.json is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
}

/** The harness ran in a sandbox against upstream code, so its output is checked before it's believed. */
export function parseRaw(text: string, models: readonly string[]): RawRun {
  const raw = parseJson(text);
  if (typeof raw.fake !== 'boolean' || !Array.isArray(raw.runs)) throw new Error('raw.json is missing fake or runs');
  const found = raw.runs.map((r) => r.model);
  for (const model of models) {
    if (found.filter((m) => m === model).length !== 1) throw new Error(`raw.json must hold one row for ${model}`);
  }
  if (found.length !== models.length) throw new Error(`raw.json holds ${found.length} rows, expected one for each of ${models.join(', ')}`);
  raw.runs.forEach(checkRow);
  return raw;
}

function cell(text: string): string {
  return text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

function row(run: ModelRun, priceOf: (model: string) => Price): string {
  if (!run.answered || !run.usage) return `| ${run.model} | no: ${cell(run.error ?? 'no answer')} | - | - | - | - |`;
  const cost = costUsd(priceOf(run.model), run.usage);
  return `| ${run.model} | yes | ${cell(run.echoedModel ?? '')} | ${run.latencyMs} ms | ${run.usage.input} / ${run.usage.output} | $${cost.toFixed(6)} |`;
}

function priceNote(runs: readonly ModelRun[], priceOf: (model: string) => Price): string {
  const parts = runs.filter((r) => r.answered).map((r) => {
    const price = priceOf(r.model);
    return `${r.model} from ${price.source}, fetched ${price.fetched}`;
  });
  return parts.length ? `Cost is the tokens above times the price per million: ${parts.join('; ')}.` : '';
}

/** The table and its notes, shared by a real result and a dry run's preview. */
export function renderBody(raw: RawRun, priceOf: (model: string) => Price, teamNote: string): string {
  const lines = [
    '| model | answered | model id echoed back | latency | input / output tokens | cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...raw.runs.map((run) => row(run, priceOf)),
    '',
    `n = one request per model, through AnythingLLM's own OpenAiLLM.getChatCompletion on this fork's code (the base commit plus this pull request's patches). Test set: one fixed prompt, "${raw.userPrompt}"`,
    '',
    priceNote(raw.runs, priceOf),
    '',
    teamNote,
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ResultInput {
  raw: RawRun;
  priceOf: (model: string) => Price;
  teamLine: string;
  measuredAt: string;
}

export function buildResult({ raw, priceOf, teamLine, measuredAt }: ResultInput): LabResult {
  if (raw.fake) throw new Error('A fake run can never become a result.');
  const body = renderBody(raw, priceOf, teamLine);
  const silent = raw.runs.filter((r) => !r.answered).map((r) => r.model);
  if (!silent.length) return { lab: LAB_NAME, status: 'measured', measured_at: measuredAt, body };
  return { lab: LAB_NAME, status: 'partial', measured_at: measuredAt, needs: `a real answer from ${silent.join(' and ')}`, body };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type GitRead = (args: string[]) => string;

/** A commit's date in UTC (D23), not in whatever offset its author was in. */
function commitDate(git: GitRead, rev: string): string {
  return new Date(git(['log', '-1', '--format=%cI', rev]).trim()).toISOString().slice(0, 10);
}

function defaultModel(git: GitRead, rev: string): string {
  const found = git(['show', `${rev}:${PROVIDER_FILE}`]).match(/OPEN_MODEL_PREF \|\| "([^"]+)"/);
  if (!found) throw new Error(`git shows no default model in ${PROVIDER_FILE} at ${rev}.`);
  return found[1];
}

/** What the commit was for. It's why the list changed at all, so the line can't leave it out. */
function commitPurpose(git: GitRead): string {
  const before = defaultModel(git, `${TEAM_COMMIT}^`);
  const after = defaultModel(git, TEAM_COMMIT);
  if (before !== SHUT_DOWN_MODEL || after === SHUT_DOWN_MODEL) {
    throw new Error(`git says ${TEAM_COMMIT} moved the default from ${before} to ${after}, not off ${SHUT_DOWN_MODEL}.`);
  }
  return `was a fix for the ${SHUT_DOWN_MODEL} shutdown that also changed this list. It moved the OpenAI default from ${before} to ${after}`;
}

/** "Never" is only said when git shows no commit up to the pin that put the model in the list. */
function missedSentence(git: GitRead, model: string): string {
  const addedLater = git(['log', '--format=%h', `-S"${model}"`, PINNED_COMMIT, '--', LIST_FILE]).trim() !== '';
  return addedLater ? `It did not add ${model}.` : `${model} was never added, as of ${PINNED_COMMIT} (${longDate(commitDate(git, PINNED_COMMIT))}).`;
}

/** A fact from git, read at run time: what the team's own commit was for, what it did to the same list, and when. */
export function teamLine(git: GitRead, releases: readonly Release[] = RELEASES): string {
  const date = commitDate(git, TEAM_COMMIT);
  const after = git(['show', `${TEAM_COMMIT}:${LIST_FILE}`]);
  const before = git(['show', `${TEAM_COMMIT}^:${LIST_FILE}`]);
  const has = (file: string, model: string) => file.includes(`"${model}"`);
  const added = releases.filter((r) => has(after, r.model) && !has(before, r.model));
  const missed = releases.filter((r) => !has(after, r.model));
  if (added.length === 0) throw new Error(`git says ${TEAM_COMMIT} added none of these models to ${LIST_FILE}.`);
  const arrivals = added.map((r, i) => `${r.model}${i === 0 ? ' first appears in that list' : ''} ${daysBetween(r.date, date)} days after it shipped`).join(' and ');
  const rest = missed.map((r) => ` ${missedSentence(git, r.model)}`).join('');
  return `The team's own commit ${TEAM_COMMIT} (${longDate(date)}) ${commitPurpose(git)}, and in the file this pull request changes (${LIST_FILE}) ${arrivals}.${rest}`;
}
