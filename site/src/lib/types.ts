/** The shapes this site reads from site/data. scripts/build-site-data.ts writes them. */

export type PulseItem = {
  key: string;
  source: string;
  source_label: string;
  kind: string;
  name: string;
  description?: string | null;
  date: string;
  url: string;
};

export type Pulse = {
  window: { from: string; to: string; fetched: string };
  total: number;
  in_window: number;
  by_source: { id: string; label: string; count: number; in_window: number }[];
  by_day: { days: string[]; by_source: Record<string, number[]>; totals: number[] };
  registry_publishers: { threshold: number; publishers: number; records: number };
  feed: PulseItem[];
};

export type Location = { path: string; line: number | null; url: string | null };

export type TeamPoint = {
  relation: 'later' | 'ahead' | 'unchanged' | 'same_day' | string;
  date: string | null;
  commit: string | null;
  commit_url: string | null;
  days_after: number | null;
  note: string | null;
};

export type ReplayEvent = {
  date: string;
  thing: string;
  kind: string;
  source_url: string | null;
  action: string;
  pr: string | null;
  summary: string | null;
  where: string | null;
  locations: Location[];
  base_commit: string | null;
  base_url: string | null;
  run: string | null;
  team: TeamPoint | null;
};

export type ReplaySummary = {
  events: number;
  prs_opened: number;
  prs_updated: number;
  held_back: number;
  watching: number;
  brief_only: number;
  findings: number;
  team_notes: number;
  team_later: number;
  team_later_on_prs: number;
  team_later_engine: number;
  team_later_engine_on_prs: number;
  team_ahead: number;
  team_unchanged: number;
  team_points: { date: string; thing: string; action: string; team_date: string; commit: string; days_after: number }[];
  median_days_later: number | null;
};

export type HeadlineParts = { big: string; second: string | null; short: string | null; engine: string | null; commit: string | null; ahead: string | null };

export type ReplayWeek = { monday: string; start: string; end: string; events: ReplayEvent[] };

export type ReplayRepo = {
  repo: string;
  fork: string;
  pinned_commit: string;
  pinned_url: string;
  summary: ReplaySummary;
  headline_parts: HeadlineParts;
  weeks: ReplayWeek[];
};

export type Replay = {
  window: { from: string; to: string; fetched: string };
  headline: string;
  repos: ReplayRepo[];
};

export type DiffHunk = { header: string; lines: string[] };
export type DiffFile = {
  path: string;
  old_path: string;
  status: string;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};
export type StageDiff = { files: DiffFile[]; additions: number; deletions: number; patches: { path: string; subject: string }[] };

export type PrStage = {
  date: string;
  title: string;
  title_state: string;
  what_shipped: string;
  what_changes: string;
  comment: string | null;
  applied_on_github: boolean;
  diff: StageDiff;
};

export type LabTable = { headers: string[]; rows: string[][]; notes: string };

export type Pr = {
  id: string;
  title: string;
  title_state: string;
  needs: string | null;
  status: string;
  status_label: string;
  github: { url: string; number?: number; state?: string; author?: string; ci?: { state: string; url?: string } } | null;
  upstream: string;
  fork: string;
  branch: string;
  base_branch: string;
  base_commit: string;
  base_commit_url: string;
  spec: string;
  source: string;
  source_url: string;
  where: Location[];
  founder_line: string;
  effect: string[];
  effort: string;
  why_it_fits: string;
  risks: string;
  rollback: string;
  proof: {
    measured_on_fork: boolean;
    vendor: { claim: string; url: string } | null;
    independent: { claim: string; url: string } | null;
  };
  sources: string[];
  lab: {
    dir: string;
    status: 'measured' | 'partial' | 'not_run' | string;
    measured_at: string | null;
    title_number: string | null;
    needs: string | null;
    table: LabTable;
    note: string | null;
  };
  repo_tests: { file: string; summary: string } | null;
  stages: PrStage[];
};

export type RunWhere = { file: string; line: number; text?: string; permalink?: string };

export type RunFinding = {
  rank: number;
  title: string;
  effect: string[];
  proof: string;
  effort: string;
  where: RunWhere[];
  why: string;
  sources: string[];
  deadline: string | null;
  pr: string | null;
  reach?: string;
  lever?: string;
  value?: unknown;
  tier?: string;
};

export type RunJob = { job: string; how: string; where: RunWhere[] };

export type Run = {
  file: string;
  name: string;
  repo: string;
  commit: string;
  commit_date: string;
  scanned_at: string;
  as_of: string;
  provider_only: string | null;
  db: { fetched: string; records: number; by_source: Record<string, number> };
  ran: { search: boolean; judge: boolean; online: boolean } | null;
  steps: { name: string; detail: string; ms: number }[];
  profile: { one_liner: string; stack: string[]; jobs: RunJob[]; stack_lock: string[] } | null;
  candidates_considered: number;
  findings: RunFinding[];
  recommendations: { name: string; kind: string; why: string; install: string; source: string }[];
  measurements: unknown[];
  exact: { kind: string; status?: string; live_places?: unknown[] }[];
  dropped_levers: { lever: string; where?: string }[];
  incomplete?: { reason: string; skipped?: string[] };
  watching: { thing: string; why: string; source: string | null }[];
  held_back: { thing: string; date: string | null; reason: string; source: string | null }[];
  checks_passed: number;
  checks_dropped: number;
  usage: { model: string; usd: number; replayed_usd: number; calls: number; replayed_calls: number; max_usd: number; price_source: string } | null;
  manifests: { file: string; kind: string; dependencies: number; permalink: string | null }[];
  languages: { language: string; files: number; lines: number; share: number }[];
  files_checked: number;
  lines_checked: number;
  ai_call_sites: { signal: string; file: string; line: number; text: string; permalink: string }[];
  ai_call_sites_total: number;
  pattern_hits: { pattern: string; file: string; line: number; text: string; permalink: string }[];
  pattern_hits_total: number;
  model_ids_total: number;
  retired_models_total: number;
};

export type WeeklyBrief = { repo: string; week: string; title: string; body: string; issue: { number?: number; url: string } | null };

export type MoonshotPrice = {
  model_id: string;
  name: string;
  price_in_per_m: number;
  price_out_per_m: number;
  released: string;
  fetched: string;
  url: string;
  source: string;
};

export type Moonshot = {
  label: string;
  prices: MoonshotPrice[];
  router_fallback: { model: string; where: string; url: string; price: number | null; note: string };
  cache: { provider: string; date: string; models: string[]; multiplier: number; printed: boolean; quote: string; url: string }[];
  fleet: {
    repo: string;
    pinned_commit: string;
    prs_opened: number;
    prs_updated: number;
    held_back: number;
    watching: number;
    brief_only: number;
    findings: number;
    team_later: number;
    median_days_later: number | null;
    runs: number;
  }[];
};

export type AppManifest = {
  app: { name: string | null; permissions: Record<string, string>; registered: boolean; url: string | null; bot: string | null };
  github: { exists: boolean; org: string | null; forks: Record<string, string>; pull_requests: number; issues: number };
  database_fetched: string;
  built_at: string;
};

export type CheckLine = { repo: string; name: string; commit: string; as_of: string; command: string; line: string; recorded_at: string };

export type ReplayCheck = {
  file: string;
  repo: string;
  commit: string;
  as_of: string;
  usd: number;
  findings: { rank: number; title: string; deadline: string | null }[];
};

export type NoteSection = { time: string; title: string; lines: string[] };

export type ModelPrice = { model: string; input: number; output: number; source: string; date?: string };

export type Bundle = {
  modelPrices: ModelPrice[];
  pulse: Pulse;
  replay: Replay;
  prs: Pr[];
  runs: Run[];
  weekly: WeeklyBrief[];
  moonshot: Moonshot;
  manifest: AppManifest;
  checks: CheckLine[];
  replayChecks: ReplayCheck[];
  notes: NoteSection[];
  requestedAppName: string | null;
};
