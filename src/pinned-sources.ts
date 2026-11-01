// What the online pipeline read and the plugin's offline gate can't fetch: the release notes, registry pages and model cards
// behind the published runs, and where a moved library went. scripts/pin-replay.ts writes db/pinned-sources.json from data/replay,
// which doesn't ship with the plugin, so a finding is checked against the same text on every path.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './signals.ts';

const PINNED_FILE = join(REPO_ROOT, 'db', 'pinned-sources.json');
const MOVES_FILE = join(REPO_ROOT, 'db', 'moves.json');

export interface PinnedSources {
  readonly note: string;
  readonly sources: Readonly<Record<string, string>>;
}

export function loadPinnedSources(file = PINNED_FILE): PinnedSources {
  if (!existsSync(file)) return { note: '', sources: {} };
  return JSON.parse(readFileSync(file, 'utf8')) as PinnedSources;
}

/** Where each moved library went, in the words a finding uses, and the page it's named on. */
export function moveFacts(file = MOVES_FILE): { readonly url: string; readonly from_url: string; readonly text: string }[] {
  if (!existsSync(file)) return [];
  const { moves } = JSON.parse(readFileSync(file, 'utf8')) as { moves: { from: string; to: string; ecosystem: string }[] };
  return moves.filter((move) => move.ecosystem === 'npm').map((move) => ({ url: `https://www.npmjs.com/package/${move.to}`, from_url: `https://www.npmjs.com/package/${move.from}`, text: `${move.from} moved to ${move.to}.` }));
}
