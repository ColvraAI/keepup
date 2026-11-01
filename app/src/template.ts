// The title and body of a keepup pull request. Numbers come only from lab/<dir>/result.md.
import { basename, join } from 'node:path';
import { measuredProblem, resultNames, tryReadResult, type LabResult } from '../../lab/shared/result.ts';
import { bodyDigest } from './objects.ts';
import type { Claim, PrSpec, Stage, WhereLink } from './specs.ts';
import { TITLE_PLACEHOLDER } from './specs.ts';

export { measuredProblem };

export const CI_TARGET = '.github/workflows/keepup-ci.yml';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class NotMeasuredError extends Error {
  readonly needs: string;
  constructor(message: string, needs: string) {
    super(message);
    this.name = 'NotMeasuredError';
    this.needs = needs;
  }
}

/** problem is why a result that says measured doesn't count; null when it does, or when it doesn't say so. */
export interface LabView {
  lab: string;
  resultFile: string;
  result: LabResult | null;
  problem: string | null;
  /** Set when the result file itself can't be read: something is wrong with it, rather than a lab still to run. */
  unreadable?: string;
}

/** A variant (01-jev from pr-jev.json) has its own numbers, in result-jev.md. It never borrows the main result. */
export function resultFileName(spec: PrSpec): string {
  if (spec.resultFile) return spec.resultFile;
  const variant = spec.id.includes('-') ? spec.id.slice(spec.id.indexOf('-') + 1) : null;
  return variant ? `result-${variant}.md` : 'result.md';
}

export function labOf(spec: PrSpec, root: string): LabView {
  const file = resultFileName(spec);
  const resultFile = join(root, spec.lab, file);
  const { result, problem } = tryReadResult(resultFile);
  if (problem) return { lab: spec.lab, resultFile, result: null, problem: `${spec.lab}/${file} can't be read: ${problem}`, unreadable: problem };
  return { lab: spec.lab, resultFile, result, problem: measuredProblem(join(root, spec.lab), resultNames(basename(spec.lab), spec.id), result, file) };
}

export function formatDate(date: string, withYear = true): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

function neededBy(lab: LabView): string {
  return lab.problem ?? lab.result?.needs ?? 'a lab run';
}

/** The public words. Why a result was disqualified is for a person at a terminal: it can quote the file, typed numbers included. */
const publicNeeds = (lab: LabView): string => lab.result?.needs ?? 'a lab run';

export function isMeasured(lab: LabView): boolean {
  return lab.result?.status === 'measured' && !lab.problem;
}

export function hasPlaceholder(stage: Stage): boolean {
  return stage.title.includes(TITLE_PLACEHOLDER);
}

export function renderTitle(stage: Stage, lab: LabView, opts: { allowUnmeasured?: boolean } = {}): string {
  if (!hasPlaceholder(stage)) return stage.title;
  if (!isMeasured(lab)) {
    if (opts.allowUnmeasured && stage.titleUnmeasured) return stage.titleUnmeasured;
    throw new NotMeasuredError(`The title needs a number from ${lab.lab}, and the lab isn't measured: it needs ${neededBy(lab)}. Run: npm run lab, then try again.`, neededBy(lab));
  }
  const number = lab.result?.title_number;
  if (!number) throw new NotMeasuredError(`${lab.lab} is measured but has no title_number, and the title needs one.`, 'title_number in result.md');
  return stage.title.split(TITLE_PLACEHOLDER).join(number);
}

function whereLink(org: string, spec: PrSpec, w: WhereLink): string {
  const url = `https://github.com/${org}/${spec.fork}/blob/${spec.baseCommit}/${w.path}`;
  return w.line ? `[${w.path}:${w.line}](${url}#L${w.line})` : `[${w.path}](${url})`;
}

/** One stage is a plain line. Several become a dated list, so nothing an earlier stage said is lost. */
function perStage(label: string, applied: Stage[], pick: (s: Stage) => string): string {
  if (applied.length === 1) return `**${label}:** ${pick(applied[0])}`;
  return `**${label}:**\n\n${applied.map((s) => `- ${formatDate(s.date)}: ${pick(s)}`).join('\n')}`;
}

function claim(c: Claim | null): string {
  return c ? `${c.claim}, ${c.url}` : 'none';
}

function ciFooter(spec: PrSpec, extra: number): string {
  const count = extra === 1 ? 'one extra commit' : `${extra} extra commits`;
  const verbs = extra === 1 ? ['adds', 'removes'] : ['add', 'remove'];
  return `The base branch has ${count} on top of ${spec.baseCommit} that ${verbs[0]} ${spec.ciWorkflow} as ${CI_TARGET} and ${verbs[1]} this repo's other workflow files, because this repo's own CI can't run on a fork and those workflows need upstream's secrets. Upstream's workflow files are gone from the fork's default branch too, in one commit there, because GitHub always runs pull_request_target workflows from the default branch.`;
}

function footer(spec: PrSpec, opened: string, measured: boolean, extra: number): string {
  if (spec.live) return `keepup wrote this change on ${formatDate(opened)} against ${spec.baseCommit}, on a fork. A person merges.`;
  const real = measured ? 'real code, real numbers, simulated time and place' : 'real code, no lab result yet, simulated time and place';
  const base = `This is the keepup demo, a replay on a fork: ${real}. keepup would have opened it on ${formatDate(opened)} against ${spec.baseCommit}; a person merges.`;
  return spec.ciWorkflow ? `${base} ${ciFooter(spec, extra)}` : base;
}

export interface BodyOptions {
  org: string;
  applied: Stage[];
  lab: LabView;
  allowUnmeasured?: boolean;
  /** How many commits the base branch has on top of the base commit. One unless a person's branch predates the current CI commit. */
  baseExtraCommits?: number;
}

function measuredSection(spec: PrSpec, opts: BodyOptions): string {
  if (spec.live) return "**Tests:** keepup did not run the repo's tests, because nothing from a repo runs on its machine. They run in CI on this pull request.";
  if (isMeasured(opts.lab)) return `**Measured on this fork:**\n\n${opts.lab.result?.body ?? ''}`;
  if (!opts.allowUnmeasured) {
    throw new NotMeasuredError(`${opts.lab.lab} isn't measured: it needs ${neededBy(opts.lab)}. Run the lab, or pass --allow-unmeasured to say so in the pull request.`, neededBy(opts.lab));
  }
  return `**Measured on this fork:** Not measured yet: needs ${publicNeeds(opts.lab)}`;
}

export function renderBody(spec: PrSpec, opts: BodyOptions): string {
  const opened = opts.applied[0].date;
  const proofLead = isMeasured(opts.lab) ? 'measured on this fork' : 'no lab result yet';
  const updates = opts.applied.flatMap((s) => (s.comment ? [s.comment] : []));
  const sections = [
    `keepup · ${formatDate(opened)} · ${spec.source}`,
    `**Where:** ${spec.where.map((w) => whereLink(opts.org, spec, w)).join(' · ')}`,
    perStage('What shipped', opts.applied, (s) => s.whatShipped),
    `**Why it fits your product:** ${spec.whyItFits}`,
    perStage('What this changes', opts.applied, (s) => s.whatThisChanges),
    measuredSection(spec, opts),
    `**Proof:** ${proofLead} · vendor: ${claim(spec.proof.vendor)} · independent: ${claim(spec.proof.independent)}`,
    `**Risks:** ${spec.risks}`,
    `**Rollback:** ${spec.rollback}`,
    `**Sources:** ${spec.sources.join(' · ')}`,
    ...updates,
    '---',
    footer(spec, opened, isMeasured(opts.lab), opts.baseExtraCommits ?? 1),
  ];
  return sections.join('\n\n');
}

/** Whether a record's words are what these stages and this lab result give now. False when they differ, or the record predates the digest. */
export function wordsCurrent(spec: PrSpec, record: { title: string; bodyDigest?: string; stagesApplied: string[]; baseExtraCommits?: number }, lab: LabView, org: string, allowUnmeasured?: boolean): boolean {
  const applied = spec.stages.filter((s) => record.stagesApplied.includes(s.date));
  if (applied.length === 0) return false;
  try {
    const title = renderTitle(applied[applied.length - 1], lab, { allowUnmeasured });
    const body = renderBody(spec, { org, applied, lab, allowUnmeasured, baseExtraCommits: record.baseExtraCommits });
    return title === record.title && record.bodyDigest === bodyDigest(body);
  } catch (e) {
    if (e instanceof NotMeasuredError) return true;
    throw e;
  }
}
