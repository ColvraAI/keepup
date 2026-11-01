// site/data/weekly.json: data/weekly/*.md if the App has written them, otherwise the
// brief rendered by app/src/brief.ts's pure function, otherwise absent. Never hand-written.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { holdsSecret } from '../../app/src/secrets.ts';
import { weeksOfWindow } from './replay.ts';

export interface WeeklyBrief { repo: string; week: string; title: string; body: string; issue: { number: number; url: string } | null }
export interface Weekly { source: 'data/weekly' | 'app/src/brief.ts'; briefs: WeeklyBrief[] }
export interface IssueMap { issues: Record<string, { number: number; url: string }> }
export interface BriefWindow { from: string; to: string }

type BuildBrief = (root: string, repo: string, week: string) => { title: string; body: string };

const FILE_NAME = /^(.+)-(\d{4}-\d{2}-\d{2})\.md$/;

const issueOf = (objects: IssueMap, repo: string, week: string): WeeklyBrief['issue'] => objects.issues[`${repo}/${week}`] ?? null;

function fromFiles(root: string, objects: IssueMap, problems: string[]): Weekly | null {
  const dir = join(root, 'data', 'weekly');
  if (!existsSync(dir)) return null;
  const briefs = readdirSync(dir).sort().flatMap((file): WeeklyBrief[] => {
    const match = file.match(FILE_NAME);
    if (!match) return [];
    const text = readFileSync(join(dir, file), 'utf8');
    if (holdsSecret(text)) {
      problems.push(`data/weekly/${file} holds a secret, or something shaped like one, so it's left off the site. Remove it, and rotate it if it's real.`);
      return [];
    }
    const title = text.match(/^# (.+)$/m)?.[1] ?? file;
    const body = text.replace(/^# .+\n+/, '').trim();
    return [{ repo: match[1], week: match[2], title, body, issue: issueOf(objects, match[1], match[2]) }];
  });
  return briefs.length ? { source: 'data/weekly', briefs } : null;
}

async function fromBriefFunction(root: string, objects: IssueMap, window: BriefWindow, problems: string[]): Promise<Weekly | null> {
  const path = join(root, 'app', 'src', 'brief.ts');
  if (!existsSync(path)) return null;
  try {
    const mod = await import(pathToFileURL(path).href) as { buildBrief?: BuildBrief; REPOS?: readonly string[] };
    if (!mod.buildBrief || !mod.REPOS) return null;
    const { buildBrief, REPOS } = mod;
    const briefs = REPOS.flatMap((repo) => weeksOfWindow(window).flatMap(({ monday: week }) => {
      const { title, body } = buildBrief(root, repo, week);
      if (holdsSecret(body)) {
        problems.push(`The ${repo} brief for ${week} holds a secret, or something shaped like one, so it's left off the site.`);
        return [];
      }
      return [{ repo, week, title, body, issue: issueOf(objects, repo, week) }];
    }));
    return { source: 'app/src/brief.ts', briefs };
  } catch (e) {
    problems.push(`app/src/brief.ts: ${(e as Error).message}`);
    return null;
  }
}

export async function buildWeekly(root: string, objects: IssueMap, window: BriefWindow, problems: string[] = []): Promise<Weekly | null> {
  return fromFiles(root, objects, problems) ?? await fromBriefFunction(root, objects, window, problems);
}
