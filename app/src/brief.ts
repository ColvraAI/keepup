// npm run brief: the Monday brief, computed only from data/timeline.json, the labs,
// data/github-objects.json and data/db. It reaches a founder as a GitHub issue (D7: no email).
// A pull request's plain line, effect and effort come from its pr.json. Timeline events with no
// pull request, and pull requests with no pr.json yet, take theirs from app/brief-labels.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { recordDate, type DateWindow, type DbRow } from '../../scripts/site-data/sources.ts';
import { NeedsSetupError, requireAppConfig, UsageError, type Env } from './config.ts';
import { renderHtml, renderMarkdownBody, renderMarkdownFile } from './brief-render.ts';
import { createAppClient, getAppInfo, getBotIdentity, isNotCovered, isStatus, notCoveredLine, type Client } from './github.ts';
import { assertDemoRepo, assertPublicText } from './guard.ts';
import { readObjects, recordsFor, updateObjects, withFork, withIssue, writeFileAtomic, type GithubObjects } from './objects.ts';
import { assertPublicSafe } from './secrets.ts';
import { isRealDate, listSpecs, type PrSpec } from './specs.ts';
import { formatDate, isMeasured, labOf } from './template.ts';

export const REPOS = ['anything-llm', 'aura'] as const;
export type BriefRepo = (typeof REPOS)[number];

interface TimelineEvent {
  date: string;
  thing: string;
  kind: string;
  source_url: string;
  keepup: { action: string; pr?: string; summary: string };
  team?: { date: string | null; commit: string | null; days_after: number | null; note: string };
}

interface TimelineRepo { repo: string; events: TimelineEvent[] }
interface Label { plain: string; effect: string[]; effort: string; proof?: string }

export interface BriefItem { plain: string; effect: string; proof: string; effort: string; details: string[]; pr: string | null }
export interface Checked { count: number; counted: string[]; left_out: string[] }

export interface Brief {
  repo: string;
  week: string;
  title: string;
  items: BriefItem[];
  heldBack: string[];
  watching: string[];
  team: string[];
  checked: Checked;
  quietLine: string;
  note: string;
  body: string;
}

export function assertMonday(week: string): void {
  if (!isRealDate(week)) throw new UsageError(`${week} isn't a date in YYYY-MM-DD.`);
  if (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) throw new UsageError(`${week} is not a Monday. A brief's week starts on a Monday, such as 2026-10-26.`);
}

export function weekDates(week: string): { from: string; to: string } {
  const to = new Date(Date.parse(`${week}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  return { from: week, to };
}

function readRecords(path: string): DbRow[] {
  try {
    return gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as DbRow);
  } catch (e) {
    throw new Error(`${path} can't be read as gzipped JSON lines: ${(e as Error).message}`);
  }
}

const ALL_TIME: DateWindow = { from: '0000-01-01', to: '9999-12-31', fetched: '' };

function replayWindow(root: string): DateWindow {
  const path = join(root, 'data', 'timeline.json');
  if (!existsSync(path)) return ALL_TIME;
  const { window } = JSON.parse(readFileSync(path, 'utf8')) as { window?: Partial<DateWindow> };
  return window?.from && window.to ? { ...ALL_TIME, ...window } : ALL_TIME;
}

/** Every data/db record dated in the week, each with its one date (recordDate, as on the pulse), so no record counts in two weeks. */
export function countChecked(root: string, week: string): Checked {
  const db = join(root, 'data', 'db');
  const files = existsSync(db) ? readdirSync(db).sort() : [];
  const { from, to } = weekDates(week);
  const window = replayWindow(root);
  const inWeek = (row: DbRow) => {
    const { date } = recordDate(row, window);
    return date !== null && date >= from && date <= to;
  };
  const left_out = files.filter((f) => !f.endsWith('.jsonl.gz')).map((f) => f.replace(/\.[^.]*(\.gz)?$/, '').replace(/\.txt$/, ''));
  const counted = files.filter((f) => f.endsWith('.jsonl.gz'));
  const count = counted.reduce((sum, file) => sum + readRecords(join(db, file)).filter(inWeek).length, 0);
  return { count, counted: counted.map((f) => f.replace('.jsonl.gz', '')), left_out };
}

function loadTimeline(root: string, repo: string): TimelineRepo {
  const timeline = JSON.parse(readFileSync(join(root, 'data', 'timeline.json'), 'utf8')) as { repos: TimelineRepo[] };
  const found = timeline.repos.find((r) => r.repo.endsWith(`/${repo}`));
  if (!found) throw new Error(`data/timeline.json has no repo named ${repo}.`);
  return found;
}

function loadLabels(root: string): Record<string, Label> {
  const local = join(root, 'app', 'brief-labels.json');
  return JSON.parse(readFileSync(existsSync(local) ? local : join(REPO_ROOT, 'app', 'brief-labels.json'), 'utf8')) as Record<string, Label>;
}

function labelFor(labels: Record<string, Label>, key: string): Label {
  const label = labels[key];
  if (!label) throw new Error(`app/brief-labels.json has no entry for ${key}. Add its plain line, effect and effort.`);
  return label;
}

function proofOf(spec: PrSpec | undefined, root: string): string {
  if (!spec) return 'not measured yet';
  if (isMeasured(labOf(spec, root))) return 'measured';
  return spec.proof.vendor ? 'vendor claim' : 'not measured yet';
}

const eventDetail = (e: TimelineEvent) => `${e.thing} (${formatDate(e.date, false)}): ${e.keepup.summary}. [Source](${e.source_url})`;

function prLink(objects: GithubObjects, id: string): string {
  const pr = objects.prs[id];
  return pr ? `[Pull request #${pr.number}: ${pr.title}](${pr.url})` : 'pull request not opened yet';
}

/** One item per pull request: two events in a week against the same one read as one finding. */
function prItem(id: string, events: TimelineEvent[], specs: PrSpec[], root: string, objects: GithubObjects, labels: Record<string, Label>): BriefItem {
  const spec = specs.find((s) => s.id === id);
  const words = spec ? { plain: spec.founderLine, effect: spec.effect, effort: spec.effort } : labelFor(labels, id);
  return {
    plain: words.plain, effect: words.effect.join(', '), effort: words.effort,
    proof: proofOf(spec, root),
    details: events.filter((e) => e.keepup.pr === id).map(eventDetail),
    pr: prLink(objects, id),
  };
}

function buildItems(events: TimelineEvent[], repo: string, root: string, objects: GithubObjects, labels: Record<string, Label>): BriefItem[] {
  const specs = listSpecs(root).specs;
  const withPr = events.filter((e) => e.keepup.pr && ['pr_opened', 'pr_updated'].includes(e.keepup.action));
  const ids = [...new Set(withPr.map((e) => e.keepup.pr as string))];
  const findings = events.filter((e) => ['finding', 'brief_only'].includes(e.keepup.action)).map((e): BriefItem => {
    const label = labelFor(labels, `${repo}/${e.date}`);
    return { plain: label.plain, effect: label.effect.join(', '), effort: label.effort, proof: label.proof ?? 'not measured yet', details: [eventDetail(e)], pr: null };
  });
  return [...ids.map((id) => prItem(id, withPr, specs, root, objects, labels)), ...findings];
}

/** Each row's own note on what the commit did, with a sentence two rows share said once. */
function rowNotes(group: TimelineEvent[]): string {
  const sentences = group.flatMap((e) => (e.team?.note ?? '').split(/(?<=\.)\s+/).map((s) => s.replace(/\.$/, '').trim()).filter(Boolean));
  return [...new Set(sentences)].map((s) => `${s}.`).join(' ');
}

const OWN_COUNT = /^(\d+ days after [^.]*)\.\s*/;
const NOT_YET_HAPPENED = /\b(shuts down|retires)\b/;

/** "56 days after X shuts down on 23 Oct" would read as 56 days after 23 Oct. The count is from the row's day. */
function sinceWhat(event: TimelineEvent): string {
  return NOT_YET_HAPPENED.test(event.thing) ? `keepup would have raised it on ${formatDate(event.date, false)}` : event.thing;
}

// days_after counts from the row's date in the replay, which for something older than the install is 1 Sep.
// So a row with no pull request says that, and the note says what the gap really was.
function teamNote(group: TimelineEvent[], upstream: string, objects: GithubObjects): string {
  const { team, keepup } = group[0];
  const when = formatDate(team?.date as string, false);
  const commit = `[${(team?.commit as string).slice(0, 8)}](https://github.com/${upstream}/commit/${team?.commit})`;
  const allNotes = rowNotes(group);
  if (!keepup.pr) {
    const days = group.map((e) => e.team?.days_after).join(' and ');
    return `Your team handled this itself on ${when}, ${days} days after keepup would have raised it: ${allNotes} Commit ${commit}.`;
  }
  // A note that opens with its own count belongs in the sentence with the other one.
  const own = OWN_COUNT.exec(allNotes);
  const notes = own ? allNotes.slice(own[0].length).trim() : allNotes;
  const counted = group.map((e) => `${e.team?.days_after} days after ${sinceWhat(e)}`).join(', and ');
  const after = own ? `${counted}, and ${own[1]}` : counted;
  const pr = objects.prs[keepup.pr];
  if (!pr) return `A later team commit overlaps this: ${commit} on ${when}, ${after}. ${notes} keepup's own pull request for it is not opened yet.`;
  return `A later team commit overlaps [pull request ${keepup.pr}](${pr.url}): ${commit} on ${when}, ${after}. ${notes}`;
}

/** Later commits by the team that made a change keepup had already raised. */
function buildTeam(all: TimelineEvent[], inWeek: (d: string | null | undefined) => boolean, upstream: string, objects: GithubObjects): string[] {
  const caught = all.filter((e) => e.team?.commit && inWeek(e.team.date) && (e.team.days_after ?? 0) > 0);
  const keys = [...new Set(caught.map((e) => `${e.team?.commit}/${e.keepup.pr ?? ''}`))];
  const notes = keys.map((key) => teamNote(caught.filter((e) => `${e.team?.commit}/${e.keepup.pr ?? ''}` === key), upstream, objects));
  const own = all.filter((e) => e.kind === 'team' && inWeek(e.date)).map((e) => `Your team shipped: ${e.thing}. ${e.keepup.summary}. [Commit](${e.source_url})`);
  return [...notes, ...own];
}

function countNote(checked: Checked): string {
  const left = checked.left_out.length ? ` Left out: ${checked.left_out.join(', ')}, which have no count by date here.` : '';
  return `New or updated counts each record once, by its one date, in: ${checked.counted.join(', ')}. Nothing compares them to this repo here: the items above are what the replay's timeline holds, and keepup check reports the repo's standing state.${left} This is the keepup demo, a replay on a fork: real events, simulated time and place.`;
}

/** Says what's true of this product, and counts the rest without claiming each was compared to the repo. */
function quietLine(hasItems: boolean, count: number): string {
  return `${hasItems ? 'Nothing else new' : 'Nothing new'} for this product this week · ${count.toLocaleString('en-US')} new or updated across AI`;
}

export function buildBrief(root: string, repo: string, week: string, org?: string): Brief {
  if (!(REPOS as readonly string[]).includes(repo)) throw new UsageError(`The repo must be anything-llm or aura, not ${repo}.`);
  assertMonday(week);
  const timeline = loadTimeline(root, repo);
  const { from, to } = weekDates(week);
  const inWeek = (d: string | null | undefined) => Boolean(d) && (d as string) >= from && (d as string) <= to;
  const events = timeline.events.filter((e) => inWeek(e.date));
  const objects = recordsFor(readObjects(root), org);
  const checked = countChecked(root, week);
  const parts = {
    items: buildItems(events, repo, root, objects, loadLabels(root)),
    heldBack: events.filter((e) => e.keepup.action === 'held_back').map((e) => `${e.thing} (${formatDate(e.date, false)}): ${e.keepup.summary}`),
    watching: events.filter((e) => e.keepup.action === 'watching').map((e) => `${e.thing} (${formatDate(e.date, false)}): ${e.keepup.summary}`),
    team: buildTeam(timeline.events, inWeek, timeline.repo, objects),
  };
  const hasItems = Object.values(parts).some((list) => list.length > 0);
  const draft = {
    repo, week, checked, ...parts,
    title: `keepup · week of ${formatDate(week, false)}`,
    quietLine: quietLine(hasItems, checked.count),
    note: countNote(checked),
  };
  return { ...draft, body: renderMarkdownBody(draft) };
}

export interface BriefRequest { repo: string; week: string; dryRun?: boolean }

export interface BriefDeps {
  root: string;
  env: Env;
  now: () => Date;
  log: (line: string) => void;
}

export interface BriefResult {
  brief: Brief;
  files: string[];
  issue: { number: number; url: string; changed: boolean } | null;
  waiting: string[];
}

function writeFiles(root: string, brief: Brief): string[] {
  const base = join(root, 'data', 'weekly', `${brief.repo}-${brief.week}`);
  writeFileAtomic(`${base}.md`, renderMarkdownFile(brief));
  writeFileAtomic(`${base}.html`, renderHtml(brief));
  return [`${base}.md`, `${base}.html`];
}

async function upsertIssue(octokit: Client, owner: string, repo: string, bot: string, brief: Brief): Promise<{ number: number; url: string; changed: boolean }> {
  try {
    const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', { owner, repo, state: 'all', per_page: 100 });
    const mine = issues.find((i) => !i.pull_request && i.title === brief.title && i.user?.login === bot);
    if (!mine) {
      const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', { owner, repo, title: brief.title, body: brief.body });
      return { number: data.number, url: data.html_url, changed: true };
    }
    if (mine.body === brief.body) return { number: mine.number, url: mine.html_url, changed: false };
    const { data } = await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: mine.number, body: brief.body });
    return { number: data.number, url: data.html_url, changed: true };
  } catch (e) {
    if (isStatus(e, 410)) throw new Error(`Issues are off on ${owner}/${repo}. Run: npm run setup -- --org ${owner}`);
    if (isNotCovered(e)) throw new Error(notCoveredLine(owner, repo));
    if (isStatus(e, 404)) throw new Error(`The App can't reach ${owner}/${repo}. Add it to the installation at https://github.com/organizations/${owner}/settings/installations, or run: npm run setup -- --org ${owner}`);
    throw e;
  }
}

async function postIssue(brief: Brief, deps: BriefDeps): Promise<BriefResult['issue']> {
  const config = requireAppConfig(deps.env, deps.root);
  assertDemoRepo(config.org, brief.repo, deps.env);
  assertPublicText(brief.body, `The ${brief.repo} brief`, config.org);
  const octokit = createAppClient(config, deps.env);
  const identity = await getBotIdentity(octokit, config.slug);
  const issue = await upsertIssue(octokit, config.org, brief.repo, identity.login, brief);
  const app = await getAppInfo(octokit, identity.login);
  const { data: fork } = await octokit.request('GET /repos/{owner}/{repo}', { owner: config.org, repo: brief.repo });
  updateObjects(deps.root, (o) => withIssue(withFork({ ...recordsFor(o, config.org), org: config.org, app }, brief.repo, fork.html_url), brief.repo, brief.week, { number: issue.number, url: issue.url }));
  deps.log(`Issue ${issue.changed ? 'written' : 'already up to date'}: ${issue.url}`);
  return issue;
}

export async function runBrief(request: BriefRequest, deps: BriefDeps): Promise<BriefResult> {
  const brief = buildBrief(deps.root, request.repo, request.week, deps.env.DEMO_ORG);
  // The files feed the public site and sit in a committable path, so a secret stops here, in every mode. A link to someone else's pull request only matters on GitHub, so that check waits for the send.
  assertPublicSafe(renderMarkdownFile(brief), `The ${brief.repo} brief`);
  const files = writeFiles(deps.root, brief);
  if (request.dryRun) return { brief, files, issue: null, waiting: [] };
  try {
    return { brief, files, issue: await postIssue(brief, deps), waiting: [] };
  } catch (e) {
    if (!(e instanceof NeedsSetupError)) throw e;
    return { brief, files, issue: null, waiting: [`Issue: ${e.message}`] };
  }
}
