// npm run lab -- 05 [--dry-run] [--no-keys]
// Runs AURA's release binary in the Docker sandbox on the examples this pull request
// moves, before and after, and records the real error and the real answers. With only
// ANTHROPIC_API_KEY the reasoning case is absent, and the result is partial and needs OPENAI_API_KEY.
//   --dry-run  the same pipeline against a fake provider, writing only under lab/.work/
//   --no-keys  the same path with an empty environment: writes not_run and exits 3
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT_NEEDS_KEY, loadEnv, NeedsKeyError, REPO_ROOT } from '../shared/env.ts';
import { openRouterPrice } from '../shared/prices.ts';
import { readResult, tryReadResult, writeResult } from '../shared/result.ts';
import { ensureBinary, fetchBytes, type BinaryInfo, type FetchBytes } from '../shared/aura-binary.ts';
import { ANTHROPIC_KEY, LAB_RELEASE_TAG, OPENAI_KEY, requestFor, selectCases, withBaseUrls, withSummarizedDisplay, type LabCase } from './cases.ts';
import { startFakeProvider } from './fake-provider.ts';
import { decide, emptyThinkingProblems, missedCases, probeProblems, readOutcome, readRawCase, renderBody, requestProblems, scrub, scrubTree, type CaseOutcome, type NotRun } from './report.ts';

const LAB = '05-models';
const PRICE_ID = 'anthropic/claude-sonnet-5.5';
const NOT_RUN = `It sends one real chat request through the AURA release binary for the retired model, the new model and the reasoning example, and records the real error and the real answers; it needs ${ANTHROPIC_KEY} for the minimal example, and ${OPENAI_KEY} as well for the reasoning example, because that file runs its coordinator and fast worker on OpenAI.`;
const ALL_KEYS = [ANTHROPIC_KEY, OPENAI_KEY];
/** Every case's config names this one, so without it nothing can run. */
const KEY_EVERY_CASE_NEEDS = ANTHROPIC_KEY;
/** What a real run clears from out/: repo-tests.json has its own lifecycle (docs/contracts.md). */
const OUTLIVES_A_RUN = /^repo-tests/;

/** Never real: the sandbox gets these in a dry run even when real keys are exported. */
export const FAKE_KEYS = { ANTHROPIC_API_KEY: 'dry-run-not-a-real-key-a', OPENAI_API_KEY: 'dry-run-not-a-real-key-o' };

export interface SandboxCall { worktree: string; command: string; env: Record<string, string> }

export interface LabDeps {
  env: () => Record<string, string | undefined>;
  arch: () => Promise<string>;
  fetcher: FetchBytes;
  sandbox: (call: SandboxCall) => Promise<number>;
  now: () => Date;
  log: (line: string) => void;
}

interface Paths {
  root: string;
  labDir: string;
  clone: string;
  result: string;
  out: string;
  binDir: string;
  work: string;
  sandboxWork: string;
  worktree: string;
}

function pathsFor(root: string, dryRun: boolean): Paths {
  const mode = dryRun ? 'dry-run' : 'run';
  const labDir = join(root, 'lab', LAB);
  const work = join(root, 'lab', '.work', LAB, mode);
  return {
    root,
    labDir,
    clone: join(root, 'tmp', 'aura'),
    result: join(labDir, 'result.md'),
    out: join(labDir, 'out'),
    binDir: join(root, 'lab', '.work', 'bin'),
    work,
    sandboxWork: `/lab-work/${LAB}/${mode}`,
    worktree: dryRun ? join(work, 'wt') : join(root, 'tmp', 'lab-wt-05'),
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function loadPlan(labDir: string): { baseCommit: string; patchFiles: string[] } {
  const pr = JSON.parse(readFileSync(join(labDir, 'pr.json'), 'utf8')) as { baseCommit?: unknown; stages?: { patches: string[] }[] };
  if (typeof pr.baseCommit !== 'string' || !pr.stages?.length) throw new Error('pr.json has no baseCommit or stages');
  return { baseCommit: pr.baseCommit, patchFiles: pr.stages.flatMap((s) => s.patches).map((p) => join(labDir, p)) };
}

function removeWorktree(clone: string, path: string): void {
  const registered = git(clone, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`);
  if (registered) git(clone, 'worktree', 'remove', '--force', path);
  rmSync(path, { recursive: true, force: true });
  git(clone, 'worktree', 'prune');
}

function configFor(labCase: LabCase, paths: Paths, baseCommit: string, apiBase: string | null): string {
  const shipped = labCase.from === 'base' ? git(paths.clone, 'show', `${baseCommit}:${labCase.file}`) : readFileSync(join(paths.worktree, labCase.file), 'utf8');
  const shaped = labCase.summarizedDisplay ? withSummarizedDisplay(shipped) : shipped;
  return apiBase ? withBaseUrls(shaped, apiBase) : shaped;
}

function writeInputs(cases: readonly LabCase[], paths: Paths, baseCommit: string, apiBase: string | null, binary: BinaryInfo): void {
  for (const dir of ['configs', 'requests', 'raw']) mkdirSync(join(paths.work, dir), { recursive: true });
  const lines = cases.map((c) => {
    writeFileSync(join(paths.work, 'configs', `${c.id}.toml`), configFor(c, paths, baseCommit, apiBase));
    writeFileSync(join(paths.work, 'requests', `${c.id}.json`), requestFor(c));
    return [c.id, `${paths.sandboxWork}/configs/${c.id}.toml`, `${paths.sandboxWork}/requests/${c.id}.json`, `/lab-work/bin/${basename(binary.file)}`].join('\t');
  });
  writeFileSync(join(paths.work, 'cases.tsv'), `${lines.join('\n')}\n`);
}

interface Exercised { outcomes: CaseOutcome[]; binary: BinaryInfo }

/** The table says which binary ran, so it takes the binary's own word for it. */
function checkVersions(cases: readonly LabCase[], paths: Paths): void {
  for (const c of cases) {
    const reported = readFileSync(join(paths.work, 'raw', c.id, 'version.txt'), 'utf8').trim();
    const expected = `aura ${LAB_RELEASE_TAG.replace(/^v/, '')}`;
    if (reported !== expected) throw new Error(`the binary for ${c.id} reports "${reported}", expected "${expected}"`);
  }
}

/** The pipeline both modes share: the fork's files at the patched commit, the binary, the sandbox. */
async function exercise(cases: readonly LabCase[], paths: Paths, keys: Record<string, string>, apiBase: string | null, deps: LabDeps): Promise<Exercised> {
  const { baseCommit, patchFiles } = loadPlan(paths.labDir);
  removeWorktree(paths.clone, paths.worktree);
  rmSync(paths.work, { recursive: true, force: true });
  mkdirSync(paths.work, { recursive: true });
  const binary = await ensureBinary(paths.binDir, await deps.arch(), deps.fetcher, LAB_RELEASE_TAG);
  git(paths.clone, 'worktree', 'add', '--force', '--detach', paths.worktree, baseCommit);
  try {
    for (const patch of patchFiles) git(paths.worktree, 'apply', patch);
    writeInputs(cases, paths, baseCommit, apiBase, binary);
    const command = `bash /lab/${LAB}/harness/run-cases.sh ${paths.sandboxWork}`;
    const code = await deps.sandbox({ worktree: paths.worktree, command, env: { ...keys, SANDBOX_ENV: Object.keys(keys).join(' ') } });
    if (code !== 0) throw new Error(`the sandbox exited with code ${code}`);
  } finally {
    removeWorktree(paths.clone, paths.worktree);
  }
  checkVersions(cases, paths);
  const outcomes = cases.map((c) => readOutcome(c, readRawCase(join(paths.work, 'raw', c.id))));
  return { outcomes, binary };
}

async function dryRun(root: string, deps: LabDeps): Promise<number> {
  const paths = pathsFor(root, true);
  const cases = selectCases({ dryRun: true });
  const fake = await startFakeProvider();
  try {
    const { outcomes, binary } = await exercise(cases, paths, FAKE_KEYS, `http://host.docker.internal:${fake.port}`, deps);
    const verdict = decide(cases, outcomes);
    const problems = [...(verdict.needs ? [verdict.needs] : []), ...requestProblems(outcomes), ...probeProblems(outcomes), ...emptyThinkingProblems(outcomes)];
    const preview = renderBody(cases, outcomes, binary, openRouterPrice(PRICE_ID));
    writeFileSync(join(paths.work, 'result-preview.md'), `${preview}\n`);
    writeFileSync(join(paths.work, 'fake-requests.json'), JSON.stringify(fake.requests(), null, 1));
    deps.log(preview);
    for (const problem of problems) deps.log(`dry run problem: ${problem}`);
    return problems.length ? 1 : 0;
  } finally {
    await fake.close();
  }
}

function clearLastRun(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => !OUTLIVES_A_RUN.test(n))) rmSync(join(dir, name), { recursive: true, force: true });
}

function saveRaw(paths: Paths, secrets: readonly string[], keepEarlier: boolean): string {
  const target = keepEarlier ? join(paths.work, 'scrubbed') : paths.out;
  clearLastRun(target);
  scrubTree(join(paths.work, 'raw'), target, secrets);
  rmSync(join(paths.work, 'raw'), { recursive: true, force: true });
  return target;
}

function saveResult(cases: readonly LabCase[], notRun: readonly NotRun[], paths: Paths, run: Exercised, secrets: readonly string[], deps: LabDeps): number {
  if (run.outcomes.every((o) => o.kind === 'no_response')) throw new Error(`no case got a response from AURA; see ${join(paths.work, 'raw')}`);
  const missingKeys = [...new Set(notRun.flatMap((n) => n.missingKeys))];
  const verdict = decide(cases, run.outcomes, missingKeys);
  const keepEarlier = readResult(paths.result)?.status === 'measured' && verdict.status !== 'measured';
  const saved = saveRaw(paths, secrets, keepEarlier);
  const { tag, asset, sha256, url } = run.binary;
  writeFileSync(join(saved, 'binary.json'), `${JSON.stringify({ tag, asset, sha256, url }, null, 2)}\n`);
  const body = scrub(renderBody(cases, run.outcomes, run.binary, openRouterPrice(PRICE_ID), notRun), secrets);
  const written = writeResult(paths.result, { lab: LAB, status: verdict.status, measured_at: deps.now().toISOString().slice(0, 10), needs: verdict.needs, body });
  deps.log(`${paths.result}: ${written.status}. Raw outputs: ${saved}`);
  deps.log(body);
  if (missedCases(cases, run.outcomes).length) return 1;
  return missingKeys.length ? EXIT_NEEDS_KEY : 0;
}

/** Which cases these keys can run, and what the others are waiting on. Keys never reach a case that doesn't name them. */
function planFor(env: Record<string, string | undefined>): { keys: Record<string, string>; cases: readonly LabCase[]; notRun: readonly NotRun[] } {
  const missing = ALL_KEYS.filter((k) => !env[k]);
  if (missing.includes(KEY_EVERY_CASE_NEEDS)) throw new NeedsKeyError(missing);
  const all = selectCases({ dryRun: false });
  const runnable = (c: LabCase) => c.keys.every((k) => !missing.includes(k));
  return {
    keys: Object.fromEntries(ALL_KEYS.filter((k) => !missing.includes(k)).map((k) => [k, env[k] as string])),
    cases: all.filter(runnable),
    notRun: all.filter((c) => !runnable(c)).map((c) => ({ label: c.label, missingKeys: c.keys.filter((k) => missing.includes(k)) })),
  };
}

async function realRun(root: string, deps: LabDeps): Promise<number> {
  const paths = pathsFor(root, false);
  const { keys, cases, notRun } = planFor(deps.env());
  if (notRun.length && tryReadResult(paths.result).result?.status === 'measured') {
    deps.log(`Needs ${[...new Set(notRun.flatMap((n) => n.missingKeys))].join(' and ')} for the whole table. Kept the earlier measured result, and sent nothing.`);
    return EXIT_NEEDS_KEY;
  }
  const run = await exercise(cases, paths, keys, null, deps);
  return saveResult(cases, notRun, paths, run, Object.values(keys), deps);
}

export async function runLab(opts: { root: string; dryRun: boolean }, deps: LabDeps): Promise<number> {
  try {
    return opts.dryRun ? await dryRun(opts.root, deps) : await realRun(opts.root, deps);
  } catch (e) {
    if (e instanceof NeedsKeyError) {
      writeResult(pathsFor(opts.root, false).result, { lab: LAB, status: 'not_run', needs: e.keys.join(' and '), body: NOT_RUN });
      deps.log(e.message);
      return EXIT_NEEDS_KEY;
    }
    deps.log(`lab ${LAB} stopped: ${(e as Error).message}`);
    return 1;
  }
}

function runSandbox(call: SandboxCall): Promise<number> {
  const child = spawn(join(REPO_ROOT, 'scripts', 'sandbox.sh'), ['aura', call.worktree, call.command], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...call.env },
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function sandboxArch(): Promise<string> {
  return Promise.resolve(execFileSync('docker', ['version', '--format', '{{.Server.Arch}}'], { encoding: 'utf8' }).trim());
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const code = await runLab({ root: REPO_ROOT, dryRun: args.includes('--dry-run') }, {
    env: args.includes('--no-keys') ? () => ({}) : () => loadEnv(),
    arch: sandboxArch,
    fetcher: fetchBytes,
    sandbox: runSandbox,
    now: () => new Date(),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.exit(code);
}
