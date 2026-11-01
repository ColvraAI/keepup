'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBundle, usePresent } from '@/components/BundleContext';
import { Feed, SourceBars, WeekBars } from '@/components/PulseCharts';
import { useForwardSkip } from '@/hooks/useSkip';
import { buildField, fitCanvas, shimmer, paintRange, prefersReducedMotion, seededRandom, wantedSize, type Rect } from '@/lib/dots';
import { readBeat } from '@/lib/beats';
import { count, daysBetween, longDate } from '@/lib/format';
import { currentZoom } from '@/lib/stage';
import type { Pulse as PulseData } from '@/lib/types';

const CLIMB_MS = 3400;
const STAGE_DOT = 3.5;

function measureCutouts(canvas: HTMLCanvasElement | null, ratio: number): Rect[] {
  if (!canvas?.parentElement) return [];
  const origin = canvas.getBoundingClientRect();
  return [...canvas.parentElement.querySelectorAll('.pulse-cut')]
    .map((element) => element.getBoundingClientRect())
    .map((rect) => ({
      left: (rect.left - origin.left) * ratio,
      right: (rect.right - origin.left) * ratio,
      top: (rect.top - origin.top) * ratio,
      bottom: (rect.bottom - origin.top) * ratio,
    }))
    .sort((a, b) => a.top - b.top);
}

const SHIMMER_TICK_MS = 110;

function useClimb(pulse: PulseData, canvasRef: React.RefObject<HTMLCanvasElement | null>, present: boolean, instant: boolean) {
  const [shown, setShown] = useState(0);
  const finishRef = useRef<() => void>(() => undefined);
  const field = useMemo(() => buildField(pulse), [pulse]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fit = canvas ? fitCanvas(canvas) : null;
    if (!canvas || !fit) return undefined;
    const { ctx, width, height, ratio } = fit;
    const dotFor = (scale: number) => (present ? STAGE_DOT * ratio * scale : Math.max(1.5 * ratio, 2));
    const size = { width, height, dot: dotFor(currentZoom()), cutouts: measureCutouts(canvas, ratio) };
    let drawn = 0;
    let raf = 0;
    let idle = 0;
    const random = seededRandom(7);
    const paintTo = (target: number) => {
      paintRange(ctx, field, drawn, target, size);
      drawn = target;
      setShown(target);
    };
    const startFlicker = () => {
      if (prefersReducedMotion()) return;
      let previous: number[] = [];
      const lastDay = pulse.by_day.days.length - 1;
      const blink = (now: number) => {
        previous = shimmer(ctx, field, size, random, previous, lastDay, now);
        idle = window.setTimeout(() => { raf = requestAnimationFrame(blink); }, SHIMMER_TICK_MS);
      };
      raf = requestAnimationFrame(blink);
    };
    // A browser going full screen, or present mode dropping the rail, changes the field's size.
    // Compare before fitting: fitting clears the canvas, which once blanked it with reduced motion on.
    const refit = () => {
      const wanted = wantedSize(canvas);
      if (wanted.width === canvas.width && wanted.height === canvas.height) return;
      const next = fitCanvas(canvas);
      if (!next) return;
      size.width = next.width;
      size.height = next.height;
      size.dot = dotFor(currentZoom());
      size.cutouts = measureCutouts(canvas, next.ratio);
      paintRange(next.ctx, field, 0, drawn, size);
    };
    const observer = new ResizeObserver(refit);
    observer.observe(canvas);
    window.addEventListener('resize', refit);
    const stop = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(idle);
    };
    finishRef.current = () => {
      if (drawn >= field.size) return;
      stop();
      paintTo(field.size);
      startFlicker();
    };
    if (prefersReducedMotion() || instant) {
      finishRef.current();
    } else {
      const start = performance.now();
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / CLIMB_MS);
        // Ease in: it starts as a trickle and ends as a flood.
        paintTo(Math.floor(field.size * t * t));
        if (t < 1) raf = requestAnimationFrame(frame);
        else startFlicker();
      };
      raf = requestAnimationFrame(frame);
    }
    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener('resize', refit);
    };
  }, [field, canvasRef, present, instant, pulse.by_day.days.length]);

  const dayIndex = shown === 0 ? 0 : (field.front[Math.min(shown, field.size) - 1] ?? 0);
  const finish = useCallback(() => finishRef.current(), []);
  return { shown, landed: shown >= field.size, day: pulse.by_day.days[dayIndex] ?? pulse.window.from, finish };
}

/** Tabular digits so the counter holds still, without the wide comma tabular figures bring. */
function Digits({ value }: { value: string }) {
  const parts = value.split(',');
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? <span className="pulse-counter__sep">,</span> : null}
          {part}
        </span>
      ))}
    </>
  );
}

export function PulseScreen() {
  const { pulse } = useBundle();
  const present = usePresent();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Coming back with ← shows the field as it was left. A refresh plays it again: it's the opening.
  const [instant] = useState(() => present && readBeat('pulse')?.beat === 'last');
  const { shown, landed, day, finish } = useClimb(pulse, canvasRef, present, instant);
  const span = daysBetween(pulse.window.from, pulse.window.to);
  const top = pulse.by_source[0];
  useForwardSkip(finish, !landed);
  return (
    <section className="pulse" data-screen="pulse" data-landed={landed} onClick={finish}>
      <canvas ref={canvasRef} className="pulse-canvas" aria-hidden="true" data-testid="pulse-canvas" />
      {landed ? null : <button type="button" hidden data-present-beat onClick={finish} />}
      <div className="pulse-main">
        <header className="pulse-cut pulse-head">
          <h1>
            <span className="pulse-head__lead">AI shipped</span>
            <span className="pulse-counter num" data-testid="pulse-counter" aria-label={`${count(pulse.total)} things`}>
              <Digits value={count(shown)} />
            </span>
            <span className="pulse-head__tail">things in {span} days</span>
          </h1>
          <p className="pulse-date mono">
            <span>{longDate(pulse.window.from)} to {shown >= pulse.total ? longDate(pulse.window.to) : longDate(day)}</span>
            <span className="pulse-date__more">new or updated · one dot per thing</span>
          </p>
        </header>
        <div className="pulse-foot">
          {present ? null : (
            <>
              <div className="pulse-chart pulse-land"><SourceBars pulse={pulse} /></div>
              <div className="pulse-chart pulse-land"><WeekBars pulse={pulse} /></div>
            </>
          )}
          <p className="pulse-line pulse-land" data-testid="pulse-line"><span>Nobody can read this.</span> <span>Your product doesn’t have to.</span></p>
          {present && top ? <p className="pulse-share pulse-land mono" data-testid="pulse-share">{Math.round((top.count / pulse.total) * 100)}% are {top.label} entries · new or updated</p> : null}
        </div>
      </div>
      <Feed pulse={pulse} landed={landed} />
    </section>
  );
}
