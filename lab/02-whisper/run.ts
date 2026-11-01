// npm run lab -- 02 [--dry-run] [--no-keys]
// Sends three LibriVox recordings through AnythingLLM's own OpenAI provider on the fork, inside
// the sandbox, once with whisper-1 and once with gpt-transcribe, and records word error rate,
// time to the result and the listed price. Exit code 3 means it's waiting on a key; 1 means a
// run that didn't finish.
//   --dry-run  the whole pipeline against a fake provider, writing only under lab/.work/02-whisper/dry-run/
//   --no-keys  run as if no key exists, without reading .env, which writes the honest not_run result
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_NEEDS_KEY, loadEnv, NeedsKeyError, REPO_ROOT, requireKeys } from '../shared/env.ts';
import { writeResult } from '../shared/result.ts';
import { ensureAudio, fetchBytes, type FetchBytes } from './audio.ts';
import { AFTER_MODEL, BEFORE_MODEL, buildResult, fakeTranscripts, KEY_NAME, LAB_NAME, NOT_RUN_SENTENCE, parsePrices, parseRaw, renderBody, scrubSecrets, UNKNOWN_MODEL, whatIsMissing } from './report.ts';
import { parseTestSet, type TestSet } from './testset.ts';
import { prepareArchiveTree, prepareWorktree, removeWorktree } from './tree.ts';

const DRY_RUN_PATHS = ['collector'];

interface PrFile {
  baseCommit: string;
  stages: { patches: string[] }[];
}

export interface SandboxRequest {
  worktree: string;
  input: string;
  out: string;
  fake: boolean;
  env: Record<string, string>;
}

export interface Deps {
  root: string;
  env: Record<string, string | undefined>;
  sandbox: (request: SandboxRequest) => { status: number; output: string };
  prepareLabTree: (pr: PrFile, dest: string) => void;
  removeLabTree: (dest: string) => void;
  prepareDryTree: (pr: PrFile, dest: string) => void;
  fetchAudio: FetchBytes;
  today: () => string;
  log: (line: string) => void;
}

const labDir = (root: string) => join(root, 'lab', LAB_NAME);
const workDir = (root: string, name: string) => join(root, 'lab', '.work', LAB_NAME, name);
const readLabFile = (root: string, name: string) => readFileSync(join(labDir(root), name), 'utf8');
const loadPr = (root: string): PrFile => JSON.parse(readLabFile(root, 'pr.json'));
const loadTestSet = (root: string): TestSet => parseTestSet(readLabFile(root, 'testset.json'));
const loadPrices = (root: string) => parsePrices(readLabFile(root, 'prices.json'));

function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function notRun(deps: Deps): number {
  const kept = writeResult(join(labDir(deps.root), 'result.md'), { lab: LAB_NAME, status: 'not_run', needs: KEY_NAME, body: NOT_RUN_SENTENCE });
  deps.log(kept.status === 'not_run' ? `Needs ${KEY_NAME}. Nothing was measured.` : `Needs ${KEY_NAME}. Kept the earlier ${kept.status} result.`);
  return EXIT_NEEDS_KEY;
}

/** Downloads what's missing and writes the harness's input. paths are as the sandbox sees them. */
async function writeInput(deps: Deps, testSet: TestSet, args: { audioDir: string; audioInSandbox: string; inputFile: string; fake: boolean }): Promise<void> {
  for (const recording of testSet.recordings) await ensureAudio(recording, args.audioDir, deps.fetchAudio);
  const input = {
    models: [BEFORE_MODEL, AFTER_MODEL],
    unknownModel: UNKNOWN_MODEL,
    recordings: testSet.recordings.map((r) => ({ id: r.id, path: `${args.audioInSandbox}/${r.audioFile}` })),
    ...(args.fake ? { fakeTranscripts: fakeTranscripts(testSet) } : {}),
  };
  writeFileSync(args.inputFile, JSON.stringify(input, null, 2));
}

function saveRealOutputs(deps: Deps, rawText: string, log: string, secrets: readonly string[]): string {
  const out = join(labDir(deps.root), 'out');
  const clean = scrubSecrets(rawText, secrets);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'responses.json'), clean);
  writeFileSync(join(out, 'sandbox.log'), scrubSecrets(log, secrets));
  return clean;
}

function recordResult(deps: Deps, rawText: string, testSet: TestSet): number {
  const result = buildResult({ raw: parseRaw(rawText, testSet), testSet, prices: loadPrices(deps.root), measuredAt: deps.today() });
  if (!result) {
    deps.log(`No transcript came back, so nothing was written to result.md. See lab/${LAB_NAME}/out/responses.json.`);
    return 1;
  }
  const kept = writeResult(join(labDir(deps.root), 'result.md'), result);
  deps.log(`result.md is ${kept.status}.`);
  return result.status === 'measured' ? 0 : 1;
}

/** The real run. Nothing from it reaches result.md unless the harness finished and its output checks out. */
async function measure(key: string, deps: Deps): Promise<number> {
  const testSet = loadTestSet(deps.root);
  const work = workDir(deps.root, 'run');
  const tree = join(deps.root, 'tmp', 'lab-wt-02');
  resetDir(work);
  await writeInput(deps, testSet, { audioDir: join(deps.root, 'lab', '.work', LAB_NAME, 'audio'), audioInSandbox: `/lab-work/${LAB_NAME}/audio`, inputFile: join(work, 'input.json'), fake: false });
  deps.prepareLabTree(loadPr(deps.root), tree);
  try {
    const sandboxDir = `/lab-work/${LAB_NAME}/run`;
    const run = deps.sandbox({ worktree: tree, input: `${sandboxDir}/input.json`, out: `${sandboxDir}/raw.json`, fake: false, env: { SANDBOX_ENV: KEY_NAME, [KEY_NAME]: key } });
    writeFileSync(join(work, 'sandbox.log'), scrubSecrets(run.output, [key]));
    if (run.status !== 0) {
      deps.log(`The sandbox run failed (exit ${run.status}). Nothing was written to result.md. See lab/.work/${LAB_NAME}/run/sandbox.log.`);
      return 1;
    }
    const rawFile = join(work, 'raw.json');
    const clean = saveRealOutputs(deps, readFileSync(rawFile, 'utf8'), run.output, [key]);
    writeFileSync(rawFile, clean);
    return recordResult(deps, clean, testSet);
  } finally {
    deps.removeLabTree(tree);
  }
}

/** Everything the real run does, against fake-openai.cjs: no key, and nothing outside the dry-run folder. */
async function dryRun(deps: Deps): Promise<number> {
  const testSet = loadTestSet(deps.root);
  const work = workDir(deps.root, 'dry-run');
  const tree = join(work, 'tree');
  resetDir(work);
  const sandboxDir = `/lab-work/${LAB_NAME}/dry-run`;
  await writeInput(deps, testSet, { audioDir: join(work, 'audio'), audioInSandbox: `${sandboxDir}/audio`, inputFile: join(work, 'input.json'), fake: true });
  deps.prepareDryTree(loadPr(deps.root), tree);
  try {
    const run = deps.sandbox({ worktree: tree, input: `${sandboxDir}/input.json`, out: `${sandboxDir}/raw.json`, fake: true, env: { SANDBOX_ENV: '' } });
    writeFileSync(join(work, 'sandbox.log'), scrubSecrets(run.output, []));
    if (run.status !== 0) {
      deps.log(`The dry run failed (exit ${run.status}). See lab/.work/${LAB_NAME}/dry-run/sandbox.log.`);
      return 1;
    }
    const raw = parseRaw(readFileSync(join(work, 'raw.json'), 'utf8'), testSet);
    const preview = `Dry run against a fake provider. Nothing here is measured.\n\n${renderBody(raw, testSet, loadPrices(deps.root))}\n`;
    writeFileSync(join(work, 'result.preview.md'), preview);
    deps.log(preview);
    const missing = whatIsMissing(raw);
    if (missing) deps.log(`The dry run reached the end but still needs ${missing}.`);
    return missing ? 1 : 0;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const FLAGS = ['--dry-run', '--no-keys'];

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const unknown = argv.filter((a) => !FLAGS.includes(a));
  if (unknown.length) throw new Error(`Unknown flag: ${unknown.join(' ')}. This lab takes ${FLAGS.join(' and ')}.`);
  if (argv.includes('--dry-run')) return dryRun(deps);
  const env = argv.includes('--no-keys') ? {} : loadEnv(deps.root, deps.env);
  try {
    const keys = requireKeys([KEY_NAME], env);
    return await measure(keys[KEY_NAME], deps);
  } catch (error) {
    if (error instanceof NeedsKeyError) return notRun(deps);
    throw error;
  }
}

function harnessCommand(request: SandboxRequest): string {
  const fake = request.fake ? ' --fake' : '';
  return `node /lab/${LAB_NAME}/harness.cjs --repo /repo --input ${request.input} --out ${request.out}${fake}`;
}

function realDeps(root: string): Deps {
  const clone = join(root, 'tmp', 'anything-llm');
  const patchesOf = (pr: PrFile) => pr.stages.flatMap((s) => s.patches).map((p) => join(labDir(root), p));
  return {
    root,
    env: process.env,
    sandbox: (request) => {
      const script = join(root, 'scripts', 'sandbox.sh');
      const run = spawnSync(script, ['anything-llm', request.worktree, harnessCommand(request)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...request.env } });
      if (run.error) throw run.error;
      return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
    },
    prepareLabTree: (pr, dest) => prepareWorktree(clone, dest, pr.baseCommit, patchesOf(pr)),
    removeLabTree: (dest) => removeWorktree(clone, dest),
    prepareDryTree: (pr, dest) => prepareArchiveTree(clone, dest, pr.baseCommit, patchesOf(pr), DRY_RUN_PATHS),
    fetchAudio: fetchBytes,
    today: () => new Date().toISOString().slice(0, 10),
    log: (line) => console.log(line),
  };
}

if (import.meta.main) {
  main(process.argv.slice(2), realDeps(REPO_ROOT)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`lab 02: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
