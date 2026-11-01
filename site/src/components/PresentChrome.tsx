'use client';

import { useCallback, useEffect, useState } from 'react';
import { useBundle, useRepo } from './BundleContext';
import { readTimer, writeTimer } from '@/lib/beats';
import { hasModifier, isForwardKey, isOnControl, isTyping } from '@/lib/keys';
import { notesFor } from '@/lib/notes';
import { demoRepos } from '@/lib/repos';
import { PRESENT_ORDER, SCREEN_LABEL, type ScreenId } from '@/lib/routes';

const COUNTDOWN_SECONDS = 120;
const OVERFLOW_SLACK = 40;
const PAGE_SHARE = 0.85;

/** The start time is kept for the tab, so a refresh doesn't lose the clock. Hiding it resets it. */
function useCountdown(): { shown: boolean; toggle: () => void; clock: string } {
  const [startedAt, setStartedAt] = useState<number | null>(() => readTimer());
  const [left, setLeft] = useState(COUNTDOWN_SECONDS);
  useEffect(() => {
    if (startedAt === null) return undefined;
    const tick = () => setLeft(COUNTDOWN_SECONDS - Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const toggle = useCallback(() => {
    setStartedAt((old) => {
      const next = old === null ? Date.now() : null;
      writeTimer(next);
      return next;
    });
  }, []);
  const abs = Math.abs(left);
  return { shown: startedAt !== null, toggle, clock: `${left < 0 ? '-' : ''}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}` };
}

/** Bold in the script is what the presenter says. */
function NoteLine({ line }: { line: string }) {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return <p>{parts.map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part))}</p>;
}

/** Anything still below the fold, on the few screens that run past the stage. */
function pageRunsOn(): boolean {
  return document.documentElement.scrollHeight - window.innerHeight - window.scrollY > OVERFLOW_SLACK;
}

/** Back undoes one beat, and leaves the screen only from its first. */
function backward(step: (delta: 1 | -1) => void): void {
  const beat = document.querySelector<HTMLElement>('[data-present-back]');
  if (beat) beat.click();
  else step(-1);
}

function forward(key: string, step: (delta: 1 | -1) => void): void {
  if (key !== 'ArrowRight' && pageRunsOn()) {
    window.scrollBy({ top: window.innerHeight * PAGE_SHARE, behavior: 'auto' });
    return;
  }
  const beat = document.querySelector<HTMLElement>('[data-present-beat]');
  if (beat) beat.click();
  else step(1);
}

/** An open detail panel takes the keys that would otherwise leave the screen. */
function panelTook(event: KeyboardEvent): boolean {
  const panel = document.querySelector<HTMLElement>('.present-detail');
  if (!panel) return false;
  if (event.key === 'Escape') panel.querySelector<HTMLElement>('[data-detail-close]')?.click();
  else if (event.key === 'PageDown' || event.key === ' ') panel.scrollBy({ top: panel.clientHeight * PAGE_SHARE });
  else if (event.key === 'PageUp') panel.scrollBy({ top: -panel.clientHeight * PAGE_SHARE });
  else return false;
  event.preventDefault();
  return true;
}

export function PresentChrome({
  screen,
  step,
  go,
  exit,
}: {
  screen: ScreenId;
  step: (delta: 1 | -1) => void;
  go: (screen: ScreenId) => void;
  exit: () => void;
}) {
  const bundle = useBundle();
  const { notes } = bundle;
  const { repo, setRepo } = useRepo();
  const repos = demoRepos(bundle);
  const [showNotes, setShowNotes] = useState(false);
  const { shown: showTimer, toggle: toggleTimer, clock } = useCountdown();
  const section = notesFor(notes, screen);
  const index = PRESENT_ORDER.indexOf(screen);

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (hasModifier(event)) return;
      if (event.key === 'Escape' && !document.querySelector('.present-detail')) {
        (document.activeElement as HTMLElement | null)?.blur?.();
        exit();
        return;
      }
      if (isTyping(event.target)) return;
      if (panelTook(event)) return;
      // Enter and Space work the control that has focus; nothing focused means the presenter's own keys.
      if ((event.key === ' ' || event.key === 'Enter') && isOnControl(event.target)) return;
      if (isForwardKey(event.key)) {
        event.preventDefault();
        forward(event.key, step);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        backward(step);
      } else if (event.key === 'n' || event.key === 'N') {
        setShowNotes((value) => !value);
      } else if (event.key === 't' || event.key === 'T') {
        toggleTimer();
      } else if (event.key === 'a' || event.key === 'A') {
        const next = repos[(repos.indexOf(repo) + 1) % repos.length];
        if (next) setRepo(next);
      } else if (event.key === 'Enter') {
        const beat = document.querySelector<HTMLElement>('[data-present-beat]');
        if (beat) {
          event.preventDefault();
          beat.click();
        }
      } else if (/^[1-9]$/.test(event.key)) {
        const jump = PRESENT_ORDER[Number(event.key) - 1];
        if (jump) go(jump);
      }
    },
    [step, go, exit, toggleTimer, repos, repo, setRepo],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  // A click leaves focus on the switch or button it hit; the presenter's next key is still theirs.
  useEffect(() => {
    const release = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !isTyping(target) && !isTyping(document.activeElement)) window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur?.(), 0);
    };
    window.addEventListener('pointerup', release);
    return () => window.removeEventListener('pointerup', release);
  }, []);

  return (
    <>
      <ol className="present-progress" aria-hidden="true" data-testid="present-progress">
        {PRESENT_ORDER.map((id, position) => (
          <li key={id} className={position === index ? 'now' : position < index ? 'done' : ''} title={SCREEN_LABEL[id]} />
        ))}
      </ol>
      {showTimer ? (
        <div className="present-timer mono" data-testid="present-timer" role="timer">
          {clock}
        </div>
      ) : null}
      {showNotes ? (
        <aside className="present-notes" data-testid="present-notes" aria-label="Speaker notes">
          {section ? (
            <>
              <p className="mono present-notes__time">
                {section.time} · {section.title}
              </p>
              {section.lines.map((line) => (
                <NoteLine key={line} line={line} />
              ))}
            </>
          ) : (
            <p>This screen is the bonus: the script’s two minutes end on Monday.</p>
          )}
        </aside>
      ) : null}
    </>
  );
}
