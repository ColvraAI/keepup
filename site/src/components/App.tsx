'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { BundleProvider, PresentProvider } from './BundleContext';
import { PresentChrome } from './PresentChrome';
import { Rail } from './Rail';
import { ScreenSwitch } from './ScreenSwitch';
import { clearBeat, startSession, writeBeat } from '@/lib/beats';
import { hasModifier, isTyping } from '@/lib/keys';
import { parseHash, PRESENT_ORDER, hashFor, stepScreen, type Route } from '@/lib/routes';
import { applyStage } from '@/lib/stage';
import type { Bundle } from '@/lib/types';

function setPresentInUrl(on: boolean): void {
  const url = new URL(window.location.href);
  if (on) url.searchParams.set('present', '');
  else url.searchParams.delete('present');
  window.history.replaceState(null, '', url.toString().replace('present=', 'present'));
}

const firstScreen = () => PRESENT_ORDER[0] ?? 'pulse';

function usePresentStage(present: boolean): void {
  useLayoutEffect(() => {
    if (!present) return undefined;
    const fit = () => applyStage(document.documentElement, window.innerWidth, window.innerHeight);
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [present]);
}

export function App({ bundle }: { bundle: Bundle }) {
  // Null until mounted: the hash only exists in the browser, and an overview flash would break the cut.
  const [route, setRoute] = useState<Route | null>(null);
  // Null until mounted too: the script before first paint already set the class, and hydrating mustn't undo it.
  const [present, setPresent] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    startSession();
    const read = () => setRoute(parseHash(window.location.hash));
    const startsPresent = /[?&]present/.test(window.location.search);
    // ?present with no screen named starts the demo, not the dashboard's home.
    if (startsPresent && !window.location.hash) window.history.replaceState(null, '', hashFor(firstScreen()));
    read();
    setPresent(startsPresent);
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  useLayoutEffect(() => {
    if (present !== null) document.documentElement.classList.toggle('is-present', present);
  }, [present]);

  usePresentStage(present === true);

  // A new screen opens at its top, whatever the last one was scrolled to, and cancels a smooth scroll in progress.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.dataset.on = route?.screen ?? '';
  }, [route?.screen, route?.arg]);

  const go = useCallback((screen: Route['screen'], arg?: string | null) => {
    clearBeat(screen);
    window.location.hash = hashFor(screen, arg);
  }, []);

  const togglePresent = useCallback((on: boolean) => {
    setPresent(on);
    setPresentInUrl(on);
    if (on && !PRESENT_ORDER.includes(parseHash(window.location.hash).screen)) {
      window.location.hash = hashFor(firstScreen());
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || hasModifier(event)) return;
      if (event.key === 'p' || event.key === 'P') togglePresent(!document.documentElement.classList.contains('is-present'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePresent]);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (!route) return;
      const next = stepScreen(route.screen, delta);
      if (!next) return;
      // Forward opens a screen at its start; back returns to where it ended.
      if (delta === -1) writeBeat(next, 'last');
      else clearBeat(next);
      window.location.hash = hashFor(next);
    },
    [route],
  );

  return (
    <BundleProvider bundle={bundle}>
      <div className={present ? 'app app--present' : 'app'}>
        {present || !route ? null : <Rail current={route.screen} onPresent={() => togglePresent(true)} />}
        <main className="main" id="main">
          <PresentProvider value={present === true}>{route ? <ScreenSwitch route={route} /> : null}</PresentProvider>
        </main>
        {present && route ? <PresentChrome screen={route.screen} step={step} go={go} exit={() => togglePresent(false)} /> : null}
      </div>
    </BundleProvider>
  );
}
