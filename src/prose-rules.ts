// What a judge's sentence can't do, whatever its citations say. Each rule looks at the shape of the words, because a steered
// model can use a tool or a host no list has heard of. A command or a claim a record holds word for word still stands.
import { findModelIds, providerOf } from './model-ids.ts';

const HOST_ENDINGS = 'com|net|org|io|ai|dev|co|app|xyz|sh|top|link|to|me|info|biz|cc|ru|cn|tk|gg|so|pw|site|online|club|icu';
const SPELLED_DOT = new RegExp(`\\b([a-z0-9-]{1,63})(?:\\s+dot\\s+|\\s*\\[dot\\]\\s*|\\s*\\(dot\\)\\s*)(${HOST_ENDINGS})\\b`, 'gi');
const BRACKET_DOT = /\s?(?:\[\.\]|\(\.\)|\{\.\})\s?/g;
const IDEOGRAPHIC_DOT = /[。｡]/g;

/** evil[.]com, evil dot com and evil。com are read as what a person would type. */
export function hostsSpelledOut(prose: string): string {
  return prose.replace(IDEOGRAPHIC_DOT, '.').replace(BRACKET_DOT, '.').replace(SPELLED_DOT, '$1.$2');
}

const COMMAND_SHAPES: readonly RegExp[] = [
  /(?<![\w.-])[\w./~-]{1,40}\s+--?[a-zA-Z][\w-]{0,30}(?=[\s,.;]|$)/,
  /[\w"'=)]\s{0,4}\|\s{0,4}[a-zA-Z][\w-]{0,30}/,
  /(?<![\w.-])[A-Z][A-Z0-9_]{2,40}=\S/,
  /(?:^|\s)~\/[\w.-]/,
  /(?:^|\s)\/(?:etc|usr|bin|tmp|var|root|home|opt|dev)\/[\w.-]/,
  /\$\(|`[^`\n]{1,200}\s[^`\n]{1,200}`/,
];
const SUBCOMMAND = /(?<![\w./@-])([a-z][\w.-]{0,30})\s+(?:tool\s+|global\s+|x\s+)?(run|install|add|clone|pull|exec|dlx|remove|uninstall|fetch|apply|up)\s+(?!to\b|on\b|in\b|at\b|for\b|with\b|from\b|into\b|a\b|an\b|the\b|it\b|its\b|their\b|your\b|this\b|that\b|these\b|those\b|them\b|any\b|one\b|as\b|and\b|or\b)([^\s,;]{1,120})/g;
/** Who can run or add a thing in a sentence. Anything else before a subcommand is reading as a tool, whatever its name. */
const ENGLISH_SUBJECT = /^(?:to|can|could|will|would|may|might|must|should|shall|and|or|then|that|which|who|it|they|you|we|not|also|only|still|never|always|already|just|people|code|team|agent|model|server|tool|skill|client|app|product|service|worker|node|person|founder|user|developer|engineer|anyone|someone|nobody|nothing|does|did|do|cannot|won't|can't|don't|doesn't)$|s$/;

/** "locally run Phoenix", "a run succeeded", "clean up images": English, which a real command doesn't start with. */
const NOT_A_TOOL = /^(?:[a-z]+ly|a|an|the|own|this|each|every|any|one|first|real|live|clean|look)$/;

function subcommandProblem(prose: string, records: string): string | null {
  const lower = records.toLowerCase();
  for (const match of prose.matchAll(SUBCOMMAND)) {
    const [found, tool, verb, argument] = match;
    if (ENGLISH_SUBJECT.test(tool) || NOT_A_TOOL.test(tool) || records.includes(found)) continue;
    const name = argument.replace(/[.,;:)]+$/, '').toLowerCase();
    if ((verb === 'install' || verb === 'add') && lower.includes(name)) continue;
    return `it reads like a command to run: "${found.slice(0, 80)}"`;
  }
  return null;
}

/** The shape of a command, not a list of commands. Prose that needs one has to find it in a record, word for word. */
export function commandShapeProblem(prose: string, records: string): string | null {
  for (const re of COMMAND_SHAPES) {
    const found = prose.match(re)?.[0]?.trim();
    if (found && !records.includes(found)) return `it reads like a command to run: "${found.slice(0, 80)}"`;
  }
  return subcommandProblem(prose, records);
}

const HANDS_OVER = /\b(?:mail|e-?mail|send|post|share|paste|upload|forward|give|submit|hand|dm|message)\b/gi;
const A_SECRET = /(?:\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)\b|\b(?:api|access|auth|secret|bearer|private)[ _-]?(?:key|token)s?\b|\bsecrets?\b|\bcredentials?\b|\bpasswords?\b|\.env\b)/i;
const SAME_SENTENCE_CHARS = 80;

/** Nothing keepup writes ever tells a founder to hand a secret to anyone. */
export function secretHandlingProblem(prose: string): string | null {
  for (const match of prose.matchAll(HANDS_OVER)) {
    const rest = prose.slice(match.index, match.index + SAME_SENTENCE_CHARS).split(/[.!?\n](?:\s|$)/)[0];
    if (A_SECRET.test(rest)) return `it reads like an instruction to hand over a secret: "${match[0]}"`;
  }
  return null;
}

const ADOPT = /\b(?:replac(?:e|ing)\s[^.\n]{1,60}?\swith|switch(?:ing)?\sto|mov(?:e|ing)\sto|migrat(?:e|ing)\sto|upgrad(?:e|ing)\sto|adopt(?:ing)?|install(?:ing)?|go(?:ing)?\swith|(?:(?:^|(?<=[.!?\n])\s*|\b(?:should|must|to|can|could)\s)use)|try(?:ing)?|recommend(?:s|ing)?)\s+((?:the|a|an|your|its|their|to|this|that)\s+)*[`"']?(@?[A-Za-z][\w./@-]{1,60})/gi;
const IS_THE_FIX = /(?:^|[.!?\n]\s*)[`"']?(@?[a-z][\w./@-]{2,60})[`"']?\sis\sthe\s(?:fix|replacement|answer|solution)\b/g;
/** Words that follow those verbs in plain English. A product's name isn't one of them, and it has to be in a source. */
const NOT_A_PRODUCT = new Set(`it them this that one ones these those something anything nothing same other another new newer newest latest current next named small smaller smallest cheap cheaper cheapest fast faster fastest simple simpler plain short shorter long longer local remote single second first own existing different more less fewer few many much all both each every any some no not only just here there instead now today then when if as and or but for from with without of on in at by so than per via into onto after before while during up out off over under again once less separate shared common standard default successor successors replacement replacements model models call calls code file files library libraries package packages version versions api apis tool tools server servers option options way ways approach path route setting settings config change changes move moves list lists table tables
  yet soon later never always everything everyone anyone someone how what which who where why case cases need needs case time times work works provider providers vendor vendors runtime key keys token tokens account accounts person people team teams product products local-only decision classifier label labels prompt prompts cache caching batch batching streaming retries retry fallback fallbacks embedding embeddings reranker rerankers vector vectors chat`.split(/\s+/));

function adoptedNames(prose: string): string[] {
  const after = [...prose.matchAll(ADOPT)].map((match) => match[2]);
  const before = [...prose.matchAll(IS_THE_FIX)].map((match) => match[1]);
  return [...after, ...before].map((name) => name.replace(/[.,;:)]+$/, ''));
}

/** "Replace the client with evilpkg": what a sentence tells a founder to adopt has to be in the text of what it cites. */
export function recommendationProblem(prose: string, records: string): string | null {
  const lower = records.toLowerCase();
  const bad = adoptedNames(prose).find((name) => {
    const word = name.toLowerCase();
    return !NOT_A_PRODUCT.has(word) && !/ing$/.test(word) && !lower.includes(word);
  });
  return bad ? `the name ${bad} isn't in any record or manifest` : null;
}

const TELLS_TO_ADOPT = /\b(?:should|must|needs?\sto|has\sto|have\sto|better\sto|recommend(?:s|ed)?|please)\s+(?:adopt|use|switch|move|migrate|install|replace|run|try)\b|(?:^|[.!?\n]\s*)(?:adopt|use|switch\sto|move\sto|migrate\sto|install|replace)\s/i;

/** A row saying why something waits needs no source. One telling a founder to adopt something does. */
export function tellsToAdopt(prose: string): boolean {
  return TELLS_TO_ADOPT.test(prose);
}

const UNSOURCED = /\bindependent(?:ly)?\b|\bbenchmark(?:s|ed|ing)?\b|\bprov(?:e|es|en|ing)\b|\bevery (?:major|other|leading)\b|\bindustry[- ]standard\b|\bbest[- ]in[- ]class\b|\bstate[- ]of[- ]the[- ]art\b|\bpeer[- ]reviewed\b|\bwidely (?:adopted|used)\b/gi;
const NEGATED_BEFORE = /\b(?:no|not|none|never|nobody|without|isn't|aren't|hasn't|haven't|wasn't|n't|lacks?)\b[^.!?\n]{0,30}$/i;
const WORD_GAIN = /\b(?:two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|a hundred|a thousand)[- ]?(?:times|fold)\b|\b(?:twice|half) (?:as|the)\b|\b(?:doubles?|triples?|quadruples?|halves)\b/gi;

function unbackedWord(prose: string, re: RegExp, lower: string): string | null {
  for (const match of prose.matchAll(re)) {
    const word = match[0].toLowerCase();
    if (lower.includes(word.slice(0, Math.max(5, word.length - 2)))) continue;
    if (!NEGATED_BEFORE.test(prose.slice(0, match.index))) return match[0];
  }
  return null;
}

/** Words that claim more than a link or a number can show, and a gain written in words so no number check sees it. */
export function unsourcedClaimProblem(prose: string, records: string): string | null {
  const lower = records.toLowerCase();
  const word = unbackedWord(prose, UNSOURCED, lower) ?? unbackedWord(prose, WORD_GAIN, lower);
  return word ? `no source makes that promise: "${word}"` : null;
}

interface Vendor {
  readonly name: RegExp;
  readonly label: string;
  readonly provider: string;
  readonly hosts: RegExp;
}

const VENDORS: readonly Vendor[] = [
  { name: /\bOpenAI\b/, label: 'OpenAI', provider: 'openai', hosts: /(?:^|\.)openai\.com$/ },
  { name: /\bAnthropic\b/, label: 'Anthropic', provider: 'anthropic', hosts: /(?:^|\.)(?:anthropic|claude)\.com$/ },
  { name: /\bGoogle\b/, label: 'Google', provider: 'google', hosts: /(?:^|\.)(?:google\.dev|google\.com|deepmind\.com)$/ },
];
const MAKER_VERBS = /\b(?:shut|shuts|shutting|retire[sd]?|retiring|deprecat\w*|names?|named|announc\w*|launch\w*|ship\w*|released?)\b/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function wrongMaker(prose: string): string | null {
  for (const sentence of prose.split(/\n|(?<=[.!?])\s+/)) {
    if (!MAKER_VERBS.test(sentence)) continue;
    const named = VENDORS.filter((vendor) => vendor.name.test(sentence));
    const makers = findModelIds(sentence).map((mention) => providerOf(mention.id)).filter((provider) => provider !== 'other');
    if (named.length === 1 && makers.length > 0 && makers.every((provider) => provider !== named[0].provider)) return named[0].label;
  }
  return null;
}

/** A vendor a sentence names has to be behind its sources, and can't be the maker of another maker's model. */
export function vendorProblem(prose: string, records: string, sources: readonly string[]): string | null {
  const wrong = wrongMaker(prose);
  if (wrong) return `its sources don't say that about ${wrong}`;
  const lower = records.toLowerCase();
  const hosts = sources.map(hostOf);
  const missing = VENDORS.find((vendor) => vendor.name.test(prose) && !lower.includes(vendor.label.toLowerCase()) && !hosts.some((host) => vendor.hosts.test(host)));
  return missing ? `its sources don't say that about ${missing.label}` : null;
}
