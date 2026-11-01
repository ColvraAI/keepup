// npm run status: the demo's Done-when list, each line computed from real state.
// It reads and never writes. With --live it asks GitHub instead of trusting the file.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NeedsSetupError, requireAppConfig, SETUP_COMMAND, type Env } from './config.ts';
import { createAppClient, describeApiError } from './github.ts';
import { readObjects, recordsFor, type GithubObjects, type PrRecord } from './objects.ts';
import { redact, safeMessage } from './secrets.ts';
import { actionsPage, buttonLine, silentForks } from './pr-gate.ts';
import { listSpecs, type PrSpec, type SpecList } from './specs.ts';
import { readLiveView, type ActionsLine } from './status-live.ts';
import { BRIEF_WEEK, FORK_NAMES as FORKS, namedKeys } from './status-terms.ts';
import { patchesCurrent } from './patch-ids.ts';
import { tryReadResult } from '../../lab/shared/result.ts';
import { hasPlaceholder, isMeasured, labOf, measuredProblem, wordsCurrent } from './template.ts';

export { BRIEF_WEEK };
export type { ActionsLine };

const REQUIRED_PRS = ['01', '02', '03', '04', '05'];
const MUST_SHOW: Record<string, string> = { '01': '2026-10-22', '04': '2026-10-30' };
const EXTRA_PRS = ['06', '01-jev'];
const TEAM_POINTS_NEEDED = 3;

export interface Check { label: string; ok: boolean; detail?: string }
export interface Item { n: number; label: string; ok: boolean; checks: Check[] }
export interface LabLine { dir: string; status: string; needs?: string; ok: boolean; keysSet?: boolean }

export interface Status {
  items: Item[];
  labs: LabLine[];
  extras: Check[];
  specs: SpecList;
  setup: { ok: boolean; missing: string[]; command?: string; detail?: string };
  live: boolean;
  liveNote: string | null;
  liveNotes: string[];
  actions: ActionsLine[] | null;
  next: { command: string; why: string };
}

function listLabs(root: string, env: Env): LabLine[] {
  const lab = join(root, 'lab');
  if (!existsSync(lab)) return [];
  const dirs = readdirSync(lab).filter((d) => d !== 'shared' && statSync(join(lab, d)).isDirectory() && /^\d/.test(d)).sort();
  return dirs.map((dir) => {
    const { result, problem: unreadable } = tryReadResult(join(lab, dir, 'result.md'));
    if (unreadable) return { dir, status: `unreadable result.md: ${redact(unreadable)}`, ok: false };
    const problem = measuredProblem(join(lab, dir), [dir], result);
    const status = problem ? `${result?.status}, but ${problem}` : (result?.status ?? 'no result yet');
    const keys = namedKeys(result?.needs);
    const keysSet = keys.length > 0 && keys.every((k) => env[k]);
    return { dir, status, ok: result?.status === 'measured' && !problem, ...(result?.needs ? { needs: result.needs } : {}), ...(keysSet ? { keysSet } : {}) };
  });
}

function setupState(env: Env, root: string): Status['setup'] {
  try {
    requireAppConfig(env, root);
    return { ok: true, missing: [] };
  } catch (e) {
    if (e instanceof NeedsSetupError) return { ok: false, missing: e.missing, command: e.command, detail: e.message };
    return { ok: false, missing: [safeMessage(e)] };
  }
}

/** A file a person or a killed process can leave half-written: unreadable means absent here, and the check says so. */
function readJson<T>(path: string): { value: T | null; problem: string | null } {
  if (!existsSync(path)) return { value: null, problem: null };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T, problem: null };
  } catch (e) {
    return { value: null, problem: `${path} isn't valid JSON (${(e as Error).message})` };
  }
}

function siteItem(root: string): Item {
  const site = join(root, 'site');
  const dataDirs = ['public/data', 'data', 'src/data'].map((d) => join(site, d));
  const hasData = dataDirs.some((d) => existsSync(d) && readdirSync(d).length > 0);
  const siteFile = join(root, 'data', 'site.json');
  const recorded = readJson<{ url?: string } | null>(siteFile);
  const url = recorded.value?.url;
  const checks: Check[] = [
    { label: 'site/ exists', ok: existsSync(join(site, 'package.json')) },
    { label: "the site's data is built", ok: hasData, detail: hasData ? undefined : 'run npm run data' },
    { label: 'deployed, with its URL in data/site.json', ok: Boolean(url), detail: url ?? recorded.problem ?? 'not deployed yet, as far as this repo knows' },
  ];
  return { n: 1, label: 'The demo site is live with all seven screens', ok: checks.every((c) => c.ok), checks };
}

/** What the pull request says against what the lab says now. Only an open one can still be changed. */
function wordProblems(id: string, spec: PrSpec, record: PrRecord, root: string, org: string): string[] {
  const lab = labOf(spec, root);
  if (!isMeasured(lab)) return [];
  const applied = spec.stages.filter((s) => record.stagesApplied.includes(s.date));
  const last = applied[applied.length - 1];
  const number = lab.result?.title_number;
  const noNumber = last && hasPlaceholder(last) && number && !record.title.includes(number);
  if (record.state === 'open' && !wordsCurrent(spec, record, lab, org)) return [`its title or body on GitHub isn't what the lab's result gives: run npm run pr -- ${id} --all`];
  return noNumber ? [`its title doesn't carry the lab's number (${number})`] : [];
}

function prCheck(id: string, record: PrRecord | undefined, specs: SpecList, root: string, org: string): Check {
  const label = `PR ${id}`;
  if (!record) return { label, ok: false, detail: 'not opened yet' };
  const spec = specs.specs.find((s) => s.id === id);
  const problems = [
    ...(['open', 'merged'].includes(record.state) ? [] : [`state ${record.state}`]),
    ...(record.author.endsWith('[bot]') ? [] : [`opened by ${record.author}, not the bot`]),
    ...(spec && record.base !== spec.baseBranch ? [`base ${record.base}, expected ${spec.baseBranch}`] : []),
    ...(record.ci.state === 'success' ? [] : [`CI ${record.ci.state}${record.ci.url ? ` (${record.ci.url})` : ''}`]),
    ...(spec && record.state === 'open' && !patchesCurrent(spec, record) ? [`a patch on disk isn't what went to the fork: run npm run pr -- ${id} --all, which says what to do`] : []),
    ...(spec && !isMeasured(labOf(spec, root)) ? ["its lab isn't measured, so its table isn't real yet"] : []),
    ...(spec ? wordProblems(id, spec, record, root, org) : []),
    ...(MUST_SHOW[id] && !record.stagesApplied.includes(MUST_SHOW[id]) ? [`needs its ${MUST_SHOW[id]} update`] : []),
  ];
  return { label, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${record.state}, CI green, ${record.url}` };
}

function prsItem(objects: GithubObjects, specs: SpecList, root: string, org: string): Item {
  const checks = REQUIRED_PRS.map((id) => prCheck(id, objects.prs[id], specs, root, org));
  return { n: 2, label: 'Pull requests 01–05 are open on the forks, by the bot, CI green, lab tables posted, with the 22 Oct and 30 Oct updates', ok: checks.every((c) => c.ok), checks };
}

function briefItem(objects: GithubObjects): Item {
  const checks: Check[] = FORKS.map((f) => {
    const issue = objects.issues[`${f}/${BRIEF_WEEK}`];
    return { label: `${f} issue, week of 26 Oct`, ok: Boolean(issue), detail: issue?.url ?? 'not posted yet' };
  });
  return { n: 3, label: 'The weekly issue exists on both forks', ok: checks.every((c) => c.ok), checks };
}

function teamPoints(root: string): number {
  const { value: timeline } = readJson<{ repos?: { events: { team?: { commit?: string | null; date?: string | null; days_after?: number | null } }[] }[] }>(join(root, 'data', 'timeline.json'));
  return (timeline?.repos ?? []).flatMap((r) => r.events).filter((e) => e.team?.commit && e.team.date && (e.team.days_after ?? 0) > 0).length;
}

function replayItem(root: string): Item {
  const points = teamPoints(root);
  const hasSummary = existsSync(join(root, 'data', 'replay-summary.json'));
  const checks: Check[] = [
    { label: 'data/replay-summary.json is computed', ok: hasSummary, detail: hasSummary ? undefined : 'run npm run replay' },
    { label: `at least ${TEAM_POINTS_NEEDED} "team shipped it" points`, ok: points >= TEAM_POINTS_NEEDED, detail: `${points} real team points in data/timeline.json` },
  ];
  return { n: 4, label: 'The replay headline is computed from timeline.json', ok: checks.every((c) => c.ok), checks };
}

function runThroughItem(root: string): Item {
  const done = existsSync(join(root, 'data', 'run-through.json'));
  const checks: Check[] = [{ label: 'recorded once as a backup video', ok: done, detail: done ? undefined : 'a person records this, then saves data/run-through.json' }];
  return { n: 5, label: 'A two-minute run-through works start to finish', ok: done, checks };
}

interface NextInputs { setup: Status['setup']; specs: SpecList; items: Item[]; labs: LabLine[]; env: Env; actions: ActionsLine[] | null; missingForks: string[]; org: string | undefined; objects: GithubObjects; objectsProblem: string | null }

function missingKeys(labs: LabLine[], env: Env): { keys: string[]; labs: string[] } {
  const waiting = labs.filter((l) => !l.ok && l.needs);
  const named = (l: LabLine) => (l.needs?.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []).filter((k) => !env[k]);
  const stuck = waiting.filter((l) => named(l).length > 0);
  return { keys: [...new Set(stuck.flatMap(named))], labs: stuck.map((l) => l.dir) };
}

function deployStep(items: Item[], env: Env): Status['next'] | null {
  const site = items.find((i) => i.n === 1);
  if (!site || site.ok) return null;
  const failing = site.checks.filter((c) => !c.ok).map((c) => c.label);
  if (failing.includes('site/ exists')) return { command: 'build site/', why: "There's no site to deploy yet: site/package.json doesn't exist." };
  if (failing.includes("the site's data is built")) return { command: 'npm run data', why: "The site's data isn't built yet." };
  if (!env.VERCEL_TOKEN) return { command: 'add VERCEL_TOKEN to .env, then run npm run deploy', why: 'Everything else this list checks here is ahead of the site. The token comes from https://vercel.com/account/tokens.' };
  return { command: 'npm run deploy', why: 'It deploys the built site and writes data/site.json once the address answers.' };
}

/** A fork whose open pull request has never shown a check: pressing the button is the one thing that helps. A minute after a push, it's too soon to say. */
function buttonStep(input: NextInputs): Status['next'] | null {
  const { specs, objects, actions, org } = input;
  const waiting = (fork: string) => actions?.find((a) => a.fork === fork)?.state === 'waiting';
  const silent = silentForks(specs.specs, objects.prs).find((f) => !waiting(f.fork));
  if (!silent || !org) return null;
  return {
    command: `fix Actions on ${silent.fork}: open ${actionsPage(org, silent.fork)}, press the button if it's there, then run npm run go`,
    why: `${buttonLine(org, silent.fork)} Pull request ${silent.ids.join(', ')} has no checks, so go holds this fork's others, and running it again won't change that until the button is pressed.`,
  };
}

/** go only rereads a finished run, and the App can't rerun one. Closing and reopening is the one thing that fires another. */
function failedCiStep({ specs, objects, org }: NextInputs): Status['next'] | null {
  const failed = specs.specs.find((s) => objects.prs[s.id]?.state === 'open' && ['failure', 'neutral'].includes(objects.prs[s.id].ci.state));
  if (!failed) return null;
  const { ci } = objects.prs[failed.id];
  return {
    command: `look at the CI run of PR ${failed.id}: ${ci.url ?? (org ? actionsPage(org, failed.fork) : 'its Actions tab')}. If it's a flake, run npm run pr -- ${failed.id} --rerun-ci`,
    why: `Its CI finished as ${ci.state}. npm run go only rereads a finished run, so it won't change this.`,
  };
}

function nextStep(input: NextInputs): Status['next'] {
  const { setup, specs, items, labs, env, actions, missingForks, org, objectsProblem } = input;
  if (objectsProblem) return { command: 'fix data/github-objects.json', why: objectsProblem };
  if (specs.invalid.length) return { command: 'fix the spec named below', why: specs.invalid[0].message };
  if (!setup.ok) return { command: setup.command ?? SETUP_COMMAND, why: setup.detail ?? `Missing: ${setup.missing.join(', ')}.` };
  if (items.every((i) => i.ok)) return { command: 'nothing', why: 'Everything on the list is done.' };
  if (missingForks.length) return { command: `add ${missingForks.join(' and ')} to the installation, at https://github.com/organizations/${org}/settings/installations`, why: "The App can't reach them, so nothing on them can be written." };
  const button = buttonStep(input);
  if (button) return button;
  const prs = items.find((i) => i.n === 2);
  const keys = missingKeys(labs, env);
  if (!prs?.ok && keys.keys.length) return { command: `add ${keys.keys.join(', ')} to .env, then run npm run go`, why: `Labs ${keys.labs.join(', ')} are waiting on them. To open their pull requests first, without numbers: npm run go -- --allow-unmeasured` };
  const stuck = actions?.find((a) => a.state === 'closed');
  if (stuck) return { command: `fix Actions on ${stuck.fork}`, why: stuck.detail };
  const failed = failedCiStep(input);
  if (failed) return failed;
  if (items.some((i) => [2, 3, 4].includes(i.n) && !i.ok)) return { command: 'npm run go', why: 'It resumes from wherever this list says things are.' };
  return deployStep(items, env) ?? { command: 'record the run-through, then save data/run-through.json', why: 'A person does this one: walk the demo once, as a backup video.' };
}

export interface StatusRequest { root: string; env: Env; live?: boolean; nowMs?: () => number }

interface LiveRead { objects: GithubObjects; live: boolean; note: string | null; notes: string[]; actions: ActionsLine[] | null; missingForks: string[] }

async function readLive(request: StatusRequest, objects: GithubObjects, setup: Status['setup'], specs: PrSpec[]): Promise<LiveRead> {
  const fromFile = (note: string | null): LiveRead => ({ objects, live: false, note, notes: [], actions: null, missingForks: [] });
  if (!request.live) return fromFile(null);
  if (!setup.ok) return fromFile(`--live needs ${setup.missing.join(', ')}. Showing the file instead.`);
  try {
    const config = requireAppConfig(request.env, request.root);
    const view = await readLiveView(createAppClient(config, request.env), config, objects, specs, (request.nowMs ?? Date.now)());
    return { objects: view.objects, live: true, note: 'Read live from GitHub just now.', notes: view.notes, actions: view.actions, missingForks: view.missingForks };
  } catch (e) {
    return fromFile(`Couldn't read GitHub (${describeApiError(e)}). Showing the file instead.`);
  }
}

function readObjectsSafely(root: string): { objects: GithubObjects; problem: string | null } {
  try {
    return { objects: readObjects(root), problem: null };
  } catch (e) {
    return { objects: { schema: 1, forks: {}, prs: {}, issues: {} }, problem: safeMessage(e) };
  }
}

export async function computeStatus(request: StatusRequest): Promise<Status> {
  const { root, env } = request;
  const specs = listSpecs(root);
  const setup = setupState(env, root);
  const { objects, problem: objectsProblem } = readObjectsSafely(root);
  const stored = recordsFor(objects, env.DEMO_ORG);
  const org = env.DEMO_ORG ?? stored.org ?? '';
  const read = await readLive(request, stored, setup, specs.specs);
  const items = [siteItem(root), prsItem(read.objects, specs, root, org), briefItem(read.objects), replayItem(root), runThroughItem(root)];
  const extras = EXTRA_PRS.map((id) => prCheck(id, read.objects.prs[id], specs, root, org));
  const labs = listLabs(root, env);
  const next = nextStep({ setup, specs, items, labs, env, actions: read.actions, missingForks: read.missingForks, org: env.DEMO_ORG, objects: read.objects, objectsProblem });
  return { items, labs, extras, specs, setup, live: read.live, liveNote: read.note, liveNotes: [...(objectsProblem ? [objectsProblem] : []), ...read.notes], actions: read.actions, next };
}

const mark = (ok: boolean) => (ok ? '✓' : '✗');

export function formatStatus(status: Status): string {
  const checkLine = (c: Check) => `    ${mark(c.ok)} ${c.label}${c.detail ? `: ${c.detail}` : ''}`;
  const sections = [
    'Done when',
    ...status.items.flatMap((i) => [`${mark(i.ok)} ${i.n}. ${i.label}`, ...i.checks.map(checkLine)]),
    '',
    'Also in the story',
    ...status.extras.map(checkLine),
    '',
    'Labs',
    ...(status.labs.length ? status.labs.map((l) => `    ${mark(l.ok)} ${l.dir}: ${l.status}${l.needs ? `, needs ${l.needs}${l.keysSet ? ' (set now, so the next npm run go runs it)' : ''}` : ''}`) : ['    none yet']),
    '',
    `Setup: ${status.setup.ok ? 'done' : 'not done'}${status.setup.ok ? '' : `. Missing: ${status.setup.missing.join(', ')}`}`,
    ...(status.liveNote ? [status.liveNote] : []),
    ...status.liveNotes,
    ...(status.actions ?? []).map((a) => `Actions on ${a.fork}: ${mark(a.ok)} ${a.detail}`),
    ...status.specs.invalid.map((b) => `Broken spec: ${b.message}`),
    '',
    `Next: ${status.next.command}`,
    status.next.why,
  ];
  return sections.join('\n');
}
