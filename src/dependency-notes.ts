// For a library far enough behind to matter, reads its own release notes. Online runs only: a dependency that's only
// old stays held back, because age alone is never a finding. A note that can't be read changes nothing.
import { AI_LIBRARY } from './findings.ts';
import type { DependencyCheck } from './exact-checks.ts';
import { registryRepository, type RegistryOptions } from './registry.ts';
import { fetchReleaseNotes, gainsBetween, gainWindow, type NotesOptions, parseReleaseNotes, specGains } from './release-notes.ts';
import { lowestVersionIn, compareVersions } from './semver.ts';

const MIN_MAJORS_BEHIND = 2;
const PROTOCOL_LIBRARY = /^rmcp$|^@modelcontextprotocol\/|^mcp$|^mcp-sdk$/;
const ALL_TIME = '0000-00-00';

export interface DependencyNotesOptions {
  readonly since: string;
  readonly registry?: RegistryOptions;
  readonly notes?: NotesOptions;
}

function farBehind(check: DependencyCheck): boolean {
  return AI_LIBRARY.test(check.name) && check.status === 'behind' && check.majors_behind >= MIN_MAJORS_BEHIND && Boolean(check.latest);
}

/** A protocol library whose lockfile sits behind what its range allows: the notes between them are a person's call to weigh. */
function lockedBehind(check: DependencyCheck): boolean {
  return PROTOCOL_LIBRARY.test(check.name) && check.status === 'allowed-by-range' && Boolean(check.latest && check.locked) && compareVersions(check.locked?.version as string, check.latest as string) < 0;
}

function worthReading(check: DependencyCheck): boolean {
  return farBehind(check) || lockedBehind(check);
}

async function withNotes(check: DependencyCheck, options: DependencyNotesOptions): Promise<DependencyCheck> {
  try {
    const repository = await registryRepository({ ecosystem: check.ecosystem, name: check.name }, options.registry ?? {});
    const notes = await fetchReleaseNotes({ name: check.name, ecosystem: check.ecosystem }, repository, options.notes ?? {});
    const window = lockedBehind(check) ? { declared: check.locked?.version as string, latest: check.latest as string, since: ALL_TIME } : gainWindow(check.spec, check.latest as string, options.since);
    if (!notes || !window) return check;
    const entries = parseReleaseNotes(notes.text);
    const declared = lowestVersionIn(check.spec);
    const spec = PROTOCOL_LIBRARY.test(check.name) && declared && farBehind(check) ? specGains(entries, declared, check.latest as string) : [];
    return { ...check, release_notes: { url: notes.url, gains: gainsBetween(entries, window), ...(spec.length ? { spec } : {}) } };
  } catch {
    return check;
  }
}

export async function addReleaseNotes(checks: readonly DependencyCheck[], options: DependencyNotesOptions): Promise<DependencyCheck[]> {
  const out: DependencyCheck[] = [];
  for (const check of checks) out.push(worthReading(check) ? await withNotes(check, options) : check);
  return out;
}
