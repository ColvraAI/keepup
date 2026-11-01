// What's on a model list that the id finder didn't recognise. keepup can't say those are fine, only that it didn't check them.
import { isDataFile } from './catalog-use.ts';
import type { ModelId } from './facts.ts';

const LIST_MIN_IDS = 8;
const KEY_AND_VALUE = /["']?([\w-]+)["']?\s*[:=]\s*["'`]([^"'`]+)["'`]/;

export interface Unrecognised {
  readonly count: number;
  readonly files: readonly string[];
}

function isList(file: string, ids: ReadonlySet<string>): boolean {
  return ids.size >= LIST_MIN_IDS || isDataFile(file);
}

/** "models/gemini-2.0-flash" is a route to an id it knows. */
function known(value: string, recognised: ReadonlySet<string>): boolean {
  return recognised.has(value) || recognised.has(value.split('/').pop() ?? value);
}

function unrecognisedIn(text: string, places: readonly { readonly text: string }[], recognised: ReadonlySet<string>): Set<string> {
  const hits = new Map<string, number>();
  for (const place of places) {
    const match = place.text.match(KEY_AND_VALUE);
    if (match && known(match[2], recognised)) hits.set(match[1], (hits.get(match[1]) ?? 0) + 1);
  }
  // The key most of them sit on: a display name can happen to read like an id, and every name on the list isn't one.
  const key = [...hits].sort(([, a], [, b]) => b - a)[0]?.[0];
  return new Set(text.split('\n').flatMap((line) => {
    const match = line.match(KEY_AND_VALUE);
    return key && match?.[1] === key && !known(match[2], recognised) ? [match[2]] : [];
  }));
}

export function unrecognisedOnLists(modelIds: readonly ModelId[], files: ReadonlyMap<string, string>): Unrecognised | null {
  const recognised = new Set(modelIds.map((model) => model.id));
  const byFile = new Map<string, { ids: Set<string>; places: { text: string }[] }>();
  for (const model of modelIds) {
    for (const place of model.places) {
      const entry = byFile.get(place.file) ?? { ids: new Set<string>(), places: [] };
      entry.ids.add(model.id);
      entry.places.push(place);
      byFile.set(place.file, entry);
    }
  }
  const found = [...byFile].filter(([file, { ids }]) => isList(file, ids)).map(([file, { places }]) => ({ file, values: unrecognisedIn(files.get(file) ?? '', places, recognised) })).filter(({ values }) => values.size > 0);
  return found.length ? { count: found.reduce((sum, item) => sum + item.values.size, 0), files: found.map((item) => item.file) } : null;
}
