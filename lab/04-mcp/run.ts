// npm run lab -- 04 [--dry-run [--sandbox [--junk-sentry-token]]] [--no-keys] [--no-start]
// Part one starts each MCP server the way its new example does and records the tools it
// lists, the tools AURA discovers from it and the tools AURA offers the agent. Part two
// sends one investigation prompt through AURA. Exit code 3 means it's waiting on a key; 1
// means a run that broke. A measured result is never rerun without everything it took.
//   --dry-run  the whole pipeline against fakes, writing only under lab/.work/04-mcp/dry-run/
//   --sandbox  with --dry-run: the real client, servers and AURA, with a fake model provider
//   --junk-sentry-token  with --sandbox: also send hosted Sentry a token that can't be good
//   --no-keys  run as if no key exists, without reading .env
//   --no-start start nothing, and write what the saved raw outputs support
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { EXIT_NEEDS_KEY, loadEnv, REPO_ROOT } from '../shared/env.ts';
import { readResult, renderResult, writeResult } from '../shared/result.ts';
import type { Plan, PlanServer } from './harness/sandbox-main.ts';
import { auraCommandFor, ensureAuraFromImage, type AuraInstall } from './lib/aura-image.ts';
import { startDockerBridge, type Bridge, type BridgeOptions } from './lib/bridge.ts';
import { newFileFromPatch, parseServers } from './lib/example.ts';
import type { RawRecord } from './lib/records.ts';
import { saveRaw, SECRET_NAMES, secretsFrom } from './lib/scrub.ts';
import { computeResult, missingPieces } from './lib/table.ts';
import { prepareWorktree, removeWorktree } from './lib/tree.ts';
import { ANTHROPIC_MODEL, AURA_IMAGE, AURA_TAG, BASE_COMMIT, CONFIG_NAMES, DRY_RUN_CALLS, EXAMPLE_MODEL, INVESTIGATION_PROMPT, JUNK_SENTRY_TOKEN, LAB_NAME, LLM_KEYS, NODE_VERSION, SDK_VERSION, SERVERS, type LabServer } from './servers.ts';

const LAB_DIR = import.meta.dirname;
const SANDBOX_LAB = `/lab/${LAB_NAME}`;
const SANDBOX_WORK = '/lab-work';
const BRIDGE_HOST = 'host.docker.internal';
// Inside the container, not on /lab-work: a cold `npx -y` failed twice with its cache on the bind mount.
const SANDBOX_NPM_CACHE = '/tmp/npm-cache';
const FLAGS = ['--dry-run', '--sandbox', '--junk-sentry-token', '--no-keys', '--no-start'];
const LOAD_ONLY_KEY = 'not-a-key-aura-only-needs-a-value-to-load-the-example';
const RECORD_FILE = /^(tools|aura-tools|offered|investigation)-.*\.json$/;

type Env = Record<string, string | undefined>;

export interface SandboxRequest { worktree: string; command: string; env: Record<string, string>; planFile: string }
export interface RunOutcome { status: number; output: string }

export interface Deps {
  root: string;
  env: Env;
  sandbox: (request: SandboxRequest) => Promise<RunOutcome>;
  runLocal: (planFile: string) => Promise<RunOutcome>;
  prepareTree: (base: string, patches: readonly string[], dest: string) => void;
  removeTree: (dest: string) => void;
  ensureAura: (binDir: string, arch: string) => Promise<AuraInstall>;
  dockerArch: () => string;
  pullImage: (image: string) => void;
  startBridge: (options: BridgeOptions) => Promise<Bridge>;
  log: (line: string) => void;
}

const labDir = (root: string) => join(root, 'lab', LAB_NAME);
const workRoot = (root: string) => join(root, 'lab', '.work');
const workDir = (root: string, name: string) => join(workRoot(root), LAB_NAME, name);
const outDir = (root: string) => join(labDir(root), 'out');
const resultFile = (root: string) => join(labDir(root), 'result.md');
const sandboxPath = (root: string, host: string) => host.replace(workRoot(root), SANDBOX_WORK);

function patchFiles(root: string): string[] {
  const pr = JSON.parse(readFileSync(join(labDir(root), 'pr.json'), 'utf8')) as { stages: { patches: string[] }[] };
  return pr.stages.flatMap((s) => s.patches).map((p) => join(labDir(root), p));
}

/** Empties a work folder. What took a download to get (the toolchain and AURA) can stay. */
function resetDir(dir: string, keep: readonly string[] = []): void {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (!keep.includes(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function withoutKeys(env: Env): Env {
  const hidden = new Set<string>([...SECRET_NAMES, ...CONFIG_NAMES]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !hidden.has(name)));
}

function readRecords(dir: string): RawRecord[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => RECORD_FILE.test(name)).sort();
  return files.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as RawRecord);
}

const isMeasured = (root: string): boolean => readResult(resultFile(root))?.status === 'measured';

/** Everything a measured result took: without any of it a rerun could only make the result weaker. */
export function missingForMeasured(env: Env): string[] {
  const backends = SERVERS.filter((s) => s.mustInvestigate).flatMap((s) => s.backend).filter((name) => !env[name]);
  const model = LLM_KEYS.some((name) => env[name]) ? [] : [LLM_KEYS.join(' or ')];
  return [...backends, ...model];
}

/** Servers this run only had placeholders for, whose real records are already in out/. */
function keptReal(servers: readonly PlanServer[], out: string): PlanServer[] {
  const records = readRecords(out);
  const hasReal = (id: string) => records.some((r) => r.server === id && 'credentials' in r && r.credentials === 'real');
  return servers.filter((s) => s.credentials === 'placeholder' && hasReal(s.id));
}

const belongsTo = (name: string, server: PlanServer) => name.includes(`-${server.id}.`);

/** Every raw output, scrubbed. A new success clears the failure it replaces. Real records are never replaced by placeholder ones. */
function saveOutputs(run: { rawDir: string; out: string; secrets: readonly string[]; servers: readonly PlanServer[] }, log: Deps['log']): void {
  if (!existsSync(run.rawDir)) return;
  const kept = keptReal(run.servers, run.out);
  for (const server of kept) log(`Kept the real ${SERVERS.find((s) => s.id === server.id)?.label} records in out/: this run only had placeholders for it.`);
  for (const name of readdirSync(run.rawDir).filter((n) => !kept.some((server) => belongsTo(n, server)))) {
    saveRaw(join(run.out, name), readFileSync(join(run.rawDir, name), 'utf8'), run.secrets);
    if (RECORD_FILE.test(name) && !name.endsWith('.failed.json')) rmSync(join(run.out, name.replace(/\.json$/, '.failed.json')), { force: true });
  }
}

function planServer(server: LabServer, env: Env): PlanServer | null {
  if (!server.required.every((name) => env[name])) return null;
  const real = server.backend.every((name) => env[name]);
  const canAsk = Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
  return { id: server.id, example: server.example, credentials: real ? 'real' : 'placeholder', placeholders: { ...server.placeholders }, listTools: true, discover: true, investigate: real && canAsk };
}

function llmFor(env: Env): Pick<Plan, 'llm' | 'provider' | 'model' | 'loadOnlyEnv'> {
  if (env.OPENAI_API_KEY) return { llm: { kind: 'as-is' }, provider: 'openai', model: EXAMPLE_MODEL, loadOnlyEnv: {} };
  if (env.ANTHROPIC_API_KEY) return { llm: { kind: 'anthropic', model: ANTHROPIC_MODEL }, provider: 'anthropic', model: ANTHROPIC_MODEL, loadOnlyEnv: {} };
  return { llm: { kind: 'as-is' }, provider: 'none', model: EXAMPLE_MODEL, loadOnlyEnv: { OPENAI_API_KEY: LOAD_ONLY_KEY } };
}

function toolchain(toolsDir: string): Pick<Plan, 'client' | 'sdkDir' | 'sdkVersion'> {
  return { client: 'sdk', sdkDir: `${toolsDir}/sdk`, sdkVersion: SDK_VERSION };
}

/** The harness command. Values never appear here; keys reach the sandbox by name through SANDBOX_ENV. */
function sandboxCommand(toolsDir: string, planPath: string): string {
  return [
    `bash ${SANDBOX_LAB}/harness/setup.sh ${toolsDir} ${NODE_VERSION} ${SDK_VERSION}`,
    `export PATH=${SANDBOX_LAB}/harness/bin:${toolsDir}/node/bin:$PATH`,
    `export npm_config_cache=${SANDBOX_NPM_CACHE} npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false`,
    `node ${SANDBOX_LAB}/harness/sandbox-main.ts ${planPath}`,
  ].join(' && ');
}

/** What the examples run through Docker: all the bridge will allow, and what to pull beforehand. */
function dockerCommands(repo: string, servers: readonly PlanServer[]): string[][] {
  return servers.flatMap((server) => {
    const spec = parseServers(readFileSync(join(repo, server.example), 'utf8'))[server.id];
    return spec?.transport === 'stdio' && spec.cmd[0] === 'docker' ? [[...spec.cmd.slice(1), ...spec.args]] : [];
  });
}

function sandboxEnv(env: Env, bridge: { port: number; token: string }): Record<string, string> {
  const names = [...SECRET_NAMES, ...CONFIG_NAMES].filter((name) => env[name]);
  const values = Object.fromEntries(names.map((name) => [name, env[name] as string]));
  const all = { ...values, BRIDGE_ADDR: `${BRIDGE_HOST}:${bridge.port}`, BRIDGE_TOKEN: bridge.token };
  return { ...all, SANDBOX_ENV: Object.keys(all).join(' ') };
}

interface SandboxRun { plan: Plan; repo: string; worktree: string; work: string; toolsDir: string; env: Env }

/** One sandbox call with the Docker bridge up around it. */
async function runInSandbox(run: SandboxRun, deps: Deps): Promise<RunOutcome> {
  const commands = dockerCommands(run.repo, run.plan.servers);
  commands.forEach((argv) => deps.pullImage(argv[argv.length - 1]));
  const token = randomBytes(32).toString('hex');
  const bridge = await deps.startBridge({ allowed: commands, token });
  try {
    const planFile = join(run.work, 'plan.json');
    writeFileSync(planFile, `${JSON.stringify(run.plan, null, 2)}\n`);
    const planPath = sandboxPath(deps.root, planFile);
    const env = sandboxEnv(run.env, { port: bridge.port, token });
    const outcome = await deps.sandbox({ worktree: run.worktree, command: sandboxCommand(run.toolsDir, planPath), env, planFile });
    saveRaw(join(run.work, 'sandbox.log'), outcome.output, [...secretsFrom(run.env), token]);
    return outcome;
  } finally {
    await bridge.close();
  }
}

function basePlan(root: string, work: string, toolsDir: string, aura: AuraInstall, servers: PlanServer[]): Omit<Plan, 'llm' | 'provider' | 'model' | 'loadOnlyEnv'> {
  return {
    repo: '/repo',
    rawDir: sandboxPath(root, join(work, 'raw')),
    cwd: sandboxPath(root, join(work, 'cwd')),
    ...toolchain(toolsDir),
    auraCommand: auraCommandFor(aura, (hostPath) => sandboxPath(root, hostPath)),
    auraTag: AURA_TAG,
    prompt: INVESTIGATION_PROMPT,
    servers,
  };
}

/** The real run. A record reaches out/ only after it passes the scrubber. */
async function realRun(env: Env, deps: Deps): Promise<boolean> {
  const work = workDir(deps.root, 'run');
  const tree = join(deps.root, 'tmp', 'lab-wt-04');
  const servers = SERVERS.map((s) => planServer(s, env)).filter((s): s is PlanServer => s !== null);
  resetDir(work);
  deps.prepareTree(BASE_COMMIT, patchFiles(deps.root), tree);
  try {
    const aura = await deps.ensureAura(join(workRoot(deps.root), 'bin'), deps.dockerArch());
    saveRaw(join(work, 'raw', 'aura-image.json'), { tag: AURA_TAG, tagCommit: BASE_COMMIT, image: aura.image, binarySha256: aura.binarySha256 }, []);
    const toolsDir = sandboxPath(deps.root, workDir(deps.root, 'toolchain'));
    const plan: Plan = { ...basePlan(deps.root, work, toolsDir, aura, servers), ...llmFor(env) };
    const outcome = await runInSandbox({ plan, repo: tree, worktree: tree, work, toolsDir, env }, deps);
    if (outcome.status !== 0) deps.log(`The sandbox run failed (exit ${outcome.status}). See lab/.work/${LAB_NAME}/run/sandbox.log.`);
    const rawDir = join(work, 'raw');
    if (isMeasured(deps.root) && computeResult(readRecords(rawDir)).status !== 'measured') {
      deps.log(`This run came back weaker than the measured result, so out/ and result.md stay as they are. Its raw outputs are in lab/.work/${LAB_NAME}/run/raw/.`);
      return false;
    }
    saveOutputs({ rawDir, out: outDir(deps.root), secrets: secretsFrom(env), servers }, deps.log);
    return outcome.status === 0;
  } finally {
    deps.removeTree(tree);
  }
}

function writeOutcome(deps: Deps, sandboxWorked: boolean): number {
  const records = readRecords(outDir(deps.root));
  const result = computeResult(records);
  const kept = writeResult(resultFile(deps.root), result);
  const needs = result.needs ? ` It needs ${result.needs}.` : '';
  deps.log(kept === result ? `result.md is ${kept.status}.${needs}` : `Kept the earlier ${kept.status} result.${needs}`);
  if (!sandboxWorked) return 1;
  if (result.status === 'measured') return 0;
  return missingPieces(records).broken.length ? 1 : EXIT_NEEDS_KEY;
}

/** The dry run's own copy of the examples, read from the patches, so no worktree is touched. */
function materializeExamples(root: string, repo: string): void {
  const patches = patchFiles(root).map((file) => readFileSync(file, 'utf8'));
  for (const { example } of SERVERS) {
    const text = patches.flatMap((patch) => {
      try {
        return [newFileFromPatch(patch, example)];
      } catch {
        return [];
      }
    })[0];
    if (!text) throw new Error(`no patch adds ${example}`);
    mkdirSync(dirname(join(repo, example)), { recursive: true });
    writeFileSync(join(repo, example), text);
  }
}

function writePreview(work: string, deps: Deps): RawRecord[] {
  const records = readRecords(join(work, 'raw'));
  const preview = `Dry run against fakes. Nothing here is measured, and none of it reaches result.md.\n\n${renderResult(computeResult(records))}`;
  writeFileSync(join(work, 'result.preview.md'), preview);
  deps.log(preview);
  return records;
}

/** Everything but Docker: our own harness, fake servers and a fake AURA, on this host. */
async function hostDryRun(deps: Deps): Promise<number> {
  const work = workDir(deps.root, 'dry-run');
  resetDir(work);
  materializeExamples(deps.root, join(work, 'repo'));
  const fakeServer = join(LAB_DIR, 'fake', 'fake-mcp-server.ts');
  const plan: Plan = {
    repo: join(work, 'repo'), rawDir: join(work, 'raw'), cwd: join(work, 'cwd'), client: 'mini',
    auraCommand: [process.execPath, join(LAB_DIR, 'fake', 'fake-aura.ts')], auraTag: AURA_TAG, prompt: INVESTIGATION_PROMPT,
    llm: { kind: 'as-is' }, provider: 'fake', model: 'fake', loadOnlyEnv: { OPENAI_API_KEY: LOAD_ONLY_KEY },
    servers: SERVERS.map((s) => ({ id: s.id, example: s.example, credentials: 'fake', placeholders: { ...s.placeholders }, override: { cmd: [process.execPath, fakeServer, s.id] }, listTools: true, discover: true, investigate: true })),
  };
  const planFile = join(work, 'plan.json');
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const outcome = await deps.runLocal(planFile);
  writePreview(work, deps);
  return outcome.status === 0 && computeResult(readRecords(join(work, 'raw'))).status === 'measured' ? 0 : 1;
}

/** The servers a sandbox dry run starts. Sentry only comes along when asked, and never with a real token. */
function dryRunServers(junkSentryToken: boolean): PlanServer[] {
  const chosen = SERVERS.filter((s) => s.required.length === 0 || junkSentryToken);
  return chosen.map((s) => ({ id: s.id, example: s.example, credentials: 'placeholder', placeholders: s.id === 'sentry' ? { SENTRY_ACCESS_TOKEN: JUNK_SENTRY_TOKEN } : { ...s.placeholders }, listTools: true, discover: true, investigate: true, probeCalls: true }));
}

/** The real client, servers and AURA in the sandbox, with a fake model provider and no key. */
async function sandboxDryRun(deps: Deps, junkSentryToken: boolean): Promise<number> {
  const work = workDir(deps.root, 'dry-run');
  const repo = join(work, 'repo');
  resetDir(work, ['toolchain']);
  materializeExamples(deps.root, repo);
  const aura = await deps.ensureAura(join(workRoot(deps.root), 'bin'), deps.dockerArch());
  const toolsDir = sandboxPath(deps.root, join(work, 'toolchain'));
  const servers = dryRunServers(junkSentryToken);
  const plan: Plan = {
    ...basePlan(deps.root, work, toolsDir, aura, servers),
    llm: { kind: 'as-is' }, provider: 'fake provider', model: EXAMPLE_MODEL, loadOnlyEnv: { OPENAI_API_KEY: LOAD_ONLY_KEY },
    fakeProvider: { preferredTools: [], calls: [...DRY_RUN_CALLS] },
  };
  const outcome = await runInSandbox({ plan, repo, worktree: repo, work, toolsDir, env: {} }, deps);
  if (outcome.status !== 0) deps.log(`The dry run failed (exit ${outcome.status}). See lab/.work/${LAB_NAME}/dry-run/sandbox.log.`);
  const records = writePreview(work, deps);
  return outcome.status === 0 && missingPieces(records).broken.length === 0 ? 0 : 1;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const unknown = argv.filter((a) => !FLAGS.includes(a));
  if (unknown.length) throw new Error(`Unknown flag: ${unknown.join(' ')}. This lab takes ${FLAGS.join(', ')}.`);
  if (argv.includes('--junk-sentry-token') && !(argv.includes('--dry-run') && argv.includes('--sandbox'))) throw new Error('--junk-sentry-token only goes with --dry-run --sandbox.');
  if (argv.includes('--dry-run')) return argv.includes('--sandbox') ? sandboxDryRun(deps, argv.includes('--junk-sentry-token')) : hostDryRun(deps);
  const env = argv.includes('--no-keys') ? withoutKeys(deps.env) : loadEnv(deps.root, deps.env as NodeJS.ProcessEnv);
  const lacking = missingForMeasured(env);
  if (isMeasured(deps.root) && lacking.length) {
    deps.log(`Kept the measured result and started nothing. A rerun needs ${lacking.join(', ')}.`);
    return EXIT_NEEDS_KEY;
  }
  const worked = argv.includes('--no-start') ? true : await realRun(env, deps);
  return writeOutcome(deps, worked);
}

function runProcess(program: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (part: Buffer) => { output += part.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, output }));
  });
}

function realDeps(): Deps {
  const root = REPO_ROOT;
  const clone = join(root, 'tmp', 'aura');
  const sandboxScript = join(root, 'scripts', 'sandbox.sh');
  return {
    root,
    env: process.env,
    sandbox: (request) => runProcess(sandboxScript, ['aura', request.worktree, request.command], { ...withoutKeys(process.env) as NodeJS.ProcessEnv, ...request.env }),
    runLocal: (planFile) => runProcess(process.execPath, [join(LAB_DIR, 'harness', 'sandbox-main.ts'), planFile], { PATH: process.env.PATH, HOME: process.env.HOME }),
    prepareTree: (base, patches, dest) => prepareWorktree(clone, dest, base, patches),
    removeTree: (dest) => removeWorktree(clone, dest),
    ensureAura: async (binDir, arch) => ensureAuraFromImage({ binDir, arch, image: AURA_IMAGE, name: AURA_TAG }, (args) => execFileSync('docker', [...args], { encoding: 'utf8' })),
    dockerArch: () => execFileSync('docker', ['version', '--format', '{{.Server.Arch}}'], { encoding: 'utf8' }).trim(),
    pullImage: (image) => { execFileSync('docker', ['pull', '--quiet', image], { stdio: 'ignore' }); },
    startBridge: startDockerBridge,
    log: (line) => { process.stdout.write(`${line}\n`); },
  };
}

if (import.meta.main) {
  main(process.argv.slice(2), realDeps()).then((code) => process.exit(code), (error: Error) => {
    process.stderr.write(`${basename(import.meta.filename)}: ${error.message}\n`);
    process.exit(1);
  });
}
