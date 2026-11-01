// Retrieval metrics and brute-force cosine search. No vector database on purpose:
// the numbers then depend on the embedder alone.

export interface Scored {
  index: number;
  score: number;
}

function norm(vector: Float32Array, from: number, dim: number): number {
  let sum = 0;
  for (let i = from; i < from + dim; i += 1) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

/** Cosine similarity of one query against every row of a flat matrix, best first. Ties go to the earlier row. */
export function rankByCosine(query: Float32Array, matrix: Float32Array, dim: number, k: number): Scored[] {
  if (dim <= 0 || query.length !== dim) throw new Error(`query has ${query.length} dimensions, expected ${dim}`);
  if (matrix.length % dim !== 0) throw new Error(`matrix of ${matrix.length} values is not a multiple of ${dim}`);
  const queryNorm = norm(query, 0, dim);
  if (queryNorm === 0) throw new Error('query vector is all zeros');
  const rows = matrix.length / dim;
  const scored: Scored[] = [];
  for (let row = 0; row < rows; row += 1) {
    const from = row * dim;
    let dot = 0;
    for (let i = 0; i < dim; i += 1) dot += query[i] * matrix[from + i];
    const rowNorm = norm(matrix, from, dim);
    if (rowNorm === 0) throw new Error(`row ${row} is all zeros`);
    scored.push({ index: row, score: dot / (queryNorm * rowNorm) });
  }
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, k);
}

/** Share of a query's relevant documents found in the top k. */
export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) throw new Error('recall needs at least one relevant document');
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;
}

/** 1 / rank of the first relevant document in the top k, or 0 when none is there. */
export function reciprocalRankAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const at = ranked.slice(0, k).findIndex((id) => relevant.has(id));
  return at < 0 ? 0 : 1 / (at + 1);
}
