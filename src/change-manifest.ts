// A manifest decides what gets installed, so a change moves only a dependency the finding names, and only to a version
// the registry serves. Nothing else in a manifest moves: not scripts, not main, not an override, not an index URL.
import type { FindingRecord } from './change-added.ts';

export const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod)$/;
const DEPENDENCY_KEYS: readonly string[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const ONE_RANGE = String.raw`(?:[\^~]|[<>]=?|=)?\s*v?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?`;
const REGISTRY_RANGE = new RegExp(`^${ONE_RANGE}(?:\\s*(?:\\|\\||,|\\s)\\s*${ONE_RANGE})*$`);
const PY_VERSION = String.raw`(?:===?|>=|<=|~=|!=|<|>)\s*[\w.*+!-]+`;
const REQUIREMENT = new RegExp(`^([A-Za-z0-9][\\w.-]*)(?:\\[[\\w,.-]+\\])?\\s*${PY_VERSION}(?:\\s*,\\s*${PY_VERSION})*(?:\\s*#.*)?$`);
const PYPROJECT_ITEM = new RegExp(`^["']([A-Za-z0-9][\\w.-]*)(?:\\[[\\w,.-]+\\])?\\s*${PY_VERSION}(?:\\s*,\\s*${PY_VERSION})*["'],?$`);
const TOML_ENTRY = /^([A-Za-z0-9][\w.-]*)\s*=\s*"([^"]+)"$/;
const GO_ENTRY = /^(?:require\s+)?([\w./-]+)\s+(v\d[\w.+-]*)(?:\s*\/\/.*)?$/;

type Parsed = Record<string, unknown>;

function parseJson(text: string): Parsed | null {
  try {
    return JSON.parse(text) as Parsed;
  } catch {
    return null;
  }
}

function jsonProblem(file: string, before: string, after: string, record: FindingRecord): string | null {
  const [was, now] = [parseJson(before), parseJson(after)];
  if (!was || !now) return null; // The syntax check says what's wrong with it.
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
  const section = keys.find((key) => !DEPENDENCY_KEYS.includes(key) && JSON.stringify(was[key]) !== JSON.stringify(now[key]));
  if (section) return `${file}: a change can't touch the ${section} section`;
  for (const key of DEPENDENCY_KEYS) {
    const [old, fresh] = [(was[key] ?? {}) as Parsed, (now[key] ?? {}) as Parsed];
    const moved = [...new Set([...Object.keys(old), ...Object.keys(fresh)])].filter((name) => old[name] !== fresh[name]);
    const unnamed = moved.find((name) => !record.tokens.has(name.toLowerCase()));
    if (unnamed) return `${file}: ${unnamed} may change only if the finding names it`;
    const bad = moved.find((name) => name in fresh && !REGISTRY_RANGE.test(String(fresh[name])));
    if (bad) return `${file}: ${bad} can only move to a version from the registry, not ${String(fresh[bad]).slice(0, 60)}`;
  }
  return null;
}

/** The dependency on one changed line, or null when the line isn't a plain dependency and a version. */
function dependencyOn(file: string, line: string): string | null {
  const text = line.trim();
  if (/requirements[^/]*\.txt$/.test(file)) return REQUIREMENT.exec(text)?.[1] ?? null;
  if (file.endsWith('go.mod')) return GO_ENTRY.exec(text)?.[1] ?? null;
  const item = PYPROJECT_ITEM.exec(text)?.[1];
  if (item) return item;
  const entry = TOML_ENTRY.exec(text);
  return entry && REGISTRY_RANGE.test(entry[2]) ? entry[1] : null;
}

function linesProblem(file: string, search: string, replace: string, record: FindingRecord): string | null {
  const before = new Set(search.split('\n').map((line) => line.trim()));
  const changed = replace.split('\n').filter((line) => line.trim() && !before.has(line.trim()));
  for (const line of changed) {
    const name = dependencyOn(file, line);
    if (!name) return `${file}: a change here can only move a dependency to a version, and this line isn't one: ${line.trim().slice(0, 80)}`;
    if (!record.tokens.has(name.toLowerCase())) return `${file}: ${name} may change only if the finding names it`;
  }
  return null;
}

export function manifestProblem(edit: { file: string; search: string; replace: string }, before: string, after: string, record: FindingRecord): string | null {
  if (!MANIFEST.test(edit.file)) return null;
  return edit.file.endsWith('package.json') ? jsonProblem(edit.file, before, after, record) : linesProblem(edit.file, edit.search, edit.replace, record);
}
