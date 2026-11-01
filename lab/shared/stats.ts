// Small, exact statistics for the lab tables. No rounding happens here: callers
// round when they print, so the raw numbers stay comparable.

export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Nearest-rank percentile, the plain definition: p in (0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) throw new Error('percentile of an empty list');
  if (p <= 0 || p > 100) throw new Error(`percentile out of range: ${p}`);
  const s = sorted(values);
  return s[Math.ceil((p / 100) * s.length) - 1];
}

/** The true median: the mean of the two middle values on an even count. */
export function median(values: readonly number[]): number {
  if (!values.length) throw new Error('median of an empty list');
  const s = sorted(values);
  const mid = s.length / 2;
  return Number.isInteger(mid) ? (s[mid - 1] + s[mid]) / 2 : s[Math.floor(mid)];
}

export function mean(values: readonly number[]): number {
  if (!values.length) throw new Error('mean of an empty list');
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Share of predictions that equal their label. */
export function accuracy(pairs: readonly { predicted: string | null; expected: string | null }[]): number {
  if (!pairs.length) throw new Error('accuracy of an empty list');
  return pairs.filter((p) => p.predicted === p.expected).length / pairs.length;
}
