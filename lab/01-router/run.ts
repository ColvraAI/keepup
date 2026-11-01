// npm run lab -- 01 [--dry-run] [--no-keys] [--variant jev]
// Runs the router's agent path and its decision-model path on the same 60 messages, inside
// the sandbox, on the fork's own code. Exit code 3 means it's waiting on a key; 1 means a
// run that didn't finish or didn't measure everything.
//   --dry-run       the whole pipeline against a fake provider, writing only under lab/.work/01-router/dry-run/
//   --no-keys       run as if no key exists, without reading .env, which writes the honest not_run result
//   --variant jev   the Claude-only variant, into result-jev.md
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT_NEEDS_KEY, loadEnv, NeedsKeyError, REPO_ROOT, requireKeys } from '../shared/env.ts';
import { outDirFor, tryReadResult, writeResult, type LabResult } from '../shared/result.ts';
import { agentRates, anthropicRates, decisionsRates, jevRates, onboardingModel, substituteFor } from './rates.ts';
import { buildResult, LAB_NAME, parseLongRules, parseRaw, parseTestset, scrubSecrets, VARIANTS, type RatesByRoute, type VariantName } from './report.ts';

const DRY_RUN_PATHS = ['server', 'docker'];
const HARNESS = `/lab/${LAB_NAME}/harness/main.cjs`;

interface PrFile {
  baseCommit: string;
  stages: { patches: string[] }[];
}

export interface SandboxRequest {
  worktree: string;
  outRelative: string;
  configRelative: string;
  real: boolean;
  env: Record<string, string>;
}

export interface AgentChoice {
  candidates: string[];
  onboarding: string;
  deprecation: { shutdown: string; substitute: string } | null;
}

export interface Deps {
  root: string;
  env: Record<string, string | undefined>;
  sandbox: (request: SandboxRequest) => { status: number; output: string };
  prepareLabTree: (pr: PrFile, patches: string[], dest: string) => void;
  removeLabTree: (dest: string) => void;
  prepareDryTree: (pr: PrFile, patches: string[], dest: string) => void;
  agentCandidates: (variant: VariantName, pr: PrFile) => AgentChoice;
  ratesFor: (variant: VariantName, agentModel: string, onboarding: string) => RatesByRoute;
  today: () => string;
  log: (line: string) => void;
}

const labDir = (root: string) => join(root, 'lab', LAB_NAME);

function loadPr(root: string, variant: VariantName): PrFile {
  return JSON.parse(readFileSync(join(labDir(root), VARIANTS[variant].prFile), 'utf8'));
}

function patchesOf(pr: PrFile, root: string): string[] {
  return pr.stages.flatMap((stage) => stage.patches).map((patch) => join(labDir(root), patch));
}

function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function writeConfig(deps: Deps, variant: VariantName, choice: AgentChoice, work: string, fake: boolean): void {
  const { rules, messages } = parseTestset(readFileSync(join(labDir(deps.root), 'testset.jsonl'), 'utf8'));
  const config = VARIANTS[variant];
  const longRules = config.afterSetting === 'decisions' ? parseLongRules(readFileSync(join(labDir(deps.root), 'testset-long-rules.jsonl'), 'utf8')) : [];
  writeFileSync(
    join(work, 'config.json'),
    JSON.stringify({
      variant,
      afterSetting: config.afterSetting,
      agent: { provider: config.agentProvider, candidates: choice.candidates },
      fakeRetired: fake && choice.deprecation ? [choice.onboarding] : [],
      rules,
      longRules,
      messages,
    }),
  );
}

function notRun(variant: VariantName, deps: Deps, needs: string): number {
  const config = VARIANTS[variant];
  const kept = writeResult(join(labDir(deps.root), config.resultFile), { lab: config.lab, status: 'not_run', needs, body: config.notRun });
  deps.log(kept.status === 'not_run' ? `Needs ${needs}. Nothing was measured.` : `Needs ${needs}. Kept the earlier ${kept.status} result.`);
  return EXIT_NEEDS_KEY;
}

/**
 * A run saved here is the one behind this variant's result. result.md's manifest covers
 * everything under out/ except a folder with its own manifest, so a variant's folder gets an
 * empty one from its first run, or its next run would count as an edit to result.md's. It proves
 * nothing: a result that says measured with no files listed is refused, and a measured run replaces it.
 */
function saveRealOutputs(deps: Deps, variant: VariantName, clean: string, log: string, secrets: readonly string[]): void {
  const config = VARIANTS[variant];
  const out = join(labDir(deps.root), 'out', variant);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'raw.jsonl'), clean);
  writeFileSync(join(out, 'sandbox.log'), scrubSecrets(log, secrets));
  const manifest = join(out, 'manifest.json');
  if (outDirFor(join(labDir(deps.root), config.resultFile)) === out && !existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ lab: config.lab, variant, files: [] }, null, 2)}\n`);
}

/** writeResult won't let this run replace a measured result, so the raw files behind that result have to stay as well. */
function replacesNothing(resultPath: string, result: LabResult): boolean {
  return result.status !== 'measured' && tryReadResult(resultPath).result?.status === 'measured';
}

function resultOf(rawText: string, variant: VariantName, choice: AgentChoice, deps: Deps) {
  const raw = parseRaw(rawText);
  return buildResult({ raw, rates: deps.ratesFor(variant, raw.meta.agentModel, choice.onboarding), measuredAt: deps.today(), variant, onboarding: choice.onboarding, deprecation: choice.deprecation });
}

/** The real run. Nothing reaches result.md or out/ unless the harness finished, and a weaker run leaves a measured one as it was. */
function measure(variant: VariantName, keys: Record<string, string>, deps: Deps): number {
  const config = VARIANTS[variant];
  const pr = loadPr(deps.root, variant);
  const relative = `${LAB_NAME}/run/${variant}`;
  const work = join(deps.root, 'lab', '.work', relative);
  const tree = join(deps.root, 'tmp', config.treeName);
  const secrets = Object.values(keys);
  resetDir(work);
  const choice = deps.agentCandidates(variant, pr);
  writeConfig(deps, variant, choice, work, false);
  deps.prepareLabTree(pr, patchesOf(pr, deps.root), tree);
  try {
    const run = deps.sandbox({
      worktree: tree,
      outRelative: `${relative}/raw.jsonl`,
      configRelative: `${relative}/config.json`,
      real: true,
      env: { SANDBOX_ENV: config.keys.join(' '), ...keys },
    });
    writeFileSync(join(work, 'sandbox.log'), scrubSecrets(run.output, secrets));
    if (run.status !== 0) {
      deps.log(`The sandbox run failed (exit ${run.status}). Nothing was written to ${config.resultFile}. See lab/.work/${relative}/sandbox.log.`);
      return 1;
    }
    const rawFile = join(work, 'raw.jsonl');
    const clean = scrubSecrets(readFileSync(rawFile, 'utf8'), secrets);
    writeFileSync(rawFile, clean);
    const result = resultOf(clean, variant, choice, deps);
    const resultPath = join(labDir(deps.root), config.resultFile);
    if (replacesNothing(resultPath, result)) {
      deps.log(`This run is ${result.status}: it needs ${result.needs}. ${config.resultFile} and the raw files behind it in out/${variant}/ stay as the measured run left them. This run's output is in lab/.work/${relative}/.`);
      return 1;
    }
    saveRealOutputs(deps, variant, clean, run.output, secrets);
    const kept = writeResult(resultPath, result);
    deps.log(`${config.resultFile} is ${kept.status}.`);
    return result.status === 'measured' ? 0 : 1;
  } finally {
    deps.removeLabTree(tree);
  }
}

/** Everything the real run does, against the fake provider: no key, and nothing outside the dry-run folder. */
function dryRun(variant: VariantName, deps: Deps): number {
  const relative = `${LAB_NAME}/dry-run/${variant}`;
  const work = join(deps.root, 'lab', '.work', relative);
  const tree = join(work, 'tree');
  const pr = loadPr(deps.root, variant);
  resetDir(work);
  const choice = deps.agentCandidates(variant, pr);
  writeConfig(deps, variant, choice, work, true);
  deps.prepareDryTree(pr, patchesOf(pr, deps.root), tree);
  try {
    const run = deps.sandbox({ worktree: tree, outRelative: `${relative}/raw.jsonl`, configRelative: `${relative}/config.json`, real: false, env: { SANDBOX_ENV: '' } });
    writeFileSync(join(work, 'sandbox.log'), run.output);
    if (run.status !== 0) {
      deps.log(`The dry run failed (exit ${run.status}). See lab/.work/${relative}/sandbox.log.`);
      return 1;
    }
    const result = resultOf(readFileSync(join(work, 'raw.jsonl'), 'utf8'), variant, choice, deps);
    const preview = `Dry run against a fake provider. Nothing here is measured. It would be status ${result.status}.\n\n${result.body}\n`;
    writeFileSync(join(work, 'result.preview.md'), preview);
    deps.log(preview);
    return result.status === 'measured' ? 0 : 1;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

interface Options {
  dryRun: boolean;
  noKeys: boolean;
  variant: VariantName;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { dryRun: false, noKeys: false, variant: 'decisions' };
  const parsed = argv.reduce<{ options: Options; skip: boolean }>(
    (state, arg, index) => {
      if (state.skip) return { ...state, skip: false };
      if (arg === '--dry-run') return { ...state, options: { ...state.options, dryRun: true } };
      if (arg === '--no-keys') return { ...state, options: { ...state.options, noKeys: true } };
      if (arg !== '--variant') throw new Error(`Unknown flag: ${arg}. This lab takes --dry-run, --no-keys and --variant jev.`);
      const value = argv[index + 1];
      if (value !== 'jev' && value !== 'decisions') throw new Error(`Unknown variant: ${value}. The variants are decisions and jev.`);
      return { skip: true, options: { ...state.options, variant: value } };
    },
    { options, skip: false },
  );
  return parsed.options;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const options = parseOptions(argv);
  if (options.dryRun) return dryRun(options.variant, deps);
  const env = options.noKeys ? {} : loadEnv(deps.root, deps.env);
  const names = VARIANTS[options.variant].keys;
  try {
    return measure(options.variant, requireKeys(names, env), deps);
  } catch (error) {
    if (error instanceof NeedsKeyError) return notRun(options.variant, deps, names.join(' and '));
    throw error;
  }
}

function git(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The base commit plus the patches, unpacked outside the clone. The ceiling stops git
 * finding this repo's own .git above dest, where `git apply` would silently skip every path.
 */
function prepareTree(clone: string, dest: string, base: string, patches: readonly string[], paths: readonly string[]): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tar = join(dest, '.base.tar');
  git(['-C', clone, 'archive', `--output=${tar}`, base, '--', ...paths]);
  execFileSync('tar', ['-xf', tar, '-C', dest]);
  rmSync(tar);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dest) };
  for (const patch of patches) git(['apply', '--whitespace=nowarn', patch], dest, env);
}

function harnessCommand(request: SandboxRequest): string {
  const real = request.real ? ' --real' : '';
  return `cd /repo/server && node ${HARNESS} --config /lab-work/${request.configRelative} --repo /repo --out /lab-work/${request.outRelative}${real}`;
}

function realAgentChoice(root: string, clone: string, variant: VariantName, pr: PrFile): AgentChoice {
  const settings = git(['-C', clone, 'show', `${pr.baseCommit}:server/models/systemSettings.js`]);
  const provider = VARIANTS[variant].agentProvider;
  const onboarding = onboardingModel(settings, provider);
  if (provider === 'anthropic') return { candidates: [onboarding], onboarding, deprecation: null };
  const deprecation = substituteFor(onboarding, readFileSync(join(root, 'tmp', 'vendor-docs', 'deprecations.md'), 'utf8'));
  return { candidates: deprecation ? [onboarding, deprecation.substitute] : [onboarding], onboarding, deprecation };
}

function realRates(root: string, variant: VariantName, agentModel: string, onboarding: string): RatesByRoute {
  if (variant === 'jev') return { agent: anthropicRates(agentModel, root), jev: jevRates(root) };
  const swapped = agentModel === onboarding ? {} : { onboarding: agentRates(onboarding, root) };
  return { agent: agentRates(agentModel, root), decisions: decisionsRates(root), ...swapped };
}

/** A dry run gets no key names at all, so nothing can reach the container by accident. */
function sandboxEnv(request: SandboxRequest): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.endsWith('_API_KEY')));
  return { ...inherited, ...request.env };
}

function realDeps(root: string): Deps {
  const clone = join(root, 'tmp', 'anything-llm');
  return {
    root,
    env: process.env,
    sandbox: (request) => {
      const script = join(root, 'scripts', 'sandbox.sh');
      const run = spawnSync(script, ['anything-llm', request.worktree, harnessCommand(request)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: sandboxEnv(request) });
      if (run.error) throw run.error;
      return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
    },
    prepareLabTree: (pr, patches, dest) => prepareTree(clone, dest, pr.baseCommit, patches, ['.']),
    removeLabTree: (dest) => {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    },
    prepareDryTree: (pr, patches, dest) => prepareTree(clone, dest, pr.baseCommit, patches, DRY_RUN_PATHS),
    agentCandidates: (variant, pr) => realAgentChoice(root, clone, variant, pr),
    ratesFor: (variant, agentModel, onboarding) => realRates(root, variant, agentModel, onboarding),
    today: () => new Date().toISOString().slice(0, 10),
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

if (import.meta.main) {
  main(process.argv.slice(2), realDeps(REPO_ROOT)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`lab 01: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
