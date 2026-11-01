'use client';

import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '@/lib/dots';
import { count } from '@/lib/format';
import { stepDetail } from '@/lib/runs';
import type { Run } from '@/lib/types';

const CLIMB_MS = 420;
/** What a step found, without the small print: the room reads the result, and the rest is behind D. */
const shortDetail = (detail: string): string => detail.replace(/\s*\([^)]*\)/, '');

function useClimbing(target: number, on: boolean): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!on) {
      setValue(0);
      return undefined;
    }
    if (prefersReducedMotion()) {
      setValue(target);
      return undefined;
    }
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / CLIMB_MS);
      setValue(Math.round(target * (1 - (1 - t) * (1 - t))));
      if (t < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [target, on]);
  return value;
}

function Counter({ value, label, on }: { value: number; label: string; on: boolean }) {
  const shown = useClimbing(value, on);
  return (
    <div className="reading__counter" data-on={on}>
      <span className="reading__value num">{count(shown)}</span>
      <span className="reading__label">{label}</span>
    </div>
  );
}

const reached = (run: Run, shown: number, name: string): boolean => run.steps.findIndex((step) => step.name === name) < shown;

/** The one moving thing on the screen: each step lands with its result, and the counters climb as it does. */
export function ReadingStage({ run, shown }: { run: Run; shown: number }) {
  return (
    <div className="reading" data-testid="reading-stage">
      <ol className="reading__steps" data-testid="reading-steps">
        {run.steps.slice(0, shown).map((step) => (
          <li key={step.name}>
            <span className="reading__name">{step.name}</span>
            <span className="reading__detail">{shortDetail(stepDetail(step))}</span>
          </li>
        ))}
      </ol>
      <div className="reading__counters" aria-live="off">
        <Counter value={run.files_checked} label="files read" on={reached(run, shown, 'List files')} />
        <Counter value={run.ai_call_sites_total} label="AI call sites" on={reached(run, shown, 'Run signals')} />
        <Counter value={run.model_ids_total} label="model ids" on={reached(run, shown, 'Find model ids')} />
      </div>
    </div>
  );
}
