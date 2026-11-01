// The 43 signals, as data. A pass over a repo's code gives counts and samples per signal,
// the way the prototype's inventory.py did with ripgrep.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoFile } from './git-files.ts';
import { matchesAnyGlob } from './glob.ts';
import { maskText } from './mask.ts';
import { literalGate, type LiteralGate, mayMatch } from './regex-literals.ts';

export const REPO_ROOT = join(import.meta.dirname, '..');
const SAMPLES_PER_SIGNAL = 4;
const MAX_COLUMNS = 220;
/** A longer line is data rather than code, and a regex over it could stall a scan. */
export const MAX_LINE_CHARS = 2000;
/** The whole pass over one repo. A repo built to stall it stops being read, and the run says so. */
export const SCAN_BUDGET_MS = 60_000;

export interface CompiledSignal {
  readonly name: string;
  readonly re: RegExp;
  readonly gate: LiteralGate;
}

export interface SignalSpec {
  readonly code_globs: readonly string[];
  readonly config_globs: readonly string[];
  readonly exclude: readonly string[];
  readonly signals: readonly CompiledSignal[];
  readonly strict: readonly CompiledSignal[];
}

export interface LineRef {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface SignalResult {
  readonly hits: number;
  readonly files: number;
  readonly samples: readonly LineRef[];
}

export interface CompileOptions {
  readonly smartCase?: boolean;
  readonly label?: string;
}

/** ripgrep's -S: ignore case unless the pattern has an uppercase letter that isn't an escape like \S. */
function wantsIgnoreCase(pattern: string): boolean {
  return !/[A-Z]/.test(pattern.replace(/\\./g, ''));
}

/** Python-style patterns to JS: a leading (?i) becomes a flag, and stateful flags go, since each line is tested alone. */
export function compileRegex(pattern: string, flags = '', options: CompileOptions = {}): RegExp {
  const inline = pattern.startsWith('(?i)');
  const body = inline ? pattern.slice(4) : pattern;
  const ignoreCase = inline || flags.includes('i') || (options.smartCase === true && wantsIgnoreCase(body));
  const kept = [...new Set(flags.replace(/[gyi]/g, ''))].join('');
  try {
    return new RegExp(body, `${ignoreCase ? 'i' : ''}${kept}`);
  } catch (error) {
    throw new Error(`Bad regex${options.label ? ` in ${options.label}` : ''}: ${pattern}: ${(error as Error).message}`);
  }
}

function compileGroup(group: Record<string, string>, smartCase: boolean): CompiledSignal[] {
  return Object.entries(group).map(([name, pattern]) => {
    const re = compileRegex(pattern, '', { smartCase, label: name });
    return { name, re, gate: literalGate(re) };
  });
}

export function loadSignals(path = join(REPO_ROOT, 'db', 'signals.json')): SignalSpec {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    code_globs: raw.code_globs,
    config_globs: raw.config_globs,
    exclude: raw.exclude,
    signals: compileGroup(raw.signals, true),
    strict: compileGroup(raw.strict, false),
  };
}

/** An exclude matches a file or folder name at any depth, like ripgrep's -g '!name'. */
export function excludedFromSignals(path: string, spec: SignalSpec): boolean {
  return path.split('/').some((segment) => matchesAnyGlob(segment, spec.exclude));
}

/** Code files only. ripgrep skips hidden files and folders by default, so this does too. */
export function signalsApplyTo(path: string, spec: SignalSpec): boolean {
  if (path.split('/').some((segment) => segment.startsWith('.'))) return false;
  return matchesAnyGlob(path, spec.code_globs) && !excludedFromSignals(path, spec);
}

interface Tally {
  hits: number;
  files: Set<string>;
  samples: LineRef[];
}

function tallyFile(file: RepoFile, signals: readonly CompiledSignal[], tallies: Map<string, Tally>, samples: number): void {
  const masked = maskText(file.text);
  const active = signals.filter((signal) => mayMatch(signal.gate, masked));
  if (active.length === 0) return;
  const lines = masked.split('\n');
  for (const signal of active) {
    lines.forEach((text, index) => {
      if (text.length > MAX_LINE_CHARS || !signal.re.test(text)) return;
      const tally = tallies.get(signal.name) ?? { hits: 0, files: new Set<string>(), samples: [] };
      tally.hits += 1;
      tally.files.add(file.path);
      if (tally.samples.length < samples) tally.samples.push({ file: file.path, line: index + 1, text: text.slice(0, MAX_COLUMNS) });
      tallies.set(signal.name, tally);
    });
  }
}

export interface CountedSignals {
  readonly results: Record<string, SignalResult>;
  /** Files never reached because the pass ran out of its time budget. */
  readonly over_time: number;
}

export function runSignalsCounted(
  files: Iterable<RepoFile>,
  spec: SignalSpec,
  group: readonly CompiledSignal[] = spec.signals,
  samples: number = SAMPLES_PER_SIGNAL,
  budgetMs: number = SCAN_BUDGET_MS,
): CountedSignals {
  const tallies = new Map<string, Tally>();
  const ordered = [...files].filter((file) => signalsApplyTo(file.path, spec)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const deadline = performance.now() + budgetMs;
  let reached = 0;
  for (const file of ordered) {
    if (performance.now() > deadline) break;
    tallyFile(file, group, tallies, samples);
    reached += 1;
  }
  const results = Object.fromEntries([...tallies].map(([name, tally]) => [name, { hits: tally.hits, files: tally.files.size, samples: tally.samples }]));
  return { results, over_time: ordered.length - reached };
}

export function runSignals(
  files: Iterable<RepoFile>,
  spec: SignalSpec,
  group: readonly CompiledSignal[] = spec.signals,
  samples: number = SAMPLES_PER_SIGNAL,
  budgetMs: number = SCAN_BUDGET_MS,
): Record<string, SignalResult> {
  return runSignalsCounted(files, spec, group, samples, budgetMs).results;
}
