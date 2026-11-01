// npm run status [-- --live]
import { UsageError } from '../config.ts';
import { computeStatus, formatStatus } from '../status.ts';
import { EXIT_OK, parseArgs, reportError, runCli, type CliContext } from './shared.ts';

export async function main(argv: string[], ctx: CliContext): Promise<number> {
  try {
    const { positional, flags } = parseArgs(argv, ['--live'], []);
    if (positional.length) throw new UsageError('Usage: npm run status [-- --live]');
    const status = await computeStatus({ root: ctx.root, env: ctx.env, live: flags.has('--live') });
    ctx.io.out(formatStatus(status));
    return EXIT_OK;
  } catch (e) {
    return reportError(e, ctx.io);
  }
}

if (import.meta.main) await runCli(main);
