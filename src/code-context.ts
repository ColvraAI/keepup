// Tells real code from tests, examples and docs, because the same model id means different
// things in each: a retired id in a test fixture never reaches a provider.

export type CodeContext = 'test' | 'example' | 'docs' | 'config' | 'code';

export interface LineContext {
  readonly context: CodeContext;
  readonly commented: boolean;
  readonly test_block_line?: number;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

const TEST_DIRS = /(?:^|\/)(?:test|tests|__tests__|__mocks__|spec|specs|e2e|fixtures|__fixtures__|testdata|test-data|benches)\//;
const TEST_FILES = /(?:\.(?:test|spec)\.[a-z]+|_tests?\.[a-z]+|(?:^|\/)test_[^/]+\.[a-z]+|(?:^|\/)tests?\.[a-z]+|(?:^|\/)conftest\.py|(?:^|\/)integration[-_][^/]+\.(?:toml|ya?ml|json))$/;
const EXAMPLE_PATHS = /(?:^|\/)(?:examples?|samples?)\/|(?:^|\/)quickstart[^/]*$|\.example(?:\.[a-z]+)?$/;
const DOC_PATHS = /(?:^|\/)(?:docs?|documentation)\//;
const CONFIG_FILES = /\.(?:toml|ya?ml|json|ini|cfg|conf)$|(?:^|\/)\.env[^/]*$/;
const HASH_COMMENTS = /\.(?:py|rb|toml|ya?ml|sh|bash|ex|exs|ini|cfg|conf)$|(?:^|\/)\.env[^/]*$/;
const SLASH_COMMENTS = /^\s*(?:\/\/|\/\*|\*(?:\s|$|\/))/;
const HASH_COMMENT = /^\s*#/;

export function pathContext(path: string): CodeContext {
  if (TEST_DIRS.test(path) || TEST_FILES.test(path)) return 'test';
  if (EXAMPLE_PATHS.test(path)) return 'example';
  if (DOC_PATHS.test(path)) return 'docs';
  if (CONFIG_FILES.test(path)) return 'config';
  return 'code';
}

function isCommented(path: string, line: string): boolean {
  return HASH_COMMENTS.test(path) ? HASH_COMMENT.test(line) : SLASH_COMMENTS.test(line);
}

const TOKEN_START = new Set(['"', "'", '/', 'b', 'r']);

/** Skips a Rust string, raw string, char or comment starting at `i`; returns the index after it, or `i` if none starts there. */
function skipRustToken(text: string, i: number): number {
  if (!TOKEN_START.has(text[i])) return i;
  const rest = text.slice(i, i + 64);
  const raw = rest.match(/^b?r(#*)"/);
  if (raw) {
    const close = text.indexOf(`"${raw[1]}`, i + raw[0].length);
    return close === -1 ? text.length : close + 1 + raw[1].length;
  }
  if (text[i] === '"') return skipRustString(text, i + 1);
  if (rest.startsWith('//')) {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end;
  }
  if (rest.startsWith('/*')) {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  const char = rest.match(/^'(?:\\.[^']*|[^\\'])'/);
  return char ? i + char[0].length : i;
}

function skipRustString(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** Where the scan for a block's closing brace stopped: at it, at a `;` with no block, or at the end of the file. */
interface BlockScan {
  readonly end: number;
  readonly reachedEof: boolean;
  readonly opened: boolean;
}

function blockEnd(text: string, from: number): BlockScan {
  let depth = 0;
  let opened = false;
  let i = from;
  while (i < text.length) {
    const next = skipRustToken(text, i);
    if (next !== i) { i = next; continue; }
    const char = text[i];
    if (char === ';' && depth === 0) return { end: -1, reachedEof: false, opened };
    if (char === '{') { depth += 1; opened = true; }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return { end: i, reachedEof: false, opened };
    }
    i += 1;
  }
  return { end: -1, reachedEof: true, opened };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOfIndex(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

const SCAN_BUDGET_FACTOR = 4;

/** Line ranges of #[cfg(test)] blocks and lone #[test] functions in Rust source, from 1. Linear: scanning stops at a budget, or at a dead end no later attribute can escape. */
export function rustTestBlocks(text: string): LineRange[] {
  const out: LineRange[] = [];
  const attribute = /#\[(?:cfg\(test\)|(?:tokio::)?test(?:\([^)]{0,200}\))?)\]/g;
  const starts = lineStarts(text);
  let searchFrom = 0;
  let budget = text.length * SCAN_BUDGET_FACTOR;
  for (let match = attribute.exec(text); match && budget > 0; match = attribute.exec(text)) {
    if (match.index < searchFrom) continue;
    const afterAttribute = match.index + match[0].length;
    const scan = blockEnd(text, afterAttribute);
    budget -= (scan.end === -1 ? text.length : scan.end) - afterAttribute;
    if (scan.reachedEof && !scan.opened) break;
    if (scan.end === -1) continue;
    out.push({ start: lineOfIndex(starts, match.index), end: lineOfIndex(starts, scan.end) });
    searchFrom = scan.end;
  }
  return out;
}

/** A per-file lookup: line number to what kind of code that line is. */
export function contextFor(path: string, text: string): (line: number) => LineContext {
  const base = pathContext(path);
  const lines = text.split('\n');
  const blocks = base !== 'test' && path.endsWith('.rs') ? rustTestBlocks(text) : [];
  return (line) => {
    const commented = isCommented(path, lines[line - 1] ?? '');
    const block = blocks.find((range) => line >= range.start && line <= range.end);
    return block ? { context: 'test', test_block_line: block.start, commented } : { context: base, commented };
  };
}
