// What kinds of new thing this repo could use. Deterministic, from its own languages, so nothing a repo
// or a model says can widen it: a Rust repo skips Python and TS libraries unless they ship an MCP server or an API.
import type { Facts } from './facts.ts';
import type { DbRecord } from './search.ts';

const MIN_SHARE = 0.15;
const CODE_LANGUAGES = new Set(['JavaScript', 'TypeScript', 'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'Ruby', 'C#', 'Swift', 'PHP', 'Elixir', 'Scala', 'Vue', 'Svelte']);
const JS_FAMILY = new Set(['JavaScript', 'TypeScript', 'Vue', 'Svelte']);
const MCP_WORDS = /(?:^|[^a-z])mcp(?:[^a-z]|$)|model context protocol/i;
const API_WORDS = /\b(?:mcp server|rest api|http api|hosted api|api service)\b/i;
const LOCAL_WEIGHTS = /onnx|transformers\.js|gguf/i;
const JS_WEIGHTS = /onnx|transformers\.js/i;

export interface StackLock {
  readonly languages: readonly string[];
  readonly rules: readonly string[];
  readonly allows: (record: DbRecord) => boolean;
}

/** The repo's own code languages: anything with at least 15% of the code lines, or else the largest. */
export function codeLanguages(facts: Pick<Facts, 'languages'>): string[] {
  const code = facts.languages.filter((entry) => CODE_LANGUAGES.has(entry.language));
  const total = code.reduce((sum, entry) => sum + entry.lines, 0) || 1;
  const big = code.filter((entry) => entry.lines / total >= MIN_SHARE).map((entry) => entry.language);
  return big.length ? big : code.slice(0, 1).map((entry) => entry.language);
}

function shipsServerOrApi(record: DbRecord): boolean {
  const text = `${record.name ?? ''} ${record.description ?? ''} ${(record.keywords ?? []).join(' ')} ${(record.topics ?? []).join(' ')}`;
  return MCP_WORDS.test(text) || API_WORDS.test(text);
}

function modelFits(record: DbRecord, languages: readonly string[]): boolean {
  const weights = `${record.name ?? ''} ${typeof record.library === 'string' ? record.library : ''}`;
  if (languages.includes('Python')) return true;
  if (languages.some((language) => JS_FAMILY.has(language))) return JS_WEIGHTS.test(weights);
  return LOCAL_WEIGHTS.test(weights);
}

function githubFits(record: DbRecord, languages: readonly string[]): boolean {
  const language = typeof record.language === 'string' ? record.language : '';
  const sameFamily = JS_FAMILY.has(language) && languages.some((known) => JS_FAMILY.has(known));
  return languages.includes(language) || sameFamily || shipsServerOrApi(record);
}

function ruleLines(languages: readonly string[]): string[] {
  const js = languages.some((language) => JS_FAMILY.has(language));
  const named = languages.join(' and ') || 'unknown';
  return [
    `Code is ${named}: only libraries in ${named}, unless they ship an MCP server or an API.`,
    languages.includes('Python') ? 'Local models: any format.' : js ? 'Local models: only ONNX or transformers.js weights.' : 'Local models: only ONNX or GGUF weights.',
    'APIs, MCP servers and skills always pass.',
  ];
}

export function stackLock(facts: Pick<Facts, 'languages'>): StackLock {
  const languages = codeLanguages(facts);
  const hasJs = languages.some((language) => JS_FAMILY.has(language));
  const hasPython = languages.includes('Python');
  const allows = (record: DbRecord): boolean => {
    if (record.source === 'npm') return hasJs || shipsServerOrApi(record);
    if (record.source === 'pypi') return hasPython || shipsServerOrApi(record);
    if (record.source === 'github') return githubFits(record, languages);
    if (record.source === 'huggingface') return modelFits(record, languages);
    return true;
  };
  return { languages, rules: ruleLines(languages), allows };
}
