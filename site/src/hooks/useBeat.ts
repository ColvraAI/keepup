'use client';

import { useCallback, useState } from 'react';
import { readBeat, writeBeat } from '@/lib/beats';

type Options = { enabled: boolean; scope?: string };

function restore(screen: string, last: number, { enabled, scope = '' }: Options): number {
  if (!enabled) return 0;
  const saved = readBeat(screen);
  if (!saved) return 0;
  if (saved.beat === 'last') return last;
  return saved.scope === scope ? Math.max(0, Math.min(last, saved.beat)) : 0;
}

/** A screen's place in its beats. In present mode it's kept for the tab; in the dashboard it's just state. */
export function useBeat(screen: string, last: number, options: Options): [number, (beat: number) => void] {
  const { enabled, scope = '' } = options;
  const [beat, setBeat] = useState(() => restore(screen, last, options));
  const set = useCallback((next: number) => {
    if (enabled) writeBeat(screen, next, scope);
    setBeat(next);
  }, [enabled, screen, scope]);
  return [Math.min(beat, last), set];
}
