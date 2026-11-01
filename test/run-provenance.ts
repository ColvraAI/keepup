// What a published run may state, read from the repo's own data, with no clones and no network. A date, price or
// multiplier in shown prose has to be in the finding's evidence, on a cited line, or in a record, lever or saved page behind it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpusOf, numberClaims, plainDecimal } from '../src/checks.ts';
import { humanDate } from '../src/dates.ts';
import { allSources, changelogEntries, loadRecords, retirements } from '../src/db.ts';
import { recordUrls } from '../src/judge-bundles.ts';
import { loadLevers } from '../src/levers.ts';
import type { Finding, Run } from '../src/run-shape.ts';
import { ROOT } from './helpers.ts';

const REPLAY = join(ROOT, 'data', 'replay');

function readAll(dir: string): { name: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? readAll(path) : [{ name: decodeURIComponent(entry.name), text: readFileSync(path, 'utf8') }];
  });
}

function addTo(map: Map<string, string>, url: unknown, text: string): void {
  if (typeof url === 'string' && url) map.set(url, `${map.get(url) ?? ''}\n${text}`);
}

function buildIndex(): Map<string, string> {
  const texts = new Map<string, string>();
  for (const record of loadRecords(allSources())) for (const url of recordUrls(record)) addTo(texts, url, JSON.stringify(record));
  for (const entry of changelogEntries()) addTo(texts, entry.url, `${entry.date} ${entry.text}`);
  for (const lever of loadLevers()) {
    addTo(texts, lever.source, JSON.stringify(lever));
    addTo(texts, lever.id, JSON.stringify(lever));
  }
  for (const row of retirements()) {
    addTo(texts, row.source, `${row.sentence} ${row.effective ?? ''}`);
    addTo(texts, row.page_source, `${row.sentence} ${row.effective ?? ''}`);
  }
  for (const { name, text } of readAll(join(REPLAY, 'cards'))) addTo(texts, `https://huggingface.co/${name.replace(/\.txt$/, '')}`, text);
  for (const { text } of readAll(join(REPLAY, 'notes'))) {
    try {
      const notes = JSON.parse(text) as { url?: string; text?: string } | null;
      addTo(texts, notes?.url, notes?.text ?? '');
    } catch { /* A saved null. */ }
  }
  for (const { text } of readAll(join(REPLAY, 'registry'))) {
    try {
      const info = JSON.parse(text) as { source?: string };
      addTo(texts, info.source, text);
    } catch { /* Not one of ours. */ }
  }
  addTo(texts, 'https://openrouter.ai/models', '');
  return texts;
}

const INDEX = buildIndex();

export function knownSource(url: string): boolean {
  return INDEX.has(url);
}

function linksOf(finding: Finding): string[] {
  return [...finding.sources, ...finding.options.map((option) => option.source), ...(finding.lever ? [finding.lever] : [])];
}

/** A date the exact checks read has to be the date the finding states for that model. A page holds many dates; this holds the one. */
export function misstatedModelDates(run: Run, finding: Finding): string[] {
  return run.exact.flatMap((check) => {
    if (check.kind !== 'model' || !check.effective || check.routed_to || !check.live_places.some((place) => finding.where.some((w) => w.file === place.file && w.line === place.line))) return [];
    const when = humanDate(check.effective);
    const said = check.status === 'retired' ? `${check.model} was shut down on ${when}` : `${check.model} shuts down ${check.earliest ? 'no earlier than' : 'on'} ${when}`;
    return finding.why.includes(said) ? [] : [said];
  });
}

/** The claims in this finding that nothing behind it holds. */
export function unreadableNumbers(run: Run, finding: Finding): string[] {
  const manifests = (run.facts.manifests ?? []).flatMap((manifest) => manifest.dependencies.map((dep) => `${dep.spec} ${dep.locked?.version ?? ''}`));
  const corpus = corpusOf([
    ...(finding.evidence ?? []),
    ...finding.where.map((place) => `${place.text} ${place.line}`),
    ...finding.options.map((option) => option.name),
    ...linksOf(finding).map((url) => INDEX.get(url) ?? ''),
    ...manifests,
  ]);
  const prose = [finding.title, finding.why, ...finding.options.flatMap((option) => [option.what, option.needs])];
  return prose.flatMap(numberClaims).filter((token) => !corpus.has(token) && !corpus.has(plainDecimal(token)));
}
