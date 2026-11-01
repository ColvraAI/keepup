// The test set's shape, and the rules that build it from its sources. Nothing in
// testset.json is typed by hand: build-testset.ts fetches each source and uses these.
import { createHash } from 'node:crypto';

export interface Recording {
  id: string;
  title: string;
  author: string;
  reader: string;
  catalogUrl: string;
  catalogLength: string;
  archiveItemUrl: string;
  audioUrl: string;
  audioFile: string;
  audioBytes: number;
  audioSha1: string;
  audioLength: string;
  audioLicence: string;
  textPageUrl: string;
  textUrl: string;
  textNote: string;
  text: string;
}

export interface TestSet {
  schema: 1;
  fetched: string;
  selectionRule: string;
  licenceNote: string;
  recordings: Recording[];
}

export const SELECTION_RULE = "The first reader on the work's LibriVox catalog page whose recording runs between one and two minutes.";
export const MIN_SECONDS = 60;
export const MAX_SECONDS = 120;
const MAX_TEXT_CHARS = 4000;

export interface CatalogRow {
  section: string;
  reader: string;
  length: string;
  audioUrl: string;
}

/** "00:01:06" or "01:06" as seconds. Throws on anything else, rather than guessing. */
export function lengthToSeconds(length: string): number {
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(length)) throw new Error(`not a length: ${length}`);
  return length.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function cellText(cell: string): string {
  const plain = cell.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'");
  return plain.replace(/\s+/g, ' ').trim();
}

/** The rows of a LibriVox catalog page's section table: its sections, readers, lengths and MP3 links, in page order. */
export function parseCatalogRows(html: string): CatalogRow[] {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => row[1]);
  return rows.flatMap((row) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cellText(cell[1]));
    const audioUrl = row.match(/href="([^"]+_64kb\.mp3)"/)?.[1];
    if (!audioUrl || cells.length < 4) return [];
    return [{ section: cells[1], reader: cells[2], length: cells[3], audioUrl }];
  });
}

export function pickRow(rows: readonly CatalogRow[]): CatalogRow {
  const row = rows.find((r) => {
    const seconds = lengthToSeconds(r.length);
    return seconds >= MIN_SECONDS && seconds <= MAX_SECONDS;
  });
  if (!row) throw new Error('no recording on this catalog page runs between one and two minutes');
  return row;
}

function markerPattern(marker: string): RegExp {
  const parts = marker.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('\\s+'));
}

function firstMatch(source: string, marker: string): { index: number; length: number } {
  const match = markerPattern(marker).exec(source);
  if (!match) throw new Error(`"${marker}" isn't in the source text`);
  return { index: match.index, length: match[0].length };
}

function tidyLines(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/\s+_\d+\s*$/, '').trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * The published words from the first `start` marker through the next `end` marker. It refuses
 * a span too long to be a short work. Editor's line numbers such as "_10" at the end of a line
 * aren't the author's, so they go.
 */
export function extractText(source: string, start: string, end: string): string {
  const from = firstMatch(source, start).index;
  const to = firstMatch(source.slice(from), end);
  const span = source.slice(from, from + to.index + to.length);
  if (span.length > MAX_TEXT_CHARS) throw new Error(`"${start}" to "${end}" spans ${span.length} characters, too long for a short work`);
  return tidyLines(span);
}

export function sha1Of(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** The audio must be the exact file the test set names, so every run measures the same thing. */
export function verifyAudio(recording: Pick<Recording, 'audioFile' | 'audioSha1' | 'audioBytes'>, bytes: Uint8Array): void {
  if (bytes.length !== recording.audioBytes) throw new Error(`${recording.audioFile}: got ${bytes.length} bytes, expected ${recording.audioBytes}`);
  const sha1 = sha1Of(bytes);
  if (sha1 !== recording.audioSha1) throw new Error(`${recording.audioFile}: sha1 is ${sha1}, expected ${recording.audioSha1}`);
}

export function parseTestSet(text: string): TestSet {
  const data = JSON.parse(text) as TestSet;
  if (data.schema !== 1 || !Array.isArray(data.recordings) || !data.recordings.length) throw new Error('testset.json has no recordings');
  for (const r of data.recordings) {
    for (const field of ['id', 'title', 'reader', 'audioUrl', 'audioFile', 'audioSha1', 'audioLicence', 'textPageUrl', 'text'] as const) {
      if (!r[field]) throw new Error(`testset.json: ${r.id ?? 'a recording'} has no ${field}`);
    }
  }
  return data;
}
