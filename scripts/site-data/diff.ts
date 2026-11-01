// A `git format-patch` file, parsed into what a browser can show. The author line
// is dropped on purpose: a name and an email don't belong on the projector.
export interface Hunk {
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: string[];
}

export interface DiffFile {
  path: string;
  old_path: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: Hunk[];
  truncated?: { reason: string; shown_lines: number; total_lines: number };
}

export interface ParsedPatch { subject: string; date: string | null; files: DiffFile[] }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$/;
const LOCKFILE_LINES = 24;
const FILE_LINES = 400;

interface Cursor { files: DiffFile[]; at: number }

function parseSubject(lines: string[]): string {
  const start = lines.findIndex((l) => l.startsWith('Subject: '));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && !l.startsWith(' '));
  const raw = lines.slice(start, end < 0 ? undefined : end).map((l) => l.replace(/^Subject: /, '').trim()).join(' ');
  return raw.replace(/^\[PATCH[^\]]*\]\s*/, '');
}

function readHunk(lines: string[], at: number, match: RegExpMatchArray): { hunk: Hunk; next: number } {
  const old_lines = match[2] === undefined ? 1 : Number(match[2]);
  const new_lines = match[4] === undefined ? 1 : Number(match[4]);
  const body: string[] = [];
  let [oldLeft, newLeft, i] = [old_lines, new_lines, at + 1];
  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const line = lines[i];
    if (line.startsWith('+')) newLeft -= 1;
    else if (line.startsWith('-')) oldLeft -= 1;
    else if (!line.startsWith('\\')) { oldLeft -= 1; newLeft -= 1; }
    body.push(line);
    i += 1;
  }
  if (lines[i]?.startsWith('\\')) { body.push(lines[i]); i += 1; }
  const hunk: Hunk = { header: lines[at], old_start: Number(match[1]), old_lines, new_start: Number(match[3]), new_lines, lines: body };
  return { hunk, next: i };
}

function fileHeader(line: string): { old_path: string; path: string } {
  const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return m ? { old_path: m[1], path: m[2] } : { old_path: '', path: '' };
}

function readFile(lines: string[], at: number): { file: DiffFile; next: number } {
  const { old_path, path } = fileHeader(lines[at]);
  let status: DiffFile['status'] = old_path === path ? 'modified' : 'renamed';
  let binary = false;
  const hunks: Hunk[] = [];
  let i = at + 1;
  while (i < lines.length && !lines[i].startsWith('diff --git ')) {
    const line = lines[i];
    const match = line.match(HUNK);
    if (match) {
      const { hunk, next } = readHunk(lines, i, match);
      hunks.push(hunk);
      i = next;
      continue;
    }
    if (line.startsWith('new file mode')) status = 'added';
    if (line.startsWith('deleted file mode')) status = 'deleted';
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) binary = true;
    if (line === '-- ' || line === '--') break;
    i += 1;
  }
  const changed = hunks.flatMap((h) => h.lines);
  return {
    file: {
      path, old_path, status, binary, hunks,
      additions: changed.filter((l) => l.startsWith('+')).length,
      deletions: changed.filter((l) => l.startsWith('-')).length,
    },
    next: i,
  };
}

export function parsePatch(text: string): ParsedPatch {
  const lines = text.split('\n');
  const date = lines.find((l) => l.startsWith('Date: '))?.slice('Date: '.length).trim() ?? null;
  const start: Cursor = { files: [], at: lines.findIndex((l) => l.startsWith('diff --git ')) };
  let cursor = start;
  while (cursor.at >= 0 && cursor.at < lines.length) {
    if (!lines[cursor.at].startsWith('diff --git ')) { cursor = { ...cursor, at: cursor.at + 1 }; continue; }
    const { file, next } = readFile(lines, cursor.at);
    cursor = { files: [...cursor.files, file], at: next };
  }
  return { subject: parseSubject(lines), date, files: cursor.files };
}

function capHunks(hunks: Hunk[], limit: number): Hunk[] {
  return hunks.reduce<{ kept: Hunk[]; left: number }>((state, hunk) => {
    if (state.left <= 0) return state;
    const lines = hunk.lines.slice(0, state.left);
    return { kept: [...state.kept, { ...hunk, lines }], left: state.left - lines.length };
  }, { kept: [], left: limit }).kept;
}

/** Keeps a diff small enough to show. The counts always describe the whole file, and `truncated` says what was cut. */
export function trimFile(file: DiffFile): DiffFile {
  const lockfile = LOCKFILE.test(file.path);
  const limit = lockfile ? LOCKFILE_LINES : FILE_LINES;
  const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  if (total <= limit) return file;
  return {
    ...file,
    hunks: capHunks(file.hunks, limit),
    truncated: { reason: lockfile ? 'generated lockfile' : 'very long diff', shown_lines: limit, total_lines: total },
  };
}
