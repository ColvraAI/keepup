// Reads BEIR's SciFact as published, and picks the test set deterministically.

export interface Doc {
  id: string;
  title: string;
  text: string;
}

export interface Query {
  id: string;
  text: string;
}

export type Qrels = ReadonlyMap<string, ReadonlySet<string>>;

function jsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').filter((line) => line.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`line ${i + 1} is not JSON: ${(error as Error).message}`);
    }
  });
}

function requireString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`row ${String(row._id)} has no string ${field}`);
  return value;
}

export function parseCorpus(text: string): Doc[] {
  return jsonLines(text).map((row) => ({
    id: requireString(row, '_id'),
    title: typeof row.title === 'string' ? row.title : '',
    text: requireString(row, 'text'),
  }));
}

export function parseQueries(text: string): Query[] {
  return jsonLines(text).map((row) => ({ id: requireString(row, '_id'), text: requireString(row, 'text') }));
}

/** BEIR's qrels: a header, then query-id, corpus-id, score. Only a score above 0 counts as relevant. */
export function parseQrels(text: string): Qrels {
  const [header, ...rows] = text.split('\n').filter((line) => line.trim());
  if (!header?.startsWith('query-id')) throw new Error('qrels have no query-id header');
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const [query, doc, score] = row.split('\t');
    if (!query || !doc || !Number.isFinite(Number(score))) throw new Error(`bad qrels row: ${row}`);
    if (Number(score) > 0) out.set(query, new Set([...(out.get(query) ?? []), doc]));
  }
  return out;
}

const byNumericId = (a: { id: string }, b: { id: string }): number => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);

/** The first n queries of the split, sorted by id. A query must have a relevant document in the corpus. */
export function selectQueries(queries: readonly Query[], qrels: Qrels, corpus: readonly Doc[], n: number): Query[] {
  const known = new Set(corpus.map((d) => d.id));
  const usable = queries.filter((q) => [...(qrels.get(q.id) ?? [])].some((id) => known.has(id)));
  if (usable.length < n) throw new Error(`the split has only ${usable.length} usable queries, ${n} were asked for`);
  return [...usable].sort(byNumericId).slice(0, n);
}

/** What goes to the embedder for one document: the BEIR convention of title then text. */
export function passageText(doc: Doc): string {
  return `${doc.title} ${doc.text}`.trim();
}

/** The ids of the passages relevant to these queries. */
export function relevantIds(queries: readonly Query[], qrels: Qrels): Set<string> {
  return new Set(queries.flatMap((q) => [...(qrels.get(q.id) ?? [])]));
}

/** The full run's corpus: every passage relevant to the queries, plus the lowest-id others up to size, in id order. */
export function corpusSubset(corpus: readonly Doc[], queries: readonly Query[], qrels: Qrels, size: number): Doc[] {
  const needed = relevantIds(queries, qrels);
  const relevant = corpus.filter((d) => needed.has(d.id));
  if (relevant.length > size) throw new Error(`${relevant.length} relevant passages don't fit in a subset of ${size}`);
  const others = corpus.filter((d) => !needed.has(d.id)).sort(byNumericId).slice(0, size - relevant.length);
  return [...relevant, ...others].sort(byNumericId);
}

/** The dry run's tiny corpus: the selected queries' relevant documents first, filled up in corpus order. Order stays corpus order. */
export function tinyCorpus(corpus: readonly Doc[], queries: readonly Query[], qrels: Qrels, size: number): Doc[] {
  const needed = relevantIds(queries, qrels);
  const relevant = corpus.filter((d) => needed.has(d.id)).slice(0, size);
  const chosen = new Set(relevant.map((d) => d.id));
  const fill = corpus.filter((d) => !chosen.has(d.id)).slice(0, size - relevant.length);
  const picked = new Set([...chosen, ...fill.map((d) => d.id)]);
  return corpus.filter((d) => picked.has(d.id));
}
