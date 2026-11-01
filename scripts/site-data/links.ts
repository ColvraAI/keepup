// Read-only permalinks to real code. Upstream at a commit, until a fork is
// recorded in data/github-objects.json, and then the fork.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CodeLocation { path: string; line?: number; end_line?: number; dir?: boolean }
export interface LinkedLocation extends CodeLocation { url: string }

export interface ForkMap { forks: Record<string, string> }

const LOCATION = /(?:[\w.@-]+\/)+[\w.@-]*|[\w@-][\w.@-]*\.[A-Za-z][A-Za-z0-9]*/g;

export const upstreamBase = (repo: string): string => `https://github.com/${repo}`;

/** The repo's name under the demo org: "<demo-org>/aura" and "aura" both give "aura". */
export const forkName = (fork: string | undefined, repo: string): string => (fork ?? repo).split('/').at(-1) ?? repo;

export function codeBase(repo: string, fork: string | undefined, objects: ForkMap): string {
  const recorded = objects.forks[forkName(fork, repo)];
  return recorded?.startsWith('https://') ? recorded.replace(/\/+$/, '') : upstreamBase(repo);
}

function toLocation(token: string, rest: string): CodeLocation {
  if (token.endsWith('/')) return { path: token.slice(0, -1), dir: true };
  const lines = rest.match(/^:(\d+)(?:[–-](\d+))?/);
  if (!lines) return { path: token };
  return lines[2] ? { path: token, line: Number(lines[1]), end_line: Number(lines[2]) } : { path: token, line: Number(lines[1]) };
}

/** Pulls file and directory locations out of a timeline `where`, which can be a path, a path:line or a short phrase. */
export function parseWhere(where: string | undefined): CodeLocation[] {
  if (!where) return [];
  return [...where.matchAll(LOCATION)].map((m) => toLocation(m[0], where.slice((m.index ?? 0) + m[0].length)));
}

export function blobUrl(base: string, commit: string, loc: CodeLocation): string {
  if (loc.dir) return `${base}/tree/${commit}/${loc.path}`;
  const anchor = loc.line ? `#L${loc.line}${loc.end_line ? `-L${loc.end_line}` : ''}` : '';
  return `${base}/blob/${commit}/${loc.path}${anchor}`;
}

export const treeUrl = (base: string, commit: string): string => `${base}/tree/${commit}`;
export const commitUrl = (base: string, commit: string): string => `${base}/commit/${commit}`;

export type ShaResolver = (repo: string, sha: string) => string;

/** Full hashes make firmer permalinks. Uses the clones in tmp/ when they're there, and the short hash otherwise. */
export function localShaResolver(root: string): ShaResolver {
  return (repo, sha) => {
    const clone = join(root, 'tmp', repo.split('/').at(-1) ?? repo);
    if (!/^[0-9a-f]{7,40}$/.test(sha) || !existsSync(join(clone, '.git'))) return sha;
    const run = spawnSync('git', ['-C', clone, 'rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' });
    return run.status === 0 ? run.stdout.trim() : sha;
  };
}

export const identitySha: ShaResolver = (_repo, sha) => sha;
