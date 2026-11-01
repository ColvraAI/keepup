// site/data/runs.json: data/runs/*.json, the real pipeline's output, with a
// permalink on each file:line. No runs means an empty list: the site says "no run
// yet" and never falls back to hand-written text.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blobUrl, codeBase, type ForkMap } from './links.ts';

export interface RunView { file: string; repo: string | null; commit: string | null; run: unknown }

const FILE_LINE = /^(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]*:\d+(?:[–-]\d+)?$/;
const PATH_KEYS = ['file', 'path'];
const REPO_PATH = /^(?!\/)(?!.*:\/\/)[^\s]+$/;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

function linkString(value: string, base: string, commit: string): string | null {
  if (!FILE_LINE.test(value)) return null;
  const [path, lines] = value.split(/:(?=\d)/);
  const [line, end] = lines.split(/[–-]/).map(Number);
  return blobUrl(base, commit, end ? { path, line, end_line: end } : { path, line });
}

function linkObject(input: Record<string, unknown>, base: string, commit: string): Record<string, unknown> {
  const pathKey = PATH_KEYS.find((k) => typeof input[k] === 'string' && REPO_PATH.test(input[k] as string));
  const walked = Object.entries(input).flatMap(([key, value]): [string, unknown][] => {
    if (typeof value === 'string') {
      const url = linkString(value, base, commit);
      return url ? [[key, value], [`${key}_url`, url]] : [[key, value]];
    }
    return [[key, addPermalinks(value, base, commit)]];
  });
  const self = pathKey && !('permalink' in input)
    ? [['permalink', blobUrl(base, commit, { path: input[pathKey] as string, ...(typeof input.line === 'number' ? { line: input.line } : {}) })] as [string, unknown]]
    : [];
  return Object.fromEntries([...walked, ...self]);
}

/** Copies a run and adds a link beside each file:line it finds. The run's own shape is otherwise untouched. */
export function addPermalinks(value: unknown, base: string, commit: string): unknown {
  if (Array.isArray(value)) return value.map((v) => addPermalinks(v, base, commit));
  if (value && typeof value === 'object') return linkObject(value as Record<string, unknown>, base, commit);
  return value;
}

const firstText = (obj: Record<string, unknown>, keys: string[]): string | null => {
  const key = keys.find((k) => typeof obj[k] === 'string' && obj[k]);
  return key ? (obj[key] as string) : null;
};

function nested(run: Record<string, unknown>): Record<string, unknown> {
  const inner = run.repo;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
}

const ownerRepo = (repo: string | null): string | null => repo && repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');

function identify(run: Record<string, unknown>): { repo: string | null; commit: string | null } {
  const inner = nested(run);
  return {
    repo: ownerRepo(firstText(run, ['repo', 'repository', 'upstream']) ?? firstText(inner, ['full_name', 'name', 'slug'])),
    commit: firstText(run, ['commit', 'sha', 'pinned_commit', 'head']) ?? firstText(inner, ['commit', 'sha']),
  };
}

/** Which pull request answers which finding, decided by a person: sharing a file with one isn't answering it. */
export interface FindingPr { repo: string; finding: string; pr: string; shared: string }

export function readFindingPrs(root: string): FindingPr[] {
  const path = join(root, 'data', 'finding-prs.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FindingPr[] : [];
}

export function applyFindingPrs<T extends { title: string; pr: string | null }>(findings: readonly T[], repo: string | null, map: readonly FindingPr[], file: string, problems: string[]): T[] {
  const mine = map.filter((row) => row.repo === repo);
  mine.filter((row) => !findings.some((finding) => finding.title.includes(row.finding)))
    .forEach((row) => problems.push(`data/finding-prs.json: "${row.finding}" matches no finding in ${file}`));
  return findings.map((finding) => ({ ...finding, pr: mine.find((row) => finding.title.includes(row.finding))?.pr ?? finding.pr ?? null }));
}

export function buildRuns(root: string, objects: ForkMap): { runs: RunView[]; problems: string[] } {
  const dir = join(root, 'data', 'runs');
  if (!existsSync(dir)) return { runs: [], problems: [] };
  const problems: string[] = [];
  const map = readFindingPrs(root);
  const runs = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((file): RunView[] => {
    try {
      const run = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      // A run nobody judged has no search behind it, so the dashboard never shows one as if it did.
      if (run.usage === null) return [];
      const { repo, commit } = identify(run);
      // A run on a local folder has no repo on GitHub to link to, so its file:line stay plain.
      const linked = repo && commit && OWNER_REPO.test(repo) ? addPermalinks(run, codeBase(repo, undefined, objects), commit) as Record<string, unknown> : run;
      // A run for one provider has its own findings, so the map speaks only to the repo's main run.
      const findings = Array.isArray(linked.findings) && !run.provider_only
        ? applyFindingPrs(linked.findings as { title: string; pr: string | null }[], repo, map, file, problems)
        : linked.findings;
      return [{ file, repo, commit, run: { ...linked, findings } }];
    } catch (e) {
      problems.push(`data/runs/${file}: ${(e as Error).message}`);
      return [];
    }
  });
  return { runs, problems };
}
