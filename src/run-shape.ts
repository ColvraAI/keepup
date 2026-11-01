// The run: data/runs/<name>.json, which the dashboard reads. docs/contracts.md section 5 is its contract.
// "version" stays 1 and fields are only ever added.
import type { Hit } from './scan.ts';
import type { DbInfo } from './db.ts';
import type { DependencyCheck, ModelCheck } from './exact-checks.ts';
import type { Facts, Step } from './facts.ts';
import type { ProofLabel } from './rank.ts';

export const EFFECT_WORDS = ['cheaper', 'faster', 'better answers', 'keeps working', 'new capability'] as const;
export const PROOF_LABELS: readonly ProofLabel[] = ['measured', 'vendor claim', 'projected', 'adoption only'];

export interface Place {
  readonly file: string;
  readonly line: number;
}

export interface Where extends Place {
  readonly text: string;
}

export interface Job {
  readonly job: string;
  readonly how: string;
  readonly where: readonly Place[];
  /** Keywords the candidate search used for this job. */
  readonly search_terms?: readonly string[];
  /** Each place with the quote that was checked against that line. */
  readonly cited?: readonly Where[];
}

export interface Profile {
  readonly one_liner: string;
  readonly stack: readonly string[];
  readonly jobs: readonly Job[];
  readonly stack_lock: readonly string[];
}

export interface FindingOption {
  readonly name: string;
  readonly what: string;
  readonly needs: string;
  readonly source: string;
}

export interface Finding {
  readonly rank?: number;
  readonly title: string;
  readonly effect: readonly string[];
  readonly proof: ProofLabel;
  readonly effort: string;
  readonly where: readonly Where[];
  readonly why: string;
  readonly options: readonly FindingOption[];
  readonly sources: readonly string[];
  readonly lever: string | null;
  readonly pr: string | null;
  /** When it breaks, for ranking: an ISO date, past or future. */
  readonly deadline?: string | null;
  /** The source sentences this finding's numbers and dates were read from. */
  readonly evidence?: readonly string[];
  /** The stated rule that keeps this finding whatever a judge says. A judge can add a note, never drop it. */
  readonly locked?: string;
  /** For a retirement: sent by code or a config someone copies, only a choice on a list, or sent with no date to stop by. Ranking reads this. */
  readonly reach?: 'sent' | 'picker' | 'undated';
  /** The successor breaks on this setting, the repo's text never mentions it, and these SDKs write the request: not ruled out, and not verified. */
  readonly sdk_unverified?: { readonly identifier: string; readonly sdks: readonly string[] };
  readonly value?: LeverValue;
}

export interface LabelledInput {
  readonly value: number | string;
  readonly label: string;
}

/** One option's sum, with its price's source and date. */
export interface RoiOption {
  readonly name: string;
  readonly lever: string;
  readonly kind: 'substitute' | 'cache' | 'batch';
  readonly price_text: string;
  readonly input_per_m?: number;
  readonly cache_minimum?: number;
  readonly source: string;
  readonly checked?: string;
  readonly today_per_call_usd?: number;
  readonly after_per_call_usd?: number;
  readonly monthly_usd?: number;
  readonly payback_months?: number | null;
  readonly worth_above_calls?: number | null;
  /** "Saves about $X a month at 10,000 calls · a day's work · pays back in N months [projected]". Absent when there's no model to price. */
  readonly line?: string;
}

/** The founder's question for a lever: what it saves, what it costs, when it pays back. Or, plainly, that it has no money figure. */
export interface LeverRoi {
  readonly money: boolean;
  readonly effort: string;
  /** With no money effect: its effect and effort, and that there's no figure. */
  readonly statement?: string;
  readonly formula?: string;
  /** read: the code names the model. default: the repo's default or fallback. example: a named common model, because nothing in the code does. */
  readonly basis?: 'read' | 'default' | 'example' | 'none';
  readonly model?: { readonly id: string; readonly input: number; readonly output: number; readonly source: string; readonly date?: string; readonly label: string };
  readonly tokens: { readonly input: number; readonly input_label: string; readonly output: number; readonly output_label: string };
  readonly calls_per_month: number;
  readonly change_usd: number;
  readonly change_label: string;
  readonly options: readonly RoiOption[];
  readonly assumed?: string;
  readonly what_to_enter?: string;
}

/** lever value = (cost today - frontier cost) x frequency - cost of change, its inputs printed. A number is projected or absent here; only a measurement is measured. "worked" has a sum on stated assumptions, which never ranks. */
export interface LeverValue {
  readonly status: 'priced' | 'no_number' | 'worked';
  readonly roi?: LeverRoi;
  readonly lever: string;
  readonly label: 'projected' | 'absent';
  readonly formula: string;
  readonly inputs: {
    readonly calls_per_month: LabelledInput;
    readonly hourly_usd: LabelledInput;
    readonly months: LabelledInput;
    readonly change_hours: LabelledInput;
    readonly input_tokens?: LabelledInput;
    readonly output_tokens?: LabelledInput;
    readonly model?: LabelledInput;
  };
  readonly today_per_call_usd?: number;
  readonly frontier_per_call_usd?: number;
  readonly change_cost_usd?: number;
  readonly monthly_gain_usd?: number;
  readonly value_usd?: number;
  readonly break_even_calls_per_month?: number;
  readonly reason?: string;
  readonly speed?: { readonly text: string; readonly label: 'vendor claim' };
  /** The lever's own words for its gain, as the database records them, labelled there. */
  readonly lever_gain?: string;
  /** There's a before-and-after this lever's change can be tested with. */
  readonly measurable?: boolean;
}

export interface Recommendation {
  readonly name: string;
  readonly kind: 'mcp-server' | 'skill' | 'plugin' | 'tool';
  readonly why: string;
  readonly install: string;
  readonly source: string;
}

export interface MeasurementRow {
  readonly recipe: string;
  readonly status: 'measured' | 'not measured' | 'refused';
  readonly needs?: string;
  readonly reason?: string;
  readonly n?: number;
  readonly summary?: string;
  /** The title's number, only when it was measured: such as "-34% input cost". */
  readonly headline?: string;
  /** Which rules it was measured under: only today's reach a title. */
  readonly rules?: number;
  readonly cannot_prove?: string;
  readonly raw?: unknown;
}

export interface Measurement {
  readonly version: 1;
  readonly id: string;
  readonly finding_rank: number;
  readonly lever: string | null;
  readonly commit: string;
  readonly at: string;
  readonly prompt: { readonly file: string; readonly line: number; readonly chars: number; readonly placeholders: readonly string[] } | null;
  readonly disclosure: string;
  readonly rows: readonly MeasurementRow[];
  readonly usd: number;
  readonly cap_usd: number;
  readonly refused?: string;
}

export interface Move {
  readonly from: string;
  readonly to: readonly string[];
  readonly places: readonly string[];
}

export interface Watching {
  readonly thing: string;
  readonly why: string;
  readonly source: string;
}

export interface HeldBack {
  readonly thing: string;
  readonly date: string | null;
  readonly reason: string;
  readonly source: string | null;
}

export interface Dropped {
  readonly what: string;
  readonly why: string;
  /** The first place in the code, when there was one. A brief prints this and the category, never the raw text. */
  readonly where?: string;
  /** The lever's own name from the database, when a check dropped a lever. Safe to print, unlike what a model wrote. */
  readonly lever?: string;
}

export interface CheckSummary {
  readonly passed: number;
  readonly dropped: readonly Dropped[];
}

export interface Usage {
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly usd: number;
  readonly price_source: string;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly calls?: number;
  /** Answers replayed from tmp/llm-cache, which cost nothing this time, and what they first cost. */
  readonly replayed_calls?: number;
  readonly replayed_usd?: number;
  readonly max_usd?: number;
}

export type ExactResult = ModelCheck | DependencyCheck;

/** Which steps really ran, so a run never claims more than it did. */
export interface Coverage {
  readonly search: boolean;
  readonly judge: boolean;
  readonly online: boolean;
}

export interface Run {
  readonly version: 1;
  readonly repo: string;
  readonly commit: string | null;
  /** HEAD, when `commit` is null because the working tree holds uncommitted changes. */
  readonly base_commit?: string;
  readonly ran?: Coverage;
  readonly commit_date: string | null;
  readonly scanned_at: string;
  readonly as_of: string;
  readonly db: DbInfo;
  readonly steps: readonly Step[];
  readonly facts: Facts;
  readonly pattern_hits: readonly Hit[];
  readonly exact: readonly ExactResult[];
  readonly profile: Profile | null;
  readonly candidates_considered: number;
  readonly findings: readonly Finding[];
  readonly watching: readonly Watching[];
  readonly held_back: readonly HeldBack[];
  readonly checks: CheckSummary;
  readonly rank_explanation: string;
  readonly usage: Usage | null;
  /** Present when a run stopped early, at the dollar cap or on a refusal: it holds what it had. */
  readonly incomplete?: { readonly reason: string; readonly skipped: readonly string[] };
  /** What the candidate search matched and cut, per job. */
  readonly candidate_log?: unknown;
  /** --provider-only: this product uses only this provider, so no other provider's API is suggested. */
  readonly provider_only?: string;
  /** Where each retired or retiring id in the repo moves to, by id, so a brief can say that and not a lever's general title. */
  readonly moves?: readonly Move[];
  /** "For your team": skills, plugins and MCP servers that fit this repo's stack. Never a pull request. */
  readonly recommendations?: readonly Recommendation[];
  /** Real before-and-after runs from `keepup measure`, newest last. */
  readonly measurements?: readonly Measurement[];
}
