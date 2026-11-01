// site/data/manifest.json: the App's permissions, what really exists on GitHub right
// now (data/github-objects.json is the only source of that, the App's name included,
// because GitHub may have given it another one), and how fresh the data is.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GithubObjectsLite {
  org?: string;
  app?: { slug: string; url: string; bot: string };
  forks: Record<string, string>;
  prs: Record<string, unknown>;
  issues: Record<string, unknown>;
}

export interface SiteManifest {
  app: { name: string | null; permissions: Record<string, string> | null; registered: boolean; url: string | null; bot: string | null };
  github: { exists: boolean; org: string | null; forks: Record<string, string>; pull_requests: number; issues: number };
  database_fetched: string;
  built_at: string;
}

function readAppManifest(root: string): { default_permissions?: Record<string, string> } | null {
  const path = join(root, 'app', 'manifest.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function buildManifest(root: string, objects: GithubObjectsLite, window: { fetched: string }, builtAt: string): SiteManifest {
  const app = readAppManifest(root);
  const forks = objects.forks ?? {};
  const pull_requests = Object.keys(objects.prs ?? {}).length;
  const issues = Object.keys(objects.issues ?? {}).length;
  return {
    app: { name: objects.app?.slug ?? null, permissions: app?.default_permissions ?? null, registered: Boolean(objects.app), url: objects.app?.url ?? null, bot: objects.app?.bot ?? null },
    github: { exists: Boolean(objects.app) || Object.keys(forks).length > 0 || pull_requests > 0 || issues > 0, org: objects.org ?? null, forks, pull_requests, issues },
    database_fetched: window.fetched,
    built_at: builtAt,
  };
}
