// npm run deploy
import { UsageError } from '../config.ts';
import { realRunVercel, realStatusOf, runDeploy, type DeployDeps } from '../deploy.ts';
import { EXIT_OK, parseArgs, reportError, runCli, type CliContext } from './shared.ts';

export async function main(argv: string[], ctx: CliContext, overrides: Partial<DeployDeps> = {}): Promise<number> {
  try {
    const { positional } = parseArgs(argv, [], []);
    if (positional.length) throw new UsageError('Usage: npm run deploy');
    await runDeploy({ root: ctx.root, env: ctx.env, log: ctx.io.out, runVercel: realRunVercel, statusOf: realStatusOf, ...overrides });
    return EXIT_OK;
  } catch (e) {
    return reportError(e, ctx.io);
  }
}

if (import.meta.main) await runCli(main);
