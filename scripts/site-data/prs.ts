// site/data/prs.json: every pull request as a real tested patch. It says
// "Ready to open" until data/github-objects.json records the real one, and then links to it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { measuredProblem, parseResult, resultNames, type LabResult } from '../../lab/shared/result.ts';
import { parsePatch, trimFile, type DiffFile } from './diff.ts';
import { blobUrl, codeBase, treeUrl, type ForkMap, type LinkedLocation } from './links.ts';
import { findRepoTests, type RepoTests } from './repo-tests.ts';

const PLACEHOLDER = '{{lab.title_number}}';
export const READY_LABEL = 'Ready to open · waits for the keepup App';
const STATUS_LABEL = { ready: READY_LABEL, open: 'Open on the fork', merged: 'Merged on the fork' } as const;

export interface GithubPrRecord {
  number: number; url: string; title: string; state: string; base: string; head: string; author: string;
  stagesApplied: string[]; ci: { state: string; url: string | null }; checkedAt: string; merged?: boolean;
}

export interface PrObjects extends ForkMap { prs: Record<string, GithubPrRecord> }

export type TitleState = 'measured' | 'not measured yet' | 'no number';
export interface RenderedTitle { title: string; state: TitleState; needs?: string }
export interface ResultTable { headers: string[]; rows: string[][]; notes: string }

export interface StageDiff {
  patches: { path: string; subject: string }[];
  missing: string[];
  files: (DiffFile & { patch: string })[];
  additions: number;
  deletions: number;
}

export interface PrStage {
  date: string;
  title: string;
  title_state: TitleState;
  what_shipped: string;
  what_changes: string;
  comment: string | null;
  applied_on_github: boolean;
  diff: StageDiff;
}

export interface LabView {
  dir: string;
  status: LabResult['status'] | 'absent';
  measured_at: string | null;
  title_number: string | null;
  needs: string | null;
  table: ResultTable;
  body: string | null;
  note: string | null;
}

export interface PrView {
  id: string;
  title: string;
  title_state: TitleState;
  needs: string | null;
  status: 'ready' | 'open' | 'merged';
  status_label: string;
  github: { number: number; url: string; state: string; author: string; head: string; base: string; ci: { state: string; url: string | null }; stages_applied: string[]; checked_at: string } | null;
  upstream: string;
  fork: string;
  branch: string | null;
  base_branch: string | null;
  base_commit: string;
  base_commit_url: string;
  spec: string | null;
  source: string | null;
  source_url: string | null;
  where: LinkedLocation[];
  founder_line: string | null;
  effect: string[];
  effort: string | null;
  why_it_fits: string | null;
  risks: string | null;
  rollback: string | null;
  proof: { measured_on_fork: boolean; vendor: unknown; independent: unknown };
  sources: string[];
  lab: LabView;
  repo_tests: RepoTests | null;
  stages: PrStage[];
}

type RawStage = { date: string; patches?: string[]; title: string; titleUnmeasured?: string | null; whatShipped?: string; whatThisChanges?: string; comment?: string | null };
type RawPr = Record<string, unknown> & { id: string; upstream: string; fork?: string; baseCommit: string; stages?: RawStage[] };

export function renderPrTitle(stage: Pick<RawStage, 'title'>, result: LabResult | null): RenderedTitle {
  if (!stage.title.includes(PLACEHOLDER)) return { title: stage.title, state: 'no number' };
  if (result?.status === 'measured' && result.title_number) return { title: stage.title.split(PLACEHOLDER).join(result.title_number), state: 'measured' };
  const before = stage.title.slice(0, stage.title.indexOf(PLACEHOLDER)).replace(/[\s·:-]+$/, '');
  return { title: before, state: 'not measured yet', needs: result?.needs ?? 'a lab run' };
}

const splitRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableLine = (line: string): boolean => line.trim().startsWith('|');
const isSeparator = (line: string): boolean => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

export function parseResultTable(body: string): ResultTable {
  const lines = body.split('\n');
  const start = lines.findIndex((l, i) => isTableLine(l) && isSeparator(lines[i + 1] ?? ''));
  if (start < 0) return { headers: [], rows: [], notes: body.trim() };
  const rest = lines.slice(start);
  const length = rest.findIndex((l) => !isTableLine(l));
  const table = length < 0 ? rest : rest.slice(0, length);
  const notes = [...lines.slice(0, start), ...lines.slice(start + table.length)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { headers: splitRow(table[0]), rows: table.slice(2).map(splitRow), notes };
}

/** A variant ("01-jev" from pr-jev.json) has its own numbers, and never borrows the main result. */
function resultFile(id: string): string {
  const dash = id.indexOf('-');
  return dash < 0 ? 'result.md' : `result-${id.slice(dash + 1)}.md`;
}

function readLab(root: string, labDir: string, id: string, problems: string[]): { result: LabResult | null; view: LabView } {
  const dir = labDir;
  const path = join(root, labDir, resultFile(id));
  const absent: LabView = { dir, status: 'absent', measured_at: null, title_number: null, needs: 'a lab run', table: { headers: [], rows: [], notes: '' }, body: null, note: null };
  if (!existsSync(path)) return { result: null, view: absent };
  try {
    const result = parseResult(readFileSync(path, 'utf8'));
    // The same rule npm run pr holds a result to: a measured result with no run behind it shows nothing, here as there.
    const problem = measuredProblem(join(root, labDir), resultNames(basename(labDir), id), result, resultFile(id));
    if (problem) {
      problems.push(`${labDir}/${resultFile(id)}: left off the site, because ${problem}`);
      return { result: null, view: { ...absent, status: 'not_run' } };
    }
    const table = parseResultTable(result.body);
    return {
      result,
      view: {
        dir, status: result.status, measured_at: result.measured_at ?? null, title_number: result.title_number ?? null, needs: result.needs ?? null,
        // A lab that didn't run has one sentence on what it will measure, never a number.
        table: result.status === 'not_run' ? { headers: [], rows: [], notes: '' } : table,
        body: result.status === 'not_run' ? null : result.body,
        note: result.status === 'not_run' ? result.body : null,
      },
    };
  } catch (e) {
    problems.push(`${labDir}/${resultFile(id)}: ${(e as Error).message}`);
    return { result: null, view: absent };
  }
}

function readPatch(labPath: string, patch: string): { subject: string; files: DiffFile[] } | null {
  if (isAbsolute(patch) || normalize(patch).startsWith('..')) return null;
  const path = join(labPath, patch);
  if (!existsSync(path)) return null;
  const parsed = parsePatch(readFileSync(path, 'utf8'));
  return { subject: parsed.subject, files: parsed.files.map(trimFile) };
}

function stageDiff(labPath: string, patches: string[]): StageDiff {
  const read = patches.map((patch) => ({ patch, parsed: readPatch(labPath, patch) }));
  const files = read.flatMap(({ patch, parsed }) => (parsed?.files ?? []).map((f) => ({ ...f, patch })));
  return {
    patches: read.flatMap(({ patch, parsed }) => (parsed ? [{ path: patch, subject: parsed.subject }] : [])),
    missing: read.filter((r) => !r.parsed).map((r) => r.patch),
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

function toStatus(record: GithubPrRecord | undefined): PrView['status'] {
  if (!record) return 'ready';
  if (record.state === 'merged' || record.merged) return 'merged';
  return record.state === 'open' ? 'open' : 'ready';
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const textList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function whereLinks(raw: RawPr, base: string): LinkedLocation[] {
  const list = Array.isArray(raw.where) ? (raw.where as { path: string; line?: number }[]) : [];
  return list.map((w) => ({ ...w, url: blobUrl(base, raw.baseCommit, w) }));
}

function toGithub(record: GithubPrRecord): NonNullable<PrView['github']> {
  return { number: record.number, url: record.url, state: record.state, author: record.author, head: record.head, base: record.base, ci: record.ci, stages_applied: record.stagesApplied, checked_at: record.checkedAt };
}

function buildPr(root: string, labDir: string, raw: RawPr, objects: PrObjects, problems: string[]): PrView {
  const labRel = text(raw.lab) ?? `lab/${labDir}`;
  const labPath = join(root, labRel);
  const { result, view } = readLab(root, labRel, raw.id, problems);
  const record = objects.prs[raw.id];
  const base = codeBase(raw.upstream, raw.fork, objects);
  const stages = (raw.stages ?? []).map((s): PrStage => {
    const title = renderPrTitle(s, result);
    return {
      date: s.date, title: title.title, title_state: title.state, what_shipped: s.whatShipped ?? '', what_changes: s.whatThisChanges ?? '', comment: s.comment ?? null,
      applied_on_github: Boolean(record?.stagesApplied?.includes(s.date)),
      diff: stageDiff(labPath, s.patches ?? []),
    };
  });
  const last = (raw.stages ?? []).at(-1);
  const rendered = last ? renderPrTitle(last, result) : { title: raw.id, state: 'no number' as const };
  const status = toStatus(record);
  const proof = (raw.proof ?? {}) as { vendor?: unknown; independent?: unknown };
  return {
    id: raw.id,
    title: record?.title ?? rendered.title,
    title_state: rendered.state,
    needs: rendered.needs ?? null,
    status,
    status_label: STATUS_LABEL[status],
    github: record ? toGithub(record) : null,
    upstream: raw.upstream,
    fork: raw.fork ?? '',
    branch: text(raw.branch),
    base_branch: text(raw.baseBranch),
    base_commit: raw.baseCommit,
    base_commit_url: treeUrl(base, raw.baseCommit),
    spec: text(raw.spec),
    source: text(raw.source),
    source_url: text(raw.sourceUrl),
    where: whereLinks(raw, base),
    founder_line: text(raw.founderLine),
    effect: textList(raw.effect),
    effort: text(raw.effort),
    why_it_fits: text(raw.whyItFits),
    risks: text(raw.risks),
    rollback: text(raw.rollback),
    proof: { measured_on_fork: view.status === 'measured', vendor: proof.vendor ?? null, independent: proof.independent ?? null },
    sources: textList(raw.sources),
    lab: view,
    repo_tests: findRepoTests(labPath, raw),
    stages,
  };
}

function readRawPr(path: string, label: string, problems: string[]): RawPr | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawPr;
    if (typeof raw.id !== 'string' || typeof raw.upstream !== 'string' || typeof raw.baseCommit !== 'string') throw new Error('needs id, upstream and baseCommit');
    return raw;
  } catch (e) {
    problems.push(`${label}: ${(e as Error).message}`);
    return null;
  }
}

function prFilesOf(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^pr(-[\w-]+)?\.json$/.test(f)).sort();
}

export function buildPrs(root: string, objects: PrObjects): { prs: PrView[]; problems: string[] } {
  const labRoot = join(root, 'lab');
  if (!existsSync(labRoot)) return { prs: [], problems: [] };
  const problems: string[] = [];
  const dirs = readdirSync(labRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const prs = dirs.flatMap((dir) => prFilesOf(join(labRoot, dir)).flatMap((file) => {
    const raw = readRawPr(join(labRoot, dir, file), `lab/${dir}/${file}`, problems);
    return raw ? [buildPr(root, dir, raw, objects, problems)] : [];
  }));
  return { prs: [...prs].sort((a, b) => a.id.localeCompare(b.id)), problems };
}
