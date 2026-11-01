// One dot per real thing that shipped, placed by the day it shipped. Canvas and
// requestAnimationFrame only; the seeded generator keeps the field the same on every load.
import type { Pulse } from './types';

/** Colour you feel, not colour you read, bright enough to survive a projector. Never green or amber. */
export const SOURCE_COLOR: Readonly<Record<string, string>> = {
  'mcp-registry': '#cfc9b8',
  npm: '#c0614f',
  github: '#6b93c9',
  huggingface: '#d3a7bf',
  pypi: '#67aab3',
  hn: '#d08a68',
  yc: '#e1d3b4',
  openrouter: '#9fb7dd',
  changelog: '#f3f0e8',
  skills: '#c9a58f',
};

const NOISE_INK = '#0b0a08';
const TRAILING_DAYS = 10;
/** The scatter that lands across the whole field first, so it opens as a flood and not a wipe. */
const SCATTER_SHARE = 0.03;

export type Field = {
  /** Flat arrays, because 41,785 objects would be the slowest part of the frame. */
  days: Uint8Array;
  /** The latest date the front has reached at each dot. The date label reads this, so it only moves forward. */
  front: Uint8Array;
  xs: Float32Array;
  ys: Float32Array;
  colors: Uint8Array;
  palette: string[];
  size: number;
};

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Placed = { day: number; x: number; y: number; color: number; order: number; scatter: boolean };

/**
 * Each dot stays at x by its real date, which keeps the chart honest. Only the order it arrives in
 * is shuffled, within a trailing window, so the front is ragged rather than ruled.
 */
export function buildField(pulse: Pulse): Field {
  const { days, by_source: bySource } = pulse.by_day;
  const sources = Object.keys(bySource);
  const random = mulberry32(41);
  const placed: Placed[] = days.flatMap((_, day) =>
    sources.flatMap((source, color) =>
      Array.from({ length: bySource[source]?.[day] ?? 0 }, (): Placed => {
        const scatter = random() < SCATTER_SHARE;
        return { day, x: (day + random()) / days.length, y: random(), color, scatter, order: scatter ? -1 + random() : day + random() * TRAILING_DAYS };
      }),
    ),
  );
  const ordered = placed.sort((a, b) => a.order - b.order);
  const size = ordered.length;
  const field: Field = {
    days: new Uint8Array(size),
    front: new Uint8Array(size),
    xs: new Float32Array(size),
    ys: new Float32Array(size),
    colors: new Uint8Array(size),
    palette: sources.map((id) => SOURCE_COLOR[id] ?? '#8d8778'),
    size,
  };
  ordered.reduce((front, dot, index) => {
    const reached = dot.scatter ? front : Math.max(front, dot.day);
    field.days[index] = dot.day;
    field.front[index] = reached;
    field.xs[index] = dot.x;
    field.ys[index] = dot.y;
    field.colors[index] = dot.color;
    return reached;
  }, 0);
  return field;
}

/** The backing size a canvas should have now. Setting a canvas's width clears it, so compare first. */
export function wantedSize(canvas: HTMLCanvasElement): { width: number; height: number; ratio: number } {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  return { width: Math.max(1, Math.round(rect.width * ratio)), height: Math.max(1, Math.round(rect.height * ratio)), ratio };
}

export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number; ratio: number } | null {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const { width, height, ratio } = wantedSize(canvas);
  canvas.width = width;
  canvas.height = height;
  return { ctx, width, height, ratio };
}

export type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Text sits in cut-outs of the field, and a dot hidden behind one would be a thing not shown. So a
 * dot's height is its place within the free space of its own column: all of them stay visible.
 */
function freeY(y: number, x: number, height: number, cutouts: readonly Rect[]): number {
  const blocks = cutouts.filter((rect) => x >= rect.left && x <= rect.right);
  if (blocks.length === 0) return y * height;
  const blocked = blocks.reduce((sum, rect) => sum + (rect.bottom - rect.top), 0);
  const free = height - blocked;
  if (free <= 0) return y * height;
  let position = y * free;
  for (const rect of blocks) {
    if (position < rect.top) break;
    position += rect.bottom - rect.top;
  }
  return position;
}

/** Paints dots [from, to) in place. Painting only the new ones keeps a frame under a millisecond or two. */
export function paintRange(
  ctx: CanvasRenderingContext2D,
  field: Field,
  from: number,
  to: number,
  size: { width: number; height: number; dot: number; cutouts: readonly Rect[] },
): void {
  let current = -1;
  for (let i = from; i < to; i += 1) {
    const color = field.colors[i] ?? 0;
    if (color !== current) {
      ctx.fillStyle = field.palette[color] ?? '#8d8778';
      current = color;
    }
    const x = (field.xs[i] ?? 0) * size.width;
    ctx.fillRect(x, freeY(field.ys[i] ?? 0, x, size.height, size.cutouts), size.dot, size.dot);
  }
}

const SHIMMER_SHARE = 0.05;
const LIT = '#fffdf6';
const SWELL_MS = 2400;
const SWELL_DAYS = 6;

type PaintSize = { width: number; height: number; dot: number; cutouts: readonly Rect[] };

/**
 * The field keeps moving while the presenter talks. About one dot in twenty winks each tick, half
 * lighter and half out, so the brightness holds steady. The newest days swell slowly. No dot is added.
 */
export function shimmer(ctx: CanvasRenderingContext2D, field: Field, size: PaintSize, random: () => number, previous: readonly number[], lastDay: number, now: number): number[] {
  previous.forEach((index) => paintRange(ctx, field, index, index + 1, size));
  const amount = Math.floor(field.size * SHIMMER_SHARE);
  const swell = 0.5 + 0.5 * Math.sin((now / SWELL_MS) * Math.PI * 2);
  const picked = Array.from({ length: amount }, () => Math.floor(random() * field.size));
  const tryNewest = Array.from({ length: amount }, () => Math.floor(random() * field.size)).filter((index) => (field.days[index] ?? 0) >= lastDay - SWELL_DAYS);
  const newest = tryNewest.slice(0, Math.floor(tryNewest.length * swell));
  const draw = (index: number) => {
    const x = (field.xs[index] ?? 0) * size.width;
    ctx.fillRect(x, freeY(field.ys[index] ?? 0, x, size.height, size.cutouts), size.dot, size.dot);
  };
  ctx.fillStyle = LIT;
  picked.filter((_, order) => order % 2 === 0).forEach(draw);
  newest.forEach(draw);
  ctx.fillStyle = NOISE_INK;
  picked.filter((_, order) => order % 2 === 1).forEach(draw);
  return [...picked, ...newest];
}

export const seededRandom = mulberry32;

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
