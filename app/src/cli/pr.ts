// npm run pr -- <id> [--update <date> | --all] [--allow-unmeasured] [--wait-ci] [--rerun-ci] [--check-actions]
import { UsageError } from '../config.ts';
import { createPrDeps, openOrUpdate, type PrDeps, type PrOutcome } from '../pr.ts';
import { actionsPage, buttonLine, checkActions, rerunCi } from '../pr-gate.ts';
import { findSpec, isRealDate, type PrSpec } from '../specs.ts';
import { EXIT_FAILED, EXIT_NEEDS_KEY, EXIT_OK, parseArgs, reportError, runCli, type CliContext } from './shared.ts';

const USAGE = 'Usage: npm run pr -- <id> [--update <date> | --all] [--allow-unmeasured] [--wait-ci] [--rerun-ci] [--check-actions]';

function describe(o: PrOutcome): string[] {
  const did = [
    o.opened ? 'opened' : '',
    o.pushedStages.length ? `pushed ${o.pushedStages.join(', ')}` : '',
    o.edited ? 'edited title and body' : '',
    o.commented ? `posted ${o.commented} comment${o.commented === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return [
    `PR ${o.id}: #${o.number} ${o.url}`,
    `  ${did.length ? did.join(', ') : 'nothing new to do'}. State ${o.state}. CI ${o.ci.state}${o.ci.url ? ` (${o.ci.url})` : ''}.`,
  ];
}

/** Only success is green. Exit 3 means something else has to happen first; exit 1 means CI itself said no. */
export function exitForCi(o: PrOutcome, waited: boolean): number {
  if (!waited || o.ci.state === 'success') return EXIT_OK;
  if (o.ci.state === 'none' || o.ci.state === 'pending') return EXIT_NEEDS_KEY;
  return EXIT_FAILED;
}

/** What to do about a result that isn't green, naming the real cause. */
export function ciCause(o: PrOutcome, org: string, fork: string): string | null {
  switch (o.ci.state) {
    case 'none': return `GitHub reports no checks on this commit, so Actions probably isn't running on the fork. ${buttonLine(org, fork)} Then run: npm run pr -- ${o.id} --rerun-ci`;
    case 'pending': return `CI is still running, so nothing is recorded as green yet. Watch it at ${o.ci.url ?? actionsPage(org, fork)} and run this again later.`;
    case 'neutral': return `CI finished without a pass: the checks were skipped, or the repo's test workflow didn't succeed on this commit. Look at ${o.ci.url ?? actionsPage(org, fork)}. If it's a flake: npm run pr -- ${o.id} --rerun-ci`;
    case 'failure': return `CI failed: ${o.ci.url ?? actionsPage(org, fork)} If it's a flake: npm run pr -- ${o.id} --rerun-ci`;
    default: return null;
  }
}

async function runCheckActions(spec: PrSpec, deps: PrDeps, ctx: CliContext): Promise<number> {
  const check = await checkActions(spec, deps);
  if (check.running) {
    ctx.io.out(`PR ${spec.id}: Actions is running on ${spec.fork}: ${check.runs} workflow run${check.runs === 1 ? '' : 's'} on ${check.sha}.`);
    return EXIT_OK;
  }
  ctx.io.err(`PR ${spec.id}: no workflow run on ${check.sha} after ${Math.round(deps.gateWindowMs / 1000)} seconds. ${buttonLine(deps.org, spec.fork)}`);
  return EXIT_NEEDS_KEY;
}

async function runOpenOrUpdate(spec: PrSpec, deps: PrDeps, flags: Map<string, string | true>, ctx: CliContext): Promise<number> {
  const waitCi = flags.has('--wait-ci');
  const update = flags.get('--update') as string | undefined;
  const outcome = await openOrUpdate(spec, { update, all: flags.has('--all'), allowUnmeasured: flags.has('--allow-unmeasured'), waitCi }, deps);
  describe(outcome).forEach(ctx.io.out);
  const code = exitForCi(outcome, waitCi);
  const cause = code === EXIT_OK ? null : ciCause(outcome, deps.org, spec.fork);
  if (cause) ctx.io.err(cause);
  return code;
}

function checkFlags(positional: string[], flags: Map<string, string | true>): void {
  if (positional.length !== 1) throw new UsageError(USAGE);
  const update = flags.get('--update') as string | undefined;
  if (update && !isRealDate(update)) throw new UsageError(`--update needs a date in YYYY-MM-DD, not ${update}.\n${USAGE}`);
  if (update && flags.has('--all')) throw new UsageError(`--update and --all ask for different things. Pick one.\n${USAGE}`);
  if (flags.has('--check-actions') && flags.size > 1) throw new UsageError(`--check-actions only looks, so it takes no other option.\n${USAGE}`);
}

export async function main(argv: string[], ctx: CliContext, overrides: Partial<PrDeps> = {}): Promise<number> {
  try {
    const { positional, flags } = parseArgs(argv, ['--all', '--allow-unmeasured', '--wait-ci', '--rerun-ci', '--check-actions'], ['--update']);
    checkFlags(positional, flags);
    const spec = findSpec(positional[0], ctx.root);
    const deps = createPrDeps(ctx.root, ctx.env, { log: ctx.io.out, ...overrides });
    if (flags.has('--check-actions')) return await runCheckActions(spec, deps, ctx);
    if (flags.has('--rerun-ci')) {
      await rerunCi(spec, deps);
      if (flags.size === 1) return EXIT_OK;
    }
    return await runOpenOrUpdate(spec, deps, flags, ctx);
  } catch (e) {
    return reportError(e, ctx.io);
  }
}

if (import.meta.main) await runCli(main);
