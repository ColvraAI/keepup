// npm run lab -- 03 [--dry-run | --record-not-run]
//
// Measures MiniLM and EmbeddingGemma 2 through the pull request's NativeEmbedder on a 1,000-passage BEIR SciFact
// subset. No API key is involved, so this never loads .env. Upstream code runs only in the sandbox; scoring runs here,
// on saved vectors.
//   --dry-run         a tiny real subset (real models, real download), output only under lab/.work/03-embeddings/dry-run/
//   --record-not-run  records the honest not_run state and exits with code 3
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXIT_NEEDS_KEY, REPO_ROOT } from '../shared/env.ts';
import { writeResult } from '../shared/result.ts';
import { corpusSubset, parseCorpus, parseQrels, parseQueries, passageText, relevantIds, selectQueries, tinyCorpus, type Doc, type Qrels, type Query } from './dataset.ts';
import { buildResult, checkCompat, CONTROL, dryRunSummary, MODELS, notRunResult, rankAll, rankingLines, score, scrubSecrets, type Compat, type ModelRun, type Progress, type SameDefault, type SubsetInfo } from './report.ts';

export const DATASET_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip';
export const LICENCE_URL = 'https://raw.githubusercontent.com/allenai/scifact/master/LICENSE.md';
export const FULL_QUERIES = 200;
export const FULL_PASSAGES = 1000;
export const TINY = { passages: 20, queries: 5 };
const EXIT_CONTINUE = 75;
const MAX_SESSIONS = 60;
const BUDGET_MIN = 30;
const SERVER_VOLUME = 'keepup-all-server-nm-03';
const CLONE = join(REPO_ROOT, 'tmp', 'anything-llm');

export type Step =
  | { kind: 'install' }
  | { kind: 'embed'; model: string; outDir: string; segment: number; oldPackage: boolean }
  | { kind: 'compat'; check: string; outFile: string; storage: string };

export interface Paths {
  lab: string;
  labWork: string;
  work: string;
  out: string;
  input: string;
  tree: string;
  result: string;
}

export interface Deps {
  paths: (dryRun: boolean) => Paths;
  sandbox: (step: Step, paths: Paths) => Promise<number>;
  prepareTree: (paths: Paths) => void;
  removeTree: (paths: Paths) => void;
  dataset: () => Promise<RawDataset>;
  dockerAvailable: () => boolean;
  env: Record<string, string | undefined>;
  today: () => string;
  log: (line: string) => void;
}

export interface RawDataset {
  corpus: string;
  queries: string;
  qrelsTest: string;
  sha256: string;
  licence: string;
}

export function pathsFor(dryRun: boolean, lab: string = import.meta.dirname, root: string = REPO_ROOT): Paths {
  const labWork = join(root, 'lab', '.work');
  const work = join(labWork, '03-embeddings', dryRun ? 'dry-run' : 'full');
  return {
    lab,
    labWork,
    work,
    out: dryRun ? join(work, 'out') : join(lab, 'out'),
    input: join(work, 'input'),
    tree: dryRun ? join(work, 'tree') : join(root, 'tmp', 'lab-wt-03'),
    result: join(lab, 'result.md'),
  };
}

interface TestSet {
  corpus: Doc[];
  queries: Query[];
  qrels: Qrels;
  /** What a full run embeds, which the dry run plans on. */
  fullRunPassages: number;
  /** How the full run's passages were chosen. A dry run has none. */
  subset: SubsetInfo | null;
}

export function pickTestSet(raw: RawDataset, dryRun: boolean): TestSet {
  const corpus = parseCorpus(raw.corpus);
  const qrels = parseQrels(raw.qrelsTest);
  const all = parseQueries(raw.queries);
  const fullRunPassages = Math.min(FULL_PASSAGES, corpus.length);
  if (dryRun) {
    const queries = selectQueries(all, qrels, corpus, TINY.queries);
    return { corpus: tinyCorpus(corpus, queries, qrels, TINY.passages), queries, qrels, fullRunPassages, subset: null };
  }
  const queries = selectQueries(all, qrels, corpus, FULL_QUERIES);
  const subset = corpusSubset(corpus, queries, qrels, FULL_PASSAGES);
  const needed = relevantIds(queries, qrels);
  const relevant = subset.filter((d) => needed.has(d.id)).length;
  return { corpus: subset, queries, qrels, fullRunPassages, subset: { relevant, others: subset.length - relevant, corpus: corpus.length } };
}

function writeInputs(set: TestSet, paths: Paths): void {
  mkdirSync(paths.input, { recursive: true });
  const lines = (rows: readonly object[]): string => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  writeFileSync(join(paths.input, 'passages.jsonl'), lines(set.corpus.map((d) => ({ id: d.id, text: passageText(d) }))));
  writeFileSync(join(paths.input, 'queries.jsonl'), lines(set.queries.map((q) => ({ id: q.id, text: q.text }))));
}

function writeRaw(paths: Paths, name: string, text: string, env: Deps['env']): void {
  mkdirSync(paths.out, { recursive: true });
  writeFileSync(join(paths.out, name), scrubSecrets(text, env));
}

async function runStep(step: Step, paths: Paths, deps: Deps, label: string): Promise<void> {
  const code = await deps.sandbox(step, paths);
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}. Run the lab again to resume.`);
}

async function runCompat(paths: Paths, deps: Deps): Promise<Compat> {
  const dir = join(paths.work, 'compat');
  mkdirSync(dir, { recursive: true });
  const checks = [['parity', '/hf-cache/anything-llm'], ['old-first', '/hf-cache/anything-llm'], ['new-first', '/hf-cache/anything-llm'], ['reuse', '/hf-cache/compat-reuse'], ['batching', '/hf-cache/anything-llm'], ['nomic', '/hf-cache/anything-llm'], ['e5', '/hf-cache/anything-llm']];
  const read: Record<string, unknown> = {};
  for (const [check, storage] of checks) {
    const outFile = join(dir, `${check}.json`);
    if (!existsSync(outFile)) await runStep({ kind: 'compat', check, outFile, storage }, paths, deps, `compat ${check}`);
    const text = readFileSync(outFile, 'utf8');
    writeRaw(paths, `compat-${check}.json`, text, deps.env);
    read[check] = JSON.parse(text);
  }
  return { parity: read.parity, oldFirst: read['old-first'], newFirst: read['new-first'], reuse: read.reuse, batching: read.batching, nomic: read.nomic, e5: read.e5 } as Compat;
}

function readVectors(file: string): Float32Array {
  const bytes = readFileSync(file);
  return new Float32Array(new Uint8Array(bytes).buffer);
}

function scoreModel(modelDir: string, set: TestSet): ModelRun & { rankings: ReturnType<typeof rankAll> } {
  const progress = JSON.parse(readFileSync(join(modelDir, 'progress.json'), 'utf8')) as Progress;
  const ids = set.corpus.map((d) => d.id);
  const rankings = rankAll(readVectors(join(modelDir, 'queries.f32')), readVectors(join(modelDir, 'passages.f32')), progress.dim, set.queries, ids);
  return { progress, scores: score(rankings, set.qrels, ids.length), rankings };
}

async function embedModel(model: typeof MODELS[number] | typeof CONTROL, set: TestSet, paths: Paths, deps: Deps, segment: number): Promise<ModelRun> {
  const outDir = join(paths.work, model.slug);
  const oldPackage = model.slug === CONTROL.slug;
  for (let session = 0; ; session += 1) {
    if (session >= MAX_SESSIONS) throw new Error(`${model.label} did not finish in ${MAX_SESSIONS} sessions`);
    const code = await deps.sandbox({ kind: 'embed', model: model.id, outDir, segment, oldPackage }, paths);
    if (code === 0) break;
    if (code !== EXIT_CONTINUE) throw new Error(`${model.label} stopped with exit code ${code}. Run the lab again to resume.`);
  }
  const { rankings, ...run } = scoreModel(outDir, set);
  writeRaw(paths, `rankings-${model.slug}.jsonl`, rankingLines(rankings), deps.env);
  writeRaw(paths, `run-${model.slug}.json`, JSON.stringify({ ...run.progress, scores: run.scores }, null, 2), deps.env);
  return run;
}

/** Runs the control, and scores documents from the old package against queries from the new one: an upgrade that doesn't re-embed. */
async function sameDefault(set: TestSet, paths: Paths, deps: Deps, segment: number): Promise<SameDefault> {
  const control = await embedModel(CONTROL, set, paths, deps, segment);
  const dim = control.progress.dim;
  const newQueries = readVectors(join(paths.work, MODELS[0].slug, 'queries.f32'));
  const oldPassages = readVectors(join(paths.work, CONTROL.slug, 'passages.f32'));
  const ids = set.corpus.map((d) => d.id);
  const same = { oldPackage: control.scores, oldDocumentsNewQueries: score(rankAll(newQueries, oldPassages, dim, set.queries, ids), set.qrels, ids.length) };
  writeRaw(paths, 'same-default.json', JSON.stringify(same, null, 2), deps.env);
  return same;
}

function saveDatasetNote(raw: RawDataset, set: TestSet, paths: Paths, deps: Deps): void {
  const chosen = set.subset ? { corpusPassages: set.subset.corpus, relevantPassages: set.subset.relevant, otherPassages: set.subset.others } : {};
  const note = { url: DATASET_URL, sha256: raw.sha256, passages: set.corpus.length, ...chosen, queries: set.queries.map((q) => q.id), passageIds: set.corpus.map((d) => d.id), licenceSource: LICENCE_URL, licence: raw.licence };
  writeRaw(paths, 'dataset.json', JSON.stringify(note, null, 2), deps.env);
  deps.log(`SciFact licence, from ${LICENCE_URL}:\n${raw.licence.trim()}`);
}

async function prepare(dryRun: boolean, deps: Deps): Promise<{ paths: Paths; set: TestSet }> {
  const paths = deps.paths(dryRun);
  if (dryRun) rmSync(paths.work, { recursive: true, force: true });
  const raw = await deps.dataset();
  const set = pickTestSet(raw, dryRun);
  writeInputs(set, paths);
  saveDatasetNote(raw, set, paths, deps);
  deps.prepareTree(paths);
  await runStep({ kind: 'install' }, paths, deps, 'installing the pull request\'s dependencies');
  return { paths, set };
}

async function dryRun(deps: Deps): Promise<number> {
  try {
    const { paths, set } = await prepare(true, deps);
    const compat = await runCompat(paths, deps);
    checkCompat(compat);
    const runs = [];
    for (const model of MODELS) runs.push({ label: model.label, run: await embedModel(model, set, paths, deps, 5) });
    await sameDefault(set, paths, deps, 5);
    const summary = dryRunSummary(runs, set.fullRunPassages, FULL_QUERIES);
    writeRaw(paths, 'summary.md', summary, deps.env);
    deps.log(summary);
    return 0;
  } finally {
    deps.removeTree(deps.paths(true));
  }
}

async function fullRun(deps: Deps): Promise<number> {
  const { paths, set } = await prepare(false, deps);
  const { subset } = set;
  if (!subset) throw new Error('a full run has to come with its subset');
  const compat = await runCompat(paths, deps);
  checkCompat(compat);
  const before = await embedModel(MODELS[0], set, paths, deps, 100);
  const same = await sameDefault(set, paths, deps, 100);
  const lengths = set.corpus.map((d) => passageText(d).length);
  try {
    const after = await embedModel(MODELS[1], set, paths, deps, 100);
    const written = writeResult(paths.result, buildResult(deps.today(), before, after, compat, same, lengths, subset));
    deps.log(`Wrote result.md: ${written.title_number}`);
    return 0;
  } catch (error) {
    writeResult(paths.result, buildResult(deps.today(), before, null, compat, same, lengths, subset));
    throw error;
  }
}

function recordNotRun(deps: Deps): number {
  writeResult(deps.paths(false).result, notRunResult());
  deps.log('Nothing was measured: result.md says not_run.');
  return EXIT_NEEDS_KEY;
}

/** A dry run never touches result.md, even to say that nothing ran. */
function refuseDryRun(deps: Deps): number {
  deps.log('The dry run needs Docker, and Docker is not running. Nothing was written.');
  return EXIT_NEEDS_KEY;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const unknown = argv.filter((a) => !['--dry-run', '--record-not-run'].includes(a));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(' ')}`);
  if (argv.includes('--record-not-run')) return recordNotRun(deps);
  const isDryRun = argv.includes('--dry-run');
  if (!deps.dockerAvailable()) return isDryRun ? refuseDryRun(deps) : recordNotRun(deps);
  return isDryRun ? dryRun(deps) : fullRun(deps);
}

// ---- the real dependencies

const inSandbox = (host: string, paths: Paths): string => `/lab-work/${relative(paths.labWork, host)}`;

export function commandFor(step: Step, paths: Paths): string {
  const harness = '/lab/03-embeddings/harness';
  const input = inSandbox(paths.input, paths);
  if (step.kind === 'install') return 'cd server && yarn install --frozen-lockfile --network-timeout 100000 2>&1 | tail -3 && test "${PIPESTATUS[0]}" -eq 0';
  if (step.kind === 'compat') return `cd server && node ${harness}/compat.cjs --check ${step.check} --input ${input} --out ${inSandbox(step.outFile, paths)} --storage ${step.storage}`;
  const embedder = step.oldPackage ? ` --embedder ${harness}/old-package-embedder.cjs` : '';
  return `mkdir -p /hf-cache/anything-llm && cd server && STORAGE_DIR=/hf-cache/anything-llm node ${harness}/embed.cjs --model ${step.model} --input ${input} --out ${inSandbox(step.outDir, paths)} --segment ${step.segment} --budget-min ${BUDGET_MIN}${embedder}`;
}

function runSandbox(step: Step, paths: Paths): Promise<number> {
  // No keys go in, and a long measurement always takes the queue.
  const { SANDBOX_ENV: _keys, SANDBOX_NO_LOCK: _lock, ...parent } = process.env;
  const env = { ...parent, SANDBOX_SERVER_VOLUME: SERVER_VOLUME };
  const child = spawn(join(REPO_ROOT, 'scripts', 'sandbox.sh'), ['anything-llm', paths.tree, commandFor(step, paths)], { env, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function git(args: string[], cwd: string = CLONE): void {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
}

function removeTree(paths: Paths): void {
  if (existsSync(paths.tree)) spawnSync('git', ['-C', CLONE, 'worktree', 'remove', '--force', paths.tree]);
  rmSync(paths.tree, { recursive: true, force: true });
  git(['worktree', 'prune']);
}

function prepareTree(paths: Paths): void {
  const pr = JSON.parse(readFileSync(join(paths.lab, 'pr.json'), 'utf8')) as { baseCommit: string; stages: { patches: string[] }[] };
  removeTree(paths);
  git(['worktree', 'add', '--force', '--detach', paths.tree, pr.baseCommit]);
  for (const patch of pr.stages.flatMap((s) => s.patches)) git(['apply', join(paths.lab, patch)], paths.tree);
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function realDataset(): Promise<RawDataset> {
  const dir = join(REPO_ROOT, 'lab', '.work', '03-embeddings', 'dataset');
  const zip = join(dir, 'scifact.zip');
  if (!existsSync(zip)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(zip, await download(DATASET_URL));
  }
  const extracted = join(dir, 'unzipped');
  if (!existsSync(join(extracted, 'scifact', 'corpus.jsonl'))) {
    mkdirSync(extracted, { recursive: true });
    const unzip = spawnSync('unzip', ['-q', '-o', zip, '-d', extracted], { encoding: 'utf8' });
    if (unzip.status !== 0) throw new Error(`could not unzip SciFact: ${unzip.stderr}`);
  }
  const root = join(extracted, 'scifact');
  if (!readdirSync(root).includes('qrels')) throw new Error('SciFact has no qrels folder');
  return {
    corpus: readFileSync(join(root, 'corpus.jsonl'), 'utf8'),
    queries: readFileSync(join(root, 'queries.jsonl'), 'utf8'),
    qrelsTest: readFileSync(join(root, 'qrels', 'test.tsv'), 'utf8'),
    sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'),
    licence: (await download(LICENCE_URL)).toString('utf8'),
  };
}

export const realDeps: Deps = {
  paths: (dryRunFlag) => pathsFor(dryRunFlag),
  sandbox: runSandbox,
  prepareTree,
  removeTree,
  dataset: realDataset,
  dockerAvailable: () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0,
  env: process.env,
  today: () => new Date().toISOString().slice(0, 10),
  log: (line) => console.log(line),
};

if (import.meta.main) {
  main(process.argv.slice(2), realDeps).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
