// data/github-objects.json: what really exists on GitHub. Only API responses go in.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CiRecord { state: string; url: string | null }

export interface PrRecord {
  number: number;
  url: string;
  title: string;
  state: string;
  base: string;
  head: string;
  author: string;
  stagesApplied: string[];
  ci: CiRecord;
  checkedAt: string;
  /** sha256 of the body GitHub returned, so a later run can tell the words on GitHub from the words a lab result now gives. */
  bodyDigest?: string;
  /** How many commits the base branch has on top of the base commit, which the footer counts. Only with a ciWorkflow. */
  baseExtraCommits?: number;
  /** Each applied stage's patch-ids when this was written, by date, so a patch that moved since can be seen with no network. */
  patchIds?: Record<string, string[]>;
}

export interface IssueRecord { number: number; url: string }

export interface GithubObjects {
  schema: 1;
  org?: string;
  app?: { slug: string; url: string; bot: string };
  forks: Record<string, string>;
  prs: Record<string, PrRecord>;
  issues: Record<string, IssueRecord>;
}

const empty = (): GithubObjects => ({ schema: 1, forks: {}, prs: {}, issues: {} });

export function bodyDigest(body: string | null | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex');
}

/** Records made for another org don't exist as far as this org is concerned. */
export function recordsFor(objects: GithubObjects, org: string | undefined): GithubObjects {
  if (!org || !objects.org || objects.org.toLowerCase() === org.toLowerCase()) return objects;
  return { ...empty(), org };
}

export function objectsPath(root: string): string {
  return join(root, 'data', 'github-objects.json');
}

export function readObjects(root: string): GithubObjects {
  const path = objectsPath(root);
  if (!existsSync(path)) return empty();
  let parsed: Partial<GithubObjects>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GithubObjects>;
  } catch (e) {
    throw new Error(`data/github-objects.json isn't valid JSON (${(e as Error).message}).`);
  }
  return { ...empty(), ...parsed, forks: parsed.forks ?? {}, prs: parsed.prs ?? {}, issues: parsed.issues ?? {} };
}

/** A reader sees the old file or the new one, never half of one. */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, mode === undefined ? {} : { mode });
  renameSync(temp, path);
}

export function updateObjects(root: string, update: (current: GithubObjects) => GithubObjects): GithubObjects {
  const next = update(readObjects(root));
  writeFileAtomic(objectsPath(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export const withPr = (o: GithubObjects, id: string, pr: PrRecord): GithubObjects => ({ ...o, prs: { ...o.prs, [id]: pr } });
export const withFork = (o: GithubObjects, fork: string, url: string): GithubObjects => ({ ...o, forks: { ...o.forks, [fork]: url } });
export const withIssue = (o: GithubObjects, repo: string, week: string, issue: IssueRecord): GithubObjects => ({
  ...o,
  issues: { ...o.issues, [`${repo}/${week}`]: issue },
});
