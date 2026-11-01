// Step 5 for what a judge says. Deterministic, and it trusts nothing the model wrote: every file:line is
// opened at the commit and has to hold the quoted text, every source has to be one the model was shown,
// and every number, date, version, model id, link and package name has to be readable from those sources.
// Repo text is never a source for a date, a price or a gain: a code comment can't vouch for a claim.
import { claimProblem, isShutdownDate } from './claims.ts';
import { corpusOf, numberClaims, placeProblem, plainDecimal, runChecks } from './checks.ts';
import { humanDate } from './dates.ts';
import { findModelIds } from './model-ids.ts';
import { commandShapeProblem, hostsSpelledOut, recommendationProblem, secretHandlingProblem, tellsToAdopt, unsourcedClaimProblem, vendorProblem } from './prose-rules.ts';
import { EFFECT_WORDS, type CheckSummary, type Dropped, type Finding, type HeldBack, type Watching } from './run-shape.ts';

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s)\]}"'`<>|]{1,2000}/gi;
const PROTOCOL_RELATIVE = /(?<![:\w/])\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
/** Any dotted host, whatever its ending: a list of endings is a list of what an attacker needn't use. */
const BARE_DOMAIN = /(?<![\w/.-])((?:[a-z0-9-]+\.)+[a-z]{2,24})(?![\w-])(?!\s*\()/gi;
/** Dotted words that are file names or runtimes in prose. "sh" isn't here: evil.sh is a host until a repo holds a file of that name. */
const FILE_ENDING = /\.(?:js|ts|jsx|tsx|mjs|cjs|json|toml|ya?ml|md|py|rs|txt|lock|html|css|env|go|rb|java|php|vue|svelte|ini|cfg|conf|ipynb|csv)$/i;
/** Characters a person can't see, which split a word so a pattern misses it. */
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;
/** A command on a line, however it's dressed. Prose that needs one has to find it in a record, word for word. */
const SHELL_SHAPED: readonly RegExp[] = [
  /(?<![\w.-])(?:curl|wget|sudo|chmod|powershell|iex)\s+\S[^\n]{0,200}/i,
  /(?<![\w.-])(?:sh|bash|zsh|dash|python\d?|perl|ruby|php|node|deno|bun)\s+(?:-[a-z]{1,3}\b|[^\s,;]*[/.][^\s,;.]+)[^\n]{0,200}/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:dlx|exec|x|run)\s+\S+/i,
  /\b(?:npx|bunx|uvx|pipx)\s+\S+/i,
  /\beval\s*\(|\bexec\s*\(/,
  /[\w/.-]+\s*(?:&&|\|\||;\s*(?:sh|bash|curl|wget|node|python\d?|rm|chmod)\b)\s*[\w/.-]+/,
];
/** The kinds of name a recommendation could smuggle in. English compounds such as long-running don't end like this. */
const PACKAGE_ENDING = /-(?:sdk|cli|mcp|client|server|plugin|helper|lib|core|api|utils?)$/;
/** Three parts or more, on a cited line and nowhere else, reads as a name someone planted rather than a plain compound. */
const LONG_NAME_PARTS = 3;
const HYPHEN_NAME = /(?<![\w./@-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\w/-]|\.\d)/g;
const RAW_HTML = /<\/?[a-z!][^<>]{0,300}>/i;
const MARKDOWN_LINK = /\]\(/;
const VERSION_IN_TEXT = /(?<![\w.-])v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?![\w])/g;
const INSTALL = /\b(?:(?:npm|pnpm|yarn|bun|pip3?|pipx|uv|cargo|gem|brew|apt(?:-get)?|go)\s+(?:i|install|add|get)|npx|bunx|uvx)\s+(?:-[\w-]+\s+)*(@?[a-z0-9][\w./@-]*)/gi;
const INSTALL_WORD = /\binstall\s+(@?[a-z0-9][\w./@-]*-[\w./@-]+)/gi;
const NOT_A_PACKAGE = new Set(['install', 'add', 'run', 'test', 'build', 'update', 'to', 'the', 'a', 'it', 'on', 'through', 'with', 'from']);
const SCOPED_PACKAGE = /(?<![\w/.-])@[a-z0-9][\w.-]*\/[a-z0-9](?:[\w.-]*[a-z0-9])?/gi;
const EFFORTS = new Set(['Hours', 'A day', 'A day or more', 'A project']);
const MIN_QUOTE_CHARS = 8;
const MIN_WHOLE_LINE_CHARS = 4;
const MIN_TOKEN_CHARS = 4;
/** Words that sit on any line in their language, so quoting one proves nothing. */
const KEYWORDS = new Set(['const', 'function', 'return', 'import', 'export', 'from', 'class', 'async', 'await', 'static', 'this', 'self', 'true', 'false', 'null', 'none', 'public', 'private', 'void', 'else', 'elif', 'then', 'type', 'interface', 'module', 'require', 'struct', 'enum', 'impl', 'match']);
const GAIN_NUMBER = /(?<![\w.])\d[\d,.]*(?:x|X|%)(?![\w])/;
const GAIN_ATTRIBUTION = /\b(?:says?|said|claims?|lists?|listed|according|reports?|states?|quotes?|vendor|price|prices|page|card|announced)\b|\b[A-Z][\w-]+'s\b/;
const BREAKAGE_WORDS = /\b(?:fail\w*|break\w*|stop\w*|shut\w*|retire\w*|error\w*|fix\w*|reject\w*|deprecat\w*|no longer|won't work|reconnect\w*|crash\w*)\b/i;
/** What a steered model tends to write. A hit here means the text followed something in a repo, not the record. */
const STEERED: readonly RegExp[] = [
  /\bignore (?:all |any |the )*(?:previous|prior|above|earlier|other) (?:instructions?|rules?|findings?)/i,
  /\b(?:curl|wget)\b[^\n]{0,300}\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|python\d?|node|perl|ruby|php)\b/i,
  /\b(?:reveal|print|show|repeat|leak) (?:the |your )?system prompt\b/i,
  /\byou are now\b/i,
  /\b(?:as )?instructed (?:by|in) (?:the |a |this )?(?:comment|readme|code|repo)/i,
  /\bdisregard (?:all |any |the )*(?:previous|prior|above|earlier)/i,
];
/** Words from inside keepup, and a voice a finding should never have. */
const INTERNAL_WORDING = /\blevers?\b|\b(?:the|this|that|its|any|no|their) records?\b|\brecords? (?:says?|shows?|lists?|only|does|doesn't|marks?|shown)\b|\bin the records\b|\bregistry (?:marks?|says?|lists? it as|calls?)\b|\bmarked official\b/i;
const FIRST_PERSON = /\bI\b|\bI'm\b|\bI've\b|\bmy\b|\bWe\b|\bwe\b|\bour\b/;
const FALSE_ABSENCE = /\bno (?:\w+ ){0,2}(?:notice|record|date|announcement)\b|\bnot (?:named|listed|mentioned)\b|\bnot on (?:the|that|this) (?:list|page)\b/i;

/** Rewrites of a word that isn't allowed, where the claim under it is fine. A promise beyond a shape stays a problem, and so does "marked official". */
const REWORDS: readonly (readonly [RegExp, string])[] = [
  [/\ba guaranteed (?=(?:[\w-]+ ){0,2}(?:shape|schema|format|structure|json|output)\b)/gi, 'an enforced '],
  [/\bguaranteed (?=(?:[\w-]+ ){0,2}(?:shape|schema|format|structure|json|output)\b)/gi, 'enforced '],
  [/\bguarantees (?=(?:[\w-]+ ){0,2}(?:shape|schema|format|structure|json|output)\b)/gi, 'enforces '],
  [/\bguarantee (?=(?:[\w-]+ ){0,2}(?:shape|schema|format|structure|json|output)\b)/gi, 'enforce '],
  [/\ba lever\b/g, 'an option'],
  [/\bA lever\b/g, 'An option'],
  [/\blevers\b/g, 'options'],
  [/\bLevers\b/g, 'Options'],
  [/\blever\b/g, 'option'],
  [/\bLever\b/g, 'Option'],
  [/\b(the|this|that|its|any|no|their) record(s?)\b/gi, '$1 source$2'],
  [/\brecord(s?) (says?|shows?|lists?|only|does|doesn't|marks?|shown)\b/g, 'source$1 $2'],
  [/\bRecord(s?) (says?|shows?|lists?|only|does|doesn't|marks?|shown)\b/g, 'Source$1 $2'],
];

export function reworded(text: string): string {
  return REWORDS.reduce((current, [re, to]) => current.replace(re, to), text);
}

function rewordedFinding(finding: Finding): Finding {
  return { ...finding, title: reworded(finding.title), why: reworded(finding.why), options: finding.options.map((option) => ({ ...option, name: reworded(option.name), what: reworded(option.what), needs: reworded(option.needs) })) };
}

/** A dotted name followed by a call, an index or more dots is code in a cited file, which a host in a comment isn't. */
const CODE_NAME_ON_LINE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?=\s*[([.])/g;
/** Names every language's prose reaches for, whether or not this file calls them. */
const COMMON_CODE_NAMES = ['console.log', 'console.error', 'console.warn', 'console.info', 'json.parse', 'json.stringify', 'json.loads', 'json.dumps'];

function codeNamesAt(finding: Finding, files: ReadonlyMap<string, string>): Set<string> {
  const inFiles = [...new Set(finding.where.map((place) => place.file))].flatMap((file) => (files.get(file)?.match(CODE_NAME_ON_LINE) ?? []).flatMap((name) => {
    const parts = name.toLowerCase().split('.');
    return parts.map((_, index) => parts.slice(index).join('.')).filter((part) => part.includes('.'));
  }));
  return new Set([...COMMON_CODE_NAMES, ...inFiles]);
}

export interface Provenance {
  /** Every url the model was shown, from a candidate's record, a lever or an exact check. */
  readonly allowed: ReadonlySet<string>;
  readonly textFor: (url: string) => string;
  /** What the repo itself declares, such as its dependency versions: a finding may state these too. */
  readonly repoText?: string;
  /** Model ids the scan found in this repo: a held-back row may name them. */
  readonly knownIds?: ReadonlySet<string>;
  /** Ids with a retirement on file, from a provider's page or a lever. */
  readonly retiredIds?: ReadonlySet<string>;
  /** What the program read from the registry and the manifests and told the judge: as good as a record. */
  readonly programText?: string;
  /** Things the stack lock cut, shown only so they can be watched: a finding can't recommend them. */
  readonly watchOnly?: ReadonlySet<string>;
  /** The base names of the repo's files, so a file name in prose isn't taken for a host. */
  readonly repoFiles?: ReadonlySet<string>;
  /** The same names without their endings, and the repo's folder names: reasoning-models is a file here, not a package. */
  readonly repoStems?: ReadonlySet<string>;
  /** Each lever's name in the database, so a brief can say which one a check dropped. */
  readonly leverNames?: ReadonlyMap<string, string>;
}

export interface JudgeChecksInput {
  readonly findings: readonly Finding[];
  /** What the program proved, before a judge added to it. If a judged version fails, this one stands. */
  readonly exact_findings?: readonly Finding[];
  readonly watching: readonly Watching[];
  readonly held_back: readonly HeldBack[];
  /** Rows the program wrote from the exact checks. They hold only what it proved, so they skip the prose checks. */
  readonly trusted_held_back?: readonly HeldBack[];
  readonly files: ReadonlyMap<string, string>;
  readonly provenance: Provenance;
}

export interface JudgeChecksResult {
  readonly findings: Finding[];
  readonly watching: Watching[];
  readonly held_back: HeldBack[];
  readonly checks: CheckSummary;
}

function normalUrl(url: string): string {
  return url.replace(/[.,;:]+$/, '').replace(/\/$/, '');
}

function isAllowed(url: string, provenance: Provenance): boolean {
  const wanted = normalUrl(url);
  return provenance.allowed.has(url) || [...provenance.allowed].some((known) => normalUrl(known) === wanted);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function allowedHosts(provenance: Provenance): Set<string> {
  return new Set([...provenance.allowed].flatMap((url) => {
    const host = hostOf(url);
    return host ? [host, host.replace(/^www\./, '')] : [];
  }));
}

/** What a repo line can vouch for ends here: a host in a recommendation has to come from a record, a lever or a registry fact. */
function linkProblem(prose: string, corpus: string, provenance: Provenance, codeNames: ReadonlySet<string>): string | null {
  if (RAW_HTML.test(prose) || MARKDOWN_LINK.test(prose)) return `it holds markup or a link: "${prose.match(RAW_HTML)?.[0] ?? prose.match(MARKDOWN_LINK)?.[0]}"`;
  const badUrl = [...prose.matchAll(URL_IN_TEXT)].map((match) => match[0]).find((url) => !isAllowed(url, provenance));
  if (badUrl) return `the link ${badUrl} isn't from any record or lever`;
  const hosts = allowedHosts(provenance);
  const lower = corpus.toLowerCase();
  const withoutUrls = prose.replace(URL_IN_TEXT, ' ');
  const isFileName = (domain: string) => FILE_ENDING.test(domain) || provenance.repoFiles?.has(domain) || codeNames.has(domain);
  const relative = [...withoutUrls.matchAll(PROTOCOL_RELATIVE)].map((match) => match[1].toLowerCase());
  const bare = [...withoutUrls.matchAll(BARE_DOMAIN)].map((match) => match[1].toLowerCase()).filter((domain) => !isFileName(domain));
  const badHost = [...relative, ...bare].find((domain) => !hosts.has(domain) && !hosts.has(domain.replace(/^www\./, '')) && !lower.includes(domain));
  return badHost ? `the link ${badHost} isn't from any record or lever` : null;
}

/** To install a package, a record has to name it. To say it's already used, a manifest can. A repo line alone is neither. */
function packageProblem(prose: string, records: string, declared: string): string | null {
  const lowerRecords = records.toLowerCase();
  const lowerBoth = `${records}\n${declared}`.toLowerCase();
  const installs = [...prose.matchAll(INSTALL), ...prose.matchAll(INSTALL_WORD)].map((match) => match[1].toLowerCase().replace(/[.,;:]+$/, '')).filter((name) => !NOT_A_PACKAGE.has(name));
  const named = (prose.match(SCOPED_PACKAGE) ?? []).map((name) => name.toLowerCase());
  const badInstall = installs.find((name) => !lowerRecords.includes(name));
  const bad = badInstall ?? named.find((name) => !lowerBoth.includes(name));
  return bad ? `the package ${bad} isn't in any record or manifest` : null;
}

function shellProblem(prose: string, records: string): string | null {
  for (const re of SHELL_SHAPED) {
    const found = prose.match(re)?.[0];
    if (found && !records.includes(found.trim())) return `it reads like a command to run: "${found.trim().slice(0, 80)}"`;
  }
  return null;
}

function wholeNames(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9-]+/));
}

/** A name that reads like a package and only a repo's own text holds: a comment can't plant a recommendation. */
function repoOnlyNameProblem(prose: string, corpus: string, records: string, provenance: Provenance): string | null {
  const vouched = `${records}\n${provenance.repoText ?? ''}`.toLowerCase();
  const inCorpus = wholeNames(corpus);
  const ids = findModelIds(prose).map((mention) => mention.id);
  const bad = (prose.match(HYPHEN_NAME) ?? []).find((name) => {
    const word = name.toLowerCase();
    if (vouched.includes(word) || ids.some((id) => id.startsWith(name)) || provenance.repoStems?.has(word)) return false;
    return PACKAGE_ENDING.test(word) || (word.split('-').length >= LONG_NAME_PARTS && inCorpus.has(word));
  });
  return bad ? `the name ${bad} isn't in any record or manifest` : null;
}

/** Every check reads what a person would see. */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE, '').normalize('NFKC');
}

function wordingProblem(prose: string): string | null {
  const internal = prose.match(INTERNAL_WORDING);
  if (internal) return `its wording uses an internal word: "${internal[0]}"`;
  const first = prose.match(FIRST_PERSON);
  return first ? `its wording is in the first person: "${first[0]}"` : null;
}

function isGainToken(token: string): boolean {
  return token.startsWith('--') || /^20\d\d-/.test(token) || /[xX%]$/.test(token);
}

function numberProblemIn(prose: string, records: string, corpus: string): string | null {
  const recordNumbers = corpusOf([records]);
  const allNumbers = corpusOf([corpus]);
  const bad = numberClaims(prose).find((token) => {
    const known = isGainToken(token) ? recordNumbers : allNumbers;
    return !known.has(token) && !known.has(plainDecimal(token));
  });
  return bad ? `${humanDate(bad)} can't be read from any source` : null;
}

/**
 * The first unreadable claim in a piece of prose, or null. `corpus` is everything it may name, including cited lines.
 * `records`, when given, is the narrower text a date, a gain or a promise has to be read from.
 */
export function proseProblem(given: string, corpus: string, provenance: Provenance, records: string = corpus, attributed = true, codeNames: ReadonlySet<string> = new Set()): string | null {
  const prose = hostsSpelledOut(visibleText(given));
  const steered = STEERED.find((re) => re.test(prose));
  if (steered) return `it reads like an instruction from the repo: "${prose.match(steered)?.[0]}"`;
  const fixed = shellProblem(prose, records) ?? commandShapeProblem(prose, records) ?? secretHandlingProblem(prose) ?? linkProblem(prose, records, provenance, codeNames) ?? wordingProblem(prose) ?? packageProblem(prose, records, provenance.repoText ?? '') ?? (attributed ? repoOnlyNameProblem(prose, corpus, records, provenance) : null) ?? recommendationProblem(prose, `${records}\n${provenance.repoText ?? ''}`) ?? unsourcedClaimProblem(prose, records);
  if (fixed) return fixed;
  const badVersion = [...prose.matchAll(VERSION_IN_TEXT)].map((match) => match[1]).find((version) => !corpus.includes(version));
  if (badVersion) return `the version ${badVersion} isn't in its sources`;
  const badModel = findModelIds(prose).map((mention) => mention.id).find((id) => !corpus.includes(id) && !provenance.knownIds?.has(id));
  if (badModel) return `the model id ${badModel} isn't in its sources`;
  return numberProblemIn(prose, records, corpus) ?? claimProblem(prose, records, attributed);
}

function recordsFor(finding: Finding, input: JudgeChecksInput): string {
  const urls = [...finding.sources, ...finding.options.map((option) => option.source)];
  return [
    ...(finding.evidence ?? []),
    ...urls.map((url) => input.provenance.textFor(url)),
    finding.lever ? input.provenance.textFor(finding.lever) : '',
    input.provenance.programText ?? '',
  ].join('\n');
}

/** Code may support only what is on a line the finding cites: its ids and plain numbers, never a date or a gain. */
function corpusFor(finding: Finding, records: string, input: JudgeChecksInput): string {
  const cited = finding.where.flatMap((place) => [String(place.line), place.file, input.files.get(place.file)?.split('\n')[place.line - 1] ?? '']);
  return [records, input.provenance.repoText ?? '', ...cited].join('\n');
}

function shapeProblem(finding: Finding): string | null {
  if (finding.where.length === 0) return 'it points at no file and line';
  if (finding.where.some((place) => !place.text?.trim())) return 'a place in the code has no quoted text to check';
  if (finding.proof === 'measured') return 'the judge measures nothing, so it can\'t say "measured"';
  if (!EFFORTS.has(finding.effort)) return `"${finding.effort}" is not an effort word`;
  const bad = finding.effect.find((word) => !(EFFECT_WORDS as readonly string[]).includes(word));
  return bad ? `"${bad}" is not one of the five effect words` : null;
}

/** A name on that line, not a piece of a word or a keyword every line has. */
function isWholeToken(quote: string, line: string): boolean {
  if (quote.length < MIN_TOKEN_CHARS || KEYWORDS.has(quote.toLowerCase()) || !/^[\w.@/-]+$/.test(quote)) return false;
  const at = line.indexOf(quote);
  return at !== -1 && !/[\w-]/.test(line[at - 1] ?? '') && !/[\w-]/.test(line[at + quote.length] ?? '');
}

/** A quote that proves a place: long enough to be that line and no other, or the whole of a short line. */
export function quoteProblem(quote: string, line: string | undefined): string | null {
  const wanted = quote.trim();
  if (wanted.replace(/\s/g, '').length >= MIN_QUOTE_CHARS) return null;
  if (line !== undefined && line.trim() === wanted && wanted.length >= MIN_WHOLE_LINE_CHARS) return null;
  if (line !== undefined && isWholeToken(wanted, line)) return null;
  return `the quote "${wanted}" is too short to prove that place`;
}

function placesProblem(finding: Finding, input: JudgeChecksInput): string | null {
  for (const place of finding.where) {
    const problem = placeProblem(place, input.files) ?? quoteProblem(place.text, input.files.get(place.file)?.split('\n')[place.line - 1]);
    if (problem) return problem;
  }
  return null;
}

function sourceProblem(finding: Finding, provenance: Provenance): string | null {
  if (finding.sources.length === 0) return 'it cites no source';
  const urls = [...finding.sources, ...finding.options.map((option) => option.source).filter(Boolean)];
  const bad = urls.find((url) => !isAllowed(url, provenance));
  if (bad) return `the source ${bad} isn't from any record or lever`;
  const cut = urls.find((url) => provenance.watchOnly?.has(url));
  return cut ? `the stack lock says it can't run here, so it can only be watched: ${cut}` : null;
}

function findingProse(finding: Finding): string {
  return [finding.title, finding.why, ...finding.options.flatMap((option) => [option.name, option.what, option.needs])].join('\n');
}

function deadlineProblem(finding: Finding, records: string): string | null {
  if (!finding.deadline) return null;
  return isShutdownDate(finding.deadline, records) ? null : `the deadline ${humanDate(finding.deadline)} isn't a shutdown date in its sources`;
}

const MODEL_CALL = /\.messages\.(?:create|stream)\(|\.chat\.completions\.create\(|\.responses\.create\(|\b(?:generateText|streamText|generateObject|generate_content|generateContent)\(/;
const CACHE_SET = /cache_control|cacheControl|prompt_cache_key|cachedContent/;
const CACHE_RADIUS = 20;

/** A call that doesn't ask for caching is exactly where it's missing: it needs no setting there to turn on. */
function isUncachedCall(place: Finding['where'][number], files: ReadonlyMap<string, string>): boolean {
  const lines = files.get(place.file)?.split('\n') ?? [];
  if (!MODEL_CALL.test(lines[place.line - 1] ?? '')) return false;
  return !CACHE_SET.test(lines.slice(Math.max(0, place.line - 1 - CACHE_RADIUS), place.line + CACHE_RADIUS).join('\n'));
}

/** Caching only fits where the code shows a caching setting, or at a model call with no caching near it. */
function cachingProblem(finding: Finding, prose: string, files: ReadonlyMap<string, string>): string | null {
  if (!/\bprompt cach/i.test(prose)) return null;
  return finding.where.some((place) => /cach/i.test(place.text) && !/^\s*Get a completion/i.test(place.text) || isUncachedCall(place, files)) ? null : 'it says to turn on prompt caching at a place with no caching setting';
}

function labelProblem(finding: Finding, prose: string): string | null {
  if (finding.deadline && finding.effect.includes('new capability')) return '"new capability" on something that stops working';
  if (finding.effect.includes('keeps working') && !finding.deadline && !BREAKAGE_WORDS.test(prose)) return '"keeps working" with nothing in it that stops working';
  const gain = prose.split(/\n|(?<=[.!?])\s+/).find((sentence) => GAIN_NUMBER.test(sentence));
  if (!gain) return null;
  if (finding.proof === 'adoption only') return `"adoption only" can't carry a gain: "${gain.match(GAIN_NUMBER)?.[0]}"`;
  return GAIN_ATTRIBUTION.test(gain) ? null : `a gain with no attribution, so nobody can see whose number it is: "${gain.match(GAIN_NUMBER)?.[0]}"`;
}

/** The first word of a name is enough: "Dynatrace Managed" is about Dynatrace. What it's called has to be in the text it links to. */
function namedBySource(name: string, source: string, provenance: Provenance): boolean {
  const text = provenance.textFor(source).toLowerCase();
  const wanted = visibleText(name).toLowerCase().trim();
  return !wanted || text.includes(wanted) || text.includes(wanted.split(/[\s(,:;]+/)[0]);
}

function optionProblem(finding: Finding, provenance: Provenance): string | null {
  const bad = finding.options.find((option) => option.source && !namedBySource(option.name, option.source, provenance));
  return bad ? `the name ${bad.name} isn't in any record or manifest` : null;
}

function findingProblem(finding: Finding, input: JudgeChecksInput): string | null {
  const shape = shapeProblem(finding) ?? sourceProblem(finding, input.provenance) ?? placesProblem(finding, input) ?? optionProblem(finding, input.provenance);
  if (shape) return shape;
  const records = recordsFor(finding, input);
  const corpus = corpusFor(finding, records, input);
  const prose = findingProse(finding);
  return deadlineProblem(finding, records)
    ?? proseProblem(prose, corpus, input.provenance, records, true, codeNamesAt(finding, input.files))
    ?? vendorProblem(hostsSpelledOut(visibleText(prose)), records, [...finding.sources, ...finding.options.map((option) => option.source)])
    ?? labelProblem(finding, prose)
    ?? cachingProblem(finding, prose, input.files);
}

function checkWatching(item: Watching, provenance: Provenance): string | null {
  if (!isAllowed(item.source, provenance)) return `the source ${item.source} isn't from any record or lever`;
  if (!namedBySource(item.thing, item.source, provenance)) return `the name ${item.thing} isn't in any record or manifest`;
  return proseProblem(`${item.thing}\n${item.why}`, `${provenance.textFor(item.source)}\n${provenance.repoText ?? ''}`, provenance, provenance.textFor(item.source));
}

function falseAbsenceProblem(prose: string, provenance: Provenance): string | null {
  if (!FALSE_ABSENCE.test(prose)) return null;
  const id = findModelIds(prose).map((mention) => mention.id).find((found) => provenance.retiredIds?.has(found));
  return id ? `${id} does have a retirement on file, so "no notice" is false` : null;
}

function heldBackProblem(row: HeldBack, provenance: Provenance): string | null {
  const prose = `${row.thing}\n${row.reason}`;
  const source = row.source && isAllowed(row.source, provenance) ? provenance.textFor(row.source) : '';
  const records = [source, provenance.programText ?? ''].join('\n');
  const corpus = [records, provenance.repoText ?? '', ...(provenance.knownIds ?? [])].join('\n');
  const noSource = tellsToAdopt(visibleText(prose)) && !source ? 'it tells a founder to adopt something, and it cites no source' : null;
  return noSource ?? falseAbsenceProblem(prose, provenance) ?? proseProblem(prose, corpus, provenance, records, false);
}

/** A held-back row is a statement to the founder too. A source or date that can't be traced is removed. */
function cleanHeldBack(row: HeldBack, provenance: Provenance): HeldBack {
  const source = row.source && isAllowed(row.source, provenance) ? row.source : null;
  const date = row.date && source && corpusOf([provenance.textFor(source)]).has(row.date) ? row.date : null;
  return { ...row, source, date };
}

function placeOf(finding: Finding): string | undefined {
  const place = finding.where[0];
  return place ? `${place.file}:${place.line}` : undefined;
}

/** A lever's finding that fails on one sentence of its why loses that sentence, not the lever. What's left must still pass every check. */
function withoutBadSentences(finding: Finding, input: JudgeChecksInput): Finding | null {
  if (!finding.lever) return null;
  const sentences = finding.why.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !findingProblem({ ...finding, why: sentence }, input));
  if (kept.length === 0 || kept.length === sentences.length) return null;
  const repaired = { ...finding, why: kept.join(' ') };
  return findingProblem(repaired, input) ? null : repaired;
}

export function runJudgeChecks(input: JudgeChecksInput): JudgeChecksResult {
  const dropped: Dropped[] = [];
  const exactByTitle = new Map((input.exact_findings ?? []).map((finding) => [finding.title, finding]));
  const survivors = input.findings.map(rewordedFinding).flatMap((finding) => {
    const problem = findingProblem(finding, input);
    if (!problem) return [finding];
    const repaired = withoutBadSentences(finding, input);
    if (repaired) {
      dropped.push({ what: `A sentence in "${finding.title}"`, why: problem, where: placeOf(finding) });
      return [repaired];
    }
    const exact = exactByTitle.get(finding.title);
    // The program's count isn't on any page, and it needn't be: it read the repo. What a judge added is what can't stand.
    if (exact) {
      dropped.push({ what: `The judge's note on "${finding.title}"`, why: problem, where: placeOf(finding) });
      return [{ ...exact, evidence: [...(exact.evidence ?? []), exact.title, exact.why, ...exact.options.flatMap((option) => [option.what, option.needs])] }];
    }
    const lever = finding.lever ? input.provenance.leverNames?.get(finding.lever) : undefined;
    dropped.push({ what: finding.title, why: problem, where: placeOf(finding), ...(lever ? { lever } : {}) });
    return [];
  });
  const base = runChecks({ findings: survivors.map((finding) => ({ ...finding, evidence: [corpusFor(finding, recordsFor(finding, input), input)] })), files: input.files, sourceText: input.provenance.textFor });
  const originals = new Map(survivors.map((finding) => [finding.title, exactByTitle.get(finding.title) && input.findings.every((given) => given.title !== finding.title || given.why === exactByTitle.get(finding.title)?.why) ? finding : exactByTitle.get(finding.title) ?? finding]));
  const watching = input.watching.map((item) => ({ ...item, thing: reworded(item.thing), why: reworded(item.why) })).filter((item) => {
    const problem = checkWatching(item, input.provenance);
    if (problem) dropped.push({ what: item.thing, why: problem });
    return !problem;
  });
  const held = input.held_back.map((row) => ({ ...row, thing: reworded(row.thing), reason: reworded(row.reason) })).flatMap((row) => {
    const problem = heldBackProblem(row, input.provenance);
    if (problem) dropped.push({ what: row.thing, why: problem });
    return problem ? [] : [cleanHeldBack(row, input.provenance)];
  });
  return {
    findings: base.findings.map((finding) => ({ ...finding, evidence: originals.get(finding.title)?.evidence ?? [] })),
    watching,
    held_back: [...held, ...(input.trusted_held_back ?? [])],
    checks: { passed: base.checks.passed + survivors.length, dropped: [...dropped, ...base.checks.dropped] },
  };
}
