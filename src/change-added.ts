// What a change may add. Everything is compared as whole tokens against the finding's record, which holds what keepup's
// sources said and never what a repo says: the text of a flagged line isn't in it, so a comment can't widen anything.
import type { Finding } from './run-shape.ts';

export type EditKind = 'swap' | 'behind-a-setting';

export interface FindingRecord {
  /** Words in the finding's own title, reasons, options and sources. */
  readonly tokens: ReadonlySet<string>;
  /** Hosts its sources and options name. */
  readonly hosts: ReadonlySet<string>;
  /** Whole words its sources and options name: only these can name a model or a command. */
  readonly sourced: ReadonlySet<string>;
  /** A file the finding points at, which prose can name without it reading as a host. */
  readonly files: ReadonlySet<string>;
  readonly isRetired: (id: string) => boolean;
}

export interface Catalog {
  readonly isRetired: (id: string) => boolean;
  /** Where a shut-down id's chain of successors ends, live: these ids can be moved to. */
  readonly liveEnds: readonly string[];
}

const NO_CATALOG: Catalog = { isRetired: () => false, liveEnds: [] };
const WORD_SPLIT = /[^\w@/.+-]+/;

const tokensOf = (text: string): string[] => text.toLowerCase().split(WORD_SPLIT).map((word) => word.replace(/^[./]+|[./]+$/g, '')).filter(Boolean);

const URLS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)>\]]+/gi;
const PROTOCOL_RELATIVE = /(?<![:\w])\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const BARE_HOST = /(?<![\w@/.-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?![\w-])/gi;
const IP = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g;
const NAME_AND_PORT = /(?<![\w.-])[a-z][\w.-]*:\d{2,5}(?![\w.])/gi;
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g;
const MODEL_IDS = /(?<![\w.-])(?:(?:gpt|chatgpt|claude|gemini|whisper|tts|text-embedding|dall-e|mistral|deepseek|command|grok)-[\w.-]*\w|o[134](?:-[\w.-]*\w)?|llama-?\d(?:[\w.-]*\w)?)/gi;
const SHELL = /\b(?:curl\b|wget\b|sudo\b|bash\s+-c|sh\s+-c|chmod\b|rm\s+-rf|npx\b|npm\s+(?:i|install|run|exec)\b|yarn\s+add\b|pnpm\s+add\b|pip3?\s+install\b)/gi;
const RUNS_OR_REACHES_OUT = /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bexec[a-zA-Z]*\s*\(|\bspawn[a-zA-Z]*\s*\(|\bchild_process\b|\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*|fork)\b|\bgetattr\s*\(|\bglobals\s*\(|\b__import__\b|\b__builtins__\b|\bimportlib\b|\bcompile\s*\(|\bvm\.\w+|\bReflect\.\w+|\.constructor\b|\bpickle\b|\bmarshal\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\b(?:http|https|net|tls|dgram|dns)\.(?:request|get|connect|createConnection|lookup)\b|\brequests\.\w+|\burllib\b|\bhttpx\b|\bsocket\b|\baiohttp\b|\baxios\b/g;
const ENV_READ = /\bprocess\.env\b(?:\.\w+|\[[^\]]+\])?|\bimport\.meta\.env\b(?:\.\w+)?|\bDeno\.env\b|\bBun\.env\b|\bos\.environ\b(?:\[[^\]]+\]|\.get\([^)]*\))?|\bos\.getenv\([^)]*\)|(?<![\w.])getenv\([^)]*\)|\bENV\[[^\]]+\]/g;
const WHOLE_ENV = /^(?:process\.env|import\.meta\.env|Deno\.env|Bun\.env|os\.environ)$/;
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const ANY_IMPORT = /\brequire\s*\([^)]*\)|\bimport\s*\([^)]*\)|^\s*import\b[^\n]*|^\s*from\s+\S+\s+import\b[^\n]*|\bfrom\s*['"][^'"]+['"]/gm;
const COMPUTED_IMPORT = /\b(?:require|import)\s*\(\s*[^'"\s)]/g;
const JS_IMPORTS = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const PY_IMPORTS = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*))/gm;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const PROSE_FILE = /\.(?:py|[cm]?[jt]sx?|json|ya?ml|toml|txt|md|html|css|env)$/;

const allOf = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((match) => match[0]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function hostsInProse(text: string): string[] {
  const urls = allOf(text, URLS);
  const rest = text.replace(URLS, ' ');
  const relative = [...rest.matchAll(PROTOCOL_RELATIVE)].map((match) => match[1]);
  return [...urls.map(hostOf), ...relative, ...allOf(rest, BARE_HOST), ...allOf(rest, IP), ...allOf(rest, NAME_AND_PORT)].map((host) => host.toLowerCase());
}

/** In code a dotted name is usually a member, so a bare host counts only inside a string. A URL or an address counts anywhere. */
function hostsInCode(text: string): string[] {
  const urls = allOf(text, URLS);
  const rest = text.replace(URLS, ' ');
  const relative = [...rest.matchAll(PROTOCOL_RELATIVE)].map((match) => match[1]);
  const inStrings = allOf(rest, STRING_LITERAL).flatMap((literal) => [...allOf(literal, BARE_HOST), ...allOf(literal, NAME_AND_PORT)]);
  return [...urls.map(hostOf), ...relative, ...allOf(rest, IP), ...inStrings].map((host) => host.toLowerCase());
}

export function findingRecord(finding: Finding, catalog: Catalog = NO_CATALOG): FindingRecord {
  const options = finding.options.map((option) => `${option.name} ${option.what} ${option.needs} ${option.source}`);
  const sourced = [...options, ...finding.sources, ...(finding.evidence ?? [])].join('\n');
  const paths = finding.where.map((place) => place.file);
  return {
    tokens: new Set(tokensOf([finding.title, finding.why, sourced].join('\n'))),
    hosts: new Set(hostsInProse(sourced)),
    sourced: new Set([...tokensOf(sourced), ...allOf(sourced, SHELL).map((word) => word.toLowerCase()), ...catalog.liveEnds.map((id) => id.toLowerCase())]),
    files: new Set(paths.flatMap((path) => [path.toLowerCase(), (path.split('/').pop() ?? path).toLowerCase()]).filter((name) => PROSE_FILE.test(name))),
    isRetired: catalog.isRetired,
  };
}

/** What a replace adds that its search didn't hold. */
function added(replace: string, search: string, extract: (text: string) => string[]): string[] {
  const before = new Set(extract(search).map((item) => item.toLowerCase()));
  return [...new Set(extract(replace))].filter((item) => !before.has(item.toLowerCase()));
}

const ranOrReached = (text: string) => allOf(text, RUNS_OR_REACHES_OUT);

function packagesIn(text: string): string[] {
  const js = [...text.matchAll(JS_IMPORTS)].map((match) => match[1]).filter((name) => !name.startsWith('.') && !name.startsWith('/') && !name.startsWith('node:'));
  const py = [...text.matchAll(PY_IMPORTS)].map((match) => match[1] ?? match[2]);
  return [...js, ...py];
}

function modelProblem(ids: readonly string[], record: FindingRecord): string | null {
  const unnamed = ids.find((id) => !record.sourced.has(id.toLowerCase()));
  if (unnamed) return `a model id that isn't in the finding's sources or options: ${unnamed}`;
  const dead = ids.find((id) => record.isRetired(id));
  return dead ? `${dead}, which its provider has already shut down` : null;
}

/** What code and prose share: hosts, shell commands and model ids. */
function commonProblem(hosts: readonly string[], shell: readonly string[], models: readonly string[], record: FindingRecord): string | null {
  const host = hosts.find((item) => !record.hosts.has(item));
  if (host) return `a host the finding doesn't name: ${host}`;
  const command = shell.find((item) => !record.sourced.has(item.toLowerCase()));
  if (command) return `a shell command the finding doesn't name: ${command}`;
  return modelProblem(models, record);
}

function envProblem(read: string, kind: EditKind): string | null {
  if (WHOLE_ENV.test(read)) return `a read of the whole environment: ${read}`;
  if (SECRET_ENV.test(read)) return `a read of a secret from the environment: ${read}`;
  return kind === 'swap' ? `an environment read, which a small swap has no reason for: ${read}` : null;
}

function importProblem(edit: { search: string; replace: string }, kind: EditKind, record: FindingRecord): string | null {
  const computed = added(edit.replace, edit.search, (text) => allOf(text, COMPUTED_IMPORT));
  if (computed.length > 0) return `an import worked out at runtime: ${computed[0]}`;
  if (kind === 'swap') {
    const fresh = added(edit.replace, edit.search, (text) => allOf(text, ANY_IMPORT).map((item) => item.trim()));
    return fresh.length > 0 ? `a new import, which a small swap has no reason for: ${fresh[0]}` : null;
  }
  const name = added(edit.replace, edit.search, packagesIn).find((item) => !record.tokens.has(item.toLowerCase()));
  return name ? `a package the finding doesn't name: ${name}` : null;
}

const codeOnly = (text: string): string => text.replace(STRING_LITERAL, '""').replace(COMMENT, ' ').replace(MODEL_IDS, ' ');
const DATA_FILE = /\.(?:json|ya?ml|toml|txt|md)$/i;

/** A small swap moves a value. A name that isn't in the file, the edit or the finding is something else coming along. */
function newIdentifier(edit: { search: string; replace: string }, fileText: string, record: FindingRecord): string | undefined {
  const known = new Set([...allOf(codeOnly(fileText), IDENTIFIER), ...allOf(codeOnly(edit.search), IDENTIFIER)]);
  return allOf(codeOnly(edit.replace), IDENTIFIER).find((name) => !known.has(name) && !record.tokens.has(name.toLowerCase()));
}

/** Null when an edit adds nothing out of bounds, else what it added. */
export function addedProblem(edit: { file: string; search: string; replace: string }, record: FindingRecord, kind: EditKind, fileText: string): string | null {
  const says = (what: string) => `${edit.file}: the change adds ${what}`;
  const danger = added(edit.replace, edit.search, ranOrReached)[0];
  if (danger) return says(`code that runs something or reaches the network: ${danger}`);
  const env = added(edit.replace, edit.search, (text) => allOf(text, ENV_READ)).map((read) => envProblem(read, kind)).find(Boolean);
  if (env) return says(env);
  const imported = importProblem(edit, kind, record);
  if (imported) return says(imported);
  const common = commonProblem(added(edit.replace, edit.search, hostsInCode), added(edit.replace, edit.search, (text) => allOf(text, SHELL)), added(edit.replace, edit.search, (text) => allOf(text, MODEL_IDS)), record);
  if (common) return says(common);
  const name = kind === 'swap' && !DATA_FILE.test(edit.file) ? newIdentifier(edit, fileText, record) : undefined;
  return name ? says(`a name that isn't in this file or the finding: ${name}`) : null;
}

/** The same bounds for words a person reads: a summary, a title, written steps. A retired id can be named here, since that's what the finding is about. */
export function proseProblem(text: string, record: FindingRecord): string | null {
  const hosts = hostsInProse(text).filter((host) => !record.files.has(host));
  return commonProblem(hosts, allOf(text, SHELL), [], { ...record, isRetired: () => false }) ?? modelProblem(allOf(text, MODEL_IDS).filter((id) => !record.tokens.has(id.toLowerCase())), record);
}

/** Whether these edits add a model id at all. */
export const addsModelId = (edit: { search: string; replace: string }): boolean => added(edit.replace, edit.search, (text) => allOf(text, MODEL_IDS)).length > 0;
