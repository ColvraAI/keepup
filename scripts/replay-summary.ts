// npm run replay: data/replay-summary.json, computed from data/timeline.json only.
// base_commit, team and where are optional: an audit may add or remove them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { median } from '../lab/shared/stats.ts';

export interface Team { date: string | null; commit: string | null; days_after: number | null; note: string }

export interface TimelineEvent {
  date: string;
  thing: string;
  kind: string;
  source_url: string;
  where?: string;
  /** 'base' when the lines in `where` are read at base_commit, because a later fix moved them by the pin. */
  where_at?: 'base';
  keepup: { action: string; pr?: string; summary: string };
  base_commit?: string;
  team?: Team;
}

export interface TimelineRepo { repo: string; fork: string; pinned_commit: string; events: TimelineEvent[] }
export interface Window { from: string; to: string; fetched: string }
export interface Timeline { window: Window; repos: TimelineRepo[] }

export type TeamRelation = 'later' | 'ahead' | 'unchanged' | 'same_day';

export interface TeamPoint { date: string; thing: string; action: string; team_date: string; commit: string | null; days_after: number }

export interface Counts {
  events: number;
  prs_opened: number;
  prs_updated: number;
  held_back: number;
  watching: number;
  brief_only: number;
  findings: number;
  team_notes: number;
  other: number;
  team_later: number;
  /** Later points on pull request rows, which are specified by hand: the engine isn't claimed to find them. */
  team_later_on_prs: number;
  /** Later points on rows a live run reached: what the engine really raised. */
  team_later_engine: number;
  team_later_engine_on_prs: number;
  team_ahead: number;
  team_unchanged: number;
  team_same_day: number;
  team_points: TeamPoint[];
  median_days_later: number | null;
}

export interface ReplaySummary {
  computed_from: string;
  window: Window;
  overall: Counts;
  repos: Record<string, Counts>;
}

const ACTION_FIELD: Record<string, keyof Counts> = {
  pr_opened: 'prs_opened',
  pr_updated: 'prs_updated',
  held_back: 'held_back',
  watching: 'watching',
  brief_only: 'brief_only',
  finding: 'findings',
  none: 'team_notes',
};

/** A positive gap means a later team commit overlaps the row. */
export function teamRelation(team: Pick<Team, 'days_after'> | undefined): TeamRelation | null {
  if (!team) return null;
  if (team.days_after === null) return 'unchanged';
  if (team.days_after > 0) return 'later';
  return team.days_after < 0 ? 'ahead' : 'same_day';
}

const PR_ACTIONS = ['pr_opened', 'pr_updated'];

const countAction = (events: TimelineEvent[], action: string): number => events.filter((e) => e.keepup.action === action).length;
const countRelation = (events: TimelineEvent[], relation: TeamRelation): number => events.filter((e) => teamRelation(e.team) === relation).length;

function teamPoints(events: TimelineEvent[]): TeamPoint[] {
  return events.flatMap((e) => (teamRelation(e.team) === 'later' && e.team?.date
    ? [{ date: e.date, thing: e.thing, action: e.keepup.action, team_date: e.team.date, commit: e.team.commit, days_after: e.team.days_after as number }]
    : []));
}

const hasRun = (e: TimelineEvent): boolean => typeof (e as { run?: unknown }).run === 'string';

function count(events: TimelineEvent[]): Counts {
  const points = teamPoints(events);
  const engineRows = events.filter((e) => hasRun(e) && teamRelation(e.team) === 'later' && e.team?.date);
  const known = Object.keys(ACTION_FIELD);
  return {
    events: events.length,
    prs_opened: countAction(events, 'pr_opened'),
    prs_updated: countAction(events, 'pr_updated'),
    held_back: countAction(events, 'held_back'),
    watching: countAction(events, 'watching'),
    brief_only: countAction(events, 'brief_only'),
    findings: countAction(events, 'finding'),
    team_notes: countAction(events, 'none'),
    other: events.filter((e) => !known.includes(e.keepup.action)).length,
    team_later: points.length,
    team_later_on_prs: points.filter((p) => PR_ACTIONS.includes(p.action)).length,
    team_later_engine: engineRows.length,
    team_later_engine_on_prs: engineRows.filter((e) => PR_ACTIONS.includes(e.keepup.action)).length,
    team_ahead: countRelation(events, 'ahead'),
    team_unchanged: countRelation(events, 'unchanged'),
    team_same_day: countRelation(events, 'same_day'),
    team_points: points,
    median_days_later: points.length ? median(points.map((p) => p.days_after)) : null,
  };
}

export function summarize(timeline: Timeline): ReplaySummary {
  return {
    computed_from: 'data/timeline.json',
    window: timeline.window,
    overall: count(timeline.repos.flatMap((r) => r.events)),
    repos: Object.fromEntries(timeline.repos.map((r) => [r.repo, count(r.events)])),
  };
}

export function readTimeline(root: string): Timeline {
  return JSON.parse(readFileSync(join(root, 'data', 'timeline.json'), 'utf8')) as Timeline;
}

function main(): void {
  const root = join(import.meta.dirname, '..');
  const summary = summarize(readTimeline(root));
  const path = join(root, 'data', 'replay-summary.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  const o = summary.overall;
  process.stdout.write(`${path}: ${o.prs_opened} opened, ${o.prs_updated} updated, ${o.held_back} held back, ${o.team_later} team points, median ${o.median_days_later} days\n`);
}

if (import.meta.main) main();
