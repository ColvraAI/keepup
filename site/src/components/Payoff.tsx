'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useBundle, usePresent } from '@/components/BundleContext';
import { CollapseField, type KeptDot } from '@/components/CollapseField';
import { Chip } from '@/components/parts';
import { PresentDetail } from '@/components/PresentDetail';
import { useDetailKey } from '@/hooks/useSkip';
import { count, usd } from '@/lib/format';
import { hashFor } from '@/lib/routes';
import { sourceCount } from '@/lib/repos';
import { prOverridingRefusal } from '@/lib/replay';
import { candidateSplit, firstRunCost, fromDeprecationPages, judgeHeldBack, namedRefusals, rankedFindings, type RankedFinding } from '@/lib/runs';
import { currentZoom } from '@/lib/stage';
import type { Run } from '@/lib/types';

const ROW_STAGGER_MS = 120;
const REFUSALS_SHOWN = 3;

/** Each survivor travels from the collapse's last frame to become its row's bullet. */
function useTravel(dots: readonly KeptDot[] | null) {
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    if (!dots || !list.current) return;
    const zoom = currentZoom();
    const bullets = [...list.current.querySelectorAll<HTMLElement>('[data-bullet]')];
    bullets.forEach((bullet, index) => {
      const dot = dots[index];
      if (!dot) return;
      const rect = bullet.getBoundingClientRect();
      bullet.style.setProperty('--from-x', `${(dot.x - (rect.left + rect.width / 2)) / zoom}px`);
      bullet.style.setProperty('--from-y', `${(dot.y - (rect.top + rect.height / 2)) / zoom}px`);
    });
    list.current.dataset.travel = 'true';
  }, [dots]);
  return list;
}

function FindingRow({ row, index, present }: { row: RankedFinding; index: number; present: boolean }) {
  const { finding, pr } = row;
  return (
    <li style={{ '--row': index, '--stagger': `${ROW_STAGGER_MS}ms` } as React.CSSProperties}>
      <i aria-hidden="true" data-bullet />
      <span className="payoff__title">{finding.title}</span>
      <span className="payoff__meta">
        {pr ? (
          <a href={hashFor('pr', pr.id)} className="payoff__pr">
            <Chip tone="blue">PR {pr.id} · pull request ready</Chip>
          </a>
        ) : null}
        {present ? null : finding.effect.map((effect) => <Chip key={effect}>{effect}</Chip>)}
        {present ? (pr ? null : <span className="mono small payoff__effort">not built · {finding.effort.toLowerCase()}</span>) : <span className="mono small">{finding.proof} · {finding.effort.toLowerCase()}</span>}
      </span>
    </li>
  );
}

function Refusals({ run }: { run: Run }) {
  const { prs } = useBundle();
  const mine = prs.filter((pr) => pr.upstream === run.repo);
  const named = namedRefusals(run, REFUSALS_SHOWN);
  return (
    <section className="refusals" data-testid="refusals">
      <p className="refusals__head">
        <span className="refusals__dots" aria-hidden="true">
          {run.held_back.map((row) => <i key={row.thing} />)}
        </span>
        <span className="refusals__count"><span className="num">{run.held_back.length}</span> held back, each with a reason</span>
      </p>
      <ul className="refusals__list">
        {named.map((row) => {
          const exception = prOverridingRefusal(row.thing, mine);
          return (
            <li key={row.thing}>
              <strong>{row.thing}.</strong> {row.reason}
              {exception ? <span className="refusals__exception" data-testid="refusal-exception"> PR {exception.id} adds it anyway, as a hand-written exception, and the replay says so.</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The funnel as it really is: what was searched, what reached the judge, and where the findings came from. */
function PayoffLine({ run }: { run: Run }) {
  return (
    <h2 className="payoff__line" data-testid="payoff-line">
      Searched <span className="num">{count(run.db.records)}</span> new or updated things. <span className="num">{count(run.candidates_considered)}</span> reached the judge.{' '}
      <span className="payoff__fit num">{run.findings.length} fit.</span>
    </h2>
  );
}

function Origins({ run }: { run: Run }) {
  const pages = fromDeprecationPages(run);
  return (
    <p className="payoff__origins mono" data-testid="payoff-origins">
      {run.checks_passed} claims checked against this commit{pages > 0 ? ` · ${pages} of the ${run.findings.length} cite provider deprecation pages, not those records` : ''}
    </p>
  );
}

function Counts({ run }: { run: Run }) {
  const split = candidateSplit(run);
  return (
    <p className="small payoff__counts">
      {count(split.total)} candidates considered: {count(split.search)} from search, {count(split.checks)} from exact checks and patterns · the judge held back {judgeHeldBack(run)}, and with the exact checks’ rows that’s {run.held_back.length} · {run.watching.length} on watch · {run.checks_passed} claims checked against this commit.
    </p>
  );
}

function SmallPrint({ run }: { run: Run }) {
  return (
    <>
      <Counts run={run} />
      <p className="small">
        Searched {count(run.db.records)} records from {sourceCount(run)} sources. These are the engine’s recorded words; where the audit later corrected one, the replay and the pull request carry the correction.{' '}
        {run.usage ? <>The first run’s judge cost {usd(firstRunCost(run))}, and this is that run rebuilt from its saved answers.</> : 'No judge ran.'}
      </p>
    </>
  );
}

export function Payoff({ run, instant = false }: { run: Run; instant?: boolean }) {
  const { prs } = useBundle();
  const present = usePresent();
  const [dots, setDots] = useState<readonly KeptDot[] | null>(null);
  const [skipped] = useState(instant);
  const [detail, setDetail] = useState(false);
  useDetailKey(useCallback(() => setDetail((open) => !open), []));
  const list = useTravel(dots);
  const rows = rankedFindings(run, prs);
  const collapsing = present && dots === null && !skipped;
  return (
    <section className="payoff" data-testid="payoff" data-settled={!collapsing}>
      {collapsing || !present ? (
        <CollapseField records={run.db.records} keep={run.findings.length} full={present} onSettled={setDots} />
      ) : null}
      {collapsing ? null : (
        <>
          <PayoffLine run={run} />
          <Origins run={run} />
          <ol className="payoff__list" ref={present ? list : undefined}>
            {rows.map((row, index) => <FindingRow key={row.finding.rank} row={row} index={index} present={present} />)}
          </ol>
          <Refusals run={run} />
          {present ? null : <SmallPrint run={run} />}
          {present ? null : <p className="small"><a href={hashFor('replay')}>See the replay</a></p>}
          {present && detail ? <PresentDetail title="How these numbers are counted" onClose={() => setDetail(false)}><SmallPrint run={run} /></PresentDetail> : null}
        </>
      )}
    </section>
  );
}
