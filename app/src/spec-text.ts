// What a spec's words may say in public. Everything here ends up on a public fork, in a commit, a pull request or an issue.
// A reference to someone else's issue or pull request shows up on their timeline, and there's no taking it back.

const AMOUNT = '\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?';
const MONEY = `(?:[$€£]\\s?${AMOUNT}|${AMOUNT}\\s*(?:USD|EUR|GBP|dollars?|cents?)(?![A-Za-z0-9]))`;
const UNIT = '(?:x|×|%|ms|s|h|k|secs?|seconds?|milliseconds?|mins?|minutes?|hours?|hrs?|days?|weeks?|times|percent|per\\s+cent|pct|fold|KB|MB|GB|TB|tokens?|req(?:uests?)?/s(?:ec)?)';
const WITH_UNIT = `[-+−]?\\d[\\d,]*(?:\\.\\d+)?\\s*-?\\s*${UNIT}(?![A-Za-z0-9])`;
/** x6 and ×6, but not the names of machines. */
const MULTIPLIER = '[x×]\\s?(?!(?:32|64|86)(?![\\w.]))\\d+(?:\\.\\d+)?(?![\\w.])';
const RATIO = '\\d+\\s+(?:out\\s+)?of\\s+\\d+';
/** 3/3, but not the pieces of a path or a link. */
const SLASH_RATIO = '(?<![/])\\d+/\\d+(?![\\w./-])';
const WORD_MULTIPLE = '(?:twice|thrice|half)\\s+as\\s+[a-z]+';
/** 1,050,000 of anything. A number with thousands in it isn't a name or a version. */
const LARGE_COUNT = '\\d{1,3}(?:,\\d{3})+(?![\\w,.]*\\d)';

/** A number that reads as a result, or as a fact someone has to stand behind. Model names, versions and dates don't match. */
const MEASURED_LOOKING = new RegExp(`(?<![\\w.-])(?:${MONEY}|${WITH_UNIT}|${MULTIPLIER}|${RATIO}|${SLASH_RATIO}|${WORD_MULTIPLE}|${LARGE_COUNT})`, 'gi');
/** 0.92 with nothing after it, but not a version (4.3.2, Node 20.9, v1.5) or a model's name (6.1 Sol). A name needs its capital, so this one minds case. */
const BARE_DECIMAL = /(?<![\w./-])(?<![A-Z][\w-]*\s)\d+\.\d+(?![\w.-])(?!\s[A-Z])/g;

export function measuredHits(text: string): string[] {
  const found = [...text.matchAll(MEASURED_LOOKING)];
  const inside = (at: number) => found.some((m) => m.index <= at && at < m.index + m[0].length);
  const decimals = [...text.matchAll(BARE_DECIMAL)].filter((m) => !inside(m.index));
  return [...found, ...decimals].sort((a, b) => a.index - b.index).map((m) => m[0]);
}

export function looksMeasured(text: string): boolean {
  return measuredHits(text).length > 0;
}

export interface SourcedNumber { text: string; source: string }

const normalised = (number: string): string => number.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Each number in a free-text field has to be listed with where it came from. Lists say what they cover; anything else is typed.
 * Whole numbers are compared: "25 times" isn't backed by "1.25 times", though it's a piece of it.
 */
export function unsourcedNumbers(text: string, sourced: readonly SourcedNumber[]): string[] {
  const listed = new Set(sourced.flatMap((s) => {
    const numbers = measuredHits(s.text);
    return (numbers.length ? numbers : [s.text]).map(normalised);
  }));
  return measuredHits(text).filter((hit) => !listed.has(normalised(hit)));
}

const REFERENCES: RegExp[] = [
  // redirect.github.com is GitHub's documented way to link with no backlink, so it doesn't match.
  /(?<![\w.-])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/[\w.-]+\/(?:issues|pull|discussions)\/\d+/gi,
  /(?<![\w./-])([A-Za-z0-9-]+)\/[\w.-]+#\d+\b/g,
];
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:[A-Za-z0-9-]+\/[\w.-]+)?#\d+\b/gi;

/** References that would land on a timeline outside the org. With no org, that's every one: a spec's text can't know which org it's for. */
export function foreignReferences(text: string, org?: string): string[] {
  const ours = (owner: string) => Boolean(org) && owner.toLowerCase() === org?.toLowerCase();
  const linked = REFERENCES.flatMap((pattern) => [...text.matchAll(pattern)].filter((m) => !ours(m[1])).map((m) => m[0]));
  return [...linked, ...[...text.matchAll(CLOSING)].map((m) => m[0])];
}

/** A format-patch file's message: what becomes the commit message. The diff below it isn't a reference to anything. */
export function patchMessage(patchText: string): string {
  const end = patchText.indexOf('\n---\n');
  return end < 0 ? patchText : patchText.slice(0, end);
}
