#!/usr/bin/env node
// keepup's command line. stdout carries the answer; stderr carries anything else.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { droppedLine, renderBrief, renderRetired, renderSummary } from '../src/brief.ts';
import { formatChange, loadRunFor, runChangeCommand } from '../src/change-cli.ts';
import { runMeasureCommand, runWithMeasurement } from '../src/measure-cli.ts';
import { formatMeasurement } from '../src/measure.ts';
import { claudeSeams } from '../src/claude.ts';
import { query } from '../src/db.ts';
import { loadEnv } from '../src/env.ts';
import { buildFacts } from '../src/facts.ts';
import { loadLevers, loadPatternMeta } from '../src/levers.ts';
import { maskText, maskValue } from '../src/mask.ts';
import { dataDir, logEvent, readLog, resetLog } from '../src/session.ts';
import { repoRoot } from '../src/git-files.ts';
import { createLlm, DEFAULT_LLM_CACHE, DEFAULT_MAX_USD, DEFAULT_MODEL } from '../src/llm.ts';
import { RUNS_DIR, runPipeline, type RunOptions, type Seams, writeRun } from '../src/pipeline.ts';
import { untrustedBlock } from '../src/repo-text.ts';
import { scanRepo } from '../src/scan.ts';
import { parseSearchQuery } from '../src/search.ts';
import { guardSession, inSession, SessionRefusal } from '../src/session-guard.ts';
import { REPO_ROOT } from '../src/signals.ts';
import { oneLine } from '../src/text-safety.ts';
import { maskedFileMap, showLines, verifyFindings, type VerifyInput } from '../src/verify.ts';
import { firstSight, markShown, weeklyCheck, weeklyDue } from '../src/weekly.ts';

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const DEFAULT_RADIUS = 20;
const MAX_RADIUS = 60;
const REPLAY_DIR = join(REPO_ROOT, 'data', 'replay');
/** A session start waits for this hook, or its line never reaches the person. A repo too big for this gets silence, and the next session tries again. */
const HOOK_BUDGET_MS = 3_000;
/** Git gets less time than the check it's in, so it's never left behind when the check is killed. */
const HOOK_GIT_MARGIN_MS = 1_000;
const PREPARED = ['scan', 'facts', 'floor', 'findings', 'verified'] as const;
const DEFAULT_GET_LIMIT = 40;

const USAGE = `keepup: check a product's code against everything new in AI.

  keepup scan <path> [--commit <sha>] [--out <file>]     hits for db/patterns, as JSON
  keepup facts <path> [--commit <sha>] [--out <file>]    the repo's inventory, as JSON
  keepup search '<json>' [--dir <dir>]    search the database, as JSON
  keepup show <path> <file> <line> [--radius <n>] [--commit <sha>] [--dir <dir>]
                                          a masked, numbered window of one file
  keepup verify <path> [<findings.json>] [--findings '<json>'] [--stdin] [--brief] [--commit <sha>] [--dir <dir>]
                                          run the checks over findings someone else judged; prints what survives,
                                          or with --brief the one screen a founder reads, written from them
  keepup prepare <path> [--commit <sha>] [--dir <dir>]
                                          write scan, facts and floor to the data folder, offline, in one call
  keepup get <facts|scan|floor|findings|verified>[.field.field] [--limit <n>] [--dir <dir>]
                                          read part of a prepared file, as JSON
  keepup levers [<pattern-id>]            the levers for a pattern, as JSON, with the pattern itself
  keepup check <path> [--as-of <date>] [--commit <sha>] [--weekly-state <file>] [--hook]
                                          the weekly check, one line; with --weekly-state, at most once a week
  keepup run <path> [--commit <sha>] [--as-of <date>] [--name <name>] [--out <dir or file.json>]
             [--provider-only <provider>] [--max-usd <n>] [--no-judge] [--online] [--no-llm-cache]
             [--full] [--retired] [--publish] [--force] [--replay]
                                          the whole pipeline: writes the run file, prints a one-screen brief. --full prints all of it.
                                          It writes to ~/.keepup/runs, or the plugin's data folder; --publish writes data/runs, which the dashboard reads.
                                          --replay rebuilds a demo run from data/replay: no key, no network, no cost.
  keepup change <path> --finding <rank> [--commit <sha>] [--run <run.json>] [--max-usd <n>]
                                          write the code change for one finding: one commit on a branch in a temporary clone under tmp/live-scans.
                                          It sends masked windows to Claude, refuses anything out of bounds, never pushes and never runs the repo.

  keepup measure <path> --finding <rank> [--commit <sha>] [--run <run.json>]
                                          a real before-and-after on this repo's own literal prompt, on your key. It says what it sends first, refuses a
                                          prompt built at runtime, prints n, and stops at $0.25. No key is "not measured · needs X", with no number.

scan, facts, search, show, verify, prepare, get, levers and check are offline and send nothing anywhere. 'run' sends masked, bounded excerpts, which can
be a whole short file but never a secret, to Claude with your ANTHROPIC_API_KEY, asks npm, crates.io and PyPI about your dependencies,
and reads public model cards and release notes. With --no-judge, or with no key, it stays offline unless you add --online, and says only what the exact checks prove.
`;

class UsageError extends Error {}

const OPTIONS = {
  commit: { type: 'string' },
  'as-of': { type: 'string' },
  online: { type: 'boolean' },
  name: { type: 'string' },
  out: { type: 'string' },
  'provider-only': { type: 'string' },
  'max-usd': { type: 'string' },
  'no-judge': { type: 'boolean' },
  'no-llm-cache': { type: 'boolean' },
  'weekly-state': { type: 'string' },
  hook: { type: 'boolean' },
  full: { type: 'boolean' },
  retired: { type: 'boolean' },
  publish: { type: 'boolean' },
  force: { type: 'boolean' },
  replay: { type: 'boolean' },
  'replay-fill': { type: 'boolean' },
  'record-replay': { type: 'boolean' },
  radius: { type: 'string' },
  dir: { type: 'string' },
  limit: { type: 'string' },
  stdin: { type: 'boolean' },
  brief: { type: 'boolean' },
  findings: { type: 'string' },
  'first-sight': { type: 'boolean' },
  'hook-child': { type: 'boolean' },
  finding: { type: 'string' },
  run: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

function parseCommandLine(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** A run from a subfolder still covers the whole repo, and says so. */
function pathArgument(positionals: readonly string[], command: string, extra = 0): string {
  if (positionals.length !== 2 + extra) throw new UsageError(`${command} takes one path${extra ? ' and more arguments, see --help' : ''}.`);
  const root = repoRoot(positionals[1]);
  if (resolve(root) !== resolve(positionals[1])) process.stderr.write(`keepup: reading the whole repo at ${root}, not just ${positionals[1]}\n`);
  return root;
}

function asOfDate(value: string | undefined): string | undefined {
  if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UsageError('--as-of takes a date like 2026-10-31.');
  return value;
}

function print(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** To a file when --out says so, because a shell redirect into a plugin's data folder is refused as a sensitive write. */
function printJson(value: unknown, out?: string): void {
  const text = JSON.stringify(value, null, 1);
  if (!out) return print(text);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${text}\n`);
  process.stderr.write(`keepup: wrote ${out}\n`);
}

/** In a session, what came from a repo or the database reaches the model marked as data, whatever it says. */
function printData(kind: string, label: string, text: string): void {
  print(inSession() ? untrustedBlock(kind, label, text) : text);
}

function maxUsd(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_USD;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError('--max-usd takes a positive number of dollars.');
  return parsed;
}

type Values = ReturnType<typeof parseCommandLine>['values'];

function claudeFor(values: Values): Seams | null {
  const apiKey = values['no-judge'] ? undefined : loadEnv().ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const llm = createLlm({ apiKey, model: DEFAULT_MODEL, maxUsd: maxUsd(values['max-usd']), cacheDir: values['no-llm-cache'] ? undefined : DEFAULT_LLM_CACHE, recordDir: values['record-replay'] ? join(REPLAY_DIR, 'llm') : undefined });
  return claudeSeams({ llm, providerOnly: values['provider-only'], online: true });
}

const refuseNetwork = (() => Promise.reject(new Error('--replay never uses the network'))) as unknown as typeof fetch;

/** --replay-fill is --replay that may ask Claude for what data/replay doesn't hold yet, and saves it there. Nothing else touches the network. */
function replaySetup(values: Values): { seams: Seams; options: Partial<RunOptions> } {
  const fill = values['replay-fill'] ? loadEnv().ANTHROPIC_API_KEY : undefined;
  if (values['replay-fill'] && !fill) throw new UsageError('--replay-fill needs ANTHROPIC_API_KEY.');
  const llm = createLlm({ apiKey: fill ?? 'replay-has-no-key', model: DEFAULT_MODEL, maxUsd: maxUsd(values['max-usd']), cacheDir: join(REPLAY_DIR, 'llm'), ...(fill ? {} : { fetchImpl: refuseNetwork, sleep: () => Promise.resolve() }) });
  const seams = claudeSeams({ llm, providerOnly: values['provider-only'], online: true, fetchImpl: refuseNetwork, cardCacheDir: join(REPLAY_DIR, 'cards'), registryCacheDir: join(REPLAY_DIR, 'registry') });
  return { seams, options: { online: true, exactIdsOnly: true, cacheDir: join(REPLAY_DIR, 'registry'), notesCacheDir: join(REPLAY_DIR, 'notes'), fetchImpl: refuseNetwork } };
}

function outFor(values: Values): string | undefined {
  if (values.out && values.publish) throw new UsageError('--publish writes data/runs, so it takes no --out.');
  return values.publish ? RUNS_DIR : values.out;
}

async function commandRun(path: string, values: Values): Promise<void> {
  const replay = values.replay || values['replay-fill'] ? replaySetup(values) : null;
  const seams = replay?.seams ?? claudeFor(values);
  if (!seams && !values['no-judge']) process.stderr.write('keepup: no ANTHROPIC_API_KEY, so this run has no profile and no judge: only what the exact checks prove.\n');
  const run = await runPipeline(path, { commit: values.commit, asOf: asOfDate(values['as-of']), online: values.online ?? Boolean(seams), ...replay?.options }, seams ?? {});
  const written = writeRun(run, { name: values.name, out: outFor(values), force: values.force });
  process.stderr.write(`keepup: wrote ${written}\n`);
  for (const dropped of run.checks.dropped) process.stderr.write(`keepup: dropped ${oneLine(maskText(droppedLine(dropped)))}\n`);
  if (run.incomplete) process.stderr.write(`keepup: incomplete: ${oneLine(run.incomplete.reason)}\n`);
  if (run.usage) process.stderr.write(`keepup: spent ${run.usage.usd.toFixed(4)} on ${run.usage.model} (${run.usage.input_tokens} input, ${run.usage.output_tokens} output tokens)\n`);
  print(values.retired ? renderRetired(run) : values.full ? renderBrief(run) : renderSummary(run));
}

/** The check runs under its own deadline. It's marked only once it answered, so one killed on a busy machine tries again next session instead of losing the week. */
function commandHook(path: string, values: Values): void {
  const state = values['weekly-state'];
  if (state && !weeklyDue(state, path)) return;
  const first = state ? firstSight(state, path) : false;
  const args = ['check', path, '--hook-child', ...(first ? ['--first-sight'] : []), ...(values['as-of'] ? ['--as-of', values['as-of']] : []), ...(values.commit ? ['--commit', values.commit] : [])];
  const budget = Number(process.env.KEEPUP_HOOK_BUDGET_MS) || HOOK_BUDGET_MS;
  const gitTimeout = Math.min(Number(process.env.KEEPUP_GIT_TIMEOUT_MS) || Infinity, Math.max(1000, budget - HOOK_GIT_MARGIN_MS));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8', timeout: budget, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { ...process.env, KEEPUP_GIT_TIMEOUT_MS: String(gitTimeout) } });
  if (child.status !== 0) return;
  if (child.stdout) process.stdout.write(child.stdout);
  if (state) markShown(state, path);
}

/** At most one line a week, shown to the person. A repo with no AI code in it hears nothing. */
async function commandHookChild(path: string, values: Values): Promise<void> {
  const result = await weeklyCheck(path, { asOf: asOfDate(values['as-of']), commit: values.commit, firstSight: Boolean(values['first-sight']) });
  if (result.has_ai_code || result.stopped_early) print(JSON.stringify({ systemMessage: result.line }));
}

async function commandCheck(path: string, values: Values): Promise<void> {
  const state = values['weekly-state'];
  if (state && !weeklyDue(state, path)) return;
  const result = await weeklyCheck(path, { asOf: asOfDate(values['as-of']), commit: values.commit, firstSight: state ? firstSight(state, path) : false });
  if (state) markShown(state, path);
  print(result.line);
}

/** Only a session someone set up gets logged, so a plain CLI call leaves nothing behind. */
function sessionDir(values: Values): string | undefined {
  const given = values.dir ?? process.env.CLAUDE_PLUGIN_DATA;
  return given ? dataDir(given) : undefined;
}

function commandSearch(positionals: readonly string[], values: Values): void {
  if (positionals.length !== 2) throw new UsageError("search takes one JSON query, such as '{\"any\":[\"rerank\"]}'.");
  let parsed;
  try {
    parsed = parseSearchQuery(positionals[1]);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const result = query(parsed);
  logEvent(sessionDir(values), 'search', positionals[1]);
  printData('records', 'the database', JSON.stringify({ version: 1, ...result }, null, 1));
}

function commandShow(positionals: readonly string[], values: Values): void {
  const path = pathArgument(positionals, 'show', 2);
  const line = Number(positionals[3]);
  const radius = values.radius === undefined ? DEFAULT_RADIUS : Number(values.radius);
  if (!Number.isInteger(line) || line < 1) throw new UsageError('show takes a line number.');
  if (!Number.isInteger(radius) || radius < 0 || radius > MAX_RADIUS) throw new UsageError(`--radius takes a number from 0 to ${MAX_RADIUS}.`);
  const text = showLines(maskedFileMap(path, values.commit), positionals[2], line, radius);
  if (text === null) throw new Error(`${positionals[2]} isn't a file keepup reads in this repo.`);
  logEvent(sessionDir(values), 'read', `${positionals[2]}:${line}`);
  printData('code', positionals[2], text);
}

/** An argument, because a heredoc is refused in a headless session and a model can't write a file to the data folder. The argument sits in single quotes, and a JSON escape can be undone on its way there, so an apostrophe travels as &apos;. */
function verifyInput(positionals: readonly string[], values: Values, dir: string | undefined): VerifyInput {
  if (values.findings !== undefined && (values.stdin || positionals[2] !== undefined)) throw new UsageError('verify takes its findings one way: a file, --stdin or --findings.');
  const from = values.stdin ? 0 : positionals[2];
  if (from === undefined && values.findings === undefined) throw new UsageError("verify takes a findings file, --stdin or --findings '<json>'.");
  try {
    const text = values.findings?.replaceAll('&apos;', "'") ?? readFileSync(from as string | number, 'utf8');
    const input = JSON.parse(text) as VerifyInput;
    if ((values.stdin || values.findings !== undefined) && dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'findings.json'), text);
    }
    return input;
  } catch (error) {
    throw new Error(`Can't read ${values.stdin || values.findings !== undefined ? 'the findings' : from}: ${(error as Error).message}`);
  }
}

async function commandVerify(positionals: readonly string[], values: Values): Promise<void> {
  const extra = values.stdin || values.findings !== undefined ? 0 : positionals.length === 3 ? 1 : 0;
  const path = pathArgument(positionals, 'verify', extra);
  const dir = sessionDir(values);
  const input = verifyInput(positionals, values, dir);
  const log = values.brief ? readLog(dir ?? dataDir()) : undefined;
  const output = await verifyFindings(path, input, { commit: values.commit, log });
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verified.json'), `${JSON.stringify(output, null, 1)}\n`);
  }
  if (values.brief) return print(output.brief ?? '');
  printJson(output, values.out);
}

/** The three deterministic files in one approved call, so the skill needs no mkdir, no loop and no shell. */
async function commandPrepare(path: string, values: Values): Promise<void> {
  const dir = dataDir(values.dir);
  resetLog(dir);
  const scan = scanRepo(path, { commit: values.commit });
  const facts = buildFacts(path, { commit: values.commit });
  const floor = await runPipeline(path, { commit: values.commit, online: false }, {});
  writeFileSync(join(dir, 'scan.json'), `${JSON.stringify(scan, null, 1)}\n`);
  writeFileSync(join(dir, 'facts.json'), `${JSON.stringify(facts, null, 1)}\n`);
  writeRun(floor, { out: join(dir, 'floor.json'), force: true });
  print([
    `keepup: prepared ${facts.repo} in ${dir}`,
    `${facts.checked.files} files, ${facts.ai_call_sites.length} AI call sites, ${facts.model_ids.length} model ids, ${scan.hits.length} pattern hits, ${floor.findings.length} exact findings.`,
    `Read them with: keepup get facts.ai_call_sites, keepup get scan.hits, keepup get floor.findings`,
  ].join('\n'));
}

function readField(value: unknown, field: string): unknown {
  if (Array.isArray(value) && /^\d+$/.test(field)) return value[Number(field)];
  return value && typeof value === 'object' && Object.hasOwn(value, field) ? (value as Record<string, unknown>)[field] : undefined;
}

/** Part of a prepared file, by name. It takes no path, so it can't be pointed at anything else. */
function commandGet(positionals: readonly string[], values: Values): void {
  const [name, ...fields] = (positionals[1] ?? '').split('.');
  if (positionals.length !== 2 || !(PREPARED as readonly string[]).includes(name)) throw new UsageError(`get takes ${PREPARED.join(', ')}, then any fields, as in facts.ai_call_sites.`);
  const path = join(dataDir(values.dir), `${name}.json`);
  if (!existsSync(path)) throw new Error(`${name}.json isn't there yet. Run keepup prepare first.`);
  const value = fields.reduce<unknown>(readField, JSON.parse(readFileSync(path, 'utf8')));
  if (value === undefined) throw new Error(`${positionals[1]} isn't in ${name}.json.`);
  const limit = values.limit === undefined ? DEFAULT_GET_LIMIT : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit takes a positive number.');
  if (Array.isArray(value) && value.length > limit) process.stderr.write(`keepup: showing ${limit} of ${value.length}. --limit shows more.\n`);
  printData('prepared', positionals[1], JSON.stringify(maskValue(Array.isArray(value) ? value.slice(0, limit) : value), null, 1));
}

async function commandChange(path: string, values: Values): Promise<void> {
  const rank = Number(values.finding);
  if (!Number.isInteger(rank) || rank < 1) throw new UsageError('change takes --finding <rank>, a finding\'s number in the run.');
  const run = loadRunFor(path, values.run);
  const result = await runChangeCommand({ path, run, rank, commit: values.commit, maxUsd: values['max-usd'] === undefined ? undefined : maxUsd(values['max-usd']), onStep: (name, detail) => process.stderr.write(`keepup: ${name}: ${detail}\n`) });
  print(formatChange(result));
}

async function commandMeasure(path: string, values: Values): Promise<void> {
  const rank = Number(values.finding);
  if (!Number.isInteger(rank) || rank < 1) throw new UsageError('measure takes --finding <rank>, a finding\'s number in the run.');
  const file = values.run ?? join(RUNS_DIR, `${basename(path)}.json`);
  const run = loadRunFor(path, values.run);
  const result = await runMeasureCommand({ path, run, rank, commit: values.commit, onStep: (name, detail) => process.stderr.write(`keepup: ${name}: ${detail}\n`) });
  writeFileSync(file, `${JSON.stringify(runWithMeasurement(run, result), null, 1)}\n`);
  process.stderr.write(`keepup: saved with the run in ${file}\n`);
  print(formatMeasurement(result));
}

function commandLevers(positionals: readonly string[]): void {
  const id = positionals[1];
  const patterns = loadPatternMeta();
  if (id && !patterns.some((pattern) => pattern.id === id)) throw new UsageError(`No pattern ${id}. Patterns: ${patterns.map((pattern) => pattern.id).join(', ')}`);
  printData('levers', id ?? 'all patterns', JSON.stringify({ version: 1, patterns: id ? patterns.filter((pattern) => pattern.id === id) : patterns, levers: loadLevers().filter((lever) => !id || lever.pattern === id) }, null, 1));
}

async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseCommandLine(argv);
  const command = positionals[0];
  if (values.help || !command) {
    print(USAGE);
    if (!command && !values.help) process.exitCode = EXIT_USAGE;
    return;
  }
  guardSession({ command, positionals, writes: [values.out, values.dir, values['weekly-state']], stdinIsTty: Boolean(process.stdin.isTTY) });
  if (command === 'scan') return printJson(scanRepo(pathArgument(positionals, command), { commit: values.commit }), values.out);
  if (command === 'facts') return printJson(buildFacts(pathArgument(positionals, command), { commit: values.commit }), values.out);
  if (command === 'search') return commandSearch(positionals, values);
  if (command === 'show') return commandShow(positionals, values);
  if (command === 'verify') return commandVerify(positionals, values);
  if (command === 'prepare') return commandPrepare(pathArgument(positionals, command), values);
  if (command === 'get') return commandGet(positionals, values);
  if (command === 'levers') return commandLevers(positionals);
  if (command === 'check') {
    if (values.hook) return commandHook(positionals[1] ?? '', values);
    if (values['hook-child']) return commandHookChild(positionals[1] ?? '', values);
    return commandCheck(pathArgument(positionals, command), values);
  }
  if (command === 'run') return commandRun(pathArgument(positionals, command), values);
  if (command === 'change') return commandChange(pathArgument(positionals, command), values);
  if (command === 'measure') return commandMeasure(pathArgument(positionals, command), values);
  throw new UsageError(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error: Error) => {
  // The weekly line is a courtesy: whatever went wrong, the session starting doesn't hear about it.
  if (process.argv.includes('--hook')) return;
  const isUsage = error instanceof UsageError;
  process.stderr.write(`keepup: ${error.message}\n`);
  if (isUsage) process.stderr.write(`\n${USAGE}`);
  process.exitCode = isUsage || error instanceof SessionRefusal ? EXIT_USAGE : EXIT_ERROR;
});
