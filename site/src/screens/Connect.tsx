'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBundle, usePresent, useRepo } from '@/components/BundleContext';
import { Beats } from '@/components/Beats';
import { Evidence, Permissions } from '@/components/ConnectParts';
import { PresentDetail } from '@/components/PresentDetail';
import { ReadingStage } from '@/components/ReadingStage';
import { useBeat } from '@/hooks/useBeat';
import { RepoSwitch, ScreenHead } from '@/components/parts';
import { useDetailKey, useForwardSkip } from '@/hooks/useSkip';
import { prefersReducedMotion } from '@/lib/dots';
import { count, friendlyRepo, longDate, shortSha, usd } from '@/lib/format';
import { demoRepos, runFor } from '@/lib/repos';
import { firstRunCost, replayedOnly, stepDetail, stepTime } from '@/lib/runs';
import type { Run } from '@/lib/types';

const STEP_MS = 260;
const SAFETY = 'The model that reads your code gets no tools and no secrets. All it can produce is a pull request, and a person merges it.';

function useStepReplay(total: number, running: boolean, instant: boolean): [number, () => void] {
  const [shown, setShown] = useState(instant ? total : 0);
  const timer = useRef<number | null>(null);
  const stop = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => {
    if (!running) {
      setShown(0);
      return stop;
    }
    if (prefersReducedMotion() || instant) {
      setShown(total);
      return stop;
    }
    setShown(1);
    timer.current = window.setInterval(() => {
      setShown((value) => {
        if (value >= total) stop();
        return Math.min(total, value + 1);
      });
    }, STEP_MS);
    return stop;
  }, [running, total, stop, instant]);
  const finish = useCallback(() => {
    stop();
    setShown(total);
  }, [stop, total]);
  return [shown, finish];
}

function StepList({ run, shown }: { run: Run; shown: number }) {
  return (
    <ol className="steps" data-testid="reading-steps">
      {run.steps.slice(0, shown).map((step) => {
        const time = stepTime(step, run);
        return (
          <li key={step.name}>
            <span className="steps__name">{step.name}</span>
            <span className="steps__detail mono">{stepDetail(step)}</span>
            <span className="steps__ms mono">{time.kind === 'ms' ? `${count(time.ms)} ms` : 'saved answer'}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RecordingNote({ run }: { run: Run }) {
  return (
    <p className="eyebrow connect__note">
      A recording of the real run on {longDate(run.scanned_at)} · {run.repo}@{shortSha(run.commit).slice(0, 7)} · {count(run.files_checked)} files, {count(run.lines_checked)} lines
      {replayedOnly(run) ? <> · model steps replayed from saved answers, and the first run cost {usd(firstRunCost(run))}</> : null}
    </p>
  );
}

/** Straight after the noise: a name, a button, one sentence. The relief is the point. */
function FirstFrame({ repo, onConnect, onAsks }: { repo: string; onConnect: () => void; onAsks: () => void }) {
  return (
    <div className="connect-first" data-testid="connect-first">
      <div className="connect-first__center">
        <p className="connect-first__name"><i aria-hidden="true" />{friendlyRepo(repo)}</p>
        <p className="mono connect-first__slug">{repo}</p>
        <button type="button" className="btn connect-first__btn" data-present-action data-present-beat data-testid="connect-repo" onClick={onConnect}>
          Connect a repo
        </button>
        <p className="connect-first__safety">{SAFETY}</p>
      </div>
      <button type="button" className="connect-first__asks" data-testid="connect-asks" onClick={onAsks}>What the App asks for</button>
    </div>
  );
}

function ReadingTitle(run: Run | null, reading: boolean, done: boolean): string {
  if (!reading) return 'Connect a repo';
  if (!done || !run) return 'Reading your code…';
  return `Read: ${count(run.files_checked)} files, ${count(run.ai_call_sites_total)} AI call sites`;
}

export function ConnectScreen() {
  const bundle = useBundle();
  const present = usePresent();
  const repos = demoRepos(bundle);
  const { repo, setRepo } = useRepo();
  const [beat, setBeat] = useBeat('connect', 1, { enabled: present });
  // Back from the next screen, or a refresh: this beat has played, so it isn't played again.
  const [instant] = useState(() => beat === 1);
  const reading = beat === 1;
  const [detail, setDetail] = useState(false);
  useDetailKey(useCallback(() => setDetail((open) => !open), []));
  const run = useMemo(() => runFor(bundle, repo), [bundle, repo]);
  const [shown, finish] = useStepReplay(run?.steps.length ?? 0, reading, instant);
  const done = run ? shown >= run.steps.length : false;
  useForwardSkip(finish, reading && !done);
  const switchRepo = <RepoSwitch repos={repos} value={repo} onChange={(next) => { setRepo(next); setBeat(0); }} />;
  const closeDetail = () => setDetail(false);

  if (present && !reading) {
    return (
      <section className="screen connect connect--first" data-screen="connect">
        <FirstFrame repo={repo} onConnect={() => setBeat(1)} onAsks={() => setDetail(true)} />
        {detail ? <PresentDetail title="Its permissions, from its real manifest" onClose={closeDetail}><Permissions /></PresentDetail> : null}
      </section>
    );
  }

  if (present && run) {
    return (
      <section className="screen connect connect--reading" data-screen="connect" onClick={finish}>
        <Beats forward={done ? null : finish} back={() => setBeat(0)} />
        <ScreenHead title={<span data-testid="connect-title">{ReadingTitle(run, reading, done)}</span>} aside={switchRepo} />
        <RecordingNote run={run} />
        <ReadingStage run={run} shown={shown} />
        {detail ? (
          <PresentDetail title="Every step, and what it found" onClose={closeDetail}>
            <StepList run={run} shown={run.steps.length} />
            <Evidence run={run} shown={run.steps.length} />
            <Permissions />
          </PresentDetail>
        ) : null}
      </section>
    );
  }

  return (
    <section className="screen connect" data-screen="connect" onClick={reading ? finish : undefined}>
      <ScreenHead eyebrow="Connect" title={<span data-testid="connect-title">{ReadingTitle(run, reading, done)}</span>} aside={switchRepo} />
      <div className="connect__grid">
        <div className="connect__left">
          {reading ? null : (
            <div className="connect__action">
              <p className="mono connect__repo">{repo}</p>
              <button type="button" className="btn" data-present-action data-present-beat data-testid="connect-repo" onClick={() => setBeat(1)}>
                Connect a repo
              </button>
            </div>
          )}
          {reading && run ? <Evidence run={run} shown={shown} /> : <Permissions />}
          <p className="safety">{SAFETY}</p>
        </div>
        <div className="connect__right">
          {run && reading ? (
            <>
              <RecordingNote run={run} />
              <StepList run={run} shown={shown} />
            </>
          ) : run ? (
            <div className="connect__preview">
              <p className="eyebrow">What connecting does</p>
              <p className="lede">
                {run.steps.length} steps against {run.repo}@{shortSha(run.commit).slice(0, 7)}, replayed from the run recorded on {longDate(run.scanned_at)}.
              </p>
              <ol className="connect__names">
                {run.steps.map((step) => (
                  <li key={step.name}>{step.name}</li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="lede">No recorded run for {repo} yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}
