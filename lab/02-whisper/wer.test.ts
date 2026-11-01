import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { corpusWer, normalizeWords, scoreTranscript, wordEdits, wordErrorRate } from './wer.ts';

test('normalizeWords lower-cases and strips punctuation', () => {
  assert.deepEqual(normalizeWords('Look on my works, ye Mighty, and despair!'), ['look', 'on', 'my', 'works', 'ye', 'mighty', 'and', 'despair']);
});

test('normalizeWords drops apostrophes, straight or curly', () => {
  assert.deepEqual(normalizeWords("don't don’t Flanders’ fields"), ['dont', 'dont', 'flanders', 'fields']);
});

test('normalizeWords treats hyphens, dashes and ellipses as word breaks', () => {
  assert.deepEqual(normalizeWords('half-sunk half sunk'), ['half', 'sunk', 'half', 'sunk']);
  assert.deepEqual(normalizeWords('the sea—and the–land -- far'), ['the', 'sea', 'and', 'the', 'land', 'far']);
  assert.deepEqual(normalizeWords('Stand in the desert...Near them'), ['stand', 'in', 'the', 'desert', 'near', 'them']);
  assert.deepEqual(normalizeWords('a great civil war. . .testing whether'), ['a', 'great', 'civil', 'war', 'testing', 'whether']);
});

test('normalizeWords drops marks around words, and accents, but keeps digits', () => {
  assert.deepEqual(normalizeWords('_My_ “name” is (blessèd) 1863'), ['my', 'name', 'is', 'blessed', '1863']);
  assert.deepEqual(normalizeWords('  \n '), []);
});

test('wordEdits is the standard word-level edit distance', () => {
  const ref = normalizeWords('the cat sat on the mat');
  assert.deepEqual(wordEdits(ref, ref), { substitutions: 0, insertions: 0, deletions: 0, errors: 0 });
  assert.deepEqual(wordEdits(['a', 'b', 'c', 'd'], ['a', 'x', 'c']), { substitutions: 1, insertions: 0, deletions: 1, errors: 2 });
  assert.deepEqual(wordEdits(['a', 'b'], ['a', 'x', 'b']), { substitutions: 0, insertions: 1, deletions: 0, errors: 1 });
  assert.deepEqual(wordEdits(['a', 'b'], []), { substitutions: 0, insertions: 0, deletions: 2, errors: 2 });
  assert.deepEqual(wordEdits([], ['a', 'b']), { substitutions: 0, insertions: 2, deletions: 0, errors: 2 });
});

test('wordEdits counts a tied alignment as substitutions: the total is what is defined, not the split', () => {
  const ref = normalizeWords('the cat sat on the mat');
  assert.deepEqual(wordEdits(ref, normalizeWords('the cat sit on mat today')), { substitutions: 3, insertions: 0, deletions: 0, errors: 3 });
});

test('wordErrorRate is errors over reference words, ignoring case and punctuation', () => {
  assert.equal(wordErrorRate('The cat, sat.', 'the CAT sat'), 0);
  assert.equal(wordErrorRate('Half sunk, a visage', 'half-sunk a visage'), 0);
  assert.equal(wordErrorRate('a traveller', 'a traveler'), 0.5);
  assert.equal(wordErrorRate('the cat sat on the mat', 'the cat sit on mat today'), 0.5);
  assert.equal(wordErrorRate('one two', ''), 1);
  assert.throws(() => wordErrorRate('', 'anything'), /reference/);
});

const POEM = 'In Flanders fields the poppies blow between the crosses row on row';
const PREAMBLE = 'In Flanders Fields by John McCrae. This is a LibriVox recording. All LibriVox recordings are in the public domain.';
const CLOSING = 'End of poem. This recording is in the public domain.';

test('scoreTranscript leaves out the words before and after the published text', () => {
  const score = scoreTranscript(POEM, `${PREAMBLE} ${POEM} ${CLOSING}`);
  assert.equal(score.errors, 0);
  assert.equal(score.wer, 0);
  assert.equal(score.referenceWords, 12);
  assert.deepEqual(score.droppedBefore, normalizeWords(PREAMBLE));
  assert.deepEqual(score.droppedAfter, normalizeWords(CLOSING));
});

test('scoreTranscript still counts every published word: inside the text and at both of its ends', () => {
  const changedInside = POEM.replace('poppies', 'puppies');
  assert.equal(scoreTranscript(POEM, `${PREAMBLE} ${changedInside} ${CLOSING}`).substitutions, 1);
  const extraInside = POEM.replace('blow', 'blow gently');
  assert.equal(scoreTranscript(POEM, `${PREAMBLE} ${extraInside} ${CLOSING}`).insertions, 1);
  const missedOpening = POEM.split(' ').slice(2).join(' ');
  assert.equal(scoreTranscript(POEM, `zzz ${missedOpening} ${CLOSING}`).errors, 2);
  const missedEnding = POEM.split(' ').slice(0, -2).join(' ');
  assert.equal(scoreTranscript(POEM, `${PREAMBLE} ${missedEnding} zzz zzz zzz`).errors, 2);
});

test('scoreTranscript scores an empty or unrelated transcript as all wrong', () => {
  assert.equal(scoreTranscript(POEM, '').wer, 1);
  assert.equal(scoreTranscript(POEM, 'nothing here matches at all').wer, 1);
  assert.throws(() => scoreTranscript('...', 'anything'), /reference/);
});

function bruteForceBest(ref: string[], hyp: string[]): number {
  let best = wordEdits(ref, []).errors;
  for (let start = 0; start <= hyp.length; start += 1) {
    for (let end = start; end <= hyp.length; end += 1) {
      best = Math.min(best, wordEdits(ref, hyp.slice(start, end)).errors);
    }
  }
  return best;
}

test('scoreTranscript finds the same best run as trying every run of the transcript', () => {
  const vocabulary = ['a', 'b', 'c', 'd'];
  let seed = 7;
  const next = (limit: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  const words = (count: number) => Array.from({ length: count }, () => vocabulary[next(vocabulary.length)]);
  for (let round = 0; round < 300; round += 1) {
    const ref = words(1 + next(6));
    const hyp = words(next(10));
    const score = scoreTranscript(ref.join(' '), hyp.join(' '));
    assert.equal(score.errors, bruteForceBest(ref, hyp), `ref=${ref.join(' ')} hyp=${hyp.join(' ')}`);
    assert.equal(score.errors, score.substitutions + score.insertions + score.deletions);
    assert.equal(score.droppedBefore.length + score.scoredWords + score.droppedAfter.length, hyp.length);
  }
});

test('corpusWer weighs each recording by its words', () => {
  assert.equal(corpusWer([{ errors: 1, referenceWords: 10 }, { errors: 9, referenceWords: 90 }]), 0.1);
  assert.throws(() => corpusWer([]), /empty/);
});
