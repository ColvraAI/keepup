// A library's own release notes: the only thing that can turn "behind on versions" into a finding, because age alone
// is never one. Read when a run is online, through the GitHub repo its registry names. Cached, masked, bounded and
// treated as untrusted text: only short plain lines survive, and the program writes them into a finding word for word.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskText } from './mask.ts';
import { compareVersions, lowestVersionIn } from './semver.ts';
import { REPO_ROOT } from './signals.ts';
import { oneLine } from './text-safety.ts';

export const DEFAULT_NOTES_CACHE = join(REPO_ROOT, 'tmp', 'release-notes');
const TIMEOUT_MS = 15_000;
const MAX_NOTES_CHARS = 400_000;
const MAX_GAINS = 4;
const MAX_LINE = 160;
const USER_AGENT = 'keepup-demo/0.1 (release notes)';
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const HEADING = /^#{1,3}\s+\[?v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\]?(?:\([^()\n]{0,300}\))?(?:\s*[-–(]\s*(20\d\d-\d\d-\d\d)\)?)?\s*$/;
const SECTION = /^#{2,4}\s+(.{1,40})$/;
const BULLET = /^\s*[-*]\s+(.{1,600})$/;
const SCOPE = /^\*\(([\w-]{1,40})\)\*\s*/;
const COLON_SCOPE = /^([a-z][\w-]{1,20}):\s+/;
const COMMIT_PREFIX = /^[0-9a-f]{7,40}:\s*/;
const NOISE = /\b(?:chore|docs?|ci|bump|release|readme|typo|lint|changelog|refactor|tests?|dependabot|merge|examples?|evals?)\b|https?:\/\/|\bignore (?:all|any|previous)\b|\binstructions?\b/i;
const CONVENTIONAL = /^(fix|fixes|fixed|feat|feature)(?:\([^)]{0,40}\))?:\s*/i;
const FIX_WORD = /^(?:fix|fixes|fixed)\b/i;
const SERVER_ONLY = /^(?:server|streamable-http-server|macros?)$/;
/** What a person running this library would feel: lost connections, cancelled work, auth, a new protocol. */
const WORTH_NAMING: readonly RegExp[] = [/\breconnect|\bredirect|\btimeout|\bretry|\bcrash|\bleak|\bdeadlock|\bhang/i, /\bcancel/i, /\bauth|\bscope|\btoken|\bsecurity|\bvulnerab/i, /\bspec\b|\bprotocol\b|\bbreaking\b/i];
/** "update for 2026-07-28 version", "add 2025-11-25 protocol version support": a protocol revision the library took on. */
const SPEC_LINE = /\b(?:add|update|align|support|implement)\w*\b.*\b(20\d\d-\d\d-\d\d)\b.*\b(?:version|spec|protocol)\b/i;

export interface ReleaseLine {
  readonly section: string;
  readonly scope: string | null;
  readonly text: string;
}

export interface ReleaseEntry {
  readonly version: string;
  readonly date: string | null;
  readonly lines: readonly ReleaseLine[];
}

export interface SpecGain {
  readonly version: string;
  readonly spec: string;
  readonly text: string;
}

export interface Gain {
  readonly version: string;
  readonly date: string | null;
  readonly kind: 'fix' | 'add';
  readonly text: string;
}

function cleanBullet(raw: string): { scope: string | null; text: string } {
  const noLinks = raw.replace(/\s*\(?\[[^\[\]\n]{0,120}\]\([^()\n]{0,300}\)\)?/g, '');
  const scope = noLinks.match(SCOPE)?.[1] ?? null;
  const text = noLinks.replace(SCOPE, '').replace(COMMIT_PREFIX, '').replace(/[`*]{1,2}/g, '').trim();
  const colon = text.match(COLON_SCOPE)?.[1] ?? null;
  return { scope: scope ?? colon, text: oneLine(colon ? text.replace(COLON_SCOPE, '') : text) };
}

export function parseReleaseNotes(notes: string): ReleaseEntry[] {
  const entries: { version: string; date: string | null; lines: ReleaseLine[] }[] = [];
  let section = '';
  for (const line of notes.slice(0, MAX_NOTES_CHARS).split('\n')) {
    const heading = line.match(HEADING);
    if (heading) {
      entries.push({ version: heading[1], date: heading[2] ?? null, lines: [] });
      section = '';
      continue;
    }
    const named = line.match(SECTION);
    if (named) { section = named[1].trim(); continue; }
    const bullet = line.match(BULLET);
    if (bullet && entries.length > 0) entries.at(-1)?.lines.push({ section, ...cleanBullet(bullet[1]) });
  }
  return entries;
}

function kindOf(line: ReleaseLine): 'fix' | 'add' {
  return /fix|bug/i.test(line.section) || FIX_WORD.test(line.text) ? 'fix' : 'add';
}

function isUsable(line: ReleaseLine): boolean {
  if (line.text.length < 12 || line.text.length > MAX_LINE || NOISE.test(line.text)) return false;
  return !(line.scope && SERVER_ONLY.test(line.scope));
}

function rankOf(text: string): number {
  const index = WORTH_NAMING.findIndex((re) => re.test(text));
  return index === -1 ? WORTH_NAMING.length : index;
}

export interface GainWindow {
  readonly declared: string;
  readonly latest: string;
  /** Only releases from this date on, since a long gap has more lines than anyone will read. */
  readonly since: string;
}

function inRange(entry: ReleaseEntry, window: GainWindow): boolean {
  if (/-/.test(entry.version)) return false;
  if (compareVersions(entry.version, window.declared) <= 0 || compareVersions(entry.version, window.latest) > 0) return false;
  return entry.date === null || entry.date >= window.since;
}

/** Up to four lines a person would care about, the newest of each kind first. Lines nobody picked out as worth naming stay out. */
export function gainsBetween(entries: readonly ReleaseEntry[], window: GainWindow): Gain[] {
  const gains = entries.filter((entry) => inRange(entry, window)).flatMap((entry) => entry.lines.filter(isUsable).map((line) => ({
    version: entry.version, date: entry.date, kind: kindOf(line), text: line.text.replace(CONVENTIONAL, ''),
  })));
  const byKind = WORTH_NAMING.map((_, index) => gains.filter((gain) => rankOf(gain.text) === index));
  const firstOfEach = byKind.flatMap((group) => group.slice(0, 1));
  const rest = byKind.flatMap((group) => group.slice(1));
  return [...firstOfEach, ...rest].slice(0, MAX_GAINS);
}

/** Protocol revisions added since the declared version, newest first, one per revision, however old the release. A pre-release counts as its release. */
export function specGains(entries: readonly ReleaseEntry[], declared: string, latest: string): SpecGain[] {
  const found = new Map<string, SpecGain>();
  for (const entry of entries) {
    const version = entry.version.replace(/-.*$/, '');
    if (compareVersions(version, declared) <= 0 || compareVersions(version, latest) > 0) continue;
    for (const line of entry.lines) {
      const spec = line.text.match(SPEC_LINE)?.[1];
      if (spec && !(line.scope && SERVER_ONLY.test(line.scope))) found.set(spec, { version, spec, text: line.text.replace(CONVENTIONAL, '') });
    }
  }
  return [...found.values()].sort((a, b) => b.spec.localeCompare(a.spec));
}

export function gainWindow(spec: string, latest: string, since: string): GainWindow | null {
  const declared = lowestVersionIn(spec);
  return declared ? { declared, latest, since } : null;
}

export interface NotesOptions {
  readonly cacheDir?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface Notes {
  readonly url: string;
  readonly text: string;
}

function candidatePaths(name: string): string[] {
  const short = name.replace(/^@[^/]+\//, '');
  return [`crates/${short}/CHANGELOG.md`, `packages/${short}/CHANGELOG.md`, 'CHANGELOG.md', `libs/${short}/CHANGELOG.md`];
}

function cacheFile(dir: string, dep: { name: string; ecosystem: string }): string {
  return join(dir, dep.ecosystem, `${encodeURIComponent(dep.name)}.json`);
}

function readCache(path: string): Notes | null | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Notes | null;
  } catch {
    return undefined;
  }
}

function writeCache(path: string, dir: string, value: Notes | null): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const RELEASES_LIMIT = 100;
/** JSON has to arrive whole to parse, so this is a limit on a release page, not a cut through it. */
const MAX_RELEASES_CHARS = 8_000_000;
const FIRST_SENTENCE = /^(.{12,160}?)(?:\s\(|[.;:]\s|$)/;

interface GitHubRelease {
  readonly tag_name?: string;
  readonly published_at?: string;
  readonly body?: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
}

function releaseLines(body: string): string[] {
  return body.split(/\r?\n/).flatMap((line) => {
    const bullet = line.match(/^\s*[-*]\s+(.{1,1200})$/)?.[1];
    if (!bullet) return [];
    const plain = bullet.replace(/\*\*([^*]{1,120})\*\*/g, '$1').replace(/`/g, '');
    return [`- ${plain.match(FIRST_SENTENCE)?.[1] ?? plain.slice(0, 160)}`];
  });
}

/** GitHub's releases, in the changelog's own shape, for a library that keeps its notes there. */
function changelogFromReleases(raw: string): string {
  const releases = JSON.parse(raw) as readonly GitHubRelease[];
  return releases.filter((release) => !release.draft && !release.prerelease && release.tag_name).map((release) => {
    const version = (release.tag_name as string).replace(/^.*?@?v?(?=\d+\.\d+\.\d+)/, '');
    return [`## [${version}] - ${(release.published_at ?? '').slice(0, 10)}`, ...releaseLines(release.body ?? '')].join('\n');
  }).join('\n\n');
}

async function fromReleases(owner: string, repo: string, fetchImpl: typeof fetch): Promise<Notes | null> {
  const raw = await tryFetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASES_LIMIT}`, fetchImpl, MAX_RELEASES_CHARS);
  if (!raw) return null;
  try {
    const text = changelogFromReleases(raw);
    return parseReleaseNotes(text).length > 0 ? { url: `https://github.com/${owner}/${repo}/releases`, text: maskText(text) } : null;
  } catch {
    return null;
  }
}

async function tryFetch(url: string, fetchImpl: typeof fetch, maxChars: number = MAX_NOTES_CHARS): Promise<string | null> {
  try {
    const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? (await response.text()).slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

/** The changelog in a GitHub repo, on its main branch. A repo url from anywhere else is never fetched. */
export async function fetchReleaseNotes(dep: { readonly name: string; readonly ecosystem: string }, repository: string | null, options: NotesOptions = {}): Promise<Notes | null> {
  const dir = options.cacheDir ?? DEFAULT_NOTES_CACHE;
  const path = cacheFile(dir, dep);
  const cached = readCache(path);
  if (cached !== undefined) return cached;
  const repo = repository?.match(GITHUB_REPO);
  if (!repo) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const file of candidatePaths(dep.name)) {
    const text = await tryFetch(`https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/main/${file}`, fetchImpl);
    if (text && parseReleaseNotes(text).length > 0) {
      const notes = { url: `https://github.com/${repo[1]}/${repo[2]}/blob/main/${file}`, text: maskText(text) };
      writeCache(path, join(dir, dep.ecosystem), notes);
      return notes;
    }
  }
  const released = await fromReleases(repo[1], repo[2], fetchImpl);
  writeCache(path, join(dir, dep.ecosystem), released);
  return released;
}
