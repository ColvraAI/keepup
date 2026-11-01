'use client';

import { useCallback, useMemo, useState } from 'react';
import { useBundle, useRepo } from '@/components/BundleContext';
import { Ext } from '@/components/Ext';
import { Chip, CodeLink, RepoSwitch } from '@/components/parts';
import { PresentDetail } from '@/components/PresentDetail';
import { Beats } from '@/components/Beats';
import { useBeat } from '@/hooks/useBeat';
import { useDetailKey } from '@/hooks/useSkip';
import { demoRepos, runFor } from '@/lib/repos';
import { longDate, shortDate, shortSha } from '@/lib/format';
import { hashFor } from '@/lib/routes';
import { actionView, engineConflict, leadStory, railLines, replayStops, rowOrigin, stopDate, teamNoteCaveat, teamNoteShort, type Stop } from '@/lib/replay';
import { firstSentence } from '@/lib/text';
import type { Replay, ReplayEvent, ReplayRepo } from '@/lib/types';
import { GapChart } from './GapChart';
import { LeadCaption, LeadLabel, LeadTitle } from './LeadStory';
import { Timeline } from './Timeline';

function TeamLine({ event }: { event: ReplayEvent }) {
  const team = event.team;
  if (!team) return null;
  if (team.relation === 'ahead') {
    return (
      <p className="stop__team">
        <strong className="num">Your team was {Math.abs(team.days_after ?? 0)} days ahead.</strong> It knows when not to bother you.{' '}
        <Ext href={team.commit_url} className="mono">{shortSha(team.commit)}</Ext>
      </p>
    );
  }
  if (team.relation === 'unchanged') return <p className="stop__team"><strong>{team.note}.</strong></p>;
  const caveat = teamNoteCaveat(team);
  return (
    <p className="stop__team">
      <strong className="num">Your team: {team.days_after} days later.</strong> {teamNoteShort(team)}.{caveat ? ` ${caveat}.` : ''}{' '}
      <Ext href={team.commit_url} className="mono">{shortSha(team.commit)}</Ext>
    </p>
  );
}

function EventStop({ event, repo }: { event: ReplayEvent; repo: ReplayRepo }) {
  const bundle = useBundle();
  const conflict = engineConflict(event, repo, runFor(bundle, repo.repo));
  const action = actionView(event);
  const where = event.locations[0];
  return (
    <article className="stop" data-testid="replay-stop" data-date={event.date}>
      <p className="stop__date mono">{shortDate(event.date)}</p>
      <div className="stop__body">
        <h2 className="stop__thing">{firstSentence(event.thing)}</h2>
        <p className="stop__did">
          {event.pr ? <a href={hashFor('pr', event.pr)} className="event__pr"><Chip tone={action.tone}>{action.label}</Chip></a> : <Chip tone={action.tone}>{action.label}</Chip>}{' '}
          <span>{firstSentence(event.summary ?? '')}</span>
        </p>
        <TeamLine event={event} />
        {conflict ? <p className="stop__conflict" data-testid="engine-conflict">The engine held back {conflict.name}: “{conflict.reason}” This pull request is a hand-written exception.</p> : null}
        <p className="small stop__meta">
          {event.source_url ? <Ext href={event.source_url}>Source</Ext> : null}
          {where ? <> · <CodeLink file={where.path} line={where.line} url={where.url} /></> : null}
          {' · '}<span className="mono" data-origin={rowOrigin(event)}>{rowOrigin(event)}</span>
        </p>
      </div>
    </article>
  );
}

function LeadStop({ repo }: { repo: ReplayRepo }) {
  const lead = leadStory(repo);
  if (!lead) return null;
  return (
    <article className="stop stop--lead" data-testid="lead-story" data-date={lead.event.date}>
      <LeadTitle lead={lead} />
      {lead.stopped ? <LeadLabel lead={lead} /> : null}
      <LeadCaption lead={lead} />
    </article>
  );
}

function CommitStop({ stop }: { stop: Extract<Stop, { kind: 'commit' }> }) {
  return (
    <article className="stop" data-testid="replay-stop" data-date={stop.date}>
      <p className="stop__date mono">{shortDate(stop.date)}</p>
      <div className="stop__body">
        <h2 className="stop__thing">Your team’s commit, <Ext href={stop.team.commit_url} className="mono">{shortSha(stop.team.commit)}</Ext>. All {stop.lines} lines end here.</h2>
        <p className="stop__did">{stop.team.note}.</p>
      </div>
    </article>
  );
}

/** The sentence with its numbers set heavier: the figures stay inside what they mean. */
function Weighted({ text }: { text: string }) {
  return <>{text.split(/(\d+)/).map((part, index) => (index % 2 === 1 ? <b key={index} className="num">{part}</b> : part))}</>;
}

/** The chart stays up. Only the words under the rule change, and the qualifiers sit directly beneath them. */
function End({ repo }: { repo: ReplayRepo }) {
  const parts = repo.headline_parts;
  const open = leadStory(repo);
  return (
    <section className="replay-end" data-testid="replay-headline">
      <p className="replay-end__line"><Weighted text={parts.big} />{parts.short ? <> <Weighted text={parts.short} /></> : null}</p>
      {parts.engine || parts.commit ? <p className="replay-end__must">{parts.engine} {parts.commit}</p> : null}
      {!parts.short && open?.counting !== null && open?.event.team?.note ? <p className="replay-end__must">{open.event.team.note}.</p> : null}
    </section>
  );
}

function Detail({ repo, window, onClose }: { repo: ReplayRepo; window: Replay['window']; onClose: () => void }) {
  const { replay } = useBundle();
  return (
    <PresentDetail title="Every row, and what the headline leaves out" onClose={onClose}>
      <p className="small">Across both products: {replay.headline}</p>
      {repo.headline_parts.ahead ? <p className="small">{repo.headline_parts.ahead}</p> : null}
      <p className="small">
        Computed from <code>data/timeline.json</code>, never typed. The replay runs on the database fetched {longDate(window.fetched)}: moving the clock doesn’t remove newer records, so it isn’t what the product would have seen on each day. Code at <Ext href={repo.pinned_url} className="mono">{repo.pinned_commit}</Ext> and the base commit on each row.
      </p>
      <Timeline repo={repo} playingWeek={null} />
    </PresentDetail>
  );
}

/** Present mode: the forward key walks the named stops, with the gaps to scale above them, and the chart stays for the sentence. */
export function ReplayStage({ repo, window }: { repo: ReplayRepo; window: Replay['window'] }) {
  const bundle = useBundle();
  const { setRepo } = useRepo();
  const stops = useMemo(() => replayStops(repo, window), [repo, window]);
  const last = stops.length - 1;
  const [index, setIndex] = useBeat('replay', last, { enabled: true, scope: repo.repo });
  const [detail, setDetail] = useState(false);
  useDetailKey(useCallback(() => setDetail((open) => !open), []));
  const stop = stops[index];
  return (
    <section className="screen replay replay--stage" data-screen="replay" data-stop={stop?.key} data-sparse={railLines(repo, window).length <= 1}>
      <Beats forward={index < last ? () => setIndex(index + 1) : null} back={index > 0 ? () => setIndex(index - 1) : null} />
      <header className="replay-stage__head">
        <p className="replay-stage__when">{longDate(window.from)} to {longDate(window.to)} · time is simulated, every date and commit is real</p>
        <RepoSwitch repos={demoRepos(bundle)} value={repo.repo} onChange={setRepo} />
      </header>
      <GapChart repo={repo} window={window} cursor={stopDate(stop, window)} focus={stop?.key ?? null} />
      <div className="replay-stage__stop" key={stop?.key}>
        {stop?.kind === 'end' ? <End repo={repo} /> : null}
        {stop?.kind === 'event' && stop.lead ? <LeadStop repo={repo} /> : null}
        {stop?.kind === 'event' && !stop.lead ? <EventStop event={stop.event} repo={repo} /> : null}
        {stop?.kind === 'commit' ? <CommitStop stop={stop} /> : null}
      </div>
      {detail ? <Detail repo={repo} window={window} onClose={() => setDetail(false)} /> : null}
    </section>
  );
}
