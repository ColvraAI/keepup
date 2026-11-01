// npm run go: the morning command. Resumable: every phase looks at real state, skips
// what's done, and reports what's waiting. A lab with no key doesn't stop the rest. Being stopped does.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_NEEDS_KEY, type Env } from './config.ts';
import { brokenLine, buildPlan, command, EXIT_INTERRUPTED, EXIT_STOPPED_AT_LIMIT, PHASES, setupProblem, startNotes, formatPlan, type GoFlags, type GoStep, type Phase, type Runner } from './go-plan.ts';
import { failedLabLines } from './go-checks.ts';
import { notCoveredLine } from './github.ts';
import { objectsPath, readObjects, recordsFor } from './objects.ts';
import { buttonLine, forksSeenRunning, silentForks } from './pr-gate.ts';
import { listSpecs } from './specs.ts';

export { buildPlan, EXIT_INTERRUPTED, EXIT_STOPPED_AT_LIMIT, formatPlan };
export type { GoFlags, GoStep, Phase, Runner };

/** One limit for the whole CI phase. A commit with no checks ends sooner on its own. */
const CI_PHASE_MS = 25 * 60_000;

export interface GoDeps {
  root: string;
  env: Env;
  log: (line: string) => void;
  runner: Runner;
  nowMs?: () => number;
  ciPhaseMs?: number;
  /** Why Docker can't be used, or null. Left out, nothing is checked. */
  dockerProblem?: () => Promise<string | null>;
  /** The repos the installation covers, or null when GitHub can't say. Left out, nothing is checked. */
  coveredForks?: () => Promise<string[] | null>;
  /** Filled in once at the start of a run: why a step can't run this time, or null. */
  holdReason?: (step: GoStep) => string | null;
}

interface Tally { waiting: string[]; failed: string[] }
const addWaiting = (t: Tally, what: string): Tally => ({ ...t, waiting: [...t.waiting, what] });
const addFailed = (t: Tally, what: string): Tally => ({ ...t, failed: [...t.failed, what] });

/** Files of work saved so far under lab/.work/<dir>/full. */
function savedWork(root: string, id: string): number {
  const lab = join(root, 'lab');
  const dir = existsSync(lab) ? readdirSync(lab).find((d) => d.startsWith(`${id}-`)) : undefined;
  const full = join(lab, '.work', dir ?? '', 'full');
  if (!dir || !existsSync(full)) return 0;
  return readdirSync(full, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
}

function report(step: GoStep, code: number, deps: GoDeps, tally: Tally): Tally {
  if (code === 0) return tally;
  if (code === EXIT_STOPPED_AT_LIMIT) {
    const saved = savedWork(deps.root, step.args[0]);
    const line = `${command(step)} stopped at its limit, with ${saved} file${saved === 1 ? '' : 's'} of work saved. Nothing is lost: it resumes from there on the next npm run go.`;
    deps.log(`      ${line}`);
    return addWaiting(tally, line);
  }
  if (code === EXIT_NEEDS_KEY) {
    const because = step.phase === 'ci' ? 'has no green result yet, for the reason above' : 'is waiting on a key or on setup';
    deps.log(`      ${command(step)} ${because}. Carrying on.`);
    return addWaiting(tally, command(step));
  }
  deps.log(`      ${command(step)} failed (exit ${code}). Carrying on.`);
  return addFailed(tally, command(step));
}

async function runStep(step: GoStep, deps: GoDeps, tally: Tally): Promise<Tally> {
  deps.log(`run   ${command(step)}`);
  const started = Date.now();
  const code = await deps.runner(step);
  if (step.script === 'lab' && ![0, EXIT_NEEDS_KEY, EXIT_STOPPED_AT_LIMIT, EXIT_INTERRUPTED].includes(code)) failedLabLines(deps.root, step.args[0], started).forEach((l) => deps.log(l));
  return report(step, code, deps, tally);
}

async function runPhase(phase: Phase, deps: GoDeps, flags: GoFlags, start: Tally): Promise<Tally> {
  const steps = buildPlan(deps.root, deps.env, flags).filter((s) => s.phase === phase);
  let next = start;
  for (const step of steps) {
    const hold = step.skip ? null : deps.holdReason?.(step);
    if (step.skip) deps.log(`skip  ${command(step)}: ${step.skip}`);
    else if (hold && step.script === 'brief') {
      // The files are still worth having. Only the issue has to wait.
      next = await runStep({ ...step, args: [...step.args, '--dry-run'] }, deps, next);
      deps.log(`      Only the files for now: ${hold}`);
    } else if (hold) deps.log(`hold  ${command(step)}: ${hold}`);
    else if (phase === 'setup') {
      const line = `${command(step)}: waiting on setup. ${setupProblem(deps.env, deps.root)} It opens a browser, so go won't run it for you.`;
      deps.log(line);
      next = addWaiting(next, line);
    } else next = await runStep(step, deps, next);
  }
  return next;
}

function gateStep(step: GoStep, flag: '--check-actions' | '--rerun-ci'): GoStep {
  return { phase: step.phase, script: 'pr', args: [step.args[0], flag], skip: null, fork: step.fork };
}

const knownObjects = (deps: GoDeps) => recordsFor(readObjects(deps.root), deps.env.DEMO_ORG);

function holdFork(step: GoStep, deps: GoDeps, tally: Tally): Tally {
  const line = `Actions isn't running on ${deps.env.DEMO_ORG}/${step.fork}. ${buttonLine(deps.env.DEMO_ORG ?? '<org>', step.fork ?? '')} Then run npm run go, which brings CI back on what's already open.`;
  deps.log(line);
  return addWaiting(tally, line);
}

/** What one run of go has learned about the forks. A hold is computed again on each run, from what GitHub has shown. */
interface GateState { closed: Set<string>; revived: Set<string> }

/**
 * A fork with an open pull request that has never shown a run is still behind its gate, as far as anyone can tell, and
 * a hold can't end just because go ended. So its oldest silent pull request gets the check, or one new event, first.
 */
async function reviveSilentForks(deps: GoDeps, start: Tally, gate: GateState, confirmed: Set<string>): Promise<Tally> {
  if (setupProblem(deps.env, deps.root)) return start;
  let tally = start;
  for (const { fork, ids } of silentForks(listSpecs(deps.root).specs, knownObjects(deps).prs)) {
    const held = deps.holdReason?.({ phase: 'prs', script: 'pr', args: [ids[0]], skip: null, fork });
    if (held) continue;
    const before = tally;
    tally = await reviveSilentPull({ phase: 'prs', script: 'pr', args: [ids[0]], skip: null, fork }, deps, tally, gate.closed);
    gate.revived.add(ids[0]);
    if (tally === before && !gate.closed.has(fork)) confirmed.add(fork);
  }
  return tally;
}

/** Pull requests oldest first. After the first one on a fork, make sure Actions really runs there before opening more. */
async function runPrPhase(deps: GoDeps, flags: GoFlags, start: Tally, gate: GateState): Promise<Tally> {
  const specs = listSpecs(deps.root).specs;
  const confirmed = forksSeenRunning(specs, knownObjects(deps).prs);
  let tally = await reviveSilentForks(deps, start, gate, confirmed);
  const steps = buildPlan(deps.root, deps.env, flags).filter((s) => s.phase === 'prs');
  for (const step of steps) {
    if (step.broken) {
      deps.log(brokenLine(step));
      tally = addFailed(tally, step.brokenWhat ?? step.args[0]);
    } else if (step.skip) deps.log(`skip  ${command(step)}: ${step.skip}`);
    else if (deps.holdReason?.(step)) deps.log(`hold  ${command(step)}: ${deps.holdReason(step)}`);
    else if (step.fork && gate.closed.has(step.fork)) deps.log(`hold  ${command(step)}: Actions isn't running on ${step.fork} yet.`);
    else {
      const before = tally;
      tally = await runStep(step, deps, tally);
      if (tally === before && step.fork && !confirmed.has(step.fork)) {
        tally = await confirmGate(step, deps, tally, gate.closed);
        if (!gate.closed.has(step.fork)) confirmed.add(step.fork);
      }
    }
  }
  return tally;
}

async function confirmGate(step: GoStep, deps: GoDeps, tally: Tally, closed: Set<string>): Promise<Tally> {
  const check = gateStep(step, '--check-actions');
  deps.log(`run   ${command(check)}`);
  const code = await deps.runner(check);
  if (code !== EXIT_NEEDS_KEY || !step.fork) return report(check, code, deps, tally);
  closed.add(step.fork);
  return holdFork(step, deps, tally);
}

/** A pull request with no checks: look for a run, and if there's none, fire one new event before giving up on the fork. */
async function reviveSilentPull(step: GoStep, deps: GoDeps, tally: Tally, closed: Set<string>): Promise<Tally> {
  const check = gateStep(step, '--check-actions');
  deps.log(`run   ${command(check)}`);
  const first = await deps.runner(check);
  if (first === 0) return tally;
  if (first !== EXIT_NEEDS_KEY) return report(check, first, deps, tally);
  const afterRerun = await runStep(gateStep(step, '--rerun-ci'), deps, tally);
  if (afterRerun !== tally) return afterRerun;
  deps.log(`run   ${command(check)}`);
  const second = await deps.runner(check);
  if (second === 0) return tally;
  if (second !== EXIT_NEEDS_KEY || !step.fork) return report(check, second, deps, tally);
  closed.add(step.fork);
  return holdFork(step, deps, tally);
}

const silentNow = (step: GoStep, deps: GoDeps): boolean => knownObjects(deps).prs[step.args[0]]?.ci.state === 'none';

async function runCiPhase(deps: GoDeps, flags: GoFlags, start: Tally, gate: GateState): Promise<Tally> {
  const { closed, revived } = gate;
  const now = deps.nowMs ?? (() => Date.now());
  const deadline = now() + (deps.ciPhaseMs ?? CI_PHASE_MS);
  const steps = buildPlan(deps.root, deps.env, flags).filter((s) => s.phase === 'ci');
  let tally = start;
  for (const step of steps) {
    if (step.skip) {
      deps.log(`skip  ${command(step)}: ${step.skip}`);
      continue;
    }
    if (deps.holdReason?.(step)) {
      deps.log(`hold  ${command(step)}: ${deps.holdReason(step)}`);
      continue;
    }
    if (step.fork && closed.has(step.fork)) {
      deps.log(`hold  ${command(step)}: Actions isn't running on ${step.fork} yet.`);
      continue;
    }
    if (silentNow(step, deps) && !revived.has(step.args[0])) {
      tally = await reviveSilentPull(step, deps, tally, closed);
      if (step.fork && closed.has(step.fork)) continue;
    }
    const left = deadline - now();
    if (left <= 0) {
      deps.log(`hold  ${command(step)}: the CI phase's shared time ran out. CI goes on without us: run npm run go again later.`);
      tally = addWaiting(tally, command(step));
      continue;
    }
    tally = await runStep({ ...step, env: { KEEPUP_CI_WAIT_MS: String(left) } }, deps, tally);
  }
  return tally;
}

function objectsText(root: string): string {
  const path = objectsPath(root);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The site shows CI state, so if the CI phase learned something the site's data is rebuilt once more. */
async function runCiThenData(deps: GoDeps, flags: GoFlags, tally: Tally, gate: GateState): Promise<Tally> {
  const before = objectsText(deps.root);
  const after = await runCiPhase(deps, flags, tally, gate);
  if (objectsText(deps.root) === before) return after;
  deps.log('CI results changed, so the site data is rebuilt.');
  return runPhase('data', deps, flags, after);
}

class GoInterrupted extends Error {
  readonly during: GoStep;
  constructor(during: GoStep) {
    super(`Stopped during ${command(during)}.`);
    this.name = 'GoInterrupted';
    this.during = during;
  }
}

/** Every step goes through here, so being stopped ends the run at whichever one it happens in. */
function stoppable(deps: GoDeps, ran: string[]): GoDeps {
  return {
    ...deps,
    runner: async (step) => {
      ran.push(command(step));
      const code = await deps.runner(step);
      if (code === EXIT_INTERRUPTED) throw new GoInterrupted(step);
      return code;
    },
  };
}

function stoppedLines(e: GoInterrupted, ran: string[], deps: GoDeps, flags: GoFlags): string[] {
  const done = ran.slice(0, -1);
  const left = buildPlan(deps.root, deps.env, flags).filter((s) => !s.skip && !s.broken && s.phase !== 'setup').map(command).filter((c) => !ran.includes(c));
  return [
    `Stopped by you during ${command(e.during)}. Nothing else started.`,
    `Ran: ${done.length ? done.join(', ') : 'nothing before that'}.`,
    `Not run: ${left.length ? left.join(', ') : 'nothing'}.`,
    'npm run go carries on from here.',
  ];
}

async function runFirstPass(deps: GoDeps, flags: GoFlags, start: Tally, gate: GateState): Promise<Tally> {
  let tally = start;
  for (const phase of PHASES.filter((p) => p !== 'longLabs' && p !== 'status')) {
    if (phase === 'prs') tally = await runPrPhase(deps, flags, tally, gate);
    else if (phase === 'ci') tally = await runCiThenData(deps, flags, tally, gate);
    else tally = await runPhase(phase, deps, flags, tally);
  }
  return tally;
}

const pendingLong = (deps: GoDeps, flags: GoFlags) => buildPlan(deps.root, deps.env, flags).filter((s) => s.long && !s.skip).map(command);

/** A long lab's numbers arrive after the first pass, so what they unlock goes out now: the pull request, the brief, the site's data, CI. */
async function runLongLabs(deps: GoDeps, flags: GoFlags, start: Tally, gate: GateState): Promise<Tally> {
  const before = pendingLong(deps, flags);
  let tally = await runPhase('longLabs', deps, flags, start);
  const after = pendingLong(deps, flags);
  if (before.every((c) => after.includes(c))) return tally;
  deps.log('A long lab finished, so what it unlocks goes out now.');
  tally = await runPrPhase(deps, flags, tally, gate);
  tally = await runPhase('briefs', deps, flags, tally);
  tally = await runPhase('data', deps, flags, tally);
  return runCiThenData(deps, flags, tally, gate);
}

interface LookFirst { dockerDown: string | null; uncovered: string[] }

/** One look at each, before anything runs: a cause named up front saves a long run of steps that fail for it. */
async function lookFirst(plan: GoStep[], deps: GoDeps): Promise<LookFirst> {
  const labsToRun = plan.some((s) => s.script === 'lab' && !s.skip);
  const dockerDown = labsToRun && deps.dockerProblem ? await deps.dockerProblem() : null;
  const setUp = !setupProblem(deps.env, deps.root);
  const covered = setUp && deps.coveredForks ? await deps.coveredForks() : null;
  const forks = [...new Set(plan.flatMap((s) => (s.fork ? [s.fork] : [])))];
  return { dockerDown, uncovered: covered ? forks.filter((f) => !covered.includes(f)) : [] };
}

function holdsFrom(look: LookFirst, deps: GoDeps): (step: GoStep) => string | null {
  const forkLine = (fork: string) => notCoveredLine(deps.env.DEMO_ORG ?? '<org>', fork, deps.env.GITHUB_APP_INSTALLATION_ID);
  return (step) => {
    if (step.script === 'lab') return look.dockerDown ? "Docker isn't answering." : null;
    const fork = step.script === 'brief' ? step.args[0] : step.fork;
    return fork && look.uncovered.includes(fork) ? forkLine(fork) : null;
  };
}

function firstWaits(look: LookFirst, deps: GoDeps): string[] {
  const hold = holdsFrom(look, deps);
  return [
    ...(look.dockerDown ? [look.dockerDown] : []),
    ...look.uncovered.map((fork) => hold({ phase: 'prs', script: 'pr', args: [], skip: null, fork }) ?? ''),
  ];
}

export async function runGo(flags: GoFlags & { dryRun?: boolean }, deps: GoDeps): Promise<number> {
  const plan = buildPlan(deps.root, deps.env, flags);
  if (flags.dryRun) {
    formatPlan(plan).forEach((l) => deps.log(l));
    deps.log('Nothing was run: this is the plan as things stand now.');
    return 0;
  }
  const look = await lookFirst(plan, deps);
  const waits = firstWaits(look, deps);
  waits.forEach((l) => deps.log(l));
  startNotes(plan, deps.env, Boolean(look.dockerDown)).forEach((l) => deps.log(l));
  const ran: string[] = [];
  const guarded = { ...stoppable(deps, ran), holdReason: holdsFrom(look, deps) };
  const gate: GateState = { closed: new Set(), revived: new Set() };
  let tally: Tally = { waiting: waits, failed: [] };
  try {
    tally = await runFirstPass(guarded, flags, tally, gate);
    tally = await runLongLabs(guarded, flags, tally, gate);
    deps.log(summary(tally));
    tally = await runPhase('status', guarded, flags, tally);
  } catch (e) {
    if (!(e instanceof GoInterrupted)) throw e;
    stoppedLines(e, ran, deps, flags).forEach((l) => deps.log(l));
    return EXIT_INTERRUPTED;
  }
  if (tally.failed.length) return 1;
  return tally.waiting.length ? EXIT_NEEDS_KEY : 0;
}

function summary(tally: Tally): string {
  const parts = [
    tally.failed.length ? `Failed: ${tally.failed.join(', ')}.` : '',
    tally.waiting.length ? `Waiting: ${tally.waiting.join(', ')}.` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Every step ran or was already done.';
}
