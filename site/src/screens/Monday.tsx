'use client';

import { Beats } from '@/components/Beats';
import { useBundle, usePresent, useRepo } from '@/components/BundleContext';
import { useBeat } from '@/hooks/useBeat';
import { Ext } from '@/components/Ext';
import { BriefBody } from '@/components/BriefBody';
import { Chip, RepoSwitch, ScreenHead } from '@/components/parts';
import { friendlyRepo, longDate, repoName, shortDate, shortSha } from '@/lib/format';
import { demoRepos, isQuietBrief, latestWeek, runFor } from '@/lib/repos';
import type { CheckLine } from '@/lib/types';

const TAGLINE = 'You can’t keep up with AI. Your product can.';

/** The real command, without the clone's path: where it ran is in the caption. */
const displayCommand = (check: CheckLine): string => check.command.replace(/\s+tmp\/\S+/, '');

function Terminal({ check }: { check: CheckLine | undefined }) {
  return (
    <section>
      <p className="eyebrow">As it reads in Claude Code, once a week</p>
      <div className="term" data-testid="keepup-check">
        {check ? (
          <div className="term__block">
            <p className="term__cmd"><span aria-hidden="true">{check.name} $ </span>{displayCommand(check)}</p>
            <p className="term__line">{check.line}</p>
          </div>
        ) : (
          <p className="term__line">Not recorded yet · run scripts/record-check.ts</p>
        )}
      </div>
      {check ? (
        <p className="small" data-testid="check-caption">
          Real output, recorded {longDate(check.recorded_at)} on a clone at {shortSha(check.commit).slice(0, 7)}, as of {shortDate(check.as_of)}. It reports the repo’s standing state; the issue covers this week’s arrivals.
        </p>
      ) : null}
    </section>
  );
}

/** "Nothing new for this product · 3,862 new or updated across AI": the claim, and the count that sits beside it. */
const quietHead = (body: string): string => {
  const head = body.split(' · ')[0] ?? body;
  return head.charAt(0).toLowerCase() + head.slice(1);
};
const quietCount = (body: string): string => body.split(' · ').slice(1).join(' · ');

function Ending() {
  const bundle = useBundle();
  const { repo } = useRepo();
  const keep = runFor(bundle, repo)?.findings.length ?? 0;
  return (
    <div className="monday-end" data-testid="tagline-screen">
      <p className="monday-end__line" data-testid="tagline">{TAGLINE.split(/(?<=\.) /).map((sentence) => <span key={sentence}>{sentence} </span>)}</p>
      <ol className="monday-end__dots" aria-hidden="true">
        {Array.from({ length: keep }, (_, index) => <li key={index} style={{ '--row': index } as React.CSSProperties} />)}
      </ol>
    </div>
  );
}

export function MondayScreen() {
  const bundle = useBundle();
  const present = usePresent();
  const { weekly, checks } = bundle;
  const repos = demoRepos(bundle);
  const { repo, setRepo } = useRepo();
  const [beat, setBeat] = useBeat('monday', 1, { enabled: present });
  const ended = beat === 1;
  const week = latestWeek(weekly);
  const brief = weekly.find((item) => item.repo === repoName(repo) && item.week === week);
  const quietBriefs = weekly.filter(isQuietBrief);
  const quiet = quietBriefs.find((item) => item.repo === repoName(repo)) ?? quietBriefs[0];
  const check = checks.find((item) => item.repo === repo);

  if (present && ended) {
    return <section className="screen monday monday--end" data-screen="monday"><Beats back={() => setBeat(0)} /><Ending /></section>;
  }
  return (
    <section className="screen monday" data-screen="monday">
      <Beats forward={present ? () => setBeat(1) : null} />
      <ScreenHead
        eyebrow={week ? `Monday · week of ${longDate(week)} · no inbox, no dashboard to check` : 'Monday'}
        title={present && week ? `Monday, week of ${shortDate(week)}` : 'The weekly brief'}
        aside={<RepoSwitch repos={repos} value={repo} onChange={setRepo} />}
      />
      <div className="monday__grid">
        <article className="brief" data-testid="brief">
          <header className="brief__head">
            <p className="eyebrow">As the GitHub issue on {friendlyRepo(repo)}’s fork</p>
            <h2 className="h2">{brief?.title}</h2>
            {brief?.issue?.url ? (
              <Ext href={brief.issue.url} className="btn btn--quiet">Open the issue</Ext>
            ) : (
              <Chip tone="blue">Ready to post · waits for the keepup App</Chip>
            )}
          </header>
          {brief ? <BriefBody body={brief.body} compact={present} /> : <p className="small">No brief for this week.</p>}
        </article>
        <div className="monday__side">
          <Terminal check={check} />
          {quiet ? (
            <section className="monday__quiet">
              <p className="monday__quiet-line" data-testid="quiet-line">
                <span>Week of {shortDate(quiet.week)}: {quietHead(quiet.body)}</span>
                <span className="monday__quiet-count mono">{quietCount(quiet.body)}</span>
              </p>
              <p className="small" data-testid="quiet-count">{quietBriefs.length} of the {weekly.length} weekly briefs in this replay were just this line. One line, then silence: the refusals are what keep it installed.</p>
            </section>
          ) : null}
        </div>
      </div>
      {present ? null : <p className="tagline" data-testid="tagline">{TAGLINE}</p>}
    </section>
  );
}
