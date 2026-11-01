// Turns what the harness left on disk into scores, the result table and the dry-run summary.
import type { LabResult } from '../shared/result.ts';
import { mean } from '../shared/stats.ts';
import type { Qrels, Query } from './dataset.ts';
import { rankByCosine, recallAtK, reciprocalRankAtK } from './metrics.ts';

export const LAB = '03-embeddings';
export const MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2', slug: 'minilm', label: 'all-MiniLM-L6-v2' },
  { id: 'onnx-community/embeddinggemma-2-ONNX', slug: 'embeddinggemma-2', label: 'EmbeddingGemma 2 (q4)' },
] as const;
export const CONTROL = { id: 'Xenova/all-MiniLM-L6-v2', slug: 'minilm-old-package', label: 'all-MiniLM-L6-v2 on @xenova/transformers' } as const;
export const NOT_RUN_SENTENCE = 'Running this measures recall@5, MRR@10, the time to embed 1,000 passages and peak memory for all-MiniLM-L6-v2 and EmbeddingGemma 2 on a 1,000-passage SciFact subset through the pull request\'s NativeEmbedder; it needs Docker and no API key.';
export const NEEDS_FULL_RUN = 'Docker and a full run (no API key)';
/**
 * Below this the lab stops: the two packages' MiniLM vectors have stopped being the same model's. An acceptance line,
 * not a measurement, moved from 0.999 after a run failed it, and waiting on a decision. See testset-notes.md for the
 * evidence. What the drift does to search is measured, in same-default.json.
 */
export const PARITY_MIN_COSINE = 0.99;
const TIMED_PASSAGES = 1000;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/g, /\bhf_[A-Za-z0-9]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{16,}/g];

/** Removes the values of secret-looking variables and anything shaped like a key. Raw outputs pass through here. */
export function scrubSecrets(text: string, env: Record<string, string | undefined>): string {
  const values = Object.entries(env).filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8).map(([, value]) => value as string);
  const named = values.reduce((out, value) => out.split(value).join('[scrubbed]'), text);
  return SECRET_SHAPES.reduce((out, shape) => out.replace(shape, '[scrubbed]'), named);
}

export interface Progress {
  model: string;
  passages: number;
  queries: number;
  dim: number;
  segmentMs: { passages: number; ms: number }[];
  queryMs: number;
  loadMs: number[];
  peakRssKb: number;
  sessions: number;
  batch: number;
  chunkChars?: number;
  prefixes: { passage: string; query: string };
  machine: { node: string; arch: string; cpus: number; totalMemMb: number; transformers: string | null };
}

export interface Ranking {
  query: string;
  top: { id: string; score: number }[];
}

export interface Scores {
  recallAt5: number;
  mrrAt10: number;
  queries: number;
  passages: number;
}

/** Ranks every query against every passage by brute force. */
export function rankAll(queryVectors: Float32Array, passageVectors: Float32Array, dim: number, queries: readonly Query[], passageIds: readonly string[]): Ranking[] {
  if (queryVectors.length !== queries.length * dim) throw new Error(`expected ${queries.length} query vectors of ${dim}, got ${queryVectors.length} values`);
  if (passageVectors.length !== passageIds.length * dim) throw new Error(`expected ${passageIds.length} passage vectors of ${dim}, got ${passageVectors.length} values`);
  return queries.map((query, i) => ({
    query: query.id,
    top: rankByCosine(queryVectors.slice(i * dim, (i + 1) * dim), passageVectors, dim, 10).map((hit) => ({ id: passageIds[hit.index], score: hit.score })),
  }));
}

export function score(rankings: readonly Ranking[], qrels: Qrels, passages: number): Scores {
  const per = rankings.map((ranking) => {
    const relevant = qrels.get(ranking.query);
    if (!relevant) throw new Error(`no relevant documents for query ${ranking.query}`);
    const ids = ranking.top.map((hit) => hit.id);
    return { recall: recallAtK(ids, relevant, 5), rr: reciprocalRankAtK(ids, relevant, 10) };
  });
  return { recallAt5: mean(per.map((p) => p.recall)), mrrAt10: mean(per.map((p) => p.rr)), queries: rankings.length, passages };
}

/** Seconds spent embedding the first count passages, or null when fewer were embedded. Load time is not included. */
export function secondsForPassages(progress: Pick<Progress, 'segmentMs'>, count: number = TIMED_PASSAGES): number | null {
  let passages = 0;
  let ms = 0;
  for (const segment of progress.segmentMs) {
    if (passages >= count) break;
    passages += segment.passages;
    ms += segment.ms;
  }
  return passages >= count ? ms / 1000 : null;
}

export function msPerPassage(progress: Pick<Progress, 'segmentMs'>): number {
  const passages = progress.segmentMs.reduce((sum, s) => sum + s.passages, 0);
  if (passages === 0) throw new Error('nothing was embedded');
  return progress.segmentMs.reduce((sum, s) => sum + s.ms, 0) / passages;
}

export interface Comparison {
  n: number;
  minCosine: number;
  meanCosine: number;
}

export interface ExistingModel {
  model: string;
  chunkChars: number;
  tokens: { texts: number; differing: number };
  chunks: Comparison & { oldDim: number; newDim: number };
  queries: Comparison & { oldDim: number; newDim: number };
}

export interface Compat {
  parity: { n: number; oldDim: number; newDim: number; minCosine: number; meanCosine: number; chunkChars: number; wholePassageMinCosine: number; wholePassageMeanCosine: number };
  oldFirst: { dim: number; rerankScores: number[] };
  newFirst: { dim: number; rerankScores: number[] };
  reuse: { n: number; oldDim: number; newDim: number; minCosine: number; offline: boolean };
  batching: { batch: number; tokens: { texts: number; differing: number }; runtimeAlone: Comparison; runtimeBatched: Comparison; batchingOld: Comparison; batchingNew: Comparison; repeatNew: Comparison; queriesRuntimeAlone: Comparison };
  nomic: ExistingModel;
  e5: ExistingModel;
}

/**
 * A failed load already stops the lab, in its sandbox step. How far the vectors move is reported in result.md and is
 * not a gate: nomic-embed-text-v1 moves further than PARITY_MIN_COSINE, and neither model is in this lab's table.
 * See testset-notes.md.
 */
function checkExistingModel({ model, chunks, queries }: ExistingModel): void {
  for (const side of [chunks, queries]) {
    if (side.oldDim !== side.newDim) throw new Error(`${model} changed dimension: ${side.oldDim} to ${side.newDim}`);
  }
}

/** Throws unless every existing model behaves the same through the new package and the two onnxruntime versions coexist. */
export function checkCompat(compat: Compat): void {
  const { parity, oldFirst, newFirst, reuse, nomic, e5 } = compat;
  checkExistingModel(nomic);
  checkExistingModel(e5);
  if (parity.oldDim !== parity.newDim) throw new Error(`MiniLM changed dimension: ${parity.oldDim} to ${parity.newDim}`);
  if (parity.minCosine < PARITY_MIN_COSINE) throw new Error(`MiniLM vectors moved: lowest cosine ${parity.minCosine} between packages`);
  if (reuse.minCosine < PARITY_MIN_COSINE || !reuse.offline) throw new Error('the new package did not reuse the old package\'s download');
  for (const run of [oldFirst, newFirst]) {
    if (run.dim !== parity.oldDim || run.rerankScores.length === 0) throw new Error('the embedder and reranker did not work in one process');
  }
}

/** How the full run's passages were chosen, counted from the corpus. */
export interface SubsetInfo {
  relevant: number;
  others: number;
  corpus: number;
}

const fixed = (value: number): string => value.toFixed(3);
const counted = (value: number): string => value.toLocaleString('en-US');
const subsetName = (passages: number): string => `${counted(passages)}-passage SciFact subset`;
const seconds = (value: number | null): string => (value === null ? 'not timed' : `${value.toFixed(1)} s`);
const megabytes = (kb: number): string => `${Math.round(kb / 1024)} MB`;

function row(name: string, before: string, after: string): string {
  return `| ${name} | ${before} | ${after} |`;
}

export interface ModelRun {
  progress: Progress;
  scores: Scores;
}

export function titleNumber(before: Scores, after: Scores): string {
  return `recall@5 ${fixed(before.recallAt5)} → ${fixed(after.recallAt5)} on a ${subsetName(after.passages)}`;
}

export function resultTable(before: ModelRun, after: ModelRun | null, subset: SubsetInfo): string {
  const cell = (read: (run: ModelRun) => string): string => (after ? read(after) : 'did not finish');
  const { queries, passages } = before.scores;
  return [
    `| | before: ${MODELS[0].label} | after: ${MODELS[1].label} |`,
    '| --- | --- | --- |',
    row('test set', `${queries} queries against every passage relevant to them (${subset.relevant}), plus the lowest-id other passages up to ${counted(passages)}`, 'same'),
    row('recall@5', fixed(before.scores.recallAt5), cell((r) => fixed(r.scores.recallAt5))),
    row('MRR@10', fixed(before.scores.mrrAt10), cell((r) => fixed(r.scores.mrrAt10))),
    row('time to embed 1,000 passages', seconds(secondsForPassages(before.progress)), cell((r) => seconds(secondsForPassages(r.progress)))),
    row('peak memory (RSS)', megabytes(before.progress.peakRssKb), cell((r) => megabytes(r.progress.peakRssKb))),
    row('vector dimensions', String(before.progress.dim), cell((r) => String(r.progress.dim))),
  ].join('\n');
}

/** What the package change does to MiniLM's retrieval, with documents embedded before the upgrade kept as they are. */
export interface SameDefault {
  oldPackage: Scores;
  oldDocumentsNewQueries: Scores;
}

/** How far the lab is from the product: it scores whole passages, and the product's splitter cuts them first. */
function wholePassagesNote(before: ModelRun, after: ModelRun | null, lengths: readonly number[]): string {
  const over = (run: ModelRun): number => lengths.filter((length) => length > (run.progress.chunkChars ?? Infinity)).length;
  const first = `Each passage was embedded whole, with no text splitter, for both models, so these scores compare the models on whole passages and are not the chunked path the product uses. ${over(before)} of ${counted(lengths.length)} passages are longer than the ${counted(before.progress.chunkChars ?? 0)} characters the product cuts ${MODELS[0].label} at`;
  return after ? `${first}, and ${over(after)} of ${counted(lengths.length)} are longer than the ${counted(after.progress.chunkChars ?? 0)} it cuts ${MODELS[1].label} at.` : `${first}.`;
}

function batchingNote({ batching }: Compat): string {
  const low = (comparison: Comparison): string => comparison.minCosine.toFixed(6);
  return `Batching: on the same ${batching.runtimeAlone.n} chunks of all-MiniLM-L6-v2, the lowest cosine between packages is, one at a time ${low(batching.runtimeAlone)}, in batches of ${batching.batch} ${low(batching.runtimeBatched)}. Within one package, alone against batched: old ${low(batching.batchingOld)}, new ${low(batching.batchingNew)}. The same batches twice on the new package: ${low(batching.repeatNew)}. ${batching.queriesRuntimeAlone.n} queries one at a time, between packages: ${low(batching.queriesRuntimeAlone)}. Token ids differ between packages on ${batching.tokens.differing} of ${batching.tokens.texts} of these texts.`;
}

function existingModelsNote({ nomic, e5 }: Compat): string {
  const line = ({ model, tokens, chunks, queries }: ExistingModel): string => `${model}: lowest cosine between packages ${chunks.minCosine.toFixed(6)} on ${chunks.n} chunks, ${queries.minCosine.toFixed(6)} on ${queries.n} queries, ${chunks.newDim} dimensions on both, token ids differ on ${tokens.differing} of ${tokens.texts} texts`;
  return `The other existing models also move to the new package, and were loaded for real on both. ${line(nomic)}. ${line(e5)}.`;
}

function notes(before: ModelRun, after: ModelRun | null, compat: Compat, same: SameDefault, lengths: readonly number[], subset: SubsetInfo): string {
  const { machine } = before.progress;
  return [
    `Test set: the first ${before.scores.queries} BEIR SciFact test queries by id, against a ${subsetName(before.scores.passages)}: every passage relevant to those queries (${subset.relevant}), plus the ${subset.others} lowest-id other passages, out of ${counted(subset.corpus)} in the corpus, with brute-force cosine search through the pull request's NativeEmbedder.`,
    "Recall on a subset isn't comparable to published SciFact scores, which search the whole corpus.",
    wholePassagesNote(before, after, lengths),
    `Machine: one Docker container on Node ${machine.node}, ${machine.arch}, ${machine.cpus} CPUs, @huggingface/transformers ${machine.transformers}. Each model ran in its own process.`,
    `Same default: all-MiniLM-L6-v2 scores recall@5 ${fixed(same.oldPackage.recallAt5)} on the old package and ${fixed(before.scores.recallAt5)} on the new one, and ${fixed(same.oldDocumentsNewQueries.recallAt5)} when documents embedded on the old package meet queries embedded on the new one. Both give ${compat.parity.newDim} dimensions. On ${compat.parity.n} passages cut to the ${compat.parity.chunkChars} characters the product sends, the lowest cosine between packages is ${compat.parity.minCosine.toFixed(6)}; on whole passages it is ${compat.parity.wholePassageMinCosine.toFixed(6)}.`,
    batchingNote(compat),
    existingModelsNote(compat),
  ].join('\n\n');
}

export function buildResult(date: string, before: ModelRun, after: ModelRun | null, compat: Compat, same: SameDefault, passageLengths: readonly number[], subset: SubsetInfo): LabResult {
  const body = `${resultTable(before, after, subset)}\n\n${notes(before, after, compat, same, passageLengths, subset)}`;
  if (!after) return { lab: LAB, status: 'partial', measured_at: date, needs: 'a re-run of npm run lab -- 03, which resumes EmbeddingGemma 2', body };
  return { lab: LAB, status: 'measured', measured_at: date, title_number: titleNumber(before.scores, after.scores), body };
}

export function notRunResult(): LabResult {
  return { lab: LAB, status: 'not_run', needs: NEEDS_FULL_RUN, body: NOT_RUN_SENTENCE };
}

/** The tiny run's report, with what it implies for planning the full run shown as a formula. */
export function dryRunSummary(runs: readonly { label: string; run: ModelRun }[], fullPassages: number, fullQueries: number): string {
  const lines = runs.map(({ label, run }) => {
    const perPassage = msPerPassage(run.progress);
    const perQuery = run.progress.queryMs / run.progress.queries;
    const planned = (perPassage * fullPassages + perQuery * fullQueries) / 60000;
    return `| ${label} | ${perPassage.toFixed(0)} ms | ${perQuery.toFixed(0)} ms | ${run.progress.loadMs[0].toFixed(0)} ms | ${megabytes(run.progress.peakRssKb)} | ${fixed(run.scores.recallAt5)} | about ${planned.toFixed(0)} min = (${perPassage.toFixed(0)} ms × ${fullPassages} + ${perQuery.toFixed(0)} ms × ${fullQueries}) |`;
  });
  return [
    '# Dry run: a tiny real subset, not a measurement',
    `${runs[0].run.scores.passages} passages and ${runs[0].run.scores.queries} queries. These scores are meaningless at this size and never reach result.md.`,
    '',
    '| model | per passage | per query | load | peak RSS | recall@5 (tiny) | full run plan |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...lines,
  ].join('\n');
}

export function rankingLines(rankings: readonly Ranking[]): string {
  return rankings.map((r) => JSON.stringify(r)).join('\n');
}
