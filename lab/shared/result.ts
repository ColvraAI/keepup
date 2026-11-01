// lab/<dir>/result.md is the one place a measured number lives. The App reads
// pull request titles from it and the site reads its tables from it, so only
// run.ts writes it, through here. See docs/contracts.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export type LabStatus = 'measured' | 'partial' | 'not_run';

export interface LabResult {
  lab: string;
  status: LabStatus;
  measured_at?: string;
  title_number?: string;
  needs?: string;
  body: string;
}

const FIELDS = ['lab', 'status', 'measured_at', 'title_number', 'needs'] as const;

export function validateResult(r: LabResult): void {
  if (!r.lab) throw new Error('result needs a lab name');
  if (!['measured', 'partial', 'not_run'].includes(r.status)) throw new Error(`unknown status: ${r.status}`);
  if (r.status === 'not_run' && (r.measured_at || r.title_number)) {
    throw new Error('a lab that did not run cannot carry a date or a number');
  }
  if (r.status === 'partial' && r.title_number) {
    throw new Error('only a fully measured lab may put a number in a title');
  }
  if (r.status !== 'not_run' && !r.measured_at) throw new Error('a lab that ran needs measured_at');
  if (r.status !== 'measured' && !r.needs) throw new Error('a lab that did not finish must say what it needs');
  if (r.measured_at && !/^\d{4}-\d{2}-\d{2}$/.test(r.measured_at)) throw new Error(`bad measured_at: ${r.measured_at}`);
}

export function renderResult(r: LabResult): string {
  validateResult(r);
  const front = FIELDS.filter((f) => r[f]).map((f) => `${f}: ${r[f]}`);
  return `---\n${front.join('\n')}\n---\n${r.body.trim()}\n`;
}

export function parseResult(text: string): LabResult {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('result.md has no front matter');
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`bad front matter line: ${line}`);
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const result: LabResult = {
    lab: fields.lab,
    status: fields.status as LabStatus,
    measured_at: fields.measured_at,
    title_number: fields.title_number,
    needs: fields.needs,
    body: match[2].trim(),
  };
  validateResult(result);
  return result;
}

export function readResult(path: string): LabResult | null {
  return existsSync(path) ? parseResult(readFileSync(path, 'utf8')) : null;
}

export interface ReadResult { result: LabResult | null; problem: string | null }

/** For readers that must carry on past one bad file: a result that can't be read is a problem to report, not a crash. */
export function tryReadResult(path: string): ReadResult {
  try {
    return { result: readResult(path), problem: null };
  } catch (e) {
    return { result: null, problem: (e as Error).message };
  }
}

const MANIFEST = 'manifest.json';
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export interface RunManifest { lab: string; variant: string | null; result_sha256: string; files: { path: string; sha256: string }[] }

const variantOf = (resultPath: string): string | null => basename(resultPath).match(/^result-(.+)\.md$/)?.[1] ?? null;

/** Where a result's run is saved: out/ for result.md, and out/<variant>/ for result-<variant>.md, so a variant can't borrow its parent's run. */
export function outDirFor(resultPath: string): string {
  const variant = variantOf(resultPath);
  return join(dirname(resultPath), 'out', ...(variant ? [variant] : []));
}

/** Evidence of the repo's own tests has its own lifecycle (docs/contracts.md), and dotfiles are the operating system's. Neither is a lab run. */
const isRunFile = (name: string) => !name.startsWith('.') && !name.startsWith('repo-tests') && name !== MANIFEST;

/** A folder with its own manifest is another result's run. */
function runFiles(dir: string, base: string = dir): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) return isRunFile(name) ? [relative(base, full)] : [];
    return existsSync(join(full, MANIFEST)) ? [] : runFiles(full, base);
  });
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function saveManifest(resultPath: string, r: LabResult): void {
  const out = outDirFor(resultPath);
  const files = existsSync(out) ? runFiles(out) : [];
  if (files.length === 0) return;
  const manifest: RunManifest = {
    lab: r.lab,
    variant: variantOf(resultPath),
    result_sha256: sha256(renderResult(r)),
    files: files.map((path) => ({ path, sha256: sha256(readFileSync(join(out, path))) })),
  };
  writeAtomic(join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

function readManifest(out: string): RunManifest | null {
  try {
    return JSON.parse(readFileSync(join(out, MANIFEST), 'utf8')) as RunManifest;
  } catch {
    return null;
  }
}

/** Why a measured result has no run behind it, or null when it does. It catches a typed or edited result, not someone forging the manifest too. */
export function manifestProblem(resultPath: string, r: LabResult): string | null {
  const out = outDirFor(resultPath);
  const shown = relative(dirname(resultPath), out);
  const manifest = readManifest(out);
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) return `its result says measured, but ${shown}/ holds no saved run`;
  if (manifest.lab !== r.lab || manifest.variant !== variantOf(resultPath)) return `its result says measured, but the run saved in ${shown}/ is from ${manifest.lab}`;
  if (manifest.result_sha256 !== sha256(renderResult(r))) return `its result isn't the one the run in ${shown}/ wrote, so it was edited after the run`;
  const missing = manifest.files.find((f) => !existsSync(join(out, f.path)) || sha256(readFileSync(join(out, f.path))) !== f.sha256);
  return missing ? `${shown}/${missing.path} isn't what the run saved` : null;
}

/** docs/contracts.md: measured means this lab's own result, a table to show, and the real run that wrote it saved beside it. Null when it holds, or when it doesn't say measured. */
export function measuredProblem(labPath: string, names: readonly string[], result: LabResult | null, file = 'result.md'): string | null {
  if (result?.status !== 'measured') return null;
  if (!names.includes(result.lab)) return `its result says it's from ${result.lab}, not ${names.join(' or ')}`;
  if (result.body.split('\n').filter((l) => l.trim().startsWith('|')).length < 3) return 'its result has no table';
  return manifestProblem(join(labPath, file), result);
}

/** The lab names a result may carry: the lab's folder, or <folder>-<variant> for a variant's own result. */
export function resultNames(labFolder: string, id: string): string[] {
  return id.includes('-') ? [`${labFolder}-${id.slice(id.indexOf('-') + 1)}`] : [labFolder];
}

/**
 * Never lets a weaker result overwrite a stronger one: a lab that lacks a key
 * must not erase the numbers from the run that had one. A file that can't be read
 * holds nothing to protect. A measured result also saves what proves the run, so
 * every lab saves its raw output before calling this.
 */
export function writeResult(path: string, r: LabResult): LabResult {
  const { result: existing } = tryReadResult(path);
  const rank: Record<LabStatus, number> = { not_run: 0, partial: 1, measured: 2 };
  if (existing && rank[existing.status] > rank[r.status]) return existing;
  writeAtomic(path, renderResult(r));
  if (r.status === 'measured') saveManifest(path, r);
  return r;
}
