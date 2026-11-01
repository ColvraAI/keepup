'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBundle, usePresent, useRepo } from '@/components/BundleContext';
import { Ext } from '@/components/Ext';
import { RepoSwitch, ScreenHead } from '@/components/parts';
import { GapChart } from '@/components/replay/GapChart';
import { LeadStoryCard } from '@/components/replay/LeadStory';
import { ReplayStage } from '@/components/replay/ReplayStage';
import { Timeline } from '@/components/replay/Timeline';
import { prefersReducedMotion } from '@/lib/dots';
import { daysBetween, longDate, shortDate } from '@/lib/format';
import { demoRepos, replayFor } from '@/lib/repos';

const WEEK_MS = 1250;

function scrollToWeek(week: string): void {
  document.querySelector(`[data-week="${week}"]`)?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

type PlayState = { week: number | null; running: boolean };

/** Pause keeps its place: the week stays, the later rows stay dim, and Resume carries on from it. */
function usePlayback(weeks: readonly { start: string }[]) {
  const [state, setState] = useState<PlayState>({ week: null, running: false });
  const timer = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  }, []);

  const pause = useCallback(() => {
    clear();
    setState((old) => ({ ...old, running: false }));
  }, [clear]);

  const reset = useCallback(() => {
    clear();
    setState({ week: null, running: false });
  }, [clear]);

  const play = useCallback(() => {
    clear();
    let index = state.week ?? 0;
    setState({ week: index, running: true });
    const first = weeks[index];
    if (first) scrollToWeek(first.start);
    timer.current = window.setInterval(() => {
      index += 1;
      const next = weeks[index];
      if (!next) {
        reset();
        document.querySelector('[data-testid="replay-headline"]')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
        return;
      }
      setState({ week: index, running: true });
      scrollToWeek(next.start);
    }, WEEK_MS);
  }, [weeks, state.week, clear, reset]);

  useEffect(() => clear, [clear]);
  return { ...state, play, pause, reset };
}

export function ReplayScreen() {
  const bundle = useBundle();
  const present = usePresent();
  const repos = demoRepos(bundle);
  const { repo: name, setRepo } = useRepo();
  const repo = useMemo(() => replayFor(bundle, name), [bundle, name]);
  const { week, running, play, pause, reset } = usePlayback(repo?.weeks ?? []);
  const window_ = bundle.replay.window;
  if (!repo) return <section className="screen" data-screen="replay"><p className="lede">No replay for {name}.</p></section>;
  if (present) return <ReplayStage key={repo.repo} repo={repo} window={window_} />;
  const parts = repo.headline_parts;
  const cursor = week === null ? null : (repo.weeks[week]?.end ?? null);
  const label = running ? 'Pause' : week !== null ? `Resume from ${shortDate(repo.weeks[week]?.start ?? '')}` : 'Play week by week';
  return (
    <section className="screen replay" data-screen="replay" onClick={running ? pause : undefined}>
      <ScreenHead
        eyebrow={`The replay · ${longDate(window_.from)} to ${longDate(window_.to)} · time is simulated, every date and commit is real`}
        title={`${daysBetween(window_.from, window_.to)} days against your code`}
        aside={
          <div className="replay__controls">
            <button
              type="button"
              className="btn"
              data-present-action
              data-testid="replay-play"
              onClick={(event) => {
                event.stopPropagation();
                if (running) pause();
                else play();
              }}
            >
              {label}
            </button>
            <RepoSwitch
              repos={repos}
              value={name}
              onChange={(next) => {
                reset();
                setRepo(next);
              }}
            />
          </div>
        }
      />
      <LeadStoryCard repo={repo} />
      <div className="replay__chart">
        <GapChart repo={repo} window={window_} cursor={cursor} />
      </div>
      <Timeline repo={repo} playingWeek={week} />
      <footer className="replay__headline" data-testid="replay-headline">
        <p className="replay__big">{parts.big}</p>
        {parts.second ? <p className="replay__second">{parts.second}</p> : null}
        <p className="small">{[parts.engine, parts.commit, parts.ahead].filter(Boolean).join(' ')}</p>
        <p className="small">Across both products: {bundle.replay.headline}</p>
        <p className="small">
          Computed from <code>data/timeline.json</code>, never typed. The replay runs on the database fetched {longDate(bundle.replay.window.fetched)}: moving the clock doesn’t remove newer records, so it isn’t what the product would have seen on each day. What keepup did on each row is written in that file too, and only rows marked “engine run” were reached by a live run. Code at <Ext href={repo.pinned_url} className="mono">{repo.pinned_commit}</Ext> and the base commit on each row.
        </p>
      </footer>
    </section>
  );
}
