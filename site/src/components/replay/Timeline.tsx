'use client';

import { useBundle } from '@/components/BundleContext';
import { Ext } from '@/components/Ext';
import { Chip, CodeLink } from '@/components/parts';
import { shortDate, shortSha } from '@/lib/format';
import { hashFor } from '@/lib/routes';
import { actionView, engineConflict, rowOrigin, teamNoteCaveat, teamNoteShort } from '@/lib/replay';
import { runFor } from '@/lib/repos';
import type { ReplayEvent, ReplayRepo, ReplayWeek } from '@/lib/types';

/** What the team did on this row, beside the row: a label can't end up next to the wrong event. */
export function TeamCell({ event }: { event: ReplayEvent }) {
  const team = event.team;
  if (!team) return <span className="event__none" aria-hidden="true">·</span>;
  const caveat = teamNoteCaveat(team);
  return (
    <>
      {team.relation === 'later' ? <strong className="num">{team.days_after} days later</strong> : null}
      {team.relation === 'ahead' ? <strong className="num event__ahead">{Math.abs(team.days_after ?? 0)} days ahead</strong> : null}
      {team.relation === 'ahead' ? <span> It knows when not to bother you.</span> : null}
      {team.relation === 'unchanged' ? <span>{team.note}</span> : <span className="event__note"> {teamNoteShort(team)}.{caveat ? ` ${caveat}.` : ''}</span>}
      {team.commit_url ? <> <Ext href={team.commit_url} className="mono">{shortSha(team.commit)}</Ext></> : null}
    </>
  );
}

function EventRow({ event, repo }: { event: ReplayEvent; repo: ReplayRepo }) {
  const bundle = useBundle();
  const conflict = engineConflict(event, repo, runFor(bundle, repo.repo));
  const action = actionView(event);
  const where = event.locations[0];
  return (
    <li className="event" data-action={event.action} data-testid="replay-row">
      <div className="event__left">
        <span className="event__date mono">{shortDate(event.date)}</span>
        <span className="event__thing">{event.thing}</span>
        {event.source_url ? <Ext href={event.source_url} className="event__source small">source</Ext> : null}
      </div>
      <div className="event__right">
        <span className="event__action">
          {event.pr ? (
            <a href={hashFor('pr', event.pr)} className="event__pr">
              <Chip tone={action.tone}>{action.label}</Chip>
            </a>
          ) : (
            <Chip tone={action.tone}>{action.label}</Chip>
          )}
          {' '}<span className="event__origin mono" data-origin={rowOrigin(event)}>{rowOrigin(event)}</span>
        </span>
        <span className="event__summary">{event.summary}</span>
        {conflict ? <span className="event__conflict small" data-testid="engine-conflict">The engine held back {conflict.name}: “{conflict.reason}” This pull request is a hand-written exception.</span> : null}
        {where ? (
          <span className="event__where">
            <CodeLink file={where.path} line={where.line} url={where.url} />
          </span>
        ) : null}
      </div>
      <div className="event__team small"><TeamCell event={event} /></div>
    </li>
  );
}

function Week({ week, dim, current, repo }: { week: ReplayWeek; dim: boolean; current: boolean; repo: ReplayRepo }) {
  const classes = ['week', dim ? 'week--dim' : '', current ? 'week--now' : '', week.events.length === 0 ? 'week--quiet' : ''].filter(Boolean).join(' ');
  return (
    <section className={classes} data-week={week.start}>
      <p className="week__label mono">{shortDate(week.start)}</p>
      {week.events.length === 0 ? (
        <p className="week__quiet">Nothing that touches this product. keepup stayed quiet.</p>
      ) : (
        <ol className="week__events">
          {week.events.map((event, index) => <EventRow key={`${event.date}-${index}`} event={event} repo={repo} />)}
        </ol>
      )}
    </section>
  );
}

/** Every row, week by week. The scale lives in the chart above it; a quiet week takes one line. */
export function Timeline({ repo, playingWeek }: { repo: ReplayRepo; playingWeek: number | null }) {
  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline__head" aria-hidden="true">
        <span />
        <span className="eyebrow">What shipped</span>
        <span className="eyebrow">What keepup did</span>
        <span className="eyebrow">Your team shipped it</span>
      </div>
      {repo.weeks.map((week, index) => (
        <Week key={week.start} repo={repo} week={week} dim={playingWeek !== null && index > playingWeek} current={playingWeek === index} />
      ))}
    </div>
  );
}
