// Reads lockfiles as text, for one question: what does this repo really install? A range can allow a new release that
// the lockfile never picked up. Line-oriented and linear; nothing is installed or run.
export interface LockedVersion {
  readonly version: string;
  readonly file: string;
  readonly line: number;
}

export interface LockFile {
  readonly path: string;
  readonly text: string;
}

export type LockIndex = ReadonlyMap<string, LockedVersion>;

const LOCK_NAME = /(?:^|\/)(?:yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|Cargo\.lock)$/;

export function isLockFile(path: string): boolean {
  return LOCK_NAME.test(path);
}

function firstWins(index: Map<string, LockedVersion>, key: string, value: LockedVersion): void {
  if (!index.has(key)) index.set(key, value);
}

/** "@scope/x@^1.0.0", x@~1: then an indented version "1.2.3". Keys carry the spec, so two ranges of one package stay apart. */
function parseYarn(file: string, lines: readonly string[]): LockIndex {
  const index = new Map<string, LockedVersion>();
  let keys: string[] = [];
  lines.forEach((line, at) => {
    if (/^\S.*:\s*$/.test(line) && !line.startsWith('#')) {
      keys = line.replace(/:\s*$/, '').split(',').map((key) => key.trim().replace(/^"|"$/g, ''));
      return;
    }
    const version = line.match(/^ {2}version:?\s+"?([^"\s]+)"?\s*$/)?.[1];
    if (!version || keys.length === 0) return;
    for (const key of keys) {
      const name = key.slice(0, key.lastIndexOf('@'));
      firstWins(index, key, { version, file, line: at + 1 });
      firstWins(index, name, { version, file, line: at + 1 });
    }
    keys = [];
  });
  return index;
}

function parseNpm(file: string, lines: readonly string[]): LockIndex {
  const index = new Map<string, LockedVersion>();
  let name: string | null = null;
  lines.forEach((line, at) => {
    const opening = line.match(/^\s*"node_modules\/((?:(?!node_modules\/)[^"])+)":\s*\{/)?.[1];
    if (opening) { name = opening; return; }
    const version = line.match(/^\s*"version":\s*"([^"]+)"/)?.[1];
    if (name && version) {
      firstWins(index, name, { version, file, line: at + 1 });
      name = null;
    }
  });
  return index;
}

function parsePnpm(file: string, lines: readonly string[]): LockIndex {
  const index = new Map<string, LockedVersion>();
  let name: string | null = null;
  lines.forEach((line, at) => {
    const key = line.match(/^ {6}'?((?:@[\w.-]+\/)?[\w.-]+)'?:\s*$/)?.[1];
    if (key) { name = key; return; }
    const version = line.match(/^ {8}version:\s*([\w.+-]+)/)?.[1];
    if (name && version) {
      firstWins(index, name, { version, file, line: at + 1 });
      name = null;
    }
  });
  return index;
}

function parseCargo(file: string, lines: readonly string[]): LockIndex {
  const index = new Map<string, LockedVersion>();
  let name: string | null = null;
  lines.forEach((line, at) => {
    const named = line.match(/^name = "([^"]+)"/)?.[1];
    if (named) { name = named; return; }
    const version = line.match(/^version = "([^"]+)"/)?.[1];
    if (name && version) {
      firstWins(index, `${name}@${version}`, { version, file, line: at + 1 });
      firstWins(index, name, { version, file, line: at + 1 });
      name = null;
    }
  });
  return index;
}

export function parseLockFile(lock: LockFile): LockIndex {
  const lines = lock.text.split('\n');
  if (lock.path.endsWith('yarn.lock')) return parseYarn(lock.path, lines);
  if (lock.path.endsWith('Cargo.lock')) return parseCargo(lock.path, lines);
  if (lock.path.endsWith('pnpm-lock.yaml')) return parsePnpm(lock.path, lines);
  return parseNpm(lock.path, lines);
}

function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** The lockfile beside a manifest, or the nearest one above it, as in a workspace. */
export function nearestLock(manifest: string, locks: ReadonlyMap<string, LockIndex>): LockIndex | null {
  const folders = new Map([...locks.keys()].map((path) => [folderOf(path), path]));
  for (let folder = folderOf(manifest); ; folder = folderOf(folder)) {
    const found = folders.get(folder);
    if (found) return locks.get(found) ?? null;
    if (folder === '') return null;
  }
}

export function lockedVersion(index: LockIndex | null, name: string, spec: string): LockedVersion | null {
  return index?.get(`${name}@${spec}`) ?? index?.get(name) ?? null;
}
