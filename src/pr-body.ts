// The words on a pull request keepup opens, from the plugin or the GitHub Action: the proof and ROI the brief printed, typed by no one. Pure.
import { roiSection } from './brief.ts';
import type { Finding } from './run-shape.ts';
import { oneLine, plainText } from './text-safety.ts';

const TESTS_NOT_RUN = "keepup did not run this repo's tests: it reads a repo as text and never runs it. Run them, or let CI run them, before you merge.";
const FOOTER = 'keepup wrote this change, and a person merges. A change can pass every check and still break an app, so read the diff and try it.';
const KEY_LENGTH = 60;

export interface PrBodyInput {
  readonly finding: Finding;
  /** owner/name, for links to the lines. */
  readonly repo?: string;
  readonly commit?: string | null;
  readonly summary?: string;
  readonly files?: readonly string[];
  /** The real test result, in words. Left out, the body says the tests didn't run. */
  readonly tests?: string;
}

/** What a later run looks for, so a lever a person already answered isn't opened again. Safe inside a comment, whatever the title says. */
export function findingKey(finding: Pick<Finding, 'lever' | 'title'>): string {
  return finding.lever ?? finding.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, KEY_LENGTH);
}

export const markerFor = (key: string): string => `<!-- keepup:finding=${key} -->`;

function placeText(input: PrBodyInput, place: Finding['where'][number]): string {
  const shown = `${oneLine(place.file)}:${place.line}`;
  return input.repo && input.commit ? `[${shown}](https://github.com/${input.repo}/blob/${input.commit}/${place.file}#L${place.line})` : shown;
}

/** A fence longer than any run of backticks in the text, so a brief can't close it. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(longest + 1);
}

/** The weekly issue: the brief word for word, and how to get the rest. */
export function renderIssueBody(brief: string): string {
  const fence = fenceFor(brief);
  return [
    'keepup checks this repo each week and updates this issue. It opens one draft pull request for the top lever, and a person merges.', '',
    fence, brief.trim(), fence, '',
    'For a pull request on another finding, run `/keepup:apply <number>` in Claude Code.',
  ].join('\n');
}

export function renderPrBody(input: PrBodyInput): string {
  const { finding } = input;
  const changes = input.summary ? [`**What this changes:** ${plainText(input.summary)}${input.files?.length ? ` Files: ${input.files.map(oneLine).join(', ')}.` : ''}`, ''] : [];
  return [
    `**Why it fits your product:** ${plainText(finding.why)}`, '',
    `**Where:** ${finding.where.map((place) => placeText(input, place)).join(' · ')}`, '',
    ...changes,
    ...roiSection(finding.value),
    `**Proof:** ${plainText(finding.proof)} · ${finding.sources.map(oneLine).join(' · ')}`, '',
    `**Tests:** ${input.tests ? plainText(input.tests) : TESTS_NOT_RUN}`, '',
    '**Rollback:** revert this one commit.', '',
    '---', '',
    FOOTER, '',
    markerFor(findingKey(finding)),
  ].join('\n');
}
