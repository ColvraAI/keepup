// The program's checks on a change a model proposed. All deterministic: none of them reads the model's reasons, and what
// they allow comes from the finding's sources, so a comment in a repo can't widen them. The first failure refuses the whole change.
import { addedProblem, addsModelId, findingRecord, type Catalog, type EditKind, type FindingRecord } from './change-added.ts';
import { manifestProblem } from './change-manifest.ts';
import { offByDefaultProblem } from './change-setting.ts';
import { LONG_LINE_MARKER, maskText } from './mask.ts';
import type { Finding } from './run-shape.ts';

export const MAX_FILES = 10;
export const MAX_CHANGED_LINES = 200;
/** Past this, it isn't a small swap: it has to be off by default. */
export const MAX_SWAP_LINES = 40;

export interface Edit {
  readonly file: string;
  readonly search: string;
  readonly replace: string;
  readonly why: string;
}

/** What git says about a file at the commit. mode is null when the file isn't there. */
export interface RepoFile {
  readonly text: string;
  readonly mode: string | null;
  readonly binary: boolean;
  /** Its bytes don't survive a round trip through UTF-8. */
  readonly notUtf8?: boolean;
}

const MASK_TOKEN = /\[masked[^\]]*\]/i;
/** Source and config a model id can live in. Anything else, a file with no extension among them, isn't a swap's business. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|py|go|rb|java|kt|rs|php|cs|swift|vue|svelte|astro|json|ya?ml|toml|txt|md)$/i;
const CONTROL_DOT_FOLDERS: ReadonlySet<string> = new Set(['.github', '.gitlab', '.circleci', '.husky', '.git', '.vscode', '.devcontainer', '.buildkite', '.travis', '.azure', '.azure-pipelines', '.idea', '.cargo', '.config', '.docker', '.semaphore', '.drone', '.woodpecker', '.forgejo', '.gitea', '.tekton', '.vercel', '.netlify', '.aws', '.ssh', '.yarn', '.pnpm', '.cursor', '.claude']);
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock|[^/]*\.lock)$/;
/** Folders whose files run at build, deploy or install time, whatever they're called. */
const RUN_FOLDERS = /(^|\/)(ci|scripts?|tekton|k8s|kubernetes|charts?|helm|deploy|deployment|terraform|ansible|hooks|githooks|infra|pipelines?)\//i;
const RUN_FILES = /(^|\/)((?:Dockerfile|docker-compose|compose|Jenkinsfile|azure-pipelines|bitbucket-pipelines|appveyor|buildkite|cloudbuild|codemagic|circle|travis|drone|vercel|netlify|render|fly|railway|Taskfile|taskfile|setup|conftest|noxfile|fabfile|tasks|manage|gulpfile|gruntfile|postinstall|preinstall|install|prepare|build|tox|Makefile)(?:\.[^/]*)?|[^/]*\.config\.[^/]+|[^/]*rc\.[cm]?js)$/i;

/** Why this path may never be edited, or null. */
export function forbiddenPath(file: string): string | null {
  const parts = file.split('/');
  const name = parts.at(-1) ?? file;
  if (file.startsWith('/') || parts.includes('..')) return `${file} isn't a path inside the repo`;
  if (name.startsWith('.') || parts.some((part) => CONTROL_DOT_FOLDERS.has(part))) return `${file} is a dotfile or under a dot folder that holds CI, secrets or config`;
  if (LOCKFILE.test(file)) return `${file} is a lockfile`;
  if (RUN_FOLDERS.test(file) || RUN_FILES.test(file)) return `${file} runs at build, test, deploy or install time`;
  if (!SOURCE_FILE.test(name)) return `${file} isn't a source or config file keepup edits`;
  return null;
}

function fileProblem(file: string, repoFile: RepoFile): string | null {
  if (repoFile.mode === null) return `${file} isn't in the repo at this commit`;
  if (repoFile.mode !== '100644') return `${file} is executable or a link (mode ${repoFile.mode})`;
  if (repoFile.binary) return `${file} is a binary file`;
  if (repoFile.notUtf8) return `${file} isn't UTF-8, so editing it as text would damage it`;
  if (repoFile.text.startsWith('#!')) return `${file} starts with #!, so it runs as a command`;
  return null;
}

/** Why a file can't be edited whatever a model says, so nobody pays to be told. */
export function uneditable(file: string, repoFile: RepoFile | undefined): string | null {
  return forbiddenPath(file) ?? (repoFile ? fileProblem(file, repoFile) : `${file} isn't in the repo at this commit`);
}

function occurrences(text: string, part: string): number {
  return part === '' ? 0 : text.split(part).length - 1;
}

/** The whole lines a search touches: a key beside a model id on one line would land on a + line. */
function touchedLines(text: string, search: string): string {
  const at = text.indexOf(search);
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at + search.length);
  return text.slice(start, end === -1 ? text.length : end);
}

function editProblem(edit: Edit, allowed: ReadonlySet<string>, repoFile: RepoFile | undefined, record: FindingRecord, kind: EditKind): string | null {
  if (!allowed.has(edit.file)) return `${edit.file} isn't in the finding's where list`;
  const blocked = uneditable(edit.file, repoFile);
  if (blocked) return blocked;
  if (MASK_TOKEN.test(edit.search) || MASK_TOKEN.test(edit.replace) || edit.search.includes(LONG_LINE_MARKER) || edit.replace.includes(LONG_LINE_MARKER)) return `${edit.file}: the edit holds masked text, which must never be written back`;
  if (maskText(edit.replace) !== edit.replace) return `${edit.file}: the replacement holds something shaped like a secret`;
  if (edit.search === edit.replace) return `${edit.file}: the edit changes nothing`;
  const text = repoFile?.text ?? '';
  const found = occurrences(text, edit.search);
  if (found !== 1) return `${edit.file}: the search text matches ${found} times at this commit, and it has to match exactly once`;
  const line = touchedLines(text, edit.search);
  if (maskText(line) !== line) return `${edit.file}: the line this edits holds something shaped like a key, which would land in the diff. Move the key out first.`;
  return addedProblem(edit, record, kind, text);
}

/** Lines really different between two texts: common lines at either end don't count. */
function changedLines(search: string, replace: string): number {
  const [a, b] = [search.split('\n'), replace.split('\n')];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return a.length - start - end + (b.length - start - end);
}

export const totalChangedLines = (edits: readonly Edit[]): number => edits.reduce((sum, edit) => sum + changedLines(edit.search, edit.replace), 0);

/** The new text of each file, or why not. Each search has to hold once against the commit and still once as edits apply. */
export function applyEdits(edits: readonly Edit[], files: ReadonlyMap<string, RepoFile>): { ok: true; files: Map<string, string> } | { ok: false; reason: string } {
  const out = new Map<string, string>();
  for (const edit of edits) {
    const current = out.get(edit.file) ?? files.get(edit.file)?.text ?? '';
    if (occurrences(current, edit.search) !== 1) return { ok: false, reason: `${edit.file}: two edits overlap, so one no longer matches` };
    out.set(edit.file, current.replace(edit.search, () => edit.replace));
  }
  return { ok: true, files: out };
}

const LANGCHAIN_OPENAI_JS = /(?:import\s*\{[^}]*\bOpenAI\b[^}]*\}\s*from|\{[^}]*\bOpenAI\b[^}]*\}\s*=\s*require\()\s*['"](?:@langchain\/|langchain\/)/;
const LANGCHAIN_OPENAI_PY = /^\s*from\s+langchain[\w.]*\s+import\s+[^\n]*\bOpenAI\b/m;
const LEGACY_COMPLETIONS = /\bopenai\.Completion\.create\b|(?<!chat)\.completions\.create\(|\bcreateCompletion\(/;

/** A client that picks its endpoint from the model's name: a new id can move every call to a different API. */
export function nameRoutedProblem(edits: readonly Edit[], files: ReadonlyMap<string, RepoFile>): string | null {
  const routed = edits.filter(addsModelId).find((edit) => [LANGCHAIN_OPENAI_JS, LANGCHAIN_OPENAI_PY, LEGACY_COMPLETIONS].some((pattern) => pattern.test(files.get(edit.file)?.text ?? '')));
  if (!routed) return null;
  return `${routed.file} calls the model through a client that chooses its API endpoint by the model's name, such as LangChain's OpenAI class or the legacy completions call. A new id there can silently change the endpoint, so this isn't a small swap.`;
}

/** Null when the edits pass everything, else the reason the whole change is refused. */
export function checkEdits(edits: readonly Edit[], finding: Finding, files: ReadonlyMap<string, RepoFile>, kind: EditKind = 'swap', catalog?: Catalog): string | null {
  const allowed = new Set(finding.where.map((place) => place.file));
  const record = findingRecord(finding, catalog);
  if (edits.length === 0) return 'The model proposed no edit.';
  for (const edit of edits) {
    const problem = editProblem(edit, allowed, files.get(edit.file), record, kind);
    if (problem) return problem;
  }
  const touched = new Set(edits.map((edit) => edit.file));
  if (touched.size > MAX_FILES) return `It touches ${touched.size} files, and the limit is ${MAX_FILES}.`;
  const lines = totalChangedLines(edits);
  if (lines > MAX_CHANGED_LINES) return `It changes ${lines} lines, and the limit is ${MAX_CHANGED_LINES}.`;
  const applied = applyEdits(edits, files);
  if (!applied.ok) return applied.reason;
  for (const edit of edits) {
    const problem = manifestProblem(edit, files.get(edit.file)?.text ?? '', applied.files.get(edit.file) ?? '', record);
    if (problem) return problem;
  }
  return kind === 'behind-a-setting' ? offByDefaultProblem(edits) : null;
}
