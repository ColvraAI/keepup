// Reads declared dependencies from the manifests keepup understands, with the exact line of each.
// Line-oriented on purpose: the files are read as text, and no dependency is ever installed or run.
import type { LockedVersion } from './lockfiles.ts';

export type Ecosystem = 'npm' | 'crates' | 'pypi';
export type DependencySource = 'registry' | 'git' | 'path';

export interface Dependency {
  readonly name: string;
  readonly spec: string;
  readonly ecosystem: Ecosystem;
  readonly section: string;
  readonly file: string;
  readonly line: number;
  readonly source: DependencySource;
  /** What the repo's lockfile installs for this declaration, when it has one. */
  readonly locked?: LockedVersion;
}

export interface Manifest {
  readonly file: string;
  readonly kind: string;
  readonly dependencies: readonly Dependency[];
  readonly error?: string;
}

const NOTED_ONLY = new Set(['setup.py', 'go.mod']);
/** More than any real manifest declares. Past it, a run says so instead of stalling. */
export const MAX_DEPENDENCIES_PER_MANIFEST = 3000;
const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

function npmSource(spec: string): DependencySource {
  if (/^(?:git\+|git:|github:|https?:|[\w-]+\/[\w.-]+$)/.test(spec)) return 'git';
  if (/^(?:file:|link:|workspace:|portal:)/.test(spec)) return 'path';
  return 'registry';
}

/** Each section's keys and their lines, read once, so a long manifest stays linear. */
function npmLineIndex(lines: readonly string[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  let section: string | null = null;
  lines.forEach((line, at) => {
    const key = line.match(/^\s*"([^"]+)"\s*:/)?.[1];
    if (!key) return;
    if ((NPM_SECTIONS as readonly string[]).includes(key)) { section = key; return; }
    if (section && !index.has(`${section}\0${key}`)) index.set(`${section}\0${key}`, at + 1);
  });
  return index;
}

function parsePackageJson(file: string, text: string): Manifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { file, kind: 'package.json', dependencies: [], error: `Unreadable JSON: ${(error as Error).message}` };
  }
  const lines = npmLineIndex(text.split('\n'));
  const dependencies = NPM_SECTIONS.flatMap((section) =>
    Object.entries((raw[section] ?? {}) as Record<string, string>).map(([name, spec]): Dependency => ({
      name, spec: String(spec), ecosystem: 'npm', section, file, line: lines.get(`${section}\0${name}`) ?? 1, source: npmSource(String(spec)),
    })));
  return { file, kind: 'package.json', dependencies: dependencies.slice(0, MAX_DEPENDENCIES_PER_MANIFEST) };
}

const TOML_SECTION = /^\s*\[([^\][]+(?:\[[^\]]*\])?[^\][]*)\]\s*(?:#.*)?$/;

function cargoLineDependency(rest: string): { spec: string; source: DependencySource } | null {
  const plain = rest.match(/^"([^"]*)"/);
  if (plain) return { spec: plain[1], source: 'registry' };
  if (/workspace\s*=\s*true/.test(rest)) return null;
  const version = rest.match(/\bversion\s*=\s*"([^"]*)"/)?.[1] ?? '';
  if (/\bgit\s*=/.test(rest)) return { spec: version, source: 'git' };
  if (/\bpath\s*=/.test(rest)) return { spec: version, source: 'path' };
  return version ? { spec: version, source: 'registry' } : null;
}

function isCargoSection(section: string): boolean {
  return /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section);
}

function parseCargoToml(file: string, text: string): Manifest {
  const out: Dependency[] = [];
  let section = '';
  const add = (name: string, spec: string, source: DependencySource, line: number) =>
    out.push({ name, spec, ecosystem: 'crates', section, file, line, source });
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const header = line.match(TOML_SECTION);
    if (header) {
      section = header[1];
      const table = section.match(/^(.*\bdependencies)\.([\w-]+)$/);
      if (!table) return;
      const version = lines.slice(index + 1, index + 12).find((l) => /^\s*version\s*=/.test(l))?.match(/"([^"]*)"/)?.[1];
      section = table[1];
      if (version) add(table[2], version, 'registry', index + 1);
      section = `${section}.${table[2]}`;
      return;
    }
    if (!isCargoSection(section)) return;
    const entry = line.match(/^\s*([\w-]+)\s*=\s*(.+)$/);
    if (!entry) return;
    const parsed = cargoLineDependency(entry[2]);
    if (parsed) add(entry[1], parsed.spec, parsed.source, index + 1);
  });
  return { file, kind: 'Cargo.toml', dependencies: out.slice(0, MAX_DEPENDENCIES_PER_MANIFEST) };
}

const PEP508 = /^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*([^;#]*)/;

function pep508(raw: string): { name: string; spec: string } | null {
  const match = raw.trim().match(PEP508);
  return match ? { name: match[1], spec: match[2].trim().replace(/\s+/g, '') } : null;
}

function parseRequirements(file: string, text: string): Manifest {
  const out: Dependency[] = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) return;
    const parsed = pep508(trimmed);
    if (parsed) out.push({ ...parsed, ecosystem: 'pypi', section: 'requirements', file, line: index + 1, source: 'registry' });
  });
  return { file, kind: 'requirements.txt', dependencies: out };
}

function pyprojectArrayItems(line: string): string[] {
  return [...line.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function parsePyproject(file: string, text: string): Manifest {
  const out: Dependency[] = [];
  let section = '';
  let inArray = false;
  const addItem = (item: string, line: number) => {
    const parsed = pep508(item);
    if (parsed) out.push({ ...parsed, ecosystem: 'pypi', section, file, line, source: 'registry' });
  };
  text.split('\n').forEach((line, index) => {
    const header = line.match(TOML_SECTION);
    if (header && !inArray) { section = header[1]; return; }
    if (inArray) {
      pyprojectArrayItems(line).forEach((item) => addItem(item, index + 1));
      if (line.includes(']')) inArray = false;
      return;
    }
    const isListHolder = (section === 'project' && /^\s*dependencies\s*=\s*\[/.test(line))
      || (section === 'project.optional-dependencies' && /=\s*\[/.test(line));
    if (isListHolder) {
      pyprojectArrayItems(line.slice(line.indexOf('[') + 1)).forEach((item) => addItem(item, index + 1));
      inArray = !line.includes(']');
      return;
    }
    if (section === 'tool.poetry.dependencies') {
      const entry = line.match(/^\s*([\w.-]+)\s*=\s*"([^"]*)"/);
      if (entry && entry[1] !== 'python') out.push({ name: entry[1], spec: entry[2], ecosystem: 'pypi', section, file, line: index + 1, source: 'registry' });
    }
  });
  return { file, kind: 'pyproject.toml', dependencies: out };
}

/** The parsed manifest, or null when the file isn't one. */
export function parseManifest(file: string, text: string): Manifest | null {
  const name = file.split('/').pop() ?? file;
  if (name === 'package.json') return parsePackageJson(file, text);
  if (name === 'Cargo.toml') return parseCargoToml(file, text);
  if (name === 'requirements.txt') return parseRequirements(file, text);
  if (name === 'pyproject.toml') return parsePyproject(file, text);
  if (NOTED_ONLY.has(name)) return { file, kind: name, dependencies: [] };
  return null;
}
