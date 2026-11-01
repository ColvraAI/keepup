// Rules that bind a number to what it's a number of. A date has to be the kind of date the prose says it is, and a
// price has to be on the side the prose says it's on. checks.ts asks whether a token exists; this asks whether it's right.
import { numberClaims } from './checks.ts';

const SHUTDOWN = /\b(?:shut(?:s|ting)?[ -]?down|shutdown|retire[sd]?|retirement|retiring|sunset\w*|stops? working|remov(?:ed|al)|discontinu\w*|end of life|fails?|no longer available)\b/gi;
const ANNOUNCED = /\b(?:announc\w*|notified|released?|shipped|launched|published)\b/gi;
const BEFORE_CHARS = 60;
const AFTER_CHARS = 40;
const SIDE_WINDOW = 28;

function sentencesOf(text: string): string[] {
  return text.split(/\n|(?<=[.!?;])\s+(?=[A-Z0-9"'(])|",\s*"/).filter(Boolean);
}

interface DateAt {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

const DATE_SPELLINGS: readonly RegExp[] = [
  /\b\d{1,2}(?:st|nd|rd|th)? (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:,? 20\d\d)?\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?(?:,? 20\d\d)?\b/g,
  /\b20\d\d-\d\d-\d\d\b/g,
];

function datesIn(sentence: string): DateAt[] {
  return DATE_SPELLINGS.flatMap((re) => [...sentence.matchAll(re)].flatMap((match) => {
    const token = numberClaims(match[0])[0];
    return token ? [{ token, start: match.index, end: match.index + match[0].length }] : [];
  }));
}

function sameDay(a: string, b: string): boolean {
  return a === b || a.slice(-5) === b.slice(-5) && (a.startsWith('--') || b.startsWith('--'));
}

type DateKind = 'shutdown' | 'announced';

/** What a date in this sentence is the date of: the nearest kind word before it, or else just after it. */
function kindsAt(sentence: string, date: DateAt): Set<DateKind> {
  const before = sentence.slice(Math.max(0, date.start - BEFORE_CHARS), date.start);
  const after = sentence.slice(date.end, date.end + AFTER_CHARS);
  const last = (text: string, re: RegExp) => [...text.matchAll(re)].at(-1)?.index ?? -1;
  const shutBefore = last(before, SHUTDOWN);
  const announcedBefore = last(before, ANNOUNCED);
  if (shutBefore !== -1 || announcedBefore !== -1) return new Set([shutBefore > announcedBefore ? 'shutdown' : 'announced']);
  const shutAfter = after.search(SHUTDOWN);
  const announcedAfter = after.search(ANNOUNCED);
  if (shutAfter === -1 && announcedAfter === -1) return new Set();
  if (shutAfter === -1) return new Set(['announced']);
  if (announcedAfter === -1) return new Set(['shutdown']);
  return new Set([shutAfter < announcedAfter ? 'shutdown' : 'announced']);
}

function kindsInCorpus(token: string, corpus: string): Set<DateKind> {
  const found = new Set<DateKind>();
  for (const sentence of sentencesOf(corpus)) {
    for (const date of datesIn(sentence)) {
      if (sameDay(date.token, token)) for (const kind of kindsAt(sentence, date)) found.add(kind);
    }
  }
  return found;
}

/** True when the corpus says something stops working on this date. */
export function isShutdownDate(date: string, corpus: string): boolean {
  return kindsInCorpus(date, corpus).has('shutdown');
}

function dateClaimProblem(prose: string, corpus: string): string | null {
  for (const sentence of sentencesOf(prose)) {
    for (const date of datesIn(sentence)) {
      const claimed = kindsAt(sentence, date);
      if (claimed.size === 0) continue;
      const known = kindsInCorpus(date.token, corpus);
      if (known.size === 0) continue;
      const wrong = [...claimed].find((kind) => !known.has(kind));
      if (wrong) return `its source doesn't give ${sentence.slice(date.start, date.end)} as the ${wrong === 'shutdown' ? 'shutdown' : 'announcement'} date`;
    }
  }
  return null;
}

type Side = 'input' | 'output';
const PRICE = /\$\d[\d,]*(?:\.\d+)?/g;
const IN_KEY = /"?price_in_per_m"?\s*:\s*(\d[\d.]*)/g;
const OUT_KEY = /"?price_out_per_m"?\s*:\s*(\d[\d.]*)/g;

function normalPrice(raw: string): string {
  return String(Number(raw.replace(/[$,]/g, '')));
}

/** The side named right next to a price: "$0.10 input", "input $0.10", "$0.10 per 1M input tokens". */
function sideOf(text: string, start: number, end: number): Side | null {
  const after = text.slice(end, end + SIDE_WINDOW).split(/[,;]| and /)[0];
  const before = text.slice(Math.max(0, start - SIDE_WINDOW), start).split(/[,;]| and /).at(-1) ?? '';
  const named = (part: string): Side | null => {
    if (/\binput\b/i.test(part)) return 'input';
    return /\boutput\b/i.test(part) ? 'output' : null;
  };
  return named(after) ?? named(before);
}

function priceSides(text: string): { price: string; side: Side }[] {
  const keyed = [...text.matchAll(IN_KEY)].map((match) => ({ price: normalPrice(match[1]), side: 'input' as const }));
  const keyedOut = [...text.matchAll(OUT_KEY)].map((match) => ({ price: normalPrice(match[1]), side: 'output' as const }));
  const written = [...text.matchAll(PRICE)].flatMap((match) => {
    const side = sideOf(text, match.index, match.index + match[0].length);
    return side ? [{ price: normalPrice(match[0]), side }] : [];
  });
  return [...keyed, ...keyedOut, ...written];
}

/** Only a positive contradiction counts: the source has this price, on the other side only. */
function priceClaimProblem(prose: string, corpus: string): string | null {
  const known = priceSides(corpus);
  for (const { price, side } of priceSides(prose)) {
    const sides = known.filter((entry) => entry.price === price).map((entry) => entry.side);
    if (sides.length > 0 && !sides.includes(side)) return `its source gives $${price} as the ${sides[0]} price, not the ${side} price`;
  }
  return null;
}

const ATTRIBUTION = /\b(?:says?|claims?|guarantees?|promises?|states?|reports?)\b/i;
/** "The reference config says": that's the repo speaking, which a place vouches for, and no record ever will. */
const REPO_SUBJECT = /\b(?:config|code|file|readme|comment|line|example|table|manifest)\b[^.]*$/i;
const ABSOLUTE = /\b(?:guarantee[sd]?|forever|risk-free|no risk)\b/i;
const MIN_WORD = 5;
const MIN_WORDS_TO_JUDGE = 2;
const MIN_SHARE = 0.5;
const STOP_WORDS = new Set(['about', 'after', 'again', 'because', 'before', 'being', 'could', 'every', 'first', 'their', 'there', 'these', 'thing', 'things', 'those', 'which', 'while', 'would', 'should', 'still', 'other', 'where', 'today']);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z-]+/g) ?? []).filter((word) => word.length >= MIN_WORD && !STOP_WORDS.has(word));
}

/** "X says Y": Y has to be mostly the source's own words. */
function attributionProblem(prose: string, corpus: string): string | null {
  const lower = corpus.toLowerCase();
  for (const sentence of sentencesOf(prose)) {
    const absolute = sentence.match(ABSOLUTE);
    if (absolute && !lower.includes(absolute[0].toLowerCase())) return `no source makes that promise: "${absolute[0]}"`;
    const match = sentence.match(ATTRIBUTION);
    if (!match) continue;
    if (REPO_SUBJECT.test(sentence.slice(0, match.index ?? 0))) continue;
    const said = sentence.slice((match.index ?? 0) + match[0].length).split(/[,;]/)[0];
    const words = contentWords(said);
    if (words.length < MIN_WORDS_TO_JUDGE) continue;
    const share = words.filter((word) => lower.includes(word.slice(0, MIN_WORD))).length / words.length;
    if (share < MIN_SHARE) return 'its source doesn\'t say what the sentence says it says';
  }
  return null;
}

/** The first claim here that its source contradicts or doesn't hold. `corpus` is records and levers only, never repo text. */
export function claimProblem(prose: string, corpus: string, attributed = true): string | null {
  return dateClaimProblem(prose, corpus) ?? priceClaimProblem(prose, corpus) ?? (attributed ? attributionProblem(prose, corpus) : null);
}
