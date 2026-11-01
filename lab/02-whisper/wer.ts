// Word error rate, defined exactly once. Both models go through the same functions.
//
// Words: lower-case, accents and punctuation stripped. Hyphens, dashes and ellipses break
// words, so "half-sunk" and "desert...Near" are two words each, because the published texts
// print them that way. An apostrophe just goes, so "don't" is "dont". A spelling variant such
// as "traveler" for "traveller" stays different, and so counts as an error.
// Edit distance: the standard word-level one, where a substitution, an insertion and a
// deletion each cost one.
// Word error rate: edits divided by the number of words in the published text.
//
// A LibriVox file also holds a spoken preamble and closing that the published text doesn't
// have. scoreTranscript handles that by one rule: it scores the unbroken run of transcript
// words that fits the whole published text best, and leaves out the words on either side of
// that run. Every published word still counts, so a missed opening or ending is an error.

export interface EditCounts {
  substitutions: number;
  insertions: number;
  deletions: number;
  errors: number;
}

export interface TranscriptScore extends EditCounts {
  referenceWords: number;
  wer: number;
  scoredWords: number;
  droppedBefore: string[];
  droppedAfter: string[];
}

interface Cell extends EditCounts {
  start: number;
}

const NO_EDITS: EditCounts = { substitutions: 0, insertions: 0, deletions: 0, errors: 0 };

export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[-\u2010-\u2015]+|\.{2,}|\.(\s+\.)+/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .split(/\s+/u)
    .filter(Boolean);
}

function withEdit(cell: Cell, kind: 'substitutions' | 'insertions' | 'deletions'): Cell {
  return { ...cell, [kind]: cell[kind] + 1, errors: cell.errors + 1 };
}

/** The cheapest candidate. On a tie the earlier one wins, so ties resolve the same way every time. */
function cheapest(candidates: readonly Cell[]): Cell {
  return candidates.reduce((best, cell) => (cell.errors < best.errors ? cell : best));
}

function nextRow(refWord: string, previous: readonly Cell[], hyp: readonly string[]): Cell[] {
  const row = [withEdit(previous[0], 'deletions')];
  for (let j = 1; j <= hyp.length; j += 1) {
    const diagonal = hyp[j - 1] === refWord ? previous[j - 1] : withEdit(previous[j - 1], 'substitutions');
    row.push(cheapest([diagonal, withEdit(previous[j], 'deletions'), withEdit(row[j - 1], 'insertions')]));
  }
  return row;
}

function lastRow(ref: readonly string[], hyp: readonly string[], firstRow: readonly Cell[]): readonly Cell[] {
  return ref.reduce<readonly Cell[]>((row, word) => nextRow(word, row, hyp), firstRow);
}

function countsOf(cell: Cell): EditCounts {
  const { substitutions, insertions, deletions, errors } = cell;
  return { substitutions, insertions, deletions, errors };
}

/** The standard edit distance between two lists of words. */
export function wordEdits(ref: readonly string[], hyp: readonly string[]): EditCounts {
  const firstRow = hyp.reduce<Cell[]>((row) => [...row, withEdit(row[row.length - 1], 'insertions')], [{ ...NO_EDITS, start: 0 }]);
  return countsOf(lastRow(ref, hyp, firstRow)[hyp.length]);
}

function requireReference(text: string): string[] {
  const words = normalizeWords(text);
  if (!words.length) throw new Error('the reference text has no words');
  return words;
}

/** Edits over reference words, comparing the two texts whole. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = requireReference(reference);
  return wordEdits(ref, normalizeWords(hypothesis)).errors / ref.length;
}

/** The score under this lab's rule: the whole published text against its best-fitting run of the transcript. */
export function scoreTranscript(reference: string, transcript: string): TranscriptScore {
  const ref = requireReference(reference);
  const hyp = normalizeWords(transcript);
  // Starting anywhere in the transcript is free, and so is ending anywhere.
  const firstRow = Array.from({ length: hyp.length + 1 }, (_, j): Cell => ({ ...NO_EDITS, start: j }));
  const row = lastRow(ref, hyp, firstRow);
  const best = cheapest(row);
  const end = row.indexOf(best);
  return {
    ...countsOf(best),
    referenceWords: ref.length,
    wer: best.errors / ref.length,
    scoredWords: end - best.start,
    droppedBefore: hyp.slice(0, best.start),
    droppedAfter: hyp.slice(end),
  };
}

/** Word error rate across recordings: all edits over all published words. */
export function corpusWer(scores: readonly Pick<TranscriptScore, 'errors' | 'referenceWords'>[]): number {
  if (!scores.length) throw new Error('word error rate of an empty list');
  const errors = scores.reduce((sum, s) => sum + s.errors, 0);
  const words = scores.reduce((sum, s) => sum + s.referenceWords, 0);
  return errors / words;
}
