// npm run go [-- --dry-run] [--allow-unmeasured] [--skip-labs]
import { UsageError } from '../config.ts';
import { runGo, type Runner } from '../go.ts';
import { dockerProblem, readCoveredForks } from '../go-checks.ts';
import { createNpmRunner } from '../go-runner.ts';
import { parseArgs, reportError, runCli, type CliContext } from './shared.ts';

export async function main(argv: string[], ctx: CliContext, runner?: Runner): Promise<number> {
  try {
    const { positional, flags } = parseArgs(argv, ['--dry-run', '--allow-unmeasured', '--skip-labs'], []);
    if (positional.length) throw new UsageError('Usage: npm run go [-- --dry-run] [--allow-unmeasured] [--skip-labs]');
    return await runGo(
      { dryRun: flags.has('--dry-run'), allowUnmeasured: flags.has('--allow-unmeasured'), skipLabs: flags.has('--skip-labs') },
      {
        root: ctx.root, env: ctx.env, log: ctx.io.out, runner: runner ?? createNpmRunner(ctx.io.out),
        // A runner handed in is a test's: it gets no real Docker and no real GitHub.
        ...(runner ? {} : { dockerProblem, coveredForks: () => readCoveredForks(ctx.root, ctx.env) }),
      },
    );
  } catch (e) {
    return reportError(e, ctx.io);
  }
}

if (import.meta.main) await runCli(main);
