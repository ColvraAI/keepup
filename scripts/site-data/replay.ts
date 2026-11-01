// site/data/replay.json: timeline events by repo and week (weeks start on Monday,
// clipped to the window), the summary, and a permalink for each code location.
import { summarize, teamRelation, type ReplaySummary, type TeamRelation, type Timeline, type TimelineEvent, type TimelineRepo, type Window } from '../replay-summary.ts';
import { blobUrl, codeBase, commitUrl, identitySha, parseWhere, treeUrl, upstreamBase, type ForkMap, type LinkedLocation, type ShaResolver } from './links.ts';

export interface Week { monday: string; start: string; end: string }

export interface ReplayEvent {
  date: string;
  thing: string;
  kind: string;
  source_url: string;
  action: string;
  pr: string | null;
  summary: string;
  where: string | null;
  locations: LinkedLocation[];
  base_commit: string | null;
  base_url: string | null;
  /** The recorded run that reached this row, when one did. Every other row's action was specified by hand. */
  run: string | null;
  team: { relation: TeamRelation; date: string | null; commit: string | null; commit_url: string | null; days_after: number | null; note: string } | null;
}

export interface ReplayWeek extends Week { events: ReplayEvent[] }

export interface ReplayRepo {
  repo: string;
  fork: string;
  pinned_commit: string;
  pinned_url: string;
  summary: ReplaySummary['overall'];
  headline_parts: HeadlineParts;
  weeks: ReplayWeek[];
}

export interface Replay {
  computed_from: string;
  window: Window;
  headline: string;
  summary: ReplaySummary;
  repos: ReplayRepo[];
}

/** A pull request's own view of the code: where it starts, at its own base commit. */
export interface PrWhere { id: string; where: { path: string; line?: number; url: string }[] }

const DAY = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const atMidnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);

export function weeksOfWindow(window: Pick<Window, 'from' | 'to'>): Week[] {
  const from = atMidnight(window.from);
  const to = atMidnight(window.to);
  const firstMonday = from - ((new Date(from).getUTCDay() + 6) % 7) * DAY;
  const count = Math.floor((to - firstMonday) / (7 * DAY)) + 1;
  return Array.from({ length: count }, (_, i) => {
    const monday = firstMonday + i * 7 * DAY;
    return { monday: isoDay(monday), start: isoDay(Math.max(monday, from)), end: isoDay(Math.min(monday + 6 * DAY, to)) };
  });
}

/**
 * The pin is after the team's fix. So a pull request row the team later got to reads the code the
 * way the pull request did, or a reader would see the change already made on the row proposing it.
 */
function readBeforeFix(e: TimelineEvent, location: LinkedLocation, prs: readonly PrWhere[]): LinkedLocation | null {
  if (e.where_at === 'base' || teamRelation(e.team) !== 'later' || !e.keepup.pr) return null;
  const own = prs.find((pr) => pr.id === e.keepup.pr)?.where.find((where) => where.path === location.path);
  return own ? { ...location, line: own.line ?? location.line, url: own.url } : null;
}

function linkEvent(e: TimelineEvent, repo: TimelineRepo, base: string, resolve: ShaResolver, prs: readonly PrWhere[]): ReplayEvent {
  const pinned = resolve(repo.repo, repo.pinned_commit);
  const relation = teamRelation(e.team);
  const baseCommit = e.base_commit ? resolve(repo.repo, e.base_commit) : null;
  const readAt = e.where_at === 'base' && baseCommit ? baseCommit : pinned;
  const teamCommit = e.team?.commit ? resolve(repo.repo, e.team.commit) : null;
  return {
    date: e.date,
    thing: e.thing,
    kind: e.kind,
    source_url: e.source_url,
    action: e.keepup.action,
    pr: e.keepup.pr ?? null,
    summary: e.keepup.summary,
    where: e.where ?? null,
    locations: parseWhere(e.where).map((loc) => {
      const linked = { ...loc, url: blobUrl(base, readAt, loc) };
      return readBeforeFix(e, linked, prs) ?? linked;
    }),
    base_commit: baseCommit,
    base_url: baseCommit ? treeUrl(base, baseCommit) : null,
    run: typeof (e as { run?: unknown }).run === 'string' ? (e as unknown as { run: string }).run : null,
    // The team's own commit always links upstream: it's their history, not our fork's.
    team: e.team && relation ? {
      relation,
      date: e.team.date,
      commit: teamCommit,
      commit_url: teamCommit ? commitUrl(upstreamBase(repo.repo), teamCommit) : null,
      days_after: e.team.days_after,
      note: e.team.note,
    } : null,
  };
}

function groupByWeek(events: ReplayEvent[], weeks: Week[], repo: string): ReplayWeek[] {
  const placed = weeks.map((w) => ({ ...w, events: events.filter((e) => e.date >= w.start && e.date <= w.end) }));
  const lost = events.filter((e) => !weeks.some((w) => e.date >= w.start && e.date <= w.end));
  if (lost.length) {
    throw new Error(`${repo} has events outside the replay window: ${lost.map((e) => `${e.date} ${e.thing}`).join('; ')}`);
  }
  return placed;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export interface HeadlineParts {
  /** The first sentence, for the room. */
  big: string;
  /** The team's half, as the headline states it. */
  second: string | null;
  /** The team's half at the size a room can read; its qualifiers are engine and commit. */
  short: string | null;
  engine: string | null;
  commit: string | null;
  ahead: string | null;
}

const was = (n: number): string => (n === 1 ? 'was' : 'were');

function engineSentence(o: ReplaySummary['overall']): string | null {
  const raised = o.team_later_engine;
  const others = o.team_later - raised;
  if (!raised) return o.team_later_on_prs ? `${o.team_later_on_prs === 1 ? 'It is on a pull request' : `All ${o.team_later_on_prs} are on pull requests`} written by hand.` : null;
  if (!others) return null;
  const own = o.team_later_engine_on_prs;
  const built = own ? `, and ${own === 1 ? 'its pull request' : 'their pull requests'} ${was(own)} written by hand` : '';
  return `The engine raised ${raised}${built}; the other ${others} ${was(others)} specified by hand.`;
}

const LIST_SEPARATOR = /, (?=[^,]*$)/;

function commitSentence(o: ReplaySummary['overall'], withDays: boolean): string | null {
  const commits = [...new Set(o.team_points.map((point) => point.commit))];
  if (commits.length !== 1 || o.team_points.length < 2) return null;
  const sha = (commits[0] ?? '').slice(0, 8);
  const days = o.team_points.map((point) => point.days_after).join(', ').replace(LIST_SEPARATOR, ' and ');
  return `All ${o.team_points.length} are one commit, ${sha}${withDays ? `: ${days} days after each date` : ''}.`;
}

/** The replay screen's headline, each number from the summary, in the parts each screen sets at its own size. */
export function replayHeadlineParts(o: ReplaySummary['overall']): HeadlineParts {
  const big = `keepup would have opened ${plural(o.prs_opened, 'pull request', 'pull requests')} and held back ${plural(o.held_back, 'thing', 'things')}.`;
  const median = o.median_days_later;
  const what = !o.team_later_engine ? 'built a pull request for' : o.team_later_engine === o.team_later ? 'raised' : 'raised or built a pull request for';
  return {
    big,
    second: median === null ? null : `Your team got to ${o.team_later} of the things keepup ${what}, a median ${median} days later.`,
    short: median === null ? null : `Your team got to ${o.team_later}, a median ${median} days later.`,
    engine: median === null ? null : engineSentence(o),
    commit: median === null ? null : commitSentence(o, true),
    ahead: o.team_ahead > 0 ? `Your team was ahead of keepup ${plural(o.team_ahead, 'time', 'times')}, and keepup stayed quiet.` : null,
  };
}

/** The whole sentence, qualifiers in it, for everywhere it's reused without its caption. */
export function replayHeadline(o: ReplaySummary['overall']): string {
  const parts = replayHeadlineParts(o);
  return [parts.big, parts.second, parts.engine, parts.second ? commitSentence(o, false) : null].filter(Boolean).join(' ');
}

export function buildReplay(timeline: Timeline, objects: ForkMap, resolve: ShaResolver = identitySha, prs: readonly PrWhere[] = []): Replay {
  const summary = summarize(timeline);
  const weeks = weeksOfWindow(timeline.window);
  const repos = timeline.repos.map((repo): ReplayRepo => {
    const base = codeBase(repo.repo, repo.fork, objects);
    const events = repo.events.map((e) => linkEvent(e, repo, base, resolve, prs));
    return {
      repo: repo.repo,
      fork: repo.fork,
      pinned_commit: repo.pinned_commit,
      pinned_url: treeUrl(base, resolve(repo.repo, repo.pinned_commit)),
      summary: summary.repos[repo.repo],
      headline_parts: replayHeadlineParts(summary.repos[repo.repo]),
      weeks: groupByWeek(events, weeks, repo.repo),
    };
  });
  return { computed_from: summary.computed_from, window: timeline.window, headline: replayHeadline(summary.overall), summary, repos };
}
