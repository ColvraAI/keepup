'use client';

import { useEffect } from 'react';
import { hasModifier, isForwardKey, isOnControl, isPresentNow, isTyping } from '@/lib/keys';

/**
 * Finishes an animation on a forward key, in the dashboard. In present mode the screen renders a
 * [data-present-beat] instead, so the one forward key finishes it and doesn't also leave the screen.
 * Other keys, such as the timer's T, leave it running.
 */
export function useForwardSkip(finish: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (isPresentNow() || hasModifier(event) || isTyping(event.target) || !isForwardKey(event.key)) return;
      if (event.key === ' ' && isOnControl(event.target)) return;
      finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish, active]);
}

/** A screen's detail in present mode: what's there for a question, kept off the stage until asked. */
export function useDetailKey(onToggle: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPresentNow() || hasModifier(event) || isTyping(event.target)) return;
      if (event.key === 'd' || event.key === 'D') onToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggle]);
}
