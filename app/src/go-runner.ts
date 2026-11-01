// Runs one of go's steps as a real process, with a limit and a line a minute, so a hung
// container or a lock nobody cleared can't stop the morning without saying so.
import { spawn } from 'node:child_process';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { EXIT_INTERRUPTED, EXIT_STOPPED_AT_LIMIT, type GoStep, type Runner } from './go-plan.ts';

const MINUTE = 60_000;
/** Labs can wait on sandbox.sh's lock for another live run before their real work. A pull request step can wait for CI. */
export const STEP_LIMITS_MS: Record<string, number> = { lab: 75 * MINUTE, pr: 30 * MINUTE };
const DEFAULT_LIMIT_MS = 5 * MINUTE;
/** Lab 03's own dry run plans over four hours of embedding. It resumes, so reaching this isn't a failure. */
const LONG_LAB_LIMIT_MS = 8 * 60 * MINUTE;
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/** Long enough for sandbox.sh to run docker kill and clear its lock, which can take a Docker VM over 2 seconds. */
const KILL_AFTER_MS = 20_000;
const GROUP_POLL_MS = 50;

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  limitMs: number;
  heartbeatMs?: number;
  log: (line: string) => void;
  label: string;
  /** What a run stopped at its limit returns. A failure unless the step can say otherwise. */
  limitExit?: number;
  /** How long a stopped step has to clean up before SIGKILL. */
  killAfterMs?: number;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // It's already gone, which is what was wanted.
  }
}

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The step's first process can end while what it started is still cleaning up. Being stopped means all of it. */
async function waitForGroup(pid: number | undefined, untilMs: number): Promise<void> {
  while (groupAlive(pid) && Date.now() < untilMs) await new Promise((resolve) => { setTimeout(resolve, GROUP_POLL_MS); });
  if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
}

/**
 * Its own process group, so stopping it stops what it started too: npm, node, the sandbox. And go's own stop signals
 * come here while a step runs, so nothing outlives go: Ctrl-C, a kill and a closed terminal all stop the step and
 * return EXIT_INTERRUPTED, which stops go before the next one.
 */
export function runCommand(command: string, args: string[], opts: CommandOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    const started = Date.now();
    let interrupted = false;
    let stopped = false;
    const killAfter = opts.killAfterMs ?? KILL_AFTER_MS;
    let killDeadline = 0;
    let killer: NodeJS.Timeout | undefined;
    const stopGroup = (signal: NodeJS.Signals) => {
      killGroup(child.pid, signal);
      killDeadline = Date.now() + killAfter;
      clearTimeout(killer);
      killer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), killAfter);
      killer.unref();
    };
    const onSignal = (signal: NodeJS.Signals) => {
      interrupted = true;
      stopGroup(signal);
    };
    STOP_SIGNALS.forEach((s) => process.on(s, onSignal));
    const beat = setInterval(() => opts.log(`      still running: ${opts.label} (${Math.round((Date.now() - started) / MINUTE)} min)`), opts.heartbeatMs ?? MINUTE);
    const limit = setTimeout(() => {
      stopped = true;
      opts.log(`      ${opts.label} hit its limit of ${Math.round(opts.limitMs / MINUTE)} min, so it was stopped.`);
      stopGroup('SIGTERM');
    }, opts.limitMs);
    const finish = (code: number) => {
      clearInterval(beat);
      clearTimeout(limit);
      const result = () => {
        clearTimeout(killer);
        STOP_SIGNALS.forEach((s) => process.off(s, onSignal));
        if (interrupted) resolve(EXIT_INTERRUPTED);
        else resolve(stopped ? (opts.limitExit ?? 1) : code);
      };
      if (interrupted || stopped) void waitForGroup(child.pid, killDeadline).finally(result);
      else result();
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
  });
}

export function limitFor(step: GoStep): { limitMs: number; limitExit?: number } {
  if (step.long) return { limitMs: LONG_LAB_LIMIT_MS, limitExit: EXIT_STOPPED_AT_LIMIT };
  return { limitMs: STEP_LIMITS_MS[step.script] ?? DEFAULT_LIMIT_MS };
}

/** Runs a step through npm, the same command a person would type. */
export function createNpmRunner(log: (line: string) => void, root: string = REPO_ROOT): Runner {
  return (step: GoStep) => {
    const args = ['run', '--silent', step.script, ...(step.args.length ? ['--', ...step.args] : [])];
    return runCommand('npm', args, {
      cwd: root, log,
      env: { ...process.env, ...step.env },
      ...limitFor(step),
      label: `npm ${args.slice(2).join(' ')}`,
    });
  };
}
