// Runs db/patterns as data: each line against each pattern, only in that pattern's file types.
// skip_files drops a file before a pattern runs on it. A hit is dropped when a skip_if_near sign
// appears within 20 lines, and all of a pattern's hits in a file go when a skip_if_in_file sign
// appears anywhere in it. skip_files and skip_if_in_file are optional. A find can name its own files,
// when the line alone can't tell. No pattern lives in code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRepoFiles, repoName, type RepoFile } from './git-files.ts';
import { matchesAnyGlob } from './glob.ts';
import { maskText } from './mask.ts';
import { gated, type GatedRegex, mayMatch } from './regex-literals.ts';
import { compileRegex, MAX_LINE_CHARS, REPO_ROOT, SCAN_BUDGET_MS } from './signals.ts';

const NEAR_LINES = 20;
const MAX_TEXT = 500;
const REQUIRED_FIELDS = ['id', 'name', 'find', 'skip_if_near', 'files'] as const;

export interface FindRule extends GatedRegex {
  /** Only these of the pattern's files: stripe==12.0 is a dependency in a requirements file and nothing in a docstring. */
  readonly files?: readonly string[];
}

export interface Pattern {
  readonly id: string;
  readonly name: string;
  readonly find: readonly FindRule[];
  readonly skipIfNear: readonly RegExp[];
  readonly files: readonly string[];
  readonly skipFiles: readonly string[];
  readonly skipIfInFile: readonly RegExp[];
  /** True of a whole repo or not at all: a sign anywhere in it, a manifest included, answers it. */
  readonly absence?: boolean;
}

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly text: string;
}

export interface ScanCounts {
  readonly files: number;
  readonly lines: number;
  /** Files never reached because the scan ran out of its time budget. Only there when that happened. */
  readonly over_time?: number;
}

export interface ScanOutput {
  readonly version: 1;
  readonly repo: string;
  readonly commit: string | null;
  readonly hits: readonly Hit[];
  readonly checked: ScanCounts;
}

function stringList(raw: Record<string, unknown>, field: string, name: string): readonly string[] {
  const value = raw[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${name}: "${field}" must be a list of strings`);
  }
  return value;
}

function parsePatternFile(path: string, name: string): Pattern {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Can't read ${name}: ${(error as Error).message}`);
  }
  const missing = REQUIRED_FIELDS.filter((field) => raw[field] === undefined);
  if (missing.length) throw new Error(`${name} is missing ${missing.join(', ')}`);
  if (!Array.isArray(raw.find)) throw new Error(`${name}: "find" must be a list`);
  const find = raw.find as ({ regex: string; flags?: string } & Record<string, unknown>)[];
  if (find.some((entry) => typeof entry?.regex !== 'string')) throw new Error(`${name}: every "find" entry needs a "regex"`);
  const compile = (field: string) => stringList(raw, field, name).map((regex) => compileRegex(regex, '', { label: name }));
  return {
    id: raw.id as string,
    name: raw.name as string,
    find: find.map((f) => ({ ...gated(compileRegex(f.regex, f.flags, { label: name })), ...(f.files === undefined ? {} : { files: stringList(f, 'files', name) }) })),
    skipIfNear: compile('skip_if_near'),
    files: stringList(raw, 'files', name),
    skipFiles: stringList(raw, 'skip_files', name),
    skipIfInFile: compile('skip_if_in_file'),
    ...(raw.absence === true ? { absence: true } : {}),
  };
}

export function loadPatterns(dir = join(REPO_ROOT, 'db', 'patterns')): Pattern[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^PAT-.*\.json$/.test(name))
    .sort()
    .map((name) => parsePatternFile(join(dir, name), name));
}

function holdsSign(line: string, signs: readonly RegExp[]): boolean {
  return line.length <= MAX_LINE_CHARS && signs.some((re) => re.test(line));
}

function isHandledNearby(lines: readonly string[], index: number, pattern: Pattern): boolean {
  if (pattern.skipIfNear.length === 0) return false;
  const from = Math.max(0, index - NEAR_LINES);
  const to = Math.min(lines.length - 1, index + NEAR_LINES);
  for (let i = from; i <= to; i += 1) {
    if (holdsSign(lines[i], pattern.skipIfNear)) return true;
  }
  return false;
}

function isHandledInFile(lines: readonly string[], pattern: Pattern): boolean {
  return pattern.skipIfInFile.length > 0 && lines.some((line) => holdsSign(line, pattern.skipIfInFile));
}

function matchesFind(rules: readonly GatedRegex[], line: string): boolean {
  return line.length <= MAX_LINE_CHARS && rules.some((rule) => mayMatch(rule.gate, line) && rule.re.test(line));
}

/** Most patterns have nothing to look for in most files, so the gate runs on the whole file first. */
function hitsForPattern(file: RepoFile, pattern: Pattern, lines: readonly string[]): Hit[] {
  const rules = pattern.find.filter((rule) => (rule.files === undefined || matchesAnyGlob(file.path, rule.files)) && mayMatch(rule.gate, file.text));
  if (rules.length === 0) return [];
  const out: Hit[] = [];
  lines.forEach((text, index) => {
    if (!matchesFind(rules, text)) return;
    if (isHandledNearby(lines, index, pattern)) return;
    out.push({ file: file.path, line: index + 1, pattern: pattern.id, text: text.replace(/\r$/, '').slice(0, MAX_TEXT) });
  });
  return out.length > 0 && isHandledInFile(lines, pattern) ? [] : out;
}

function appliesTo(path: string, pattern: Pattern): boolean {
  return matchesAnyGlob(path, pattern.files) && !matchesAnyGlob(path, pattern.skipFiles);
}

function compareHits(a: Hit, b: Hit): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
}

const MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[\w.-]*\.txt|Cargo\.toml|go\.mod|Gemfile)$/;

/** A manifest or a file this pattern reads holds a sign. A lock file doesn't count: a dependency's dependency isn't this product's choice. */
function answeredInRepo(files: readonly RepoFile[], pattern: Pattern): boolean {
  return files.some((file) => (MANIFEST.test(file.path) || appliesTo(file.path, pattern)) && isHandledInFile(file.text.split('\n'), pattern));
}

/** The core: any iterable of {path, text}, so it can later scan a tarball too. */
export function scanFiles(given: Iterable<RepoFile>, patterns: readonly Pattern[], budgetMs: number = SCAN_BUDGET_MS): { hits: Hit[]; checked: ScanCounts } {
  const files = [...given];
  const answered = new Set(patterns.filter((pattern) => pattern.absence && answeredInRepo(files, pattern)).map((pattern) => pattern.id));
  const hits: Hit[] = [];
  let fileCount = 0;
  let lineCount = 0;
  let overTime = 0;
  const deadline = performance.now() + budgetMs;
  for (const file of files) {
    const applicable = patterns.filter((pattern) => !answered.has(pattern.id) && appliesTo(file.path, pattern));
    if (applicable.length === 0) continue;
    if (performance.now() > deadline) { overTime += 1; continue; }
    const text = maskText(file.text);
    const masked: RepoFile = { path: file.path, text };
    const lines = text.split('\n');
    fileCount += 1;
    lineCount += lines.length;
    hits.push(...applicable.flatMap((pattern) => hitsForPattern(masked, pattern, lines)));
  }
  return { hits: hits.sort(compareHits), checked: { files: fileCount, lines: lineCount, ...(overTime ? { over_time: overTime } : {}) } };
}

export interface ScanOptions {
  readonly commit?: string;
  readonly patternsDir?: string;
}

export function scanRepo(path: string, options: ScanOptions = {}): ScanOutput {
  const { commit, files } = listRepoFiles(path, { commit: options.commit });
  const { hits, checked } = scanFiles(files, loadPatterns(options.patternsDir));
  return { version: 1, repo: repoName(path), commit, hits, checked };
}
