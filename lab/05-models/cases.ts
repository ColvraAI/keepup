// The runs this lab makes and the configs they use. The files come from the fork; the
// only rewrites are the ones spelled out here, and each row of the table says which.

export const MINIMAL_PATH = 'examples/minimal/anthropic.toml';
export const REASONING_PATH = 'examples/complete/reasoning-models.toml';
export const RETIRED_MODEL = 'claude-sonnet-4-20250514';
export const TARGET_MODEL = 'claude-sonnet-5-5';
export const WORKER_NAME = 'deep-analysis';
/** The base commit's own code: it adds only CI, docs and tests to this release, and a test holds that. */
export const LAB_RELEASE_TAG = 'v0.2.12';
export const ANTHROPIC_KEY = 'ANTHROPIC_API_KEY';
export const OPENAI_KEY = 'OPENAI_API_KEY';

export const MINIMAL_PROMPT = 'Name the capital of France in one word.';
export const REASONING_PROMPT = 'A nightly batch job became far slower the week we started keeping more history in a table it scans in full. Weigh two options, adding an index or partitioning by date, and recommend one in three sentences. This needs careful multi-step reasoning, so assign it to the deep-analysis worker.';

export type CaseId = 'before-minimal' | 'after-minimal' | 'after-reasoning-shipped' | 'probe-display-summarized' | 'probe-empty-thinking';

export interface LabCase {
  id: CaseId;
  label: string;
  file: string;
  /** The keys its config names. A case runs only with all of them: no config is rewritten to get around one. */
  keys: readonly string[];
  column: 'before' | 'after';
  from: 'base' | 'patched';
  model: string;
  expect: 'answer' | 'error';
  /** What an expected error has to say to count: any other error didn't prove what this row claims. */
  errorProof: readonly RegExp[];
  orchestrated: boolean;
  /** Every token is Claude's, so one price covers the row. */
  priced: boolean;
  prompt: string;
  summarizedDisplay: boolean;
}

const code = (path: string): string => `\`${path}\``;

const RETIRED_PROOF: readonly RegExp[] = [/\b404\b/, /\bnot_found_error\b/];

const BEFORE_MINIMAL: LabCase = { id: 'before-minimal', label: code(MINIMAL_PATH), file: MINIMAL_PATH, keys: [ANTHROPIC_KEY], column: 'before', from: 'base', model: RETIRED_MODEL, expect: 'error', errorProof: RETIRED_PROOF, orchestrated: false, priced: true, prompt: MINIMAL_PROMPT, summarizedDisplay: false };
const AFTER_MINIMAL: LabCase = { ...BEFORE_MINIMAL, id: 'after-minimal', column: 'after', from: 'patched', model: TARGET_MODEL, expect: 'answer', errorProof: [] };
const AFTER_SHIPPED: LabCase = {
  id: 'after-reasoning-shipped',
  label: `${code(REASONING_PATH)}, as shipped: OpenAI coordinator, Claude worker`,
  file: REASONING_PATH,
  keys: [ANTHROPIC_KEY, OPENAI_KEY],
  column: 'after',
  from: 'patched',
  model: TARGET_MODEL,
  expect: 'answer',
  errorProof: [],
  orchestrated: true,
  priced: false,
  prompt: REASONING_PROMPT,
  summarizedDisplay: false,
};
/**
 * Dry run only: the pull request says not to set display = "summarized" on a worker that
 * calls tools yet, because rig sends the summary back doubled. This keeps that claim
 * checked: it expects the changed thinking block to fail, and says so once it stops.
 */
const PROBE_DISPLAY: LabCase = {
  ...AFTER_SHIPPED,
  id: 'probe-display-summarized',
  label: `${code(REASONING_PATH)} with display = "summarized", a dry-run probe`,
  expect: 'error',
  summarizedDisplay: true,
};

/**
 * Dry run only: the pull request says rig drops the empty thinking block on a worker that
 * calls tools. The fake can't say what the real API does about that, but it does hand out
 * a thinking block, so this keeps the claim itself checked.
 */
const PROBE_EMPTY_THINKING: LabCase = {
  ...AFTER_SHIPPED,
  id: 'probe-empty-thinking',
  label: `${code(REASONING_PATH)}, a dry-run probe`,
};

export function selectCases(opts: { dryRun: boolean }): readonly LabCase[] {
  const real = [BEFORE_MINIMAL, AFTER_MINIMAL, AFTER_SHIPPED];
  return opts.dryRun ? [...real, PROBE_DISPLAY, PROBE_EMPTY_THINKING] : real;
}

export function requestFor(labCase: LabCase): string {
  return JSON.stringify({ messages: [{ role: 'user', content: labCase.prompt }], stream: false });
}

/** Dry run only: points each provider block at the fake. AURA's config has a base_url for this. */
export function withBaseUrls(toml: string, apiBase: string): string {
  return toml
    .replace(/^provider = "anthropic"$/gm, `provider = "anthropic"\nbase_url = "${apiBase}"`)
    .replace(/^provider = "openai"$/gm, `provider = "openai"\nbase_url = "${apiBase}/v1"`);
}

export function withSummarizedDisplay(toml: string): string {
  if (!/^type = "adaptive"$/m.test(toml)) throw new Error('no adaptive thinking block to change');
  return toml.replace(/^type = "adaptive"$/m, 'type = "adaptive"\ndisplay = "summarized"');
}
