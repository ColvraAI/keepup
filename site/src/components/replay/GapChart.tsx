'use client';

import { useMemo } from 'react';
import { usePresent } from '@/components/BundleContext';
import { Ext } from '@/components/Ext';
import { count, daysBetween, shortDate, shortSha } from '@/lib/format';
import { allEvents, byLineOrder, dotClass, leadStory, railLines, timesWord, type LeadStory, type RailLine } from '@/lib/replay';
import type { Replay, ReplayEvent, ReplayRepo } from '@/lib/types';

type Props = {
  repo: ReplayRepo;
  window: Replay['window'];
  /** Rows and dots past this date aren't there yet: the argument builds as the replay moves. */
  cursor: string | null;
  /** The row the current stop is about stands out. */
  focus?: string | null;
};

const shortThing = (event: ReplayEvent): string => event.thing.split(/[:;,(]/)[0]?.trim() ?? event.thing;

function useX(window: Replay['window']) {
  const span = daysBetween(window.from, window.to);
  return (date: string) => `${(Math.max(0, Math.min(span, daysBetween(window.from, date))) / span) * 100}%`;
}

/** The blue is keepup's: from its flag to the day the thing stopped. The black is the break, up to the team's fix. */
function LeadRow({ line, lead, window, shown }: { line: RailLine; lead: LeadStory; window: Replay['window']; shown: boolean }) {
  const x = useX(window);
  const span = (from: string, to: string) => ({ left: x(from), width: `calc(${x(to)} - ${x(from)})` });
  const stopped = lead.stopped ?? line.to;
  return (
    <div className="gap-lead" data-shown={shown} data-testid="gap-lead">
      <div className="gap-lead__top" style={{ marginLeft: x(line.from) }}>
        <span className="gap-lead__days num" data-testid="gap-lead-days">{line.days} days</span>
        <span className="gap-lead__what">from keepup’s flag to your team’s fix</span>
      </div>
      <div className="gap-lead__track">
        <i className="gap-bar gap-bar--lead" style={span(line.from, stopped)} />
        <i className="gap-bar gap-bar--broken" style={span(stopped, line.to)} />
        <b className="gap-lead__broken num" style={{ right: `calc(100% - ${x(line.to)} + 10px)` }}>{lead.downDays} days after it shut down</b>
      </div>
      <div className="gap-lead__ends">
        <span style={{ left: x(line.from) }}>{shortDate(line.from)} · keepup flags it</span>
        <span className="gap-lead__end--right" style={{ right: `calc(100% - ${x(line.to)} + 10px)` }}>
          {shortDate(stopped)} · shut down · {shortDate(line.to)} · your team’s fix
        </span>
      </div>
    </div>
  );
}

/** Still open: the bar runs off the chart, in the team's ink, because nothing has ended it. */
function OpenLeadRow({ line, window, shown }: { line: RailLine; window: Replay['window']; shown: boolean }) {
  const x = useX(window);
  const team = line.event.team;
  return (
    <div className="gap-lead gap-lead--open" data-shown={shown} data-testid="gap-lead">
      <div className="gap-lead__top" style={{ marginLeft: x(line.from) }}>
        <span className="gap-lead__days num" data-testid="gap-lead-days">{line.days} days</span>
        <span className="gap-lead__what">and counting, still unfixed</span>
      </div>
      <div className="gap-lead__track">
        <i className="gap-bar gap-bar--open" style={{ left: x(line.from), right: 0 }} />
        <i className="gap-off gap-off--lead" />
      </div>
      <div className="gap-lead__ends">
        <span style={{ left: x(line.from) }}>{shortDate(line.from)} · keepup flags it</span>
        <span className="gap-lead__end--right" style={{ right: 0 }}>{team?.note?.split(':')[0]}</span>
      </div>
    </div>
  );
}

function Row({ line, window, shown, focus }: { line: RailLine; window: Replay['window']; shown: boolean; focus: boolean }) {
  const x = useX(window);
  const left = x(line.from);
  const width = `calc(${x(line.to)} - ${left})`;
  const days = line.kind === 'later' ? `${line.days} days later` : line.kind === 'ahead' ? `${count(line.days ?? 0)} days ahead` : `${line.days} days and counting`;
  const labelLeft = line.kind === 'later';
  return (
    <div className={`gap-row gap-row--${line.kind}`} data-shown={shown} data-focus={focus}>
      <i className="gap-bar" style={{ left, width: line.kind === 'ahead' ? `max(${width}, 8px)` : width }} />
      {line.offChart && line.kind === 'ahead' ? <i className="gap-off gap-off--left" style={{ left }} /> : null}
      {line.offChart && line.kind === 'unchanged' ? <i className="gap-off gap-off--right" /> : null}
      <span className={labelLeft ? 'gap-row__label gap-row__label--left' : 'gap-row__label'} style={labelLeft ? { right: `calc(100% - ${left} + 14px)` } : { left: `calc(${x(line.to)} + 14px)` }}>
        <b className="num">{days}</b> · {shortThing(line.event)}
      </span>
    </div>
  );
}

function isLeadLine(line: RailLine, lead: LeadStory | null): boolean {
  if (!lead || line.event !== lead.event) return false;
  return (line.kind === 'later' && Boolean(lead.stopped)) || line.kind === 'unchanged';
}

/**
 * The argument, to scale and on one screen: 60 days across the stage, keepup's date on the left of
 * each bar and the team's real commit on the right. Blue is what keepup does, black is the team or
 * the break, amber is held back. The rows below it hold the words.
 */
export function GapChart({ repo, window, cursor, focus = null }: Props) {
  const x = useX(window);
  const present = usePresent();
  const lines = useMemo(() => railLines(repo, window), [repo, window]);
  const lead = leadStory(repo);
  const leadLine = lines.find((line) => isLeadLine(line, lead)) ?? null;
  // On the stage a stub running off the chart would be the biggest number with no bar behind it.
  const rows = lines.filter((line) => line !== leadLine && !(present && line.offChart)).sort(byLineOrder);
  const passed = (date: string) => cursor === null || date <= cursor;
  const team = (leadLine?.kind === 'later' ? leadLine.event.team : null) ?? lines.find((line) => line.kind === 'later')?.event.team ?? null;
  const events = allEvents(repo).filter((event) => event.action !== 'none');
  const ahead = lines.filter((line) => line.kind === 'ahead');
  const runsOff = [...rows, ...(leadLine ? [leadLine] : [])].some((line) => line.offChart);
  const scale = runsOff ? 'To scale, except where an arrow runs off the chart' : 'To scale';
  return (
    <figure className="gap" data-testid="gap-chart" aria-label={`Each gap, to scale, from ${shortDate(window.from)} to ${shortDate(window.to)}`}>
      <div className="gap__axis" aria-hidden="true">
        {repo.weeks.map((week) => (
          <span key={week.start} className="gap__tick mono" style={{ left: x(week.start) }}>{shortDate(week.start)}</span>
        ))}
        {cursor ? <i className="gap__cursor" style={{ left: x(cursor) }} /> : null}
      </div>
      <div className="gap__dots" aria-hidden="true">
        {events.map((event, index) => (
          <i key={`${event.date}-${index}`} className={dotClass(event)} data-shown={passed(event.date)} style={{ left: x(event.date) }} />
        ))}
      </div>
      <div className="gap__plot">
        {leadLine?.kind === 'later' && lead ? <LeadRow line={leadLine} lead={lead} window={window} shown={passed(leadLine.from)} /> : null}
        {leadLine?.kind === 'unchanged' ? <OpenLeadRow line={leadLine} window={window} shown={passed(leadLine.from)} /> : null}
        {rows.length > 0 ? (
          <div className="gap__rows">
            {rows.map((line) => (
              <Row key={line.key} line={line} window={window} shown={passed(line.kind === 'ahead' ? line.to : line.from)} focus={focus === line.key} />
            ))}
          </div>
        ) : null}
        {team?.date && passed(team.date) ? <div className="gap__commit" style={{ left: x(team.date) }} aria-hidden="true" /> : null}
      </div>
      {present && ahead.length > 0 ? (
        <p className="gap__ahead" data-shown={ahead.every((line) => passed(line.to))} data-testid="gap-ahead">
          Your team was ahead {timesWord(ahead.length)}, and keepup stayed quiet.
        </p>
      ) : null}
      <figcaption className="gap__key mono">
        <span><i className="axis-dot axis-dot--blue" /> keepup acts</span>
        <span><i className="axis-dot axis-dot--amber" /> held back</span>
        <span><i className="axis-dot axis-dot--grey" /> watching</span>
        <span><i className="gap__key-line" /> your team, or the break</span>
        {team?.date ? <span className="gap__key-commit">{scale} · ends at <Ext href={team.commit_url} className="mono">{shortSha(team.commit)}</Ext>, {shortDate(team.date)}</span> : <span className="gap__key-commit">{scale}</span>}
      </figcaption>
    </figure>
  );
}
