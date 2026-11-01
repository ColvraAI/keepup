// A live scan of a public repo: a shallow clone with hooks and filters off, read as text by
// bin/keepup.ts. Nothing in the clone runs. The clone waits briefly for "Have Claude check them",
// then goes, and every path is under tmp/live-scans.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { saveRun, savedRun, savedSlugs, tidySaved } from './saved.ts';
import type { Emit, Job } from './server.ts';

const CLONE_LIMIT_MS = 120_000;
const JOB_LIMIT_MS = 180_000;
const JUDGE_LIMIT_MS = 600_000;
export const KEEP_FOR_JUDGE_MINUTES = 20;
const KEEP_FOR_JUDGE_MS = KEEP_FOR_JUDGE_MINUTES * 60_000;
const MAX_REPO_KB = 400_000;
const MAX_CLONE_BYTES = 800_000_000;
// With no size from GitHub, the only limit is what lands on disk, so it has to be low.
const MAX_UNKNOWN_CLONE_BYTES = 150_000_000;
const MIN_FREE_BYTES = 4_000_000_000;
const MAX_STDOUT_BYTES = 64_000_000;
const MAX_HITS_SHOWN = 60;
const POLL_MS = 2000;
export const JUDGE_MAX_USD = '1.50';

const CLONE_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.symlinks=false',
  'core.fsmonitor=false',
  'protocol.file.allow=never',
  'filter.lfs.smudge=',
  'filter.lfs.process=',
  'filter.lfs.required=false',
  'submodule.recurse=false',
];

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: 'true',
    ...extra,
  };
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const full = join(path, entry.name);
    if (entry.isDirectory()) return sum + directoryBytes(full);
    return sum + (entry.isFile() ? statSync(full).size : 0);
  }, 0);
}

export const cloneByteCap = (sizeKb: number | null): number => (sizeKb === null ? MAX_UNKNOWN_CLONE_BYTES : MAX_CLONE_BYTES);

type RunResult = { code: number | null; stdout: string; stderr: string };

/** Git hands the transfer to git-remote-https, so stopping means the whole group, not the command. */
const running = new Set<number>();

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// A group of its own doesn't get the terminal's Ctrl-C, so nothing outlives this server.
process.on('exit', () => running.forEach(killGroup));

export function runBounded(command: string, args: string[], options: { limitMs: number; signal: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string; watch?: () => boolean; onStderr?: (line: string) => void }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid) running.add(child.pid);
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    const stop = (message: string) => {
      killGroup(child.pid);
      reject(new Error(message));
    };
    const timer = setTimeout(() => stop('That took too long, so it was stopped.'), options.limitMs);
    const poll = options.watch ? setInterval(() => { if (options.watch?.()) stop('That repo is too large to scan here.'); }, POLL_MS) : null;
    const onAbort = () => stop('Stopped: the page went away.');
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) stop('That produced too much output, so it was stopped.');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = `${stderr}${text}`.slice(-4000);
      options.onStderr?.(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (child.pid) running.delete(child.pid);
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      options.signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr });
    });
  });
}

async function repoSizeKb(slug: string, signal: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'keepup-dashboard' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 404) throw new Error('No public repo by that name.');
    if (!response.ok) return null; // Rate limited, most likely. The clone watch still holds.
    const body = await response.json() as { size?: unknown; private?: unknown };
    if (body.private === true) throw new Error('That repo is not public.');
    return typeof body.size === 'number' ? body.size : null;
  } catch (error) {
    if (error instanceof Error && /public/.test(error.message)) throw error;
    return null;
  }
}

type FactsShape = { model_ids?: readonly unknown[]; ai_call_sites?: readonly unknown[] };

/** A pattern hit is only one way in: an id in a config is enough for the retirement checks, which cost nothing. */
export function worthChecking(facts: FactsShape, hits: number): boolean {
  return hits > 0 || (facts.model_ids?.length ?? 0) > 0 || (facts.ai_call_sites?.length ?? 0) > 0;
}

export type LiveScanConfig = { root: string; keepup: string; minFreeBytes?: number; judgeMaxUsd?: string };

/** A live scan's run, as much of it as the list of repos shows. */
export type LiveRepo = { repo: string; commit: string | null; scanned_at: string; findings: number; held_back: number; usd: number | null };

type Kept = { dir: string; timer: NodeJS.Timeout };

export function createLiveScans(config: LiveScanConfig) {
  const base = join(config.root, 'tmp', 'live-scans');
  const kept = new Map<string, Kept>();
  tidySaved(base);

  const forget = (slug: string) => {
    const entry = kept.get(slug);
    if (!entry) return;
    clearTimeout(entry.timer);
    rmSync(entry.dir, { recursive: true, force: true });
    kept.delete(slug);
  };

  const keepup = (args: string[], signal: AbortSignal, limitMs = JOB_LIMIT_MS, env?: NodeJS.ProcessEnv, onStderr?: (line: string) => void) =>
    runBounded(process.execPath, [config.keepup, ...args], { limitMs, signal, env, cwd: config.root, onStderr });

  const clone = async (slug: string, dir: string, emit: Emit, signal: AbortSignal): Promise<string> => {
    const free = statfsSync(config.root);
    if (free.bavail * free.bsize < (config.minFreeBytes ?? MIN_FREE_BYTES)) throw new Error('This machine is low on disk, so the scan was refused.');
    const started = Date.now();
    emit({ type: 'step', name: 'Checking the repo', detail: 'asking GitHub for its size' });
    const size = await repoSizeKb(slug, signal);
    if (size !== null && size > MAX_REPO_KB) throw new Error('That repo is too large to scan here.');
    const cap = cloneByteCap(size);
    emit({ type: 'step', name: 'Cloning…', detail: size === null ? `GitHub didn’t report its size, so this stops at ${Math.round(cap / 1_000_000)} MB` : 'one commit, no history; the next step appears when it lands' });
    const dest = join(dir, 'repo');
    const args = ['clone', '--depth', '1', '--single-branch', '--no-tags', '--template=', ...CLONE_CONFIG.flatMap((item) => ['-c', item]), `https://github.com/${slug}.git`, dest];
    const result = await runBounded('git', args, { limitMs: CLONE_LIMIT_MS, signal, watch: () => directoryBytes(dir) > cap });
    if (result.code !== 0) throw new Error('Couldn’t clone that repo. Is it public, and is the name right?');
    emit({ type: 'step', name: 'Shallow clone', detail: 'hooks, filters and symlinks off; files read as text and never executed', ms: Date.now() - started });
    return dest;
  };

  const scan: Job = async (slug, emit, signal) => {
    forget(slug);
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'scan-'));
    let keep = false;
    try {
      const repo = await clone(slug, dir, emit, signal);
      const factsFile = join(dir, 'facts.json');
      const facts = await keepup(['facts', repo, '--out', factsFile], signal);
      if (facts.code !== 0) throw new Error('The engine couldn’t read that repo.');
      const parsed = JSON.parse(readFileSync(factsFile, 'utf8')) as FactsShape & { steps?: { name: string; detail: string; ms: number }[]; commit?: string };
      (parsed.steps ?? []).forEach((step) => emit({ type: 'step', name: step.name, detail: step.detail, ms: step.ms }));
      const started = Date.now();
      const scanned = await keepup(['scan', repo], signal);
      if (scanned.code !== 0) throw new Error('The pattern scan failed.');
      const hits = (JSON.parse(scanned.stdout) as { hits?: { pattern: string; file: string; line: number; text: string }[] }).hits ?? [];
      emit({ type: 'step', name: 'Run patterns', detail: `${hits.length} regex hits, unreviewed`, ms: Date.now() - started });
      hits.slice(0, MAX_HITS_SHOWN).forEach((hit) => emit({ type: 'hit', pattern: hit.pattern, file: hit.file, line: hit.line, text: hit.text }));
      emit({ type: 'summary', repo: slug, commit: parsed.commit ?? null, hits: hits.length, shown: Math.min(hits.length, MAX_HITS_SHOWN), models: parsed.model_ids?.length ?? 0, checkable: worthChecking(parsed, hits.length) });
      keep = true;
      kept.set(slug, { dir, timer: setTimeout(() => forget(slug), KEEP_FOR_JUDGE_MS) });
      emit({ type: 'done' });
    } finally {
      if (!keep) rmSync(dir, { recursive: true, force: true });
    }
  };

  const judge: Job = async (slug, emit, signal) => {
    const entry = kept.get(slug);
    if (!entry) throw new Error('Scan that repo again first: its copy has been cleaned up.');
    const out = join(entry.dir, 'run.json');
    try {
      const cap = config.judgeMaxUsd ?? JUDGE_MAX_USD;
      emit({ type: 'step', name: 'Claude is checking', detail: `dollar cap ${cap}; masked text only, no tools, no secrets` });
      // Its own clone, one commit, untouched: HEAD is the truth, whatever a filter or a link makes the checkout look like.
      const result = await keepup(['run', join(entry.dir, 'repo'), '--commit', 'HEAD', '--out', out, '--max-usd', cap], signal, JUDGE_LIMIT_MS);
      if (result.code !== 0 || !existsSync(out)) throw new Error('The run stopped before it finished. The terminal has the detail.');
      const run = JSON.parse(readFileSync(out, 'utf8')) as {
        findings: { rank: number; title: string; effect: string[]; proof: string; effort: string; where: { file: string; line: number }[]; why: string }[];
        held_back: unknown[];
        usage: { usd?: number } | null;
        steps?: { name: string; detail: string; ms: number }[];
      };
      (run.steps ?? []).forEach((step) => emit({ type: 'step', name: step.name, detail: step.detail, ms: step.ms }));
      run.findings.forEach((finding) => emit({ type: 'finding', rank: finding.rank, title: finding.title, effect: finding.effect, proof: finding.proof, effort: finding.effort, where: finding.where.slice(0, 3).map(({ file, line }) => ({ file, line })), why: finding.why }));
      emit({ type: 'summary', findings: run.findings.length, held_back: run.held_back.length, usd: run.usage?.usd ?? null });
      // Judged, it's a repo in the list: its run is kept on disk, and its clone for as long as the dashboard runs.
      saveRun(base, slug, out);
      clearTimeout(entry.timer);
      emit({ type: 'done' });
    } catch (error) {
      forget(slug);
      throw error;
    }
  };

  const readRun = (slug: string): Record<string, unknown> | null => {
    const entry = kept.get(slug);
    const file = entry ? join(entry.dir, 'run.json') : null;
    return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : savedRun(base, slug);
  };

  const repos = (): LiveRepo[] => savedSlugs(base).flatMap((slug) => {
    const run = readRun(slug) as { commit?: string | null; scanned_at?: string; findings?: unknown[]; held_back?: unknown[]; usage?: { usd?: number } | null } | null;
    return run ? [{ repo: slug, commit: run.commit ?? null, scanned_at: run.scanned_at ?? '', findings: (run.findings as { reach?: string }[] | undefined)?.filter((finding) => !finding.reach).length ?? 0, held_back: run.held_back?.length ?? 0, usd: run.usage?.usd ?? null }] : [];
  });

  const clonePath = (slug: string): string | null => {
    const entry = kept.get(slug);
    return entry ? join(entry.dir, 'repo') : null;
  };

  const closeAll = () => [...kept.keys()].forEach(forget);
  return { scan, judge, closeAll, repos, readRun, clonePath };
}
