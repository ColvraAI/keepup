// node lab/02-whisper/build-testset.ts
// Fetches each source once and writes testset.json and testset.md, so that every URL,
// file hash, length, reader and published word in the test set is read from its source.
// It never downloads the audio itself, only its archive.org metadata.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTestSetNotes, type LocalCheck } from './testset-notes.ts';
import { extractText, parseCatalogRows, pickRow, SELECTION_RULE, type Recording, type TestSet } from './testset.ts';

interface Source {
  id: string;
  title: string;
  author: string;
  catalogUrl: string;
  textPageUrl: string;
  textUrl: string;
  textNote: string;
  start: string;
  end: string;
}

interface ArchiveFile {
  name: string;
  size: string;
  sha1: string;
  length: string;
}

const LAB_DIR = import.meta.dirname;

const LICENCE_NOTE =
  "LibriVox's catalog pages state its recordings are in the public domain in the USA, and each archive.org item names its licence below. The texts are public domain works, taken from Project Gutenberg. Outside the USA, check your own country's rules. Only metadata and text live in this repo; the audio is downloaded into lab/.work/ when the lab runs.";

const SOURCES: readonly Source[] = [
  {
    id: 'gettysburg-address',
    title: 'The Gettysburg Address',
    author: 'Abraham Lincoln',
    catalogUrl: 'https://librivox.org/the-gettysburg-address-by-abraham-lincoln/',
    textPageUrl: 'https://www.gutenberg.org/ebooks/4',
    textUrl: 'https://www.gutenberg.org/ebooks/4.txt.utf-8',
    textNote: "The text LibriVox's catalog page links to. Prose, and the only one of the three that isn't verse.",
    start: 'Four score and seven years ago',
    end: 'shall not perish from this earth.',
  },
  {
    id: 'in-flanders-fields',
    title: 'In Flanders Fields',
    author: 'John McCrae',
    catalogUrl: 'https://librivox.org/in-flanders-fields-by-john-mccrae-2/',
    textPageUrl: 'https://www.gutenberg.org/ebooks/353',
    textUrl: 'https://www.gutenberg.org/ebooks/353.txt.utf-8',
    textNote: "The text LibriVox's catalog page links to.",
    start: 'In Flanders fields the poppies blow',
    end: 'We shall not sleep, though poppies grow In Flanders fields.',
  },
  {
    id: 'ozymandias',
    title: 'Ozymandias of Egypt',
    author: 'Percy Bysshe Shelley',
    catalogUrl: 'https://librivox.org/ozymandias-of-egypt-by-percy-bysshe-shelley/',
    textPageUrl: 'https://www.gutenberg.org/ebooks/4800',
    textUrl: 'https://www.gutenberg.org/ebooks/4800.txt.utf-8',
    textNote: "LibriVox's catalog page links only to its own recording, so this is Thomas Hutchinson's edition of Shelley on Project Gutenberg, without its editor's line numbers.",
    start: 'I met a traveller from an antique land',
    end: 'The lone and level sands stretch far away.',
  },
];

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

async function archiveFile(audioUrl: string): Promise<{ licence: string; itemUrl: string; file: ArchiveFile; url: string }> {
  const match = audioUrl.match(/\/download\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`not an archive.org download link: ${audioUrl}`);
  const [, item, name] = match;
  const metadata = JSON.parse(await fetchText(`https://archive.org/metadata/${item}`)) as { metadata: { licenseurl?: string }; files: ArchiveFile[] };
  const file = metadata.files.find((f) => f.name === name);
  if (!file) throw new Error(`${name} isn't in archive.org item ${item}`);
  if (!metadata.metadata.licenseurl) throw new Error(`archive.org item ${item} names no licence`);
  return { licence: metadata.metadata.licenseurl, itemUrl: `https://archive.org/details/${item}`, file, url: `https://archive.org/download/${item}/${name}` };
}

async function buildRecording(source: Source): Promise<Recording> {
  const row = pickRow(parseCatalogRows(await fetchText(source.catalogUrl)));
  const archive = await archiveFile(row.audioUrl);
  return {
    id: source.id,
    title: source.title,
    author: source.author,
    reader: row.reader,
    catalogUrl: source.catalogUrl,
    catalogLength: row.length,
    archiveItemUrl: archive.itemUrl,
    audioUrl: archive.url,
    audioFile: archive.file.name,
    audioBytes: Number(archive.file.size),
    audioSha1: archive.file.sha1,
    audioLength: archive.file.length,
    audioLicence: archive.licence,
    textPageUrl: source.textPageUrl,
    textUrl: source.textUrl,
    textNote: source.textNote,
    text: extractText(await fetchText(source.textUrl), source.start, source.end),
  };
}

function readLocalCheck(): LocalCheck | null {
  const path = join(LAB_DIR, 'testset-check.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LocalCheck) : null;
}

async function main(): Promise<void> {
  const recordings = await Promise.all(SOURCES.map(buildRecording));
  const testSet: TestSet = {
    schema: 1,
    fetched: new Date().toISOString().slice(0, 10),
    selectionRule: SELECTION_RULE,
    licenceNote: LICENCE_NOTE,
    recordings,
  };
  writeFileSync(join(LAB_DIR, 'testset.json'), `${JSON.stringify(testSet, null, 2)}\n`);
  writeFileSync(join(LAB_DIR, 'testset.md'), renderTestSetNotes(testSet, readLocalCheck()));
  console.log(recordings.map((r) => `${r.id}: ${r.reader}, ${r.audioLength}, ${r.audioFile}`).join('\n'));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`build-testset: ${(error as Error).message}`);
    process.exit(1);
  });
}
