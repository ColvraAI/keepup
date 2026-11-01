// npm run brief -- <repo> <week> [--dry-run]
import { runBrief } from '../brief.ts';
import { UsageError } from '../config.ts';
import { EXIT_NEEDS_KEY, EXIT_OK, parseArgs, reportError, runCli, type CliContext } from './shared.ts';

const USAGE = 'Usage: npm run brief -- <anything-llm|aura> <Monday, e.g. 2026-10-26> [--dry-run]';

export async function main(argv: string[], ctx: CliContext): Promise<number> {
  try {
    const { positional, flags } = parseArgs(argv, ['--dry-run'], []);
    if (positional.length !== 2) throw new UsageError(USAGE);
    const [repo, week] = positional;
    const result = await runBrief(
      { repo, week, dryRun: flags.has('--dry-run') },
      { root: ctx.root, env: ctx.env, now: () => new Date(), log: ctx.io.out },
    );
    ctx.io.out(result.brief.title);
    ctx.io.out(result.brief.quietLine);
    ctx.io.out(result.brief.note);
    result.files.forEach((f) => ctx.io.out(`Wrote ${f}`));
    if (flags.has('--dry-run')) ctx.io.out('Dry run: nothing was posted or sent.');
    result.waiting.forEach(ctx.io.err);
    return result.waiting.length ? EXIT_NEEDS_KEY : EXIT_OK;
  } catch (e) {
    return reportError(e, ctx.io);
  }
}

if (import.meta.main) await runCli(main);
