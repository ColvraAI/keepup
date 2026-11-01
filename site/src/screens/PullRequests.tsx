'use client';

import { useCallback, useEffect, useState } from 'react';
import { useBundle, usePresent, useRepo } from '@/components/BundleContext';
import { DiffViewer } from '@/components/DiffViewer';
import { PrCard } from '@/components/PrCard';
import { PresentDetail } from '@/components/PresentDetail';
import { PrPresent } from '@/components/PrPresent';
import { ScreenHead } from '@/components/parts';
import { useDetailKey } from '@/hooks/useSkip';
import { friendlyRepo, shortDate } from '@/lib/format';
import { hashFor } from '@/lib/routes';
import { firstSentence } from '@/lib/text';
import type { Pr } from '@/lib/types';

function byId(a: Pr, b: Pr): number {
  return a.id.localeCompare(b.id);
}

function PrSwitcher({ prs, current }: { prs: readonly Pr[]; current: string }) {
  return (
    <nav className="pr-switch" aria-label="All pull requests" data-testid="pr-switch">
      {prs.map((pr) => (
        <a key={pr.id} href={hashFor('pr', pr.id)} aria-current={pr.id === current ? 'page' : undefined}>
          <span className="pr-switch__id mono">{pr.id}</span>
          <span className="pr-switch__repo">{friendlyRepo(pr.upstream)}</span>
        </a>
      ))}
    </nav>
  );
}

function Stages({ pr, index, onChange }: { pr: Pr; index: number; onChange: (index: number) => void }) {
  return (
    <div className="pr-stages" role="group" aria-label="Commits on this pull request">
      {pr.stages.map((item, position) => (
        <button key={item.date} type="button" aria-pressed={position === index} onClick={() => onChange(position)}>
          <span className="mono">{shortDate(item.date)}</span>
          {position === 0 ? 'Would open' : 'Would update'}
        </button>
      ))}
    </div>
  );
}

export function PullRequestsScreen({ arg }: { arg: string | null }) {
  const { prs } = useBundle();
  const { repo, setRepo } = useRepo();
  const present = usePresent();
  const sorted = [...prs].sort(byId);
  const pr = sorted.find((item) => item.id === arg) ?? sorted.find((item) => item.upstream === repo) ?? sorted[0];
  const [stageIndex, setStageIndex] = useState(0);
  const [detail, setDetail] = useState(false);
  useEffect(() => setStageIndex(0), [pr?.id]);
  useEffect(() => {
    if (arg && pr) setRepo(pr.upstream);
  }, [arg, pr, setRepo]);
  useDetailKey(useCallback(() => setDetail((open) => !open), []));
  if (!pr) return <section className="screen" data-screen="pr"><p className="lede">No pull requests in the data yet.</p></section>;
  const stage = pr.stages[stageIndex] ?? pr.stages[0];
  const diff = stage ? <DiffViewer key={`${pr.id}-${stage.date}`} diff={stage.diff} scope={`this commit, ${shortDate(stage.date)}`} /> : null;
  if (present) {
    return (
      <section className="screen pr-screen" data-screen="pr">
        <div className="pr-stage__top"><span /><PrSwitcher prs={sorted} current={pr.id} /></div>
        <PrPresent pr={pr} detailHint="" />
        <div className="pr-stage__bottom">
          <div className="pr-stage__left">
            <p className="pr-founder">{pr.founder_line}</p>
            <Stages pr={pr} index={stageIndex} onChange={setStageIndex} />
            {stage ? <p className="small pr-stage-text">{firstSentence(stage.what_changes)}</p> : null}
          </div>
          <div className="pr-diff-col">{diff}</div>
        </div>
        {detail ? (
          <PresentDetail title="The rest of the pull request" onClose={() => setDetail(false)}>
            <PrCard pr={pr} />
          </PresentDetail>
        ) : null}
      </section>
    );
  }
  return (
    <section className="screen pr-screen" data-screen="pr">
      <ScreenHead eyebrow="The pull request" title="Measured on your code, or it says so" aside={<PrSwitcher prs={sorted} current={pr.id} />} />
      <div className="pr-layout">
        <PrCard key={pr.id} pr={pr} />
        <div className="pr-diff-col">
          <Stages pr={pr} index={stageIndex} onChange={setStageIndex} />
          {stage ? <p className="small pr-stage-text">{stage.what_changes}</p> : null}
          {diff}
        </div>
      </div>
    </section>
  );
}
