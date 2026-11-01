// How a recorded run reads on screen: its steps' counts say what they count, and a replayed model
// step never shows a replay's milliseconds as if a model had answered that fast.
import type { Pr, Run, RunFinding } from './types';

const MODEL_STEP = /^(Understand the product|Search the database|Judge each candidate)/;
const SEARCH_COUNT = /^(\d[\d,]*) candidates$/;
const HELD = /(\d[\d,]*) held back/;

const toNumber = (text: string | undefined): number => Number((text ?? '').replaceAll(',', '')) || 0;

export const replayedOnly = (run: Run): boolean => Boolean(run.usage && run.usage.calls === 0 && run.usage.replayed_calls > 0);

export const firstRunCost = (run: Run): number => (run.usage ? run.usage.usd + run.usage.replayed_usd : 0);

export function searchCandidates(run: Run): number {
  const step = run.steps.find((item) => item.name === 'Search the database');
  return toNumber(SEARCH_COUNT.exec(step?.detail ?? '')?.[1]);
}

export function judgeHeldBack(run: Run): number {
  const step = run.steps.find((item) => item.name.startsWith('Judge each candidate'));
  return toNumber(HELD.exec(step?.detail ?? '')?.[1]);
}

export function stepDetail(step: Run['steps'][number]): string {
  if (step.name === 'Search the database') return step.detail.replace(SEARCH_COUNT, '$1 from search');
  if (step.name.startsWith('Judge each candidate')) return `${step.detail}, before the checks`;
  return step.detail.replace(/\b1 findings\b/, '1 finding');
}

export type StepTime = { kind: 'ms'; ms: number } | { kind: 'replayed' };

export function stepTime(step: Run['steps'][number], run: Run): StepTime {
  return replayedOnly(run) && MODEL_STEP.test(step.name) ? { kind: 'replayed' } : { kind: 'ms', ms: step.ms };
}

export function candidateSplit(run: Run): { total: number; search: number; checks: number } {
  const search = searchCandidates(run);
  return { total: run.candidates_considered, search, checks: run.candidates_considered - search };
}

/** Only what data/finding-prs.json names. A shared file isn't a fix: the Gemini default shares one with PR 07. */
export function prForFinding(finding: RunFinding, prs: readonly Pr[]): Pr | null {
  return prs.find((pr) => pr.id === finding.pr) ?? null;
}

export type RankedFinding = { finding: RunFinding; pr: Pr | null };

/** What already has a pull request comes first: the list says what happens next. */
export function rankedFindings(run: Run, prs: readonly Pr[]): RankedFinding[] {
  const mine = prs.filter((pr) => pr.upstream === run.repo);
  const rows = run.findings.map((finding) => ({ finding, pr: prForFinding(finding, mine) }));
  return [...rows.filter((row) => row.pr), ...rows.filter((row) => !row.pr)];
}

const NAMED_THING = /^(?!\d)(?!.*\ba (?:retired|retiring|deprecated) model\b)/;

/** The refusals a founder would have expected to see built: real things with a reason, not model-list rows. */
export function namedRefusals(run: Run, wanted: number): Run['held_back'] {
  const named = run.held_back.filter((row) => NAMED_THING.test(row.thing) && row.reason.length < 170);
  const fromTheJudge = named.filter((row) => /new|model|adapter|\d\.\d/i.test(row.thing));
  return (fromTheJudge.length >= wanted ? fromTheJudge : named).slice(0, wanted);
}

/** How many findings rest on a provider's deprecation page, which isn't among the records searched. */
export function fromDeprecationPages(run: Run): number {
  return run.findings.filter((finding) => (finding.sources ?? []).some((source) => /deprecations/.test(source))).length;
}
