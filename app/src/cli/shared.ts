// What every command shares: the exit codes, and printing that can't leak a secret.
import { EXIT_NEEDS_KEY, loadConfigEnv, NeedsSetupError, repoRoot, UsageError, type Env } from '../config.ts';
import { GuardError } from '../guard.ts';
import { redact, registerEnvSecrets, safeMessage } from '../secrets.ts';
import { NotMeasuredError } from '../template.ts';
import { describeApiError } from '../github.ts';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export { EXIT_NEEDS_KEY };

export interface Io { out: (line: string) => void; err: (line: string) => void }

export const processIo: Io = {
  out: (line) => process.stdout.write(`${redact(line)}\n`),
  err: (line) => process.stderr.write(`${redact(line)}\n`),
};

export interface CliContext { root: string; env: Env; io: Io }

export function defaultContext(): CliContext {
  const root = repoRoot();
  const env = loadConfigEnv(root, process.env);
  registerEnvSecrets(env);
  return { root, env, io: processIo };
}

function isApiError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number';
}

/** Turns anything thrown into a clear line and the right exit code. */
export function reportError(e: unknown, io: Io): number {
  if (e instanceof UsageError) {
    io.err(e.message);
    return EXIT_USAGE;
  }
  if (e instanceof NeedsSetupError || e instanceof NotMeasuredError || (e as Error)?.name === 'NeedsKeyError') {
    io.err(safeMessage(e));
    return EXIT_NEEDS_KEY;
  }
  if (e instanceof GuardError) {
    io.err(`Refused: ${safeMessage(e)}`);
    return EXIT_FAILED;
  }
  io.err(isApiError(e) ? `GitHub said ${describeApiError(e)}` : safeMessage(e));
  return EXIT_FAILED;
}

/** Runs a command's main and exits with its code. Only the entry points call this. */
export async function runCli(main: (argv: string[], ctx: CliContext) => Promise<number>): Promise<never> {
  let ctx: CliContext;
  try {
    ctx = defaultContext();
  } catch (e) {
    process.exit(reportError(e, processIo));
  }
  try {
    process.exit(await main(process.argv.slice(2), ctx));
  } catch (e) {
    process.exit(reportError(e, ctx.io));
  }
}

export interface ParsedArgs { positional: string[]; flags: Map<string, string | true> }

/** Plain flags and `--name value`. A flag not in the lists is a usage error, so typos don't run a real command. */
export function parseArgs(argv: string[], booleans: string[], withValue: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (booleans.includes(arg)) flags.set(arg, true);
    else if (withValue.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value.`);
      flags.set(arg, value);
      i += 1;
    } else throw new UsageError(`Unknown option: ${arg}`);
  }
  return { positional, flags };
}
