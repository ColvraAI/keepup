'use client';

import { useEffect, useRef } from 'react';
import { useForwardSkip } from '@/hooks/useSkip';
import { fitCanvas, prefersReducedMotion } from '@/lib/dots';
import { currentZoom } from '@/lib/stage';

const HOLD_MS = 260;
const BAND_MS = 1500;
const STAGE_MS = 2700;
const NOISE = '#16140f'; // Paper-side noise: the pulse's field, in the product's own ink.
const KEPT = '#2f6fde';

export type KeptDot = { x: number; y: number; radius: number };

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Where the survivors end, in viewport pixels, so they can travel on to become the list's bullets. */
export function keptRow(canvas: DOMRect, keep: number, radius: number, gap: number): KeptDot[] {
  const midY = canvas.top + canvas.height / 2;
  const midX = canvas.left + canvas.width / 2;
  return Array.from({ length: keep }, (_, i) => ({ x: midX + (i - (keep - 1) / 2) * gap, y: midY, radius }));
}

/**
 * Every record, as one dot. All but the few that fit stream toward them and vanish, and those stay
 * blue and whole. On a band in the dashboard; alone on the whole stage in present mode.
 */
export function CollapseField({ records, keep, full, onSettled }: { records: number; keep: number; full: boolean; onSettled: (dots: readonly KeptDot[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const skip = useRef<() => void>(() => undefined);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    const canvas = ref.current;
    const fit = canvas ? fitCanvas(canvas) : null;
    if (!canvas || !fit) return undefined;
    const { ctx, width, height, ratio } = fit;
    const zoom = currentZoom();
    const random = seeded(records);
    const xs = new Float32Array(records);
    const ys = new Float32Array(records);
    const thresholds = new Float32Array(records);
    for (let i = 0; i < records; i += 1) {
      xs[i] = random() * width;
      ys[i] = random() * height;
      thresholds[i] = random();
    }
    const dot = full ? 3 * ratio * zoom : Math.max(1.5 * ratio, 2);
    const radius = full ? 15 * ratio * zoom : Math.max(5 * ratio, Math.min(height * 0.16, 11 * ratio));
    const gap = Math.min(width / (keep + 1), radius * (full ? 9 : 7));
    const keptX = (i: number) => width / 2 + (i - (keep - 1) / 2) * gap;
    const midY = height / 2;

    const paint = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = NOISE;
      const pull = t * t * t;
      for (let i = 0; i < records; i += 1) {
        const threshold = thresholds[i] ?? 0;
        if (threshold < t) continue;
        const x = xs[i] ?? 0;
        const y = ys[i] ?? 0;
        ctx.fillRect(x + (keptX(i % keep) - x) * pull, y + (midY - y) * pull, dot, dot);
      }
      ctx.fillStyle = KEPT;
      const grown = Math.max(0, Math.min(1, (t - 0.25) / 0.6));
      for (let i = 0; i < keep; i += 1) {
        ctx.beginPath();
        ctx.arc(keptX(i), midY, radius * grown, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    let raf = 0;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      paint(1);
      const rect = canvas.getBoundingClientRect();
      settledRef.current(keptRow(rect, keep, radius / ratio, gap / ratio));
    };
    skip.current = settle;
    if (prefersReducedMotion()) {
      settle();
      return undefined;
    }
    paint(0);
    const span = full ? STAGE_MS : BAND_MS;
    const begin = () => {
      const start = performance.now();
      const frame = (now: number) => {
        const t = Math.max(0, Math.min(1, (now - start - HOLD_MS) / span));
        if (t >= 1) {
          settle();
          return;
        }
        paint(t * t * (3 - 2 * t));
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    };
    if (full) {
      begin();
      return () => cancelAnimationFrame(raf);
    }
    // In the dashboard it plays when it's seen, so a viewer scrolling down doesn't miss it.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        begin();
      }
    }, { threshold: 0.4 });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [records, keep, full]);

  useForwardSkip(() => skip.current(), true);

  return (
    <>
      <canvas ref={ref} className={full ? 'payoff__canvas payoff__canvas--stage' : 'payoff__canvas'} aria-hidden="true" data-testid="collapse-canvas" onClick={() => skip.current()} />
      {full ? <button type="button" hidden data-present-beat onClick={() => skip.current()} /> : null}
    </>
  );
}
