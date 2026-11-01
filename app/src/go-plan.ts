// What npm run go would do, as things stand now. Every line is computed from real state.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tryReadResult } from '../../lab/shared/result.ts';
import { patchesCurrent } from './patch-ids.ts';
import { BRIEF_WEEK, namedKeys } from './status-terms.ts';
import { NeedsSetupError, requireAppConfig, type Env } from './config.ts';
import { readObjects, recordsFor, type GithubObjects } from './objects.ts';
import { safeMessage } from './secrets.ts';
import { listSpecs, type PrSpec } from './specs.ts';
import { hasPlaceholder, isMeasured, labOf, measuredProblem, wordsCurrent, type LabView } from './template.ts';

// CI comes after the brief, the replay and the data, so a slow run or a closed Actions gate holds none of them back.
// A lab that takes hours comes after all of it, for the same reason.
export type Phase = 'setup' | 'labs' | 'prs' | 'briefs' | 'replay' | 'data' | 'ci' | 'longLabs' | 'status';
export const PHASES: Phase[] = ['setup', 'labs', 'prs', 'briefs', 'replay', 'data', 'ci', 'longLabs', 'status'];
const REPOS = ['anything-llm', 'aura'];
const SCRIPT_FILES: Record<string, string> = { replay: 'scripts/replay-summary.ts', data: 'scripts/build-site-data.ts' };
/** What a step returns when go itself is being stopped. 128 + SIGINT, as a shell would say. */
export const EXIT_INTERRUPTED = 130;
/** What a long lab returns when its limit stops it. Its work is saved, and the next run carries on from there. */
export const EXIT_STOPPED_AT_LIMIT = 124;
/** Labs whose real run takes hours, by id, with how long their own dry run plans. They run last, so nothing waits for them. */
export const LONG_LABS: Record<string, string> = { '03': 'about 4 hours' };

export interface GoStep {
  phase: Phase;
  script: string;
  args: string[];
  skip: string | null;
  fork?: string;
  /** Set when this can't run because a file is broken: that's a failure, not a skip. Says what's wrong. */
  broken?: string;
  /** What's broken, for the summary. */
  brokenWhat?: string;
  /** A lab that runs for hours and resumes. */
  long?: boolean;
  /** Set on a pull request held only because its lab hasn't finished: that lab's id, and what its result says it needs. */
  waitsOnLab?: { id: string; variant: string | null; needs: string | null };
  env?: Record<string, string>;
}
export interface GoFlags { allowUnmeasured?: boolean; skipLabs?: boolean }

export function setupProblem(env: Env, root: string): string | null {
  try {
    requireAppConfig(env, root);
    return null;
  } catch (e) {
    return e instanceof NeedsSetupError ? e.message : safeMessage(e);
  }
}

function labDirs(root: string): string[] {
  const lab = join(root, 'lab');
  if (!existsSync(lab)) return [];
  return readdirSync(lab).filter((d) => /^\d+-/.test(d) && statSync(join(lab, d)).isDirectory() && existsSync(join(lab, d, 'run.ts'))).sort();
}

function labIdOf(dir: string): string {
  return dir.slice(0, dir.indexOf('-'));
}

/** A result that can't be read counts as not measured here: running the lab is how it gets fixed. */
function dirMeasured(root: string, dir: string): boolean {
  const { result } = tryReadResult(join(root, 'lab', dir, 'result.md'));
  return result?.status === 'measured' && !measuredProblem(join(root, 'lab', dir), [dir], result);
}

function labSkip(measured: boolean, flags: GoFlags): string | null {
  if (flags.skipLabs) return '--skip-labs';
  return measured ? 'already measured' : null;
}

function labSteps(root: string, specs: PrSpec[], flags: GoFlags): GoStep[] {
  const main = labDirs(root).map((dir): GoStep => {
    const id = labIdOf(dir);
    const long = id in LONG_LABS;
    return { phase: long ? 'longLabs' : 'labs', script: 'lab', args: [id], skip: labSkip(dirMeasured(root, dir), flags), ...(long ? { long } : {}) };
  });
  const variants = specs.filter((s) => s.id.includes('-')).map((s): GoStep => {
    const variant = s.id.slice(s.id.indexOf('-') + 1);
    return { phase: 'labs', script: 'lab', args: [s.id.split('-')[0], '--variant', variant], skip: labSkip(isMeasured(labOf(s, root)), flags) };
  });
  return [...main, ...variants];
}

function allApplied(spec: PrSpec, objects: GithubObjects): boolean {
  const applied = objects.prs[spec.id]?.stagesApplied ?? [];
  return spec.stages.every((s) => applied.includes(s.date));
}

/** "All stages applied" says nothing about the words: a lab that finished later still owes the pull request its number. */
function nothingToDo(spec: PrSpec, root: string, objects: GithubObjects, flags: GoFlags, org: string): boolean {
  const record = objects.prs[spec.id];
  if (!record || !allApplied(spec, objects)) return false;
  if (record.state !== 'open') return true;
  // A patch that moved since it was pushed isn't applied. Running the step is what says so, loudly.
  return patchesCurrent(spec, record) && wordsCurrent(spec, record, labOf(spec, root), org, flags.allowUnmeasured);
}

/** What a result said it needed when it was written. With those keys set now, that's no longer what it's waiting for. */
function needsNow(lab: LabView, env: Env): string {
  if (lab.problem) return lab.problem;
  const needs = lab.result?.needs ?? 'a lab run';
  const keys = namedKeys(needs);
  return keys.length && keys.every((k) => env[k]) ? 'a lab run, and its keys are set' : needs;
}

function prSkip(spec: PrSpec, root: string, objects: GithubObjects, flags: GoFlags, setup: string | null, org: string, env: Env): string | null {
  if (setup) return 'waiting on setup';
  if (nothingToDo(spec, root, objects, flags, org)) return 'all stages applied';
  const lab = labOf(spec, root);
  if (isMeasured(lab)) return null;
  const needs = needsNow(lab, env);
  if (!flags.allowUnmeasured) return `its lab isn't measured: needs ${needs}`;
  const stuck = spec.stages.some((s) => hasPlaceholder(s) && !s.titleUnmeasured);
  return stuck ? `its title needs a number from the lab: needs ${needs}` : null;
}

const unmeasuredFlag = (spec: PrSpec, root: string, flags: GoFlags) => (flags.allowUnmeasured && !isMeasured(labOf(spec, root)) ? ['--allow-unmeasured'] : []);

function prSteps(specs: PrSpec[], root: string, objects: GithubObjects, flags: GoFlags, setup: string | null, org: string, env: Env): GoStep[] {
  return specs.map((spec): GoStep => {
    const lab = labOf(spec, root);
    const base = { phase: 'prs' as const, script: 'pr', fork: spec.fork, args: [spec.id, '--all', ...unmeasuredFlag(spec, root, flags)] };
    const done = setup ? 'waiting on setup' : nothingToDo(spec, root, objects, flags, org) ? 'all stages applied' : null;
    if (!done && lab.unreadable) return { ...base, args: [spec.id], skip: null, broken: `this pull request waits, because ${lab.problem}`, brokenWhat: `the lab result of PR ${spec.id}` };
    const skip = prSkip(spec, root, objects, flags, setup, org, env);
    const waiting = skip && !done && !isMeasured(lab);
    const variant = spec.id.includes('-') ? spec.id.slice(spec.id.indexOf('-') + 1) : null;
    return { ...base, skip, ...(waiting ? { waitsOnLab: { id: spec.id.split('-')[0], variant, needs: lab.result?.needs ?? null } } : {}) };
  });
}

function ciSteps(specs: PrSpec[], root: string, objects: GithubObjects, flags: GoFlags, setup: string | null): GoStep[] {
  return specs.map((spec): GoStep => {
    const record = objects.prs[spec.id];
    let skip: string | null = null;
    if (setup) skip = 'waiting on setup';
    else if (!record) skip = 'no pull request yet';
    else if (record.ci.state === 'success') skip = 'CI already green';
    else if (record.state !== 'open') skip = `pull request is ${record.state}`;
    return { phase: 'ci', script: 'pr', fork: spec.fork, args: [spec.id, '--wait-ci', ...unmeasuredFlag(spec, root, flags)], skip };
  });
}

function briefSteps(setup: string | null): GoStep[] {
  return REPOS.map((repo): GoStep => ({ phase: 'briefs', script: 'brief', args: [repo, BRIEF_WEEK, ...(setup ? ['--dry-run'] : [])], skip: null }));
}

function scriptStep(root: string, phase: Phase, script: string): GoStep {
  const file = SCRIPT_FILES[script];
  return { phase, script, args: [], skip: existsSync(join(root, file)) ? null : `${file} isn't there yet` };
}

/** The whole plan as things stand now. go rebuilds it before each phase, because labs and pull requests change the answer. */
export function buildPlan(root: string, env: Env, flags: GoFlags): GoStep[] {
  const setup = setupProblem(env, root);
  const { specs, invalid } = listSpecs(root);
  const objects = recordsFor(readObjects(root), env.DEMO_ORG);
  const org = env.DEMO_ORG ?? objects.org ?? '';
  return [
    { phase: 'setup', script: 'setup', args: ['--org', env.DEMO_ORG ?? '<name>'], skip: setup ? null : 'already set up' },
    ...labSteps(root, specs, flags),
    ...invalid.map((b): GoStep => ({ phase: 'prs', script: 'pr', args: [b.file], skip: null, broken: `this pull request can't open until the spec is fixed. ${b.message}`, brokenWhat: `the spec ${b.file}` })),
    ...prSteps(specs, root, objects, flags, setup, org, env),
    ...briefSteps(setup),
    scriptStep(root, 'replay', 'replay'),
    scriptStep(root, 'data', 'data'),
    ...ciSteps(specs, root, objects, flags, setup),
    { phase: 'status', script: 'status', args: [], skip: null },
  ];
}

export const command = (s: GoStep) => `npm run ${s.script}${s.args.length ? ` -- ${s.args.join(' ')}` : ''}`;

export const brokenLine = (s: GoStep) => `BROKEN ${s.args[0]}: ${s.broken}`;

function planLine(s: GoStep): string {
  if (s.broken) return `  ${brokenLine(s)}`;
  return s.skip ? `  skip  ${command(s)}: ${s.skip}` : `  run   ${command(s)}`;
}

export function formatPlan(plan: GoStep[]): string[] {
  return PHASES.flatMap((phase) => {
    const steps = plan.filter((s) => s.phase === phase);
    if (!steps.length) return [];
    const note = phase === 'prs' && steps.some((s) => !s.skip && !s.broken) ? ['  then  after the first pull request on each fork, check that Actions really ran, and hold that fork if it did not'] : [];
    return [phase, ...steps.map(planLine), ...note];
  });
}

/** What this run can't do and why, said before anything runs, so a person isn't left waiting for what won't come. */
export function startNotes(plan: GoStep[], env: Env = {}, dockerDown = false): string[] {
  const labWillRun = (s: GoStep): boolean => {
    const wait = s.waitsOnLab;
    if (!wait || dockerDown) return false;
    const step = plan.find((l) => l.script === 'lab' && !l.skip && l.args[0] === wait.id && (wait.variant ? l.args.includes(wait.variant) : l.args.length === 1));
    return Boolean(step) && namedKeys(wait.needs).every((k) => env[k]);
  };
  const held = plan.filter((s) => s.phase === 'prs' && s.skip && !['all stages applied', 'waiting on setup'].includes(s.skip) && !labWillRun(s));
  const long = plan.filter((s) => s.long && !s.skip);
  return [
    ...held.map((s) => `Can't open yet: PR ${s.args[0]}: ${s.skip}.`),
    ...long.map((s) => `${command(s)} runs last, because it takes ${LONG_LABS[s.args[0]]}. Nothing waits for it, stopping it loses no work, and --skip-labs leaves it out.`),
  ];
}

export type Runner = (step: GoStep) => Promise<number>;
