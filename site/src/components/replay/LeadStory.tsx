'use client';

import { useBundle } from '@/components/BundleContext';
import { CodeLink } from '@/components/parts';
import { Ext } from '@/components/Ext';
import { longDate, shortDate, shortSha, usd } from '@/lib/format';
import { leadLabel, leadStory, type LeadStory } from '@/lib/replay';
import type { ReplayRepo } from '@/lib/types';

/** A live judge run at that commit that named this row. It shows the route, not what the product saw that day. */
function useJudgedAt(lead: LeadStory) {
  const { replayChecks } = useBundle();
  const check = replayChecks.find((item) => item.commit === lead.event.base_commit);
  if (!check) return null;
  const finding = check.findings.find((item) => item.deadline !== null && item.deadline === lead.stopped) ?? null;
  return finding ? { check, finding } : null;
}

/** A date stays on one line, in the biggest type on the stage. */
const keepDates = (text: string): string => text.replace(/(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})/g, '$1\u00a0$2\u00a0$3');

export function LeadTitle({ lead }: { lead: LeadStory }) {
  const { event, subject, provider, stopped, downDays, counting } = lead;
  if (event.team && stopped && event.team.date) {
    return (
      <h2 className="lead__title">
        <i className="kept-dot" aria-hidden="true" />
        {subject ? <code>{subject}</code> : 'Your default model'}, your own {provider} default, shut down on {shortDate(stopped)}.
        {downDays !== null ? <> The fix came <span className="num">{downDays}</span> days later.</> : null}
        <span className="lead__blue"> keepup would have flagged it on {shortDate(event.date)}.</span>
      </h2>
    );
  }
  return (
    <h2 className="lead__title">
      <i className="kept-dot" aria-hidden="true" />
      {keepDates(event.thing.split(';')[0] ?? event.thing)}.{' '}
      {counting !== null ? <span><span className="num">{counting}</span> days and counting, still unfixed.</span> : null}
    </h2>
  );
}

export function LeadLabel({ lead }: { lead: LeadStory }) {
  const { prs } = useBundle();
  const label = leadLabel(lead, prs.find((pr) => pr.id === lead.event.pr) ?? null);
  return <p className="lead__label mono" data-testid="lead-label" data-measured={label.measured}>{label.words}</p>;
}

export function LeadCaption({ lead }: { lead: LeadStory }) {
  const { replay } = useBundle();
  const { event, announced, provider, stopped } = lead;
  const team = event.team;
  const where = event.locations[0];
  const judged = useJudgedAt(lead);
  if (team && stopped && team.date) {
    return (
      <p className="small lead__caption">
        {announced ? <>{provider}’s notice was public from {announced}, so this needed no hindsight. </> : null}
        <Ext href={team.commit_url}>Commit {shortSha(team.commit)}</Ext> · {team.note}.{' '}
        {where ? <>In the code at this base: <CodeLink file={where.path} line={where.line} url={where.url} />. </> : null}
        {judged ? (
          <>
            A live judge run at {shortSha(judged.check.commit)} as of {shortDate(judged.check.as_of)} ({usd(judged.check.usd)}) raised it as finding {judged.finding.rank} of {judged.check.findings.length}, using the {longDate(replay.window.fetched)} database and today’s pattern list, so it shows the route, not what the product saw that day.
          </>
        ) : null}
      </p>
    );
  }
  return (
    <p className="small lead__caption">
      {team?.note}. {event.summary}. <Ext href={event.source_url}>Source</Ext>.{' '}
      {where ? <CodeLink file={where.path} line={where.line} url={where.url} /> : null}
    </p>
  );
}

export function LeadStoryCard({ repo }: { repo: ReplayRepo }) {
  const lead = leadStory(repo);
  if (!lead?.event.team) return null;
  return (
    <section className="lead" data-testid="lead-story">
      <p className="eyebrow">The top row · {shortDate(lead.event.date)}</p>
      <LeadTitle lead={lead} />
      {lead.stopped ? <LeadLabel lead={lead} /> : null}
      <LeadCaption lead={lead} />
    </section>
  );
}
