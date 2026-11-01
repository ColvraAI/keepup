// What's kept between runs of the dashboard: each repo's run, and each change's masked record and patch. A clone isn't kept:
// a repo's page and its changes need none, and making a new change fetches the one commit again.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGE_ID, CHANGE_RULES, type ChangeResult } from '../../../src/change.ts';
import { maskText } from '../../../src/mask.ts';

export const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
const SAVED = 'saved-runs';
const SLUG_FILE = /^([A-Za-z0-9-]+)__(.+)\.json$/;

const runFile = (base: string, slug: string): string => join(base, SAVED, `${slug.replace('/', '__')}.json`);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function saveRun(base: string, slug: string, from: string): void {
  mkdirSync(join(base, SAVED), { recursive: true });
  copyFileSync(from, runFile(base, slug));
}

export const savedRun = (base: string, slug: string): Record<string, unknown> | null => readJson(runFile(base, slug));

export function savedSlugs(base: string): string[] {
  const dir = join(base, SAVED);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const match = SLUG_FILE.exec(name);
    return match ? [`${match[1]}/${match[2]}`] : [];
  });
}

function allChanges(base: string): ChangeResult[] {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((name) => CHANGE_ID.test(name)).flatMap((name) => readJson<ChangeResult>(join(base, name, 'change.json')) ?? []).filter((change) => change.rules === CHANGE_RULES);
}

const madeAt = (base: string, id: string): number => statSync(join(base, id, 'change.json')).mtimeMs;

/** The newest change for each finding of a repo, so a reload shows what was made rather than offering to make it again. */
export function savedChanges(base: string, repo: string): ChangeResult[] {
  const mine = allChanges(base).filter((change) => change.repo === repo).sort((a, b) => madeAt(base, a.id) - madeAt(base, b.id));
  return [...new Map(mine.map((change) => [`${change.commit}#${change.finding_rank}`, change])).values()];
}

/** A change already made for this commit and finding. One that was refused can be tried again. */
export function existingChange(base: string, repo: string, commit: string, rank: number): ChangeResult | null {
  return savedChanges(base, repo).find((change) => change.commit === commit && change.finding_rank === rank && !change.refused) ?? null;
}

function tidyChange(dir: string): void {
  [join(dir, 'repo'), join(dir, 'syntax')].forEach((path) => rmSync(path, { recursive: true, force: true }));
  const patch = join(dir, 'change.patch');
  if (!existsSync(patch)) return;
  const text = readFileSync(patch, 'utf8');
  const masked = maskText(text);
  if (masked !== text) writeFileSync(patch, masked);
}

/** Past the age limit it goes. Under it, only masked text stays: no clones, no copies of files, no raw patches. */
export function tidySaved(base: string, now: number = Date.now()): void {
  if (!existsSync(base)) return;
  const old = (path: string) => now - statSync(path).mtimeMs > KEEP_DAYS * DAY_MS;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    if (CHANGE_ID.test(name)) {
      if (old(dir)) rmSync(dir, { recursive: true, force: true });
      else tidyChange(dir);
    } else if (/^(?:scan-|pinned-)/.test(name)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (existsSync(join(base, SAVED))) readdirSync(join(base, SAVED)).map((name) => join(base, SAVED, name)).filter(old).forEach((file) => rmSync(file, { force: true }));
}
