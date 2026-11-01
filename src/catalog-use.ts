// A file naming many models is a table. Whether an id in it matters depends on who reads that table: a picker or a
// lookup can send it, a table of context-window sizes can't, and a table nothing imports sends nothing at all.
import { pathContext } from './code-context.ts';

export type CatalogKind = 'picker' | 'limits' | 'unused';
export type CatalogUse = (file: string, ids: readonly string[]) => CatalogKind;

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rs|go|rb|php|java|kt|svelte|vue)$/;
const SIZE_ENTRY = /^\s*["'`]?[\w./:-]+["'`]?\s*:\s*[\d_]+\s*,?\s*$/;
const LIMIT_SHARE = 0.8;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function baseName(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '');
}

/** Lines of the table that map an id to a number and nothing else. */
function isLimitsTable(text: string, ids: readonly string[]): boolean {
  const entries = text.split('\n').filter((line) => ids.some((id) => line.includes(id)));
  return entries.length > 0 && entries.filter((line) => SIZE_ENTRY.test(line)).length / entries.length >= LIMIT_SHARE;
}

function importedByCode(file: string, files: ReadonlyMap<string, string>, ignore: (path: string) => boolean = () => false): boolean {
  const name = escapeRegex(baseName(file));
  const importing = new RegExp(`(?:\\bfrom\\s+|\\bimport\\s+|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*|\\buse\\s+)["'\`]?[\\w@./:-]*\\b${name}(?:\\.\\w+)?(?:["'\`\\s;)]|$)`, 'm');
  for (const [path, text] of files) {
    if (path === file || !CODE_FILE.test(path) || pathContext(path) === 'test' || ignore(path)) continue;
    if (text.length < 2_000_000 && importing.test(text)) return true;
  }
  return false;
}

export function catalogUse(files: ReadonlyMap<string, string>): CatalogUse {
  return (file, ids) => {
    const text = files.get(file) ?? '';
    if (isLimitsTable(text, ids)) return 'limits';
    return importedByCode(file, files) ? 'picker' : 'unused';
  };
}

/** Code under an examples folder that isn't at the top of the repo: a developer's script inside a source tree. */
const NESTED_EXAMPLE = /^(.+\/(?:examples?|samples?)\/)/;

/**
 * A top-level examples/ folder and any example config are things users copy, so what they name counts as sent.
 * A script deep in a source tree that only other scripts in its folder load is sent by nobody when the product runs.
 */
export function unloadedExampleLookup(files: ReadonlyMap<string, string>): (file: string) => boolean {
  const answers = new Map<string, boolean>();
  return (file) => {
    const known = answers.get(file);
    if (known !== undefined) return known;
    const folder = file.match(NESTED_EXAMPLE)?.[1];
    const answer = Boolean(folder) && CODE_FILE.test(file) && !importedByCode(file, files, (path) => path.startsWith(folder as string));
    answers.set(file, answer);
    return answer;
  };
}

const DATA_FILE = /\.(?:json|csv|tsv)$/;
const NOT_DATA = /(?:^|\/)(?:package|tsconfig|manifest|config|settings|[^/]*\.config|[^/]*\.settings)\.json$/;

/** A data file holds ids without sending them, however few it names. YAML and TOML are configs someone copies, so they count as sent. */
export function isDataFile(file: string): boolean {
  return DATA_FILE.test(file) && !NOT_DATA.test(file) && pathContext(file) === 'config';
}

/** A list of models the code refuses: an id on it is the opposite of being sent. */
const REFUSED_LIST = /(?:NO|NOT|UNSUPPORTED|DISABLED|BLOCKED|SKIP|EXCLUDE\w*)_\w*MODELS|\b(?:disabled|excluded|unsupported|blocked|denied|ignored)\w*Models?\b|\bnoAgent\w*|[Ff]ilteredModels/;
const REFUSED_AFTER = /^\s*\]\s*\.(?:includes|indexOf)\([^)]{0,80}\)\s*(?:===\s*false|<\s*0|===\s*-1)/;
const LIST_REACH = 40;
const CASE_REACH = 2;

function linesOf(cache: Map<string, readonly string[]>, files: ReadonlyMap<string, string>, file: string): readonly string[] {
  const known = cache.get(file) ?? files.get(file)?.split('\n') ?? [];
  cache.set(file, known);
  return known;
}

function namedAbove(lines: readonly string[], line: number): boolean {
  for (let index = line - 1; index >= Math.max(0, line - 1 - LIST_REACH); index -= 1) {
    if (REFUSED_LIST.test(lines[index] ?? '')) return true;
    if (index < line - 1 && /^\s*[\]}]/.test(lines[index] ?? '')) return false;
  }
  return false;
}

/** ["a", "b"].includes(model) === false: the list closes with the refusal. */
function refusedBelow(lines: readonly string[], line: number): boolean {
  for (let index = line; index < Math.min(lines.length, line + LIST_REACH); index += 1) {
    const text = lines[index] ?? '';
    if (/^\s*\]/.test(text)) return REFUSED_AFTER.test(text);
  }
  return false;
}

export function exclusionLookup(files: ReadonlyMap<string, string>): (file: string, line: number) => boolean {
  const cache = new Map<string, readonly string[]>();
  return (file, line) => {
    const lines = linesOf(cache, files, file);
    return namedAbove(lines, line) || refusedBelow(lines, line);
  };
}

/** case "cometapi": return "gpt-5-mini": a switch over providers says who this id really goes to. */
export function caseLookup(files: ReadonlyMap<string, string>): (file: string, line: number) => string | null {
  const cache = new Map<string, readonly string[]>();
  return (file, line) => {
    const lines = linesOf(cache, files, file);
    for (let index = line - 2; index >= Math.max(0, line - 1 - CASE_REACH); index -= 1) {
      const match = lines[index]?.match(/^\s*case\s+["'`]([\w-]+)["'`]\s*:/);
      if (match) return match[1];
    }
    return null;
  };
}
