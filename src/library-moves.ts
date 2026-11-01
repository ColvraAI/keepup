// When a job's code sits on a library that stopped moving, the judge needs the facts to say what moving takes: where it
// went, what version that's at, which manifests declare the old one, and what else in the code loads it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DependencyCheck } from './exact-checks.ts';
import { humanDate } from './dates.ts';
import type { PipelineContext } from './pipeline.ts';
import { registryInfo, type RegistryOptions } from './registry.ts';
import { pathContext } from './code-context.ts';
import { REPO_ROOT } from './signals.ts';

const MOVES_FILE = join(REPO_ROOT, 'db', 'moves.json');
const MAX_USERS = 6;

interface Move {
  readonly from: string;
  readonly to: string;
  readonly ecosystem: 'npm' | 'crates' | 'pypi';
  readonly source: string;
}

export interface LibraryFact {
  readonly name: string;
  readonly text: string;
  readonly url: string;
  /** Files whose code loads this library. A job touching one of them gets this fact. */
  readonly users: readonly string[];
  /** Where it moves to, and what moves: the program writes this into any finding that needs the move. */
  readonly move?: LibraryMove;
}

export interface LibraryMove {
  readonly to: string;
  readonly manifests: readonly { readonly file: string; readonly line: number; readonly text: string }[];
  readonly loaders: readonly string[];
  /** The line that sets today's default model on this library, if one does. */
  readonly defaults: readonly { readonly file: string; readonly line: number; readonly text: string }[];
  readonly versions: readonly { readonly version: string; readonly date: string }[];
  readonly stale_since: string | null;
  readonly declared: string;
}

function loadMoves(): readonly Move[] {
  if (!existsSync(MOVES_FILE)) return [];
  return (JSON.parse(readFileSync(MOVES_FILE, 'utf8')) as { moves: Move[] }).moves;
}

function usersOf(name: string, files: ReadonlyMap<string, string>): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const [file, text] of files) {
    if (!text.includes(name) || /package(?:-lock)?\.json$/.test(file) || pathContext(file) === 'test') continue;
    const index = text.split('\n').findIndex((line) => line.includes(name));
    if (index !== -1) out.push({ file, line: index + 1 });
  }
  return out;
}

const DEFAULT_MODEL_LINE = /\bdefault\w*\s*[:=]\s*["'`][\w.-]+\/[\w.-]+["'`]/i;
const RECENT_VERSIONS = 3;

function defaultLines(users: readonly { file: string }[], files: ReadonlyMap<string, string>): LibraryMove['defaults'] {
  return users.flatMap(({ file }) => (files.get(file)?.split('\n') ?? []).flatMap((text, index) => (DEFAULT_MODEL_LINE.test(text) ? [{ file, line: index + 1, text: text.trim() }] : [])));
}

function stale(check: DependencyCheck): string {
  return check.stale && check.latest_date ? `It has had no release since ${humanDate(check.latest_date)}.` : '';
}

async function destination(move: Move, options: RegistryOptions): Promise<{ text: string; versions: LibraryMove['versions'] }> {
  try {
    const info = await registryInfo({ ecosystem: move.ecosystem, name: move.to }, options);
    const stable = Object.entries(info.version_dates).filter(([version]) => !version.includes('-')).sort((a, b) => a[1].localeCompare(b[1])).map(([version, date]) => ({ version, date }));
    const recent = stable.slice(-RECENT_VERSIONS).map((item) => `${item.version} on ${humanDate(item.date)}`).join(', ');
    return { versions: stable, text: `${move.to} is at ${info.latest}${info.latest_date ? `, released ${humanDate(info.latest_date)}` : ''}. It shipped ${recent}.` };
  } catch {
    return { versions: [], text: `The registry didn't answer for ${move.to}, so no version is known here.` };
  }
}

/** One fact per moved library this repo declares, read from the manifests, the code and the registry. */
export async function libraryFacts(context: PipelineContext, options: RegistryOptions & { readonly online?: boolean } = {}): Promise<LibraryFact[]> {
  const checks = context.exact.filter((item): item is DependencyCheck => item.kind === 'dependency');
  const facts: LibraryFact[] = [];
  for (const move of loadMoves()) {
    const check = checks.find((item) => item.name === move.from);
    if (!check) continue;
    const declared = check.places.map((place) => `${place.file}:${place.line} \`${context.files.get(place.file)?.split('\n')[place.line - 1]?.trim() ?? ''}\``).join('; ');
    const users = usersOf(move.from, context.files).slice(0, MAX_USERS);
    const moved = options.online ? await destination(move, options) : { text: '', versions: [] };
    const defaults = defaultLines(users, context.files);
    const manifests = check.places.map((place) => ({ file: place.file, line: place.line, text: context.files.get(place.file)?.split('\n')[place.line - 1]?.trim() ?? '' }));
    facts.push({
      name: move.from,
      url: `https://www.npmjs.com/package/${move.to}`,
      users: users.map((user) => user.file),
      text: `This product declares ${move.from} ${check.spec} at ${declared}. ${stale(check)} The package moved to ${move.to}. ${moved.text} Other code on ${move.from}: ${users.map((user) => `${user.file}:${user.line}`).join(', ') || 'none found'}.`,
      move: { to: move.to, manifests, loaders: users.map((user) => user.file), defaults, versions: moved.versions, stale_since: check.stale ? check.latest_date : null, declared: move.from },
    });
  }
  return facts;
}
