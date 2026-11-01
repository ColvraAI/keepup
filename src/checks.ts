// The last step before anyone sees a finding, and all of it deterministic: every file:line is opened
// at the stated commit and has to match, every source has to be a real record or URL, and every
// number has to be read from a source. A finding that fails any of these is dropped, loudly.
import { EFFECT_WORDS, type CheckSummary, type Dropped, type Finding, PROOF_LABELS } from './run-shape.ts';
import { humanDate, isoDate, monthNumber } from './dates.ts';

const SMALL_COUNT_LIMIT = 10;
const MONTH = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const DAY_MONTH_YEAR = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${MONTH},? (20\\d\\d)\\b`, 'g');
const MONTH_DAY_YEAR = new RegExp(`\\b${MONTH} (\\d{1,2})(?:st|nd|rd|th)?,? (20\\d\\d)\\b`, 'g');
const ISO_DATE = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${MONTH}\\b`, 'g');
const MONTH_DAY = new RegExp(`\\b${MONTH} (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g');
const IDENTIFIER = /(?<![\w.,$])[A-Za-z_@/][\w./@:-]*\d[\w./@:-]*/g;
const NUMBER = /(?<![\w.-])\$?\d[\d,]*(?:\.\d+)*(?:[xX%]|[KMB](?![a-z]))?(?![\w-])/g;
/** A number run into a unit or a word, or two run into a range: 7ms-50ms, 9731-dimensional, 1.5s, $0.10-$0.50. */
const JOINED = /(?<![\w.$-])\$?\d[\d,]*(?:\.\d+)*(?:[a-zA-Z%]{0,14})(?:[-–]\$?\d[\d,]*(?:\.\d+)*[a-zA-Z%]{0,14})*(?:[-–][a-zA-Z]{1,20})*(?![\w])/g;
const JOINED_PART = /\$?\d[\d,]*(?:\.\d+)*(?:[xX%]|[KMB](?![a-z]))?/g;
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;
/** "imported.js lines 15-23" points at a place, which step 5 opens. It isn't a claim about anything. */
const LINE_REFERENCE = /\blines? \d+(?:\s?(?:[-–]|,|and|&)\s?\d+)*|(?<![\w.])[\w./-]+\.[a-z]{1,5}:\d+(?:(?:,| and)\s:?\d+)*|(?<=[\s(]):\d+\b/gi;

function pad(value: string | number): string {
  return String(value).padStart(2, '0');
}

interface DatePass {
  readonly re: RegExp;
  readonly toToken: (m: readonly string[]) => string;
}

const DATE_PASSES: readonly DatePass[] = [
  { re: DAY_MONTH_YEAR, toToken: (m) => isoDate(m[2], m[1], m[3]) },
  { re: MONTH_DAY_YEAR, toToken: (m) => isoDate(m[1], m[2], m[3]) },
  { re: ISO_DATE, toToken: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { re: DAY_MONTH, toToken: (m) => `--${pad(monthNumber(m[2]))}-${pad(m[1])}` },
  { re: MONTH_DAY, toToken: (m) => `--${pad(monthNumber(m[1]))}-${pad(m[2])}` },
];

/** Pulls dates out one spelling at a time, leaving a marker so later passes can't read them twice. */
function extractDates(text: string): { dates: { at: number; token: string }[]; rest: string } {
  const dates: { at: number; token: string }[] = [];
  let rest = text;
  for (const { re, toToken } of DATE_PASSES) {
    rest = rest.replace(re, (...args) => {
      const groups = args.slice(0, -2) as string[];
      dates.push({ at: args.at(-2) as number, token: toToken(groups) });
      return ' '.repeat(groups[0].length);
    });
  }
  return { dates, rest };
}

function normaliseNumber(raw: string): string {
  return raw.replace(/^\$/, '').replace(/,/g, '');
}

/** $0.50 in a sentence and 0.5 in a record are the same number. */
export function plainDecimal(token: string): string {
  return /^\d+\.\d+$/.test(token) ? token.replace(/\.?0+$/, '') : token;
}

function isSmallCount(token: string): boolean {
  return /^\d+$/.test(token) && Number(token) < SMALL_COUNT_LIMIT;
}

interface NumberAt {
  readonly at: number;
  readonly token: string;
  /** A unit or a word is joined to it, so even a small one is claiming something. */
  readonly joined: boolean;
}

/** One match of JOINED, as its numbers. A plain number, an ordinal or a plain range of small ones claims nothing new here. */
function joinedNumbers(text: string, at: number): NumberAt[] {
  if (ORDINAL.test(text)) return [];
  const hasUnit = /[a-zA-Z]/.test(text.replace(/(?<=\d)[xX%KMB](?![a-z])/g, ''));
  return [...text.matchAll(JOINED_PART)].map((part) => ({ at: at + part.index, token: normaliseNumber(part[0]), joined: hasUnit }));
}

function allNumbers(text: string): { dates: { at: number; token: string }[]; numbers: NumberAt[] } {
  const { dates, rest } = extractDates(text);
  const withoutIds = rest.replace(LINE_REFERENCE, (ref) => ' '.repeat(ref.length)).replace(IDENTIFIER, (id) => ' '.repeat(id.length));
  const joined = [...withoutIds.matchAll(JOINED)].flatMap((match) => joinedNumbers(match[0], match.index));
  const plain = [...withoutIds.replace(JOINED, (whole) => ' '.repeat(whole.length)).matchAll(NUMBER)].map((match) => ({ at: match.index, token: normaliseNumber(match[0]), joined: false }));
  return { dates, numbers: [...joined, ...plain] };
}

/** The dates and numbers a piece of prose claims, in one spelling. Ids and paths aren't claims, and neither is a plain small count. */
export function numberClaims(text: string): string[] {
  const { dates, numbers } = allNumbers(text);
  const counted = numbers.filter((entry) => entry.joined || !isSmallCount(entry.token));
  return [...dates, ...counted].sort((a, b) => a.at - b.at).map((entry) => entry.token);
}

/** Everything a source can vouch for, small numbers too: 7ms can be read from a page that says 7 ms. */
export function corpusOf(texts: readonly string[]): Set<string> {
  const corpus = new Set<string>();
  for (const text of texts) {
    const { dates, numbers } = allNumbers(text);
    for (const { token } of [...dates, ...numbers]) {
      corpus.add(token);
      corpus.add(plainDecimal(token));
      if (/^20\d\d-\d\d-\d\d$/.test(token)) corpus.add(`--${token.slice(5)}`);
    }
  }
  return corpus;
}

function isRealUrl(source: string): boolean {
  try {
    const url = new URL(source);
    const isWeb = url.protocol === 'https:' || url.protocol === 'http:';
    return isWeb && url.hostname.includes('.') && !/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname);
  } catch {
    return false;
  }
}

/** The first thing wrong with a place in the code, or null. Both sides are masked text. */
export function placeProblem(place: Finding['where'][number], files: ReadonlyMap<string, string>): string | null {
  const text = files.get(place.file);
  if (text === undefined) return `${place.file}: not in the repo at this commit`;
  const line = text.split('\n')[place.line - 1];
  if (line === undefined) return `${place.file}: no line ${place.line}`;
  if (place.text && !line.includes(place.text.trim())) return `${place.file}:${place.line}: that line says something else`;
  return null;
}

interface Verdict {
  readonly problem: string | null;
  readonly passed: number;
}

function labelProblem(finding: Finding): string | null {
  const badEffect = finding.effect.find((word) => !(EFFECT_WORDS as readonly string[]).includes(word));
  if (finding.effect.length === 0) return 'it names no effect';
  if (badEffect) return `"${badEffect}" is not one of the five effect words`;
  return PROOF_LABELS.includes(finding.proof) ? null : `"${finding.proof}" is not a proof label`;
}

function sourceProblem(finding: Finding): string | null {
  if (finding.sources.length === 0) return 'it cites no source';
  const bad = finding.sources.find((source) => !isRealUrl(source));
  return bad ? `the source "${bad}" is not a real URL` : null;
}

function numberProblem(finding: Finding, sourceText: (url: string) => string): string | null {
  const prose = [finding.title, finding.why, ...finding.options.flatMap((option) => [option.what, option.needs])];
  const corpus = corpusOf([
    ...(finding.evidence ?? []),
    ...finding.where.map((place) => place.text),
    ...finding.options.map((option) => option.name),
    ...finding.sources.map(sourceText),
    ...finding.options.map((option) => sourceText(option.source)),
  ]);
  const unread = prose.flatMap(numberClaims).find((token) => !corpus.has(token) && !corpus.has(plainDecimal(token)));
  return unread ? `${humanDate(unread)} can't be read from any source` : null;
}

function verdictFor(finding: Finding, files: ReadonlyMap<string, string>, sourceText: (url: string) => string): Verdict {
  if (finding.where.length === 0) return { problem: 'it points at no file and line', passed: 0 };
  const stages: (() => string | null)[] = [
    () => labelProblem(finding),
    ...finding.where.map((place) => () => placeProblem(place, files)),
    () => sourceProblem(finding),
    () => numberProblem(finding, sourceText),
  ];
  let passed = 0;
  for (const stage of stages) {
    const problem = stage();
    if (problem) return { problem, passed };
    passed += 1;
  }
  return { problem: null, passed };
}

export interface ChecksInput {
  readonly findings: readonly Finding[];
  readonly files: ReadonlyMap<string, string>;
  readonly sourceText: (url: string) => string;
}

export function runChecks(input: ChecksInput): { findings: Finding[]; checks: CheckSummary } {
  const kept: Finding[] = [];
  const dropped: Dropped[] = [];
  let passed = 0;
  for (const finding of input.findings) {
    const verdict = verdictFor(finding, input.files, input.sourceText);
    passed += verdict.passed;
    if (verdict.problem) dropped.push({ what: finding.title, why: verdict.problem });
    else kept.push(finding);
  }
  return { findings: kept, checks: { passed, dropped } };
}
