// lab/<dir>/pr.json: load and validate against docs/contracts.md, section 2.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { UPSTREAM_REPOS } from './guard.ts';
import { holdsSecret } from './secrets.ts';
import { foreignReferences, looksMeasured, patchMessage, unsourcedNumbers, type SourcedNumber } from './spec-text.ts';

export { looksMeasured };

export interface Claim { claim: string; url: string }
export interface WhereLink { path: string; line?: number }

export interface Stage {
  date: string;
  patches: string[];
  patchFiles: string[];
  title: string;
  titleUnmeasured?: string | null;
  whatShipped: string;
  whatThisChanges: string;
  comment: string | null;
}

export interface PrSpec {
  schema: 1;
  id: string;
  spec: string;
  upstream: string;
  fork: string;
  baseCommit: string;
  baseBranch: string;
  ciWorkflow: string | null;
  branch: string;
  resultFile?: string;
  lab: string;
  labDir: string;
  file: string;
  source: string;
  sourceUrl: string;
  where: WhereLink[];
  founderLine: string;
  effect: string[];
  effort: string;
  whyItFits: string;
  risks: string;
  rollback: string;
  proof: { vendor: Claim | null; independent: Claim | null };
  sources: string[];
  /** Every number in the free text that reads as a result or a fact, with where it came from. */
  sourcedNumbers?: SourcedNumber[];
  stages: Stage[];
  /** A change keepup wrote just now on a person's click, rather than a replay of one written from a spec. */
  live?: boolean;
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

type Json = Record<string, unknown>;
export const TITLE_PLACEHOLDER = '{{lab.title_number}}';
export const EFFECT_WORDS = ['cheaper', 'faster', 'better answers', 'keeps working', 'new capability'];
export const EFFORT_WORDS = ['Hours', 'A day', 'A project'];

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isUrl = (v: unknown): v is string => isText(v) && /^https?:\/\/\S+$/.test(v);
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isRealDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const BACKLINK_ADVICE = "That would show on that repo's public timeline for good. Drop it, or link through redirect.github.com, which leaves no backlink.";

const DATES = /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?: \d{4})?|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, \d{4})?|\b\d{4}-\d{2}-\d{2}\b/g;
/** A whole number standing alone. Right after a capitalised word it's part of a name, as in "EmbeddingGemma 2". */
const BARE_COUNT = /(?<![\w.-])(?<![A-Z][\w-]* )\d+(?![\w.-]|\.\d)/;

/** A title, a founder line and titleUnmeasured promise no number at all. "6.1 Sol", "GPT-6" and dates are fine; "3 official servers" is a count. */
export function holdsCount(text: string): boolean {
  return looksMeasured(text) || BARE_COUNT.test(text.replace(DATES, ''));
}

function checkText(json: Json, fields: string[], errors: string[]): void {
  for (const f of fields) if (!isText(json[f])) errors.push(`${f} must be a non-empty string`);
}

function checkIdentity(json: Json, errors: string[], upstreams: readonly string[]): void {
  checkText(json, ['id', 'spec', 'fork', 'lab', 'source', 'founderLine', 'whyItFits', 'risks', 'rollback'], errors);
  if (isText(json.founderLine) && holdsCount(json.founderLine)) errors.push(`founderLine must hold no measured number: ${json.founderLine}`);
  if (json.resultFile !== undefined && (typeof json.resultFile !== 'string' || !/^result(-[a-z0-9-]+)?\.md$/.test(json.resultFile))) errors.push('resultFile must look like result-<name>.md in the lab dir');
  if (!Array.isArray(json.effect) || json.effect.length === 0 || !json.effect.every((w) => EFFECT_WORDS.includes(w as string))) {
    errors.push(`effect must be a list from: ${EFFECT_WORDS.join(', ')}. Got ${JSON.stringify(json.effect)}`);
  }
  if (!EFFORT_WORDS.includes(json.effort as string)) errors.push(`effort must be one of: ${EFFORT_WORDS.join(', ')}. Got ${JSON.stringify(json.effort)}`);
  if (json.schema !== 1) errors.push('schema must be 1');
  if (typeof json.upstream !== 'string' || !upstreams.includes(json.upstream)) {
    errors.push(`upstream must be one of ${upstreams.join(', ')}, got ${JSON.stringify(json.upstream)}`);
  }
  if (typeof json.fork === 'string' && !/^[A-Za-z0-9._-]+$/.test(json.fork)) errors.push('fork must be a bare repository name');
  if (typeof json.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(json.baseCommit)) {
    errors.push(`baseCommit must be 40 hex characters, got ${JSON.stringify(json.baseCommit)}`);
  }
  if (typeof json.baseBranch !== 'string' || !/^replay\/[A-Za-z0-9._-]+$/.test(json.baseBranch)) errors.push('baseBranch must look like replay/<short sha>');
  if (typeof json.branch !== 'string' || !/^keepup\/[A-Za-z0-9._/-]+$/.test(json.branch)) errors.push('branch must start with keepup/');
  if (!isUrl(json.sourceUrl)) errors.push('sourceUrl must be a URL');
}

function checkClaim(value: unknown, name: string, errors: string[]): void {
  if (value === null) return;
  if (!isObject(value)) {
    errors.push(`${name} must be null or { claim, url }`);
    return;
  }
  if (!isText(value.claim)) errors.push(`${name}.claim must be a non-empty string`);
  if (!isUrl(value.url)) errors.push(`${name}.url must be a URL`);
}

function checkEvidence(json: Json, errors: string[]): void {
  if (!Array.isArray(json.where) || json.where.length === 0) {
    errors.push('where must be a non-empty list of { path, line }');
  } else {
    json.where.forEach((w: unknown, i) => {
      if (!isObject(w) || !isText(w.path)) errors.push(`where[${i}].path must be a non-empty string`);
      else if (w.line !== undefined && (!Number.isInteger(w.line) || (w.line as number) < 1)) errors.push(`where[${i}].line must be a positive whole number`);
    });
  }
  if (!isObject(json.proof)) {
    errors.push('proof must be { vendor, independent }');
  } else {
    if (!('vendor' in json.proof)) errors.push('proof.vendor is required (null when there is none)');
    if (!('independent' in json.proof)) errors.push('proof.independent is required (null when there is none)');
    checkClaim(json.proof.vendor ?? null, 'proof.vendor', errors);
    checkClaim(json.proof.independent ?? null, 'proof.independent', errors);
  }
  if (!Array.isArray(json.sources) || json.sources.length === 0 || !json.sources.every(isUrl)) errors.push('sources must be a non-empty list of URLs');
}

function checkPatch(patch: unknown, where: string, labDir: string, errors: string[]): void {
  if (!isText(patch)) {
    errors.push(`${where} must be a path`);
    return;
  }
  if (isAbsolute(patch) || normalize(patch).startsWith('..')) {
    errors.push(`${where} (${patch}) must be relative and stays inside the lab dir`);
    return;
  }
  const file = join(labDir, patch);
  if (!existsSync(file)) {
    errors.push(`${where}: ${patch} doesn't exist on disk`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  if (holdsSecret(text)) errors.push(`${where}: ${patch} holds something secret, so it won't be pushed`);
  for (const ref of foreignReferences(patchMessage(text))) errors.push(`${where}: the message of ${patch} references ${ref}. ${BACKLINK_ADVICE}`);
}

function checkStage(stage: unknown, i: number, labDir: string, errors: string[]): void {
  const at = `stages[${i}]`;
  if (!isObject(stage)) {
    errors.push(`${at} must be an object`);
    return;
  }
  if (!isRealDate(stage.date)) errors.push(`${at}.date must be a real date in YYYY-MM-DD, got ${JSON.stringify(stage.date)}`);
  for (const f of ['title', 'whatShipped', 'whatThisChanges']) if (!isText(stage[f])) errors.push(`${at}.${f} must be a non-empty string`);
  if (isText(stage.title)) {
    const stripped = stage.title.split(TITLE_PLACEHOLDER).join('');
    if (stripped.includes('{{')) errors.push(`${at}.title uses an unknown placeholder; only ${TITLE_PLACEHOLDER} exists`);
    if (holdsCount(stripped)) errors.push(`${at}.title types a measured number: ${stage.title}. Numbers come from the lab, through ${TITLE_PLACEHOLDER}`);
  }
  if (stage.titleUnmeasured !== undefined && stage.titleUnmeasured !== null) {
    if (!isText(stage.titleUnmeasured)) errors.push(`${at}.titleUnmeasured must be null or a string`);
    else if (stage.titleUnmeasured.includes('{{')) errors.push(`${at}.titleUnmeasured can't hold a placeholder: it's the title for when there's no number`);
    else if (holdsCount(stage.titleUnmeasured)) errors.push(`${at}.titleUnmeasured must hold no number and no claim of testing: ${stage.titleUnmeasured}`);
  }
  if (!Array.isArray(stage.patches) || stage.patches.length === 0) errors.push(`${at}.patches must be a non-empty list`);
  else stage.patches.forEach((p: unknown, j) => checkPatch(p, `${at}.patches[${j}]`, labDir, errors));
  if (i === 0 && stage.comment !== null) errors.push(`${at}.comment must be null: the first stage opens the pull request`);
  if (i > 0 && !isText(stage.comment)) errors.push(`${at}.comment must say what changed: later stages post it on the pull request`);
}

function checkStages(json: Json, labDir: string, errors: string[]): void {
  if (!Array.isArray(json.stages) || json.stages.length === 0) {
    errors.push('stages must be a non-empty list');
    return;
  }
  json.stages.forEach((s: unknown, i) => checkStage(s, i, labDir, errors));
  const dates = json.stages.map((s: unknown) => (isObject(s) ? s.date : null));
  const ascending = dates.every((d, i) => i === 0 || String(dates[i - 1]) < String(d));
  if (!ascending) errors.push('stages must be oldest first, with no repeated date');
}

/** The CI file gets pushed to a public fork, so it must be a YAML file under lab/ci, really inside it, with nothing secret in it. Null means fine. */
export function ciFileProblem(root: string, path: string): string | null {
  if (!/^lab\/ci\/[\w.-]+\.ya?ml$/.test(path) || path.includes('..')) return `ciWorkflow must be a YAML file directly under lab/ci, got ${path}`;
  const full = join(root, path);
  if (!existsSync(full)) return `ciWorkflow: ${path} doesn't exist on disk`;
  const inside = resolve(realpathSync(join(root, 'lab', 'ci'))) + sep;
  if (!realpathSync(full).startsWith(inside)) return `ciWorkflow: ${path} points outside lab/ci`;
  const text = readFileSync(full, 'utf8');
  if (text.includes('PRIVATE KEY') || holdsSecret(text)) return `ciWorkflow: ${path} holds something secret, so it won't be pushed`;
  return null;
}

const stagesOf = (json: Json): Json[] => (Array.isArray(json.stages) ? json.stages.filter(isObject) : []);
const claimText = (c: unknown): unknown[] => (isObject(c) ? [c.claim, c.url] : []);

/** Every text field that reaches a public repo, by name. */
function publicText(json: Json): [string, string][] {
  const proof = isObject(json.proof) ? json.proof : {};
  const fields: [string, unknown][] = [
    ...['source', 'sourceUrl', 'founderLine', 'whyItFits', 'risks', 'rollback'].map((f): [string, unknown] => [f, json[f]]),
    ...(Array.isArray(json.sources) ? json.sources.map((v, i): [string, unknown] => [`sources[${i}]`, v]) : []),
    ...claimText(proof.vendor).map((v): [string, unknown] => ['proof.vendor', v]),
    ...claimText(proof.independent).map((v): [string, unknown] => ['proof.independent', v]),
    ...stagesOf(json).flatMap((s, i) => ['title', 'titleUnmeasured', 'whatShipped', 'whatThisChanges', 'comment'].map((f): [string, unknown] => [`stages[${i}].${f}`, s[f]])),
  ];
  return fields.flatMap(([name, value]) => (isText(value) ? [[name, value] as [string, string]] : []));
}

function checkReferences(json: Json, errors: string[]): void {
  for (const [name, text] of publicText(json)) {
    for (const ref of foreignReferences(text)) errors.push(`${name} references ${ref}. ${BACKLINK_ADVICE}`);
  }
}

function readSourcedNumbers(json: Json, root: string, errors: string[]): SourcedNumber[] {
  if (json.sourcedNumbers === undefined) return [];
  if (!Array.isArray(json.sourcedNumbers)) {
    errors.push('sourcedNumbers must be a list of { text, source }');
    return [];
  }
  return json.sourcedNumbers.flatMap((entry: unknown, i): SourcedNumber[] => {
    if (!isObject(entry) || !isText(entry.text) || !isText(entry.source)) {
      errors.push(`sourcedNumbers[${i}] must be { text, source }`);
      return [];
    }
    if (!isUrl(entry.source) && !existsSync(join(root, entry.source))) errors.push(`sourcedNumbers[${i}].source must be a URL or a file in this repo, got ${entry.source}`);
    return [{ text: entry.text, source: entry.source }];
  });
}

/** Titles and the founder line take no number at all. The free text may state one, if the spec says where it came from. */
function checkNumbers(json: Json, root: string, errors: string[]): void {
  const sourced = readSourcedNumbers(json, root, errors);
  const free = /^(whyItFits|risks|rollback|stages\[\d+\]\.(whatShipped|whatThisChanges|comment))$/;
  for (const [name, text] of publicText(json).filter(([n]) => free.test(n))) {
    const typed = unsourcedNumbers(text, sourced);
    if (typed.length) errors.push(`${name} states ${typed.join(', ')}, which nothing backs. Numbers come from the lab, or go in sourcedNumbers with where they came from.`);
  }
}

function checkFiles(json: Json, root: string, errors: string[]): void {
  if (isText(json.spec) && !existsSync(join(root, json.spec))) errors.push(`spec: ${json.spec} doesn't exist on disk`);
  if (json.ciWorkflow === undefined) errors.push('ciWorkflow is required (null when the repo has its own CI)');
  else if (json.ciWorkflow !== null) {
    if (!isText(json.ciWorkflow)) errors.push('ciWorkflow must be null or a path');
    else {
      const problem = ciFileProblem(root, json.ciWorkflow);
      if (problem) errors.push(problem);
    }
  }
}

function parseFile(file: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new SpecError(`${file}: not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(parsed)) throw new SpecError(`${file}: must be a JSON object`);
  return parsed;
}

/** `upstream` names the one extra repo a live change was made on. Nothing else widens the list. */
export function loadSpec(file: string, root: string, options: { upstream?: string } = {}): PrSpec {
  const json = parseFile(file);
  const shown = relative(root, file);
  const errors: string[] = [];
  const labDir = join(file, '..');
  checkIdentity(json, errors, [...UPSTREAM_REPOS, ...(options.upstream ? [options.upstream] : [])]);
  if (isText(json.lab) && json.lab !== relative(root, labDir)) errors.push(`lab must be ${relative(root, labDir)}, got ${json.lab}`);
  checkEvidence(json, errors);
  checkStages(json, labDir, errors);
  checkFiles(json, root, errors);
  checkReferences(json, errors);
  checkNumbers(json, root, errors);
  if (errors.length) throw new SpecError(`${shown} doesn't match the contract in docs/contracts.md:\n- ${errors.join('\n- ')}`);
  const stages = (json.stages as (Omit<Stage, 'patchFiles'>)[]).map((s) => ({ ...s, patchFiles: s.patches.map((p) => join(labDir, p)) }));
  return { ...(json as unknown as PrSpec), labDir, file, stages };
}

function specFiles(root: string): string[] {
  const lab = join(root, 'lab');
  if (!existsSync(lab)) return [];
  const dirs = readdirSync(lab).filter((d) => d !== 'shared' && statSync(join(lab, d)).isDirectory()).sort();
  return dirs.flatMap((d) => readdirSync(join(lab, d)).filter((f) => /^pr(-[a-z0-9-]+)?\.json$/.test(f)).sort().map((f) => join(lab, d, f)));
}

export interface SpecList { specs: PrSpec[]; invalid: { file: string; message: string }[] }

/** Oldest replay date first, so pull request numbers follow the replay. */
export function listSpecs(root: string): SpecList {
  const loaded = specFiles(root).map((file) => {
    try {
      return { spec: loadSpec(file, root) };
    } catch (e) {
      return { invalid: { file: relative(root, file), message: (e as Error).message } };
    }
  });
  const specs = loaded.flatMap((l) => (l.spec ? [l.spec] : []));
  const sorted = [...specs].sort((a, b) => a.stages[0].date.localeCompare(b.stages[0].date) || a.id.localeCompare(b.id));
  return { specs: sorted, invalid: loaded.flatMap((l) => (l.invalid ? [l.invalid] : [])) };
}

export function findSpec(id: string, root: string): PrSpec {
  const { specs, invalid } = listSpecs(root);
  const matches = specs.filter((s) => s.id === id);
  if (matches.length > 1) throw new SpecError(`more than one spec claims id ${id}: ${matches.map((s) => relative(root, s.file)).join(', ')}`);
  if (matches[0]) return matches[0];
  const broken = invalid.find((b) => b.file.startsWith(`lab/${id.split('-')[0]}-`));
  if (broken) throw new SpecError(broken.message);
  const known = specs.map((s) => s.id).join(', ') || 'none yet';
  const problems = invalid.length ? `\nBroken spec files:\n${invalid.map((b) => b.message).join('\n')}` : '';
  throw new SpecError(`No pull request spec for ${id}. Known ids: ${known}.${problems}`);
}
