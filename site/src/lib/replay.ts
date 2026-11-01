// Everything the replay computes from replay.json. Pure, so what's on screen can't drift from data.
import { daysBetween } from './format';
import { firstSentence } from './text';
import type { Pr, Replay, ReplayEvent, ReplayRepo, ReplayWeek, Run, TeamPoint } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type ActionView = { label: string; tone: 'blue' | 'amber' | 'grey' | 'ink' | 'quiet' };

export function actionView(event: ReplayEvent): ActionView {
  switch (event.action) {
    case 'pr_opened':
      return { label: `Would open PR ${event.pr ?? ''}`.trim(), tone: 'blue' };
    case 'pr_updated':
      return { label: `Would update PR ${event.pr ?? ''}`.trim(), tone: 'blue' };
    case 'held_back':
      return { label: 'Held back', tone: 'amber' };
    case 'watching':
      return { label: 'Watching', tone: 'grey' };
    case 'finding':
      return { label: 'Would flag it', tone: 'blue' };
    case 'brief_only':
      return { label: 'Brief only', tone: 'quiet' };
    default:
      return { label: 'Your team', tone: 'quiet' };
  }
}

export function dotClass(event: ReplayEvent): string {
  return `axis-dot axis-dot--${actionView(event).tone}`;
}

export const allEvents = (repo: ReplayRepo): ReplayEvent[] => repo.weeks.flatMap((week) => week.events);

export const weekDays = (week: ReplayWeek): number => daysBetween(week.start, week.end) + 1;

export type RailLine = {
  key: string;
  event: ReplayEvent;
  kind: 'later' | 'ahead' | 'unchanged';
  from: string;
  to: string;
  offChart: boolean;
  days: number | null;
};

/** One line per team point, from keepup's date to the team's, clipped to the window when it goes past. */
export function railLines(repo: ReplayRepo, window: Replay['window']): RailLine[] {
  return allEvents(repo).flatMap((event, index): RailLine[] => {
    const team = event.team;
    if (!team) return [];
    const key = `${event.date}-${index}`;
    if (team.relation === 'unchanged') {
      const counted = /(\d+) days/.exec(team.note ?? '');
      return [{ key, event, kind: 'unchanged', from: event.date, to: window.to, offChart: true, days: counted ? Number(counted[1]) : null }];
    }
    if (!team.date) return [];
    if (team.relation === 'ahead') {
      const offChart = team.date < window.from;
      return [{ key, event, kind: 'ahead', from: offChart ? window.from : team.date, to: event.date, offChart, days: team.days_after === null ? null : Math.abs(team.days_after) }];
    }
    return [{ key, event, kind: 'later', from: event.date, to: team.date, offChart: false, days: team.days_after }];
  });
}

function isoFromDayMonth(dayMonth: string, year: string): string | null {
  const match = /^(\d{1,2}) (\w{3})/.exec(dayMonth);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2] ?? '');
  return month === -1 ? null : `${year}-${String(month + 1).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
}

export type LeadStory = {
  event: ReplayEvent;
  subject: string | null;
  provider: string | null;
  stopped: string | null;
  announced: string | null;
  downDays: number | null;
  counting: number | null;
};

/** The top row of the replay: the first event whose team point is late or still open. */
export function leadStory(repo: ReplayRepo): LeadStory | null {
  const event = allEvents(repo).find((item) => item.team?.relation === 'later' || item.team?.relation === 'unchanged');
  if (!event?.team) return null;
  const shutdown = /^(.*?),?\s*(?:your .*?,\s*)?shuts down on (\d{1,2} \w{3}) \(announced (\d{1,2} \w{3})\)/.exec(event.thing);
  const note = event.team.note ?? '';
  const down = /^(\d+) days after the model stopped working/.exec(note);
  const counted = /(\d+) days after the retirement/.exec(note);
  return {
    event,
    subject: shutdown?.[1] ?? null,
    provider: /your (\w+) default/.exec(event.thing)?.[1] ?? null,
    stopped: shutdown?.[2] ? isoFromDayMonth(shutdown[2], event.date.slice(0, 4)) : null,
    announced: shutdown?.[3] ?? null,
    downDays: down ? Number(down[1]) : null,
    counting: counted ? Number(counted[1]) : null,
  };
}

const SENTENCE = /(?<=\.)\s+/;

/** The part of a team note that says what the commit really did, in place of "there in this commit". */
export function teamNoteShort(team: TeamPoint | null): string | null {
  const note = team?.note;
  if (!note) return null;
  const sentences = note.split(SENTENCE);
  const appears = sentences.find((sentence) => /first appears/.test(sentence));
  if (appears) return appears.replace(' there in this commit', ' in the fallback list').replace(/\.$/, '');
  return firstSentence(note).replace(/\.$/, '');
}

/** The rest of the note: what the "first appears" line needs beside it to stay honest. */
export function teamNoteCaveat(team: TeamPoint | null): string | null {
  const sentence = team?.note?.split(SENTENCE).find((item) => /only used when/.test(item));
  return sentence ? sentence.replace(/\s*\([^)]*\)\.?$/, '').replace(/\.$/, '') : null;
}

export type Stop =
  | { kind: 'event'; key: string; event: ReplayEvent; lead: boolean }
  | { kind: 'commit'; key: string; date: string; team: TeamPoint; lines: number }
  | { kind: 'end'; key: string };

const STOP_MIN = 3;

function isStopEvent(event: ReplayEvent, window: Replay['window']): boolean {
  const team = event.team;
  if (!team) return false;
  if (team.relation === 'unchanged') return true;
  if (team.relation === 'later') return event.action !== 'pr_updated';
  return team.relation === 'ahead' && team.date !== null && team.date >= window.from;
}

/** Quiet repos still get a story: the first pull request, the first refusal, the last update. */
function fillStops(events: readonly ReplayEvent[], chosen: readonly ReplayEvent[]): ReplayEvent[] {
  if (chosen.length >= STOP_MIN) return [...chosen];
  const extra = [events.find((e) => e.action === 'pr_opened' && !chosen.includes(e)), events.find((e) => e.action === 'held_back'), events.findLast((e) => e.action === 'pr_updated')];
  return [...chosen, ...extra.filter((e): e is ReplayEvent => Boolean(e))].sort((a, b) => a.date.localeCompare(b.date));
}

/** The named stops a presenter walks through. The script's moments, computed from the rows that have a team point. */
export function replayStops(repo: ReplayRepo, window: Replay['window']): Stop[] {
  const events = allEvents(repo);
  const chosen = fillStops(events, events.filter((event) => isStopEvent(event, window)));
  const later = railLines(repo, window).filter((line) => line.kind === 'later');
  const team = later[0]?.event.team ?? null;
  const shared = team?.date && later.every((line) => line.event.team?.commit === team.commit);
  return [
    ...chosen.map((event, index): Stop => ({ kind: 'event', key: `${event.date}-${index}`, event, lead: index === 0 })),
    ...(team && shared ? [{ kind: 'commit', key: 'commit', date: team.date as string, team, lines: later.length } as Stop] : []),
    { kind: 'end', key: 'end' },
  ];
}

export function stopDate(stop: Stop | undefined, window: Replay['window']): string {
  if (!stop || stop.kind === 'end') return window.to;
  return stop.kind === 'commit' ? stop.date : stop.event.date;
}

/** A row's own origin: only a few rows are something a live run reached. The rest were written by hand. */
export const rowOrigin = (event: ReplayEvent): 'engine run' | 'specified by hand' => (event.run ? 'engine run' : 'specified by hand');

/** Late rows first, then what's still open, then where the team got there first. */
const LINE_ORDER: Readonly<Record<RailLine['kind'], number>> = { later: 0, unchanged: 1, ahead: 2 };
export const byLineOrder = (a: RailLine, b: RailLine): number => LINE_ORDER[a.kind] - LINE_ORDER[b.kind];

const WORD_FOR_TIMES = ['never', 'once', 'twice'];
export const timesWord = (times: number): string => WORD_FOR_TIMES[times] ?? `${times} times`;

/** The label the lead's claim carries: nothing has measured it until its lab runs, and then the lab's number does the talking. */
export function leadLabel(lead: LeadStory, pr: Pr | null): { measured: boolean; words: string } {
  const scope = pr ? /^(chats with no model set)/i.exec(pr.founder_line)?.[1]?.toLowerCase() : null;
  const notice = lead.provider ? `per ${lead.provider}’s notice` : 'per the notice';
  if (pr?.lab.status === 'measured' && pr.lab.title_number) return { measured: true, words: `Measured: ${pr.lab.title_number}` };
  return { measured: false, words: [notice, 'not measured yet', scope].filter(Boolean).join(' · ') };
}

const ROW_NAME = /\s+released$/;

/** The model names a "released" row is about, so a refusal of one of them can be set beside it. */
function rowNames(event: ReplayEvent): string[] {
  return ROW_NAME.test(event.thing) ? event.thing.replace(ROW_NAME, '').split(/ and /) : [];
}

export type EngineConflict = { name: string; reason: string };

/**
 * The engine refused something a hand-written pull request does anyway. Both stay on screen, and each
 * says so: hiding either would make the other a false claim.
 */
export function engineConflict(event: ReplayEvent, repo: ReplayRepo, run: Run | null): EngineConflict | null {
  if (!event.pr || event.run || !run) return null;
  const names = allEvents(repo).filter((row) => row.pr === event.pr).flatMap(rowNames);
  for (const row of run.held_back) {
    const name = names.find((item) => row.thing.includes(item));
    if (name) return { name, reason: firstSentence(row.reason) };
  }
  return null;
}

/** The pull request that adds what a refusal names, by the name in its own title. */
export function prOverridingRefusal(thing: string, prs: readonly Pr[]): Pr | null {
  const name = thing.replace(/\s*\(.*$/, '').split(' ').slice(1).join(' ');
  return name.length > 4 ? prs.find((pr) => pr.title.includes(name)) ?? null : null;
}
