// npm run lab -- 07 [--dry-run] [--no-keys]
// Through AnythingLLM's own OpenAI provider on the fork, inside the sandbox: one real
// request naming gpt-4.1-nano, which records the error OpenAI returns now it has shut
// down, and one with no model set, which records what the new default answers. Exit code
// 3 means it's waiting on a key; 1 means a run that didn't finish; 2 means usage.
//   --dry-run  the whole pipeline against a fake provider, writing only under lab/.work/07-default-model/dry-run/
//   --no-keys  run as if no key exists, without reading .env, which writes the honest not_run result
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareArchiveTree, prepareWorktree, removeWorktree } from '../06-models/tree.ts';
import { EXIT_NEEDS_KEY, loadEnv, NeedsKeyError, REPO_ROOT, requireKeys } from '../shared/env.ts';
import { readResult, writeResult, type LabResult } from '../shared/result.ts';
import { buildResult, KEY_NAME, LAB_NAME, NEW_MODEL, NOT_RUN_SENTENCE, OLD_MODEL, parseRaw, renderBody, scrubSecrets, teamLine, type RawRun } from './report.ts';

const DRY_RUN_PATHS = ['server'];

interface PrFile {
  baseCommit: string;
  stages: { patches: string[] }[];
}

export interface SandboxRequest {
  worktree: string;
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
  teamLine: () => string;
  today: () => string;
  log: (line: string) => void;
}

const labDir = (root: string) => join(root, 'lab', LAB_NAME);
const workDir = (root: string, name: string) => join(root, 'lab', '.work', LAB_NAME, name);
const resultPath = (root: string) => join(labDir(root), 'result.md');

function loadPr(root: string): PrFile {
  return JSON.parse(readFileSync(join(labDir(root), 'pr.json'), 'utf8'));
}

function patchesOf(pr: PrFile, root: string): string[] {
  return pr.stages.flatMap((s) => s.patches).map((p) => join(labDir(root), p));
}

function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function notRun(deps: Deps): number {
  const kept = writeResult(resultPath(deps.root), { lab: LAB_NAME, status: 'not_run', needs: KEY_NAME, body: NOT_RUN_SENTENCE });
  deps.log(kept.status === 'not_run' ? `Needs ${KEY_NAME}. Nothing was measured.` : `Needs ${KEY_NAME}. Kept the earlier ${kept.status} result.`);
  return EXIT_NEEDS_KEY;
}

/** Copies from the work folder, whose files are already scrubbed. */
function saveOutputs(root: string, work: string): void {
  const out = join(labDir(root), 'out');
  mkdirSync(out, { recursive: true });
  copyFileSync(join(work, 'raw.json'), join(out, 'responses.json'));
  copyFileSync(join(work, 'sandbox.log'), join(out, 'sandbox.log'));
}

/** Scrubs first, then checks. The scrubbed copy stays under lab/.work/ whatever happens next. */
function readRealRun(work: string, key: string): RawRun {
  const rawFile = join(work, 'raw.json');
  const clean = scrubSecrets(readFileSync(rawFile, 'utf8'), [key]);
  writeFileSync(rawFile, clean);
  return parseRaw(clean);
}

/** out/ and result.md move together, so a measured table always matches the run saved under out/. */
function record(deps: Deps, work: string, result: LabResult): number {
  const file = resultPath(deps.root);
  if (result.status !== 'measured' && readResult(file)?.status === 'measured') {
    deps.log(`This run came back weaker than the measured result, so out/ and result.md stay as they are. Its raw output is in lab/.work/${LAB_NAME}/run/.`);
    return 1;
  }
  saveOutputs(deps.root, work);
  writeResult(file, result);
  deps.log(`result.md is ${result.status}.`);
  return result.status === 'measured' ? 0 : 1;
}

/** The real run. Nothing from it reaches out/ or result.md unless the harness finished, its output checks out, and it's no weaker than what's there. */
function measure(key: string, deps: Deps): number {
  const pr = loadPr(deps.root);
  const team = deps.teamLine(); // this can fail, so it runs before any money is spent
  const work = workDir(deps.root, 'run');
  const tree = join(deps.root, 'tmp', 'lab-wt-07');
  resetDir(work);
  try {
    deps.prepareLabTree(pr, tree);
    const out = `/lab-work/${LAB_NAME}/run/raw.json`;
    const run = deps.sandbox({ worktree: tree, out, fake: false, env: { SANDBOX_ENV: KEY_NAME, [KEY_NAME]: key } });
    writeFileSync(join(work, 'sandbox.log'), scrubSecrets(run.output, [key]));
    if (run.status !== 0) {
      deps.log(`The sandbox run failed (exit ${run.status}). Nothing was written to result.md. See lab/.work/${LAB_NAME}/run/sandbox.log.`);
      return 1;
    }
    const raw = readRealRun(work, key);
    return record(deps, work, buildResult({ raw, teamLine: team, measuredAt: deps.today() }));
  } finally {
    deps.removeLabTree(tree);
  }
}

function dryRunPreview(deps: Deps, rawText: string): { text: string; ok: boolean } {
  const raw = parseRaw(rawText);
  const body = renderBody(raw, deps.teamLine());
  const [old, next] = raw.runs;
  return { text: `Dry run against a fake provider. Nothing here is measured.\n\n${body}\n`, ok: !old.answered && next.answered };
}

/** Everything the real run does, against fake-openai.cjs: no key, and nothing outside the dry-run folder. */
function dryRun(deps: Deps): number {
  const work = workDir(deps.root, 'dry-run');
  const tree = join(work, 'tree');
  resetDir(work);
  try {
    deps.prepareDryTree(loadPr(deps.root), tree);
    const out = `/lab-work/${LAB_NAME}/dry-run/raw.json`;
    const run = deps.sandbox({ worktree: tree, out, fake: true, env: { SANDBOX_ENV: '' } });
    writeFileSync(join(work, 'sandbox.log'), scrubSecrets(run.output, []));
    if (run.status !== 0) {
      deps.log(`The dry run failed (exit ${run.status}). See lab/.work/${LAB_NAME}/dry-run/sandbox.log.`);
      return 1;
    }
    const preview = dryRunPreview(deps, readFileSync(join(work, 'raw.json'), 'utf8'));
    writeFileSync(join(work, 'result.preview.md'), preview.text);
    deps.log(preview.text);
    return preview.ok ? 0 : 1;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const FLAGS = ['--dry-run', '--no-keys'];
const EXIT_USAGE = 2;

function keyFrom(env: Record<string, string | undefined>): string | null {
  try {
    return requireKeys([KEY_NAME], env)[KEY_NAME];
  } catch (error) {
    if (error instanceof NeedsKeyError) return null;
    throw error;
  }
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const unknown = argv.filter((a) => !FLAGS.includes(a));
  if (unknown.length) {
    deps.log(`Unknown flag: ${unknown.join(' ')}. This lab takes ${FLAGS.join(' and ')}.`);
    return EXIT_USAGE;
  }
  if (argv.includes('--dry-run')) return dryRun(deps);
  const key = keyFrom(argv.includes('--no-keys') ? {} : loadEnv(deps.root, deps.env));
  return key ? measure(key, deps) : notRun(deps);
}

function harnessCommand(request: SandboxRequest): string {
  const fake = request.fake ? ' --fake' : '';
  return `node /lab/${LAB_NAME}/harness.cjs --repo /repo --out ${request.out} --old-model ${OLD_MODEL} --new-model ${NEW_MODEL}${fake}`;
}

function realDeps(root: string): Deps {
  const clone = join(root, 'tmp', 'anything-llm');
  const gitRead = (args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    root,
    env: process.env,
    sandbox: (request) => {
      const script = join(root, 'scripts', 'sandbox.sh');
      const run = spawnSync(script, ['anything-llm', request.worktree, harnessCommand(request)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...request.env } });
      if (run.error) throw run.error;
      return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
    },
    prepareLabTree: (pr, dest) => prepareWorktree(clone, dest, pr.baseCommit, patchesOf(pr, root)),
    removeLabTree: (dest) => removeWorktree(clone, dest),
    prepareDryTree: (pr, dest) => prepareArchiveTree(clone, dest, pr.baseCommit, patchesOf(pr, root), DRY_RUN_PATHS),
    teamLine: () => teamLine(gitRead),
    today: () => new Date().toISOString().slice(0, 10),
    log: (line) => console.log(line),
  };
}

if (import.meta.main) {
  main(process.argv.slice(2), realDeps(REPO_ROOT)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`lab 07: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
