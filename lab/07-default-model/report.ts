// Turns what the harness saved into result.md's table, and keeps keys out of anything
// written to disk. Every number here comes from a saved run or from git.
import { daysBetween } from '../06-models/report.ts';
import type { LabResult } from '../shared/result.ts';

export const LAB_NAME = '07-default-model';
export const KEY_NAME = 'OPENAI_API_KEY';
export const TEAM_COMMIT = '5edf32b9';
/** The newest upstream commit the demo pins (data/timeline.json). */
export const PINNED_COMMIT = '9caf2b4';
export const PROVIDER_FILE = 'server/utils/AiProviders/openAi/index.js';
/** OpenAI's deprecations page: announced 22 Apr 2026, shut down 23 Oct 2026, substitute gpt-5.6-luna. */
export const OLD_MODEL = 'gpt-4.1-nano';
export const NEW_MODEL = 'gpt-5.6-luna';
export const SHUTDOWN_DATE = '2026-10-23';

export const NOT_RUN_SENTENCE = `Not measured yet: one real request on the old default model and one with no model set, through AnythingLLM's own OpenAI provider on this fork, will record the error the old model returns and the answer the new default gives, and it needs ${KEY_NAME}.`;

export type Role = 'old-default' | 'new-default';

export interface Attempt {
  role: Role;
  /** The model the provider was given. Null is the point of the new-default row: nothing was set. */
  askedFor: string | null;
  sentModel: string | null;
  answered: boolean;
  echoedModel: string | null;
  latencyMs: number | null;
  text: string | null;
  usage: { input: number; output: number } | null;
  error: string | null;
  errorStatus: number | null;
  errorCode: string | null;
  response: unknown;
}

export interface RawRun {
  fake: boolean;
  startedAt: string;
  finishedAt: string;
  systemPrompt: string;
  userPrompt: string;
  runs: Attempt[];
}

const KEY_SHAPED = /\bsk-[A-Za-z0-9_*-]{8,}/g;

/** Every raw output passes through here before it's written. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const exact = secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
  return exact.replace(KEY_SHAPED, '[redacted]');
}

function checkOld(row: Attempt): void {
  if (row.askedFor !== OLD_MODEL) throw new Error(`raw.json: the old-default row asked for ${row.askedFor}, not ${OLD_MODEL}`);
  if (!row.answered && typeof row.error !== 'string') throw new Error('raw.json: the old-default row has a bad error');
}

function checkNew(row: Attempt): void {
  if (row.askedFor !== null) throw new Error(`raw.json: the new-default row set a model (${row.askedFor}), so it does not test the default`);
  if (!row.answered) {
    if (typeof row.error !== 'string') throw new Error('raw.json: the new-default row has a bad error');
    return;
  }
  if (row.sentModel !== NEW_MODEL) throw new Error(`raw.json: the new-default row sent ${row.sentModel}, not ${NEW_MODEL}`);
  if (typeof row.echoedModel !== 'string') throw new Error('raw.json: the new-default row has a bad echoedModel');
  if (typeof row.latencyMs !== 'number') throw new Error('raw.json: the new-default row has a bad latencyMs');
  if (typeof row.usage?.input !== 'number' || typeof row.usage?.output !== 'number') throw new Error('raw.json: the new-default row has a bad usage');
}

function parseJson(text: string): RawRun {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`raw.json is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
}

/** The harness ran in a sandbox against upstream code, so its output is checked before it's believed. */
export function parseRaw(text: string): RawRun {
  const raw = parseJson(text);
  if (typeof raw.fake !== 'boolean' || !Array.isArray(raw.runs)) throw new Error('raw.json is missing fake or runs');
  if (raw.runs.length !== 2 || raw.runs[0]?.role !== 'old-default' || raw.runs[1]?.role !== 'new-default') {
    throw new Error('raw.json must hold one old-default row, then one new-default row');
  }
  checkOld(raw.runs[0]);
  checkNew(raw.runs[1]);
  return raw;
}

const MODEL_GONE = /deprecat|shut ?down|retired|discontinued|no longer|does not exist/i;

/** Only a refusal about the model shows the shutdown. A bad key or a rate limit says nothing about it. */
export function refusedForTheModel(row: Attempt): boolean {
  if (row.answered) return false;
  return row.errorStatus === 404 || row.errorCode === 'model_not_found' || MODEL_GONE.test(row.error ?? '');
}

function cell(text: string): string {
  return text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function cameBack(row: Attempt): string {
  if (row.answered) return `${cell(row.echoedModel ?? '')}: "${cell(row.text ?? '')}"`;
  const code = [row.errorStatus, row.errorCode].filter((part) => part !== null && part !== undefined).join(' ');
  return cell(`${code ? `${code}: ` : ''}${row.error ?? 'no answer'}`);
}

const LABELS: Record<Role, string> = { 'old-default': 'The old default, set by name', 'new-default': "No model set: this fork's default" };

function tableRow(row: Attempt): string {
  const latency = row.latencyMs === null ? '-' : `${row.latencyMs} ms`;
  const tokens = row.usage ? `${row.usage.input} / ${row.usage.output}` : '-';
  return `| ${LABELS[row.role]} | ${cell(row.sentModel ?? row.askedFor ?? 'none sent')} | ${row.answered ? 'yes' : 'no'} | ${cameBack(row)} | ${latency} | ${tokens} |`;
}

/** The table and its notes, shared by a real result and a dry run's preview. */
export function renderBody(raw: RawRun, teamNote: string): string {
  return [
    '| request | model sent | answered | what came back | latency | input / output tokens |',
    '| --- | --- | --- | --- | --- | --- |',
    ...raw.runs.map(tableRow),
    '',
    `n = one request each, through AnythingLLM's own OpenAiLLM.getChatCompletion on this fork's code (the base commit plus this pull request's patch), with OPEN_MODEL_PREF unset. Test set: one fixed prompt, "${raw.userPrompt}"`,
    '',
    teamNote,
  ].join('\n').trim();
}

export interface ResultInput {
  raw: RawRun;
  teamLine: string;
  measuredAt: string;
}

function whatIsMissing(raw: RawRun): string | null {
  const [old, next] = raw.runs;
  const missing = [
    ...(old.answered ? [`${OLD_MODEL} still answered, so the shutdown isn't shown`] : []),
    ...(!old.answered && !refusedForTheModel(old) ? [`a refusal of ${OLD_MODEL} about the model itself`] : []),
    ...(next.answered ? [] : [`a real answer from ${NEW_MODEL}`]),
  ];
  return missing.length ? missing.join(' and ') : null;
}

export function buildResult({ raw, teamLine, measuredAt }: ResultInput): LabResult {
  if (raw.fake) throw new Error('A fake run can never become a result.');
  const body = renderBody(raw, teamLine);
  const needs = whatIsMissing(raw);
  if (!needs) return { lab: LAB_NAME, status: 'measured', measured_at: measuredAt, body };
  return { lab: LAB_NAME, status: 'partial', measured_at: measuredAt, needs, body };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
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

/** A fact from git, read at run time. It says what the commit did and when, and nothing about what the team knew. */
export function teamLine(git: GitRead): string {
  const before = defaultModel(git, `${TEAM_COMMIT}^`);
  const after = defaultModel(git, TEAM_COMMIT);
  if (before !== OLD_MODEL || after !== NEW_MODEL) throw new Error(`git says ${TEAM_COMMIT} moved the default from ${before} to ${after}, not from ${OLD_MODEL} to ${NEW_MODEL}.`);
  const date = commitDate(git, TEAM_COMMIT);
  const days = daysBetween(SHUTDOWN_DATE, date);
  const tagged = git(['tag', '--contains', TEAM_COMMIT]).trim() !== '';
  const release = tagged ? '' : ` No tagged release carries it, as of ${PINNED_COMMIT} (${longDate(commitDate(git, PINNED_COMMIT))}).`;
  return `The team's own commit ${TEAM_COMMIT} (${longDate(date)}) moved this default from ${before} to ${after}, ${days} days after the model stopped working on ${longDate(SHUTDOWN_DATE)}.${release}`;
}
