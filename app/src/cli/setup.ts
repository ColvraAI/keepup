// npm run setup -- --org <name> [--app-name <name>] [--force] [--overwrite-env] [--new-app]
import { UsageError } from '../config.ts';
import { openInBrowser, readGhToken, runSetup, SetupRefused, type SetupDeps } from '../setup.ts';
import { EXIT_FAILED, EXIT_OK, parseArgs, reportError, runCli, type CliContext } from './shared.ts';

const USAGE = 'Usage: npm run setup -- --org <name> [--app-name <name>] [--force] [--overwrite-env] [--new-app]';

export async function main(argv: string[], ctx: CliContext, overrides: Partial<SetupDeps> = {}): Promise<number> {
  try {
    const { positional, flags } = parseArgs(argv, ['--force', '--overwrite-env', '--new-app'], ['--org', '--app-name']);
    const org = flags.get('--org') as string | undefined;
    if (!org || positional.length) throw new UsageError(USAGE);
    const result = await runSetup(
      { org, appName: flags.get('--app-name') as string | undefined, force: flags.has('--force'), overwriteEnv: flags.has('--overwrite-env'), newApp: flags.has('--new-app') },
      { root: ctx.root, env: ctx.env, ghToken: readGhToken, openBrowser: openInBrowser, log: ctx.io.out, ...overrides },
    );
    return result.problems.length ? EXIT_FAILED : EXIT_OK;
  } catch (e) {
    if (e instanceof SetupRefused) {
      ctx.io.err(e.message);
      return EXIT_FAILED;
    }
    return reportError(e, ctx.io);
  }
}

if (import.meta.main) await runCli(main);
