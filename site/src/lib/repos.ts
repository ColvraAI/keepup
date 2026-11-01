import type { Bundle, Pr, ReplayRepo, Run, WeeklyBrief } from './types';

/** The two products in the demo, in the order the replay lists them. */
export function demoRepos(bundle: Bundle): string[] {
  return bundle.replay.repos.map((repo) => repo.repo);
}

export function runFor(bundle: Bundle, repo: string): Run | null {
  return bundle.runs.find((run) => run.repo === repo && !run.provider_only) ?? null;
}

export function replayFor(bundle: Bundle, repo: string): ReplayRepo | null {
  return bundle.replay.repos.find((item) => item.repo === repo) ?? null;
}

export function prsFor(bundle: Bundle, repo: string): Pr[] {
  return bundle.prs.filter((pr) => pr.upstream === repo);
}

/** The most recent week in the data: the one the Monday screen shows. */
export function latestWeek(briefs: readonly WeeklyBrief[]): string | null {
  return briefs.reduce<string | null>((latest, brief) => (latest === null || brief.week > latest ? brief.week : latest), null);
}

export function isQuietBrief(brief: WeeklyBrief): boolean {
  return !brief.body.includes('\n') && /^Nothing new for this product/.test(brief.body);
}

/** What the patches have behind them, counted, never a constant "tested". */
export function patchesLine(prs: readonly Pr[]): string {
  const recorded = prs.filter((pr) => pr.repo_tests).length;
  return `${prs.length} built patches, ${recorded} with the repo’s tests recorded`;
}

export type PrFacts = { additions: number; deletions: number; files: number };

/** The whole pull request, across its commits. */
export function prFacts(pr: Pr): PrFacts {
  const files = new Set(pr.stages.flatMap((stage) => stage.diff.files.map((file) => file.path)));
  return {
    additions: pr.stages.reduce((sum, stage) => sum + stage.diff.additions, 0),
    deletions: pr.stages.reduce((sum, stage) => sum + stage.diff.deletions, 0),
    files: files.size,
  };
}

export function sourceCount(run: Run): number {
  return Object.keys(run.db.by_source).length;
}

/** The label on a lab, and the only words used for it anywhere. */
export function labLabel(pr: Pr): string {
  if (pr.lab.status === 'measured') return `Measured ${pr.lab.measured_at ?? ''}`.trim();
  if (pr.lab.status === 'partial') return `Part measured · needs ${pr.lab.needs ?? 'more'}`;
  return `Not measured yet · needs ${pr.lab.needs ?? pr.needs ?? 'a run'}`;
}

/** Green only ever means measured. */
export function labTone(pr: Pr): 'pass' | 'partial' | 'none' {
  if (pr.lab.status === 'measured') return 'pass';
  return pr.lab.status === 'partial' ? 'partial' : 'none';
}

/** Whether this pull request answers something the engine really raised: the blue dot stays with those. */
export function isSurvivor(bundle: Bundle, pr: Pr): boolean {
  const base = pr.id.split('-')[0];
  const found = bundle.runs.some((run) => run.repo === pr.upstream && !run.provider_only && run.findings.some((finding) => finding.pr === base));
  const reached = bundle.replay.repos.some((repo) => repo.weeks.some((week) => week.events.some((event) => event.pr === base && event.run)));
  return found || reached;
}
