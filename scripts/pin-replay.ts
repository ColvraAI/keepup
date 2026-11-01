// Copies what the published runs read from the network into data/replay, so `keepup run --replay` can rebuild each
// of them with no key, no network and no cost. Model answers get there through `keepup run --record-replay`.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CARD_CACHE } from '../src/cards.ts';
import { DEFAULT_CACHE_DIR } from '../src/registry.ts';
import { DEFAULT_NOTES_CACHE } from '../src/release-notes.ts';
import { computeRecordDates } from '../src/db.ts';
import type { Run } from '../src/run-shape.ts';
import { REPO_ROOT } from '../src/signals.ts';
import { buildPinnedSources } from './pinned-sources.ts';

const RUNS = join(REPO_ROOT, 'data', 'runs');
const REPLAY = join(REPO_ROOT, 'data', 'replay');
const MOVES = join(REPO_ROOT, 'db', 'moves.json');

function copyIfThere(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  mkdirSync(join(to, '..'), { recursive: true });
  copyFileSync(from, to);
  return true;
}

function dependencies(): { ecosystem: string; name: string }[] {
  const runs = readdirSync(RUNS).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(RUNS, file), 'utf8')) as Run);
  const declared = runs.flatMap((run) => run.exact.flatMap((item) => (item.kind === 'dependency' ? [{ ecosystem: item.ecosystem, name: item.name }] : [])));
  const moved = (JSON.parse(readFileSync(MOVES, 'utf8')) as { moves: { ecosystem: string; to: string }[] }).moves.map((move) => ({ ecosystem: move.ecosystem, name: move.to }));
  return [...declared, ...moved];
}

/** What ships with the plugin, read from data/replay, which doesn't. Run after any change there. */
export function writeDerived(root = REPO_ROOT): void {
  writeFileSync(join(root, 'db', 'pinned-sources.json'), `${JSON.stringify(buildPinnedSources(join(root, 'data', 'replay'), join(root, 'db', 'moves.json')), null, 1)}\n`);
  writeFileSync(join(root, 'db', 'record-dates.json'), `${JSON.stringify(computeRecordDates(), null, 1)}\n`);
  const runs = readdirSync(join(root, 'data', 'runs')).filter((file) => file.endsWith('.json')).sort();
  const hashes = Object.fromEntries(runs.map((file) => [file, createHash('sha256').update(readFileSync(join(root, 'data', 'runs', file))).digest('hex')]));
  writeFileSync(join(root, 'test', 'golden', 'published-runs.json'), `${JSON.stringify(hashes, null, 1)}\n`);
}

function main(): void {
  if (process.argv.includes('--derived-only')) return writeDerived();
  for (const folder of ['registry', 'notes', 'cards']) rmSync(join(REPLAY, folder), { recursive: true, force: true });
  let copied = 0;
  for (const { ecosystem, name } of dependencies()) {
    const file = `${encodeURIComponent(name)}.json`;
    if (copyIfThere(join(DEFAULT_CACHE_DIR, ecosystem, file), join(REPLAY, 'registry', ecosystem, file))) copied += 1;
    if (copyIfThere(join(DEFAULT_NOTES_CACHE, ecosystem, file), join(REPLAY, 'notes', ecosystem, file))) copied += 1;
  }
  if (copyIfThere(join(DEFAULT_CACHE_DIR, 'openrouter-models.json'), join(REPLAY, 'registry', 'openrouter-models.json'))) copied += 1;
  if (existsSync(DEFAULT_CARD_CACHE)) {
    for (const file of readdirSync(DEFAULT_CARD_CACHE)) if (copyIfThere(join(DEFAULT_CARD_CACHE, file), join(REPLAY, 'cards', file))) copied += 1;
  }
  writeDerived();
  process.stdout.write(`pin-replay: copied ${copied} files into ${REPLAY}\n`);
}

if (process.argv[1] === import.meta.filename) main();
