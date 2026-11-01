// One order, no impact categories: the biggest lever first, by the plan's formula. A lever with no number follows, the huge
// levers before the long tail, by proven gain per hour of work. One that loses money at the assumed volume comes after those,
// since having a formula isn't having a gain. A retired or retiring model is never the headline: last.

export type ProofLabel = 'measured' | 'vendor claim' | 'projected' | 'adoption only';

export interface RankableFinding {
  readonly title: string;
  readonly effect: readonly string[];
  readonly proof: ProofLabel;
  readonly effort: string;
  readonly deadline?: string | null;
  /** A retirement that's only a choice on a list, or that code sends with no date to stop by, comes after everything that does have one. */
  readonly reach?: 'sent' | 'picker' | 'undated';
  /** lever value = (cost today - frontier cost) x frequency - cost of change. Only a priced one ranks by it. */
  readonly value?: { readonly status: string; readonly value_usd?: number };
  readonly tier?: 'huge' | 'long_tail';
}

export const BREAKS_SOON_DAYS = 30;
const PROOF_WEIGHT: Readonly<Record<ProofLabel, number>> = { measured: 1, 'vendor claim': 0.6, projected: 0.4, 'adoption only': 0.25 };
const DEFAULT_HOURS = 16;

/** The brief's effort words as rough hours of work, for ordering only. Never shown as a number. */
export function hoursOf(effort: string): number {
  const word = effort.toLowerCase();
  if (word.startsWith('hours')) return 3;
  if (word.startsWith('a day or more')) return 12;
  if (word.startsWith('a day')) return 8;
  if (word.startsWith('a project')) return 40;
  return DEFAULT_HOURS;
}

function daysUntil(deadline: string, asOf: string): number {
  return (Date.parse(deadline) - Date.parse(asOf)) / 86_400_000;
}

function breaksSoon(finding: RankableFinding, asOf: string): boolean {
  return Boolean(finding.deadline) && daysUntil(finding.deadline as string, asOf) <= BREAKS_SOON_DAYS;
}

/** Effect words say what kind of gain, not how much of it, so they never raise a score. */
function gainPerHour(finding: RankableFinding): number {
  return PROOF_WEIGHT[finding.proof] / hoursOf(finding.effort);
}

function comesLater(finding: RankableFinding): boolean {
  return finding.reach === 'picker' || finding.reach === 'undated';
}

function compareSoon(a: RankableFinding, b: RankableFinding): number {
  if (comesLater(a) !== comesLater(b)) return comesLater(a) ? 1 : -1;
  if (a.deadline === b.deadline) return 0;
  return (a.deadline as string) < (b.deadline as string) ? -1 : 1;
}

/** On equal gain, what covers more comes first, then what has a date. */
function compareTied(a: RankableFinding, b: RankableFinding): number {
  if (a.effect.length !== b.effect.length) return b.effect.length - a.effect.length;
  if (Boolean(a.deadline) !== Boolean(b.deadline)) return a.deadline ? -1 : 1;
  if (a.deadline && b.deadline && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
  return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
}

function priced(finding: RankableFinding): number | null {
  return finding.value?.status === 'priced' && typeof finding.value.value_usd === 'number' ? finding.value.value_usd : null;
}

/** Pays back at the assumed volume, then no number at all, then doesn't pay back. */
function band(value: number | null): number {
  if (value === null) return 1;
  return value > 0 ? 0 : 2;
}

function compare(a: RankableFinding, b: RankableFinding, asOf: string): number {
  if (Boolean(a.reach) !== Boolean(b.reach)) return a.reach ? 1 : -1;
  const [aValue, bValue] = [priced(a), priced(b)];
  const [aBand, bBand] = [band(aValue), band(bValue)];
  if (aBand !== bBand) return aBand - bBand;
  if (aValue !== null && bValue !== null && aValue !== bValue) return bValue - aValue;
  if ((a.tier === 'huge') !== (b.tier === 'huge')) return a.tier === 'huge' ? -1 : 1;
  const aSoon = breaksSoon(a, asOf);
  const bSoon = breaksSoon(b, asOf);
  if (aSoon !== bSoon) return aSoon ? -1 : 1;
  if (aSoon && bSoon) {
    const soon = compareSoon(a, b);
    if (soon !== 0) return soon;
  }
  if (comesLater(a) !== comesLater(b)) return comesLater(a) ? 1 : -1;
  const gain = gainPerHour(b) - gainPerHour(a);
  return gain !== 0 ? gain : compareTied(a, b);
}

export const RANK_EXPLANATION = `Order: the biggest lever first, by (cost today - frontier cost) x assumed calls - cost of change. Then levers with no number, anything breaking within ${BREAKS_SOON_DAYS} days first, then the biggest proven gain per hour of work. A lever that doesn't pay back at that volume comes after those. Retired and retiring models come last.`;

export function rankFindings<T extends RankableFinding>(findings: readonly T[], asOf: string): { findings: (T & { rank: number })[]; explanation: string } {
  const ordered = [...findings].sort((a, b) => compare(a, b, asOf));
  return { findings: ordered.map((finding, index) => ({ ...finding, rank: index + 1 })), explanation: RANK_EXPLANATION };
}
