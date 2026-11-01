// Turns the harness's raw output into the table and result.md, under the rule in wer.ts.
// Every number in the table comes from the raw output or from prices.json, never from here.
import type { LabResult } from '../shared/result.ts';
import { median } from '../shared/stats.ts';
import type { Recording, TestSet } from './testset.ts';
import { corpusWer, scoreTranscript, type TranscriptScore } from './wer.ts';

export const LAB_NAME = '02-whisper';
export const KEY_NAME = 'OPENAI_API_KEY';
export const BEFORE_MODEL = 'whisper-1';
export const AFTER_MODEL = 'gpt-transcribe';
export const UNKNOWN_MODEL = 'keepup-no-such-transcription-model';
export const NOT_RUN_SENTENCE =
  "Running this lab sends each LibriVox recording through the fork's OpenAI provider with whisper-1 and with gpt-transcribe, then records word error rate against the published text, time to the result and the listed price per minute; it needs OPENAI_API_KEY.";
export const RULE =
  "How word error rate is counted: lower-case the words, strip punctuation (a hyphen, dash or ellipsis counts as a space), and take the standard word-level edit distance (a substitution, an insertion and a deletion each cost one), divided by the published text's word count. A spelling variant counts as an error. Each file is uploaded whole, the way a user's file would be, so LibriVox's spoken preamble and closing reach the model, and the published text doesn't have them. The score therefore uses the unbroken run of transcript words that fits the whole published text best, and leaves out the words on either side of that run. Every published word still counts, so a missed opening or ending is an error. Words a model adds right next to the text can fall outside the run and go uncounted, for both models alike.";

const MODELS = [BEFORE_MODEL, AFTER_MODEL] as const;
const KEY_SHAPED = /\bsk-[A-Za-z0-9_*-]{8,}/g;

export interface Run {
  recording: string;
  model: string;
  ms: number;
  content: string | null;
  error: string | null;
  request: { fields: string[]; model?: string } | null;
  response: { fields: string[]; languages?: unknown; usage?: unknown } | null;
}

export interface UnknownModelCheck {
  model: string;
  content: string | null;
  error: string | null;
  apiStatus: number | null;
  apiCode: string | null;
  apiMessage: string | null;
}

export interface Raw {
  schema: 1;
  fake: boolean;
  startedAt: string;
  finishedAt: string;
  nodeVersion: string;
  sdkVersion: string | null;
  runs: Run[];
  unknownModel: UnknownModelCheck;
}

export interface Prices {
  source: string;
  fetched: string;
  perMinuteUsd: Record<(typeof MODELS)[number], number>;
}

/** Removes exact secret values, and anything shaped like an OpenAI key, such as one masked in an API error. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const withoutValues = secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[scrubbed]'), text);
  return withoutValues.replace(KEY_SHAPED, '[scrubbed]');
}

export function parsePrices(text: string): Prices {
  const prices = JSON.parse(text) as Prices;
  for (const model of MODELS) {
    if (typeof prices.perMinuteUsd?.[model] !== 'number') throw new Error(`prices.json has no price for ${model}`);
  }
  if (!prices.source || !prices.fetched) throw new Error('prices.json must name its source and date');
  return prices;
}

/** Checks the harness's output is the whole shape this report needs, with one run for each model on each recording. */
export function parseRaw(text: string, testSet: TestSet): Raw {
  const raw = JSON.parse(text) as Raw;
  if (raw.schema !== 1) throw new Error(`raw output has schema ${raw.schema}, expected 1`);
  if (!Array.isArray(raw.runs) || !raw.unknownModel) throw new Error('raw output has no runs or no unknown-model check');
  for (const recording of testSet.recordings) {
    for (const model of MODELS) {
      const found = raw.runs.filter((r) => r.recording === recording.id && r.model === model);
      if (found.length !== 1) throw new Error(`raw output has ${found.length} runs of ${model} on ${recording.id}, expected 1`);
      if (typeof found[0].ms !== 'number') throw new Error(`raw output has no time for ${model} on ${recording.id}`);
    }
  }
  return raw;
}

const answered = (run: Run): boolean => !run.error && typeof run.content === 'string' && run.content.length > 0;
const runOf = (raw: Raw, recording: string, model: string): Run => raw.runs.find((r) => r.recording === recording && r.model === model) as Run;
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').replaceAll('|', '/').trim();

function scoreOf(raw: Raw, recording: Recording, model: string): TranscriptScore | null {
  const run = runOf(raw, recording.id, model);
  return answered(run) ? scoreTranscript(recording.text, run.content as string) : null;
}

function recordingRow(raw: Raw, recording: Recording): string {
  const words = scoreTranscript(recording.text, '').referenceWords;
  const cells = MODELS.map((model) => {
    const score = scoreOf(raw, recording, model);
    return score ? percent(score.wer) : `failed: ${oneLine(runOf(raw, recording.id, model).error ?? 'no text came back')}`;
  });
  return `| ${recording.title}, read by ${recording.reader}: ${words} words | ${cells.join(' | ')} |`;
}

/** Only for a run where every upload answered. */
const scoresFor = (raw: Raw, testSet: TestSet, model: string): TranscriptScore[] => testSet.recordings.map((r) => scoreOf(raw, r, model) as TranscriptScore);

/** What follows the "·" in the title. The rate goes in only when the table would show it better, so the title never claims a gain the table doesn't. */
export function titleNumberFor(before: number, after: number, recordings: number): string {
  const change = `${BEFORE_MODEL} → ${AFTER_MODEL}`;
  const better = Number((after * 100).toFixed(1)) < Number((before * 100).toFixed(1));
  return better ? `${change}, word error rate ${percent(before)} → ${percent(after)} on ${recordings} recordings` : change;
}

function overallRows(raw: Raw, testSet: TestSet): string[] {
  const words = scoresFor(raw, testSet, BEFORE_MODEL).reduce((sum, s) => sum + s.referenceWords, 0);
  const n = testSet.recordings.length;
  const wer = MODELS.map((model) => percent(corpusWer(scoresFor(raw, testSet, model))));
  const time = MODELS.map((model) => seconds(median(raw.runs.filter((r) => r.model === model).map((r) => r.ms))));
  return [`| Word error rate, all ${n} recordings (${words} published words) | ${wer.join(' | ')} |`, `| Median time to the result, per upload | ${time.join(' | ')} |`];
}

function textBackCell(raw: Raw, model: string): string {
  const runs = raw.runs.filter((r) => r.model === model);
  return `${runs.filter(answered).length} of ${runs.length}`;
}

function fieldsCell(raw: Raw, model: string): string {
  const fields = new Set(raw.runs.filter((r) => r.model === model && answered(r)).flatMap((r) => r.response?.fields ?? []));
  return fields.size ? [...fields].sort().join(', ') : 'none came back';
}

function droppedLine(raw: Raw, testSet: TestSet): string {
  const counts = MODELS.map((model) => {
    const scores = testSet.recordings.map((r) => scoreOf(raw, r, model)).filter((s): s is TranscriptScore => s !== null);
    const before = scores.reduce((sum, s) => sum + s.droppedBefore.length, 0);
    const after = scores.reduce((sum, s) => sum + s.droppedAfter.length, 0);
    return `${model}, ${before} before and ${after} after`;
  });
  return `Words left out by that rule, across the recordings: ${counts.join('; ')}. The raw transcripts are in lab/${LAB_NAME}/out/responses.json.`;
}

function isClearRefusal(check: UnknownModelCheck): boolean {
  return Boolean(check.error?.includes(check.model) && check.error.includes('WHISPER_OPEN_AI_MODEL'));
}

function unknownModelLine(check: UnknownModelCheck): string {
  const status = check.apiStatus === null ? 'no HTTP status' : `HTTP ${check.apiStatus}`;
  return `Unknown model: the provider sent "${check.model}", OpenAI answered ${status}, and the provider returned: ${oneLine(check.error ?? 'no error at all')}`;
}

function testSetLine(testSet: TestSet): string {
  const items = testSet.recordings.map((r) => `${r.title} (${r.catalogUrl})`);
  return `Test set, n = ${testSet.recordings.length} recordings, each sent once to each model: ${items.join('; ')}. Details in lab/${LAB_NAME}/testset.md.`;
}

export function renderBody(raw: Raw, testSet: TestSet, prices: Prices): string {
  const complete = raw.runs.every(answered);
  const rows = [
    `| | before: ${BEFORE_MODEL} | after: ${AFTER_MODEL} |`,
    '| --- | --- | --- |',
    ...(complete ? overallRows(raw, testSet) : []),
    ...testSet.recordings.map((r) => recordingRow(raw, r)),
    `| Uploads that gave text back in the provider's {content, error} shape | ${MODELS.map((m) => textBackCell(raw, m)).join(' | ')} |`,
    `| Fields in OpenAI's response | ${MODELS.map((m) => fieldsCell(raw, m)).join(' | ')} |`,
    `| Price per minute of audio (OpenAI pricing page, fetched ${prices.fetched}) | ${MODELS.map((m) => `$${prices.perMinuteUsd[m]}`).join(' | ')} |`,
  ];
  return [rows.join('\n'), testSetLine(testSet), RULE, droppedLine(raw, testSet), unknownModelLine(raw.unknownModel), `Prices: ${prices.source}, fetched ${prices.fetched}.`].join('\n\n');
}

/** What's still missing from a run that didn't finish, or null when nothing is. */
export function whatIsMissing(raw: Raw): string | null {
  const failed = raw.runs.filter((r) => !answered(r)).map((r) => `${r.model} on ${r.recording}`);
  const gaps = [...(failed.length ? [`a run that gets text back for ${failed.join(', ')}`] : []), ...(isClearRefusal(raw.unknownModel) ? [] : ['a clear error from the provider for an unknown model'])];
  return gaps.length ? gaps.join(', and ') : null;
}

/** The result for a real run, or null when no transcript came back and so nothing was measured. */
export function buildResult(args: { raw: Raw; testSet: TestSet; prices: Prices; measuredAt: string }): LabResult | null {
  const { raw, testSet, prices, measuredAt } = args;
  if (raw.fake) throw new Error('a run against the fake provider cannot be a result');
  if (!raw.runs.some(answered)) return null;
  const needs = whatIsMissing(raw);
  const body = renderBody(raw, testSet, prices);
  if (needs) return { lab: LAB_NAME, status: 'partial', measured_at: measuredAt, needs, body };
  const [before, after] = MODELS.map((model) => corpusWer(scoresFor(raw, testSet, model)));
  return { lab: LAB_NAME, status: 'measured', measured_at: measuredAt, title_number: titleNumberFor(before, after, testSet.recordings.length), body };
}

/** What the fake provider says for a recording: the text between a made-up preamble and closing, with its last word lost. */
export function fakeTranscript(recording: Pick<Recording, 'text'>): string {
  const words = recording.text.split(/\s+/);
  return `A fake spoken preamble. ${words.slice(0, -1).join(' ')} A fake spoken closing.`;
}

export function fakeTranscripts(testSet: TestSet): Record<string, Record<string, string>> {
  const forBoth = (r: Recording) => Object.fromEntries(MODELS.map((model) => [model, fakeTranscript(r)]));
  return Object.fromEntries(testSet.recordings.map((r) => [r.audioFile, forBoth(r)]));
}
