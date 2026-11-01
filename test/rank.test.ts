import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { rankFindings, type RankableFinding } from '../src/rank.ts';

const finding = (over: Partial<RankableFinding>): RankableFinding => ({
  title: 'x', effect: ['cheaper'], proof: 'vendor claim', effort: 'A day', ...over,
});
const asOf = '2026-10-31';
const titles = (input: RankableFinding[]) => rankFindings(input, asOf).findings.map((f) => f.title);

describe('rankFindings', () => {
  it('puts what breaks within 30 days first, soonest first, whatever else ranks higher', () => {
    assert.deepEqual(titles([
      finding({ title: 'measured gain', proof: 'measured', effort: 'Hours' }),
      finding({ title: 'breaks in 30 days', proof: 'vendor claim', effort: 'A project', deadline: '2026-11-30' }),
      finding({ title: 'broke already', proof: 'vendor claim', effort: 'A project', deadline: '2026-06-15' }),
    ]), ['broke already', 'breaks in 30 days', 'measured gain']);
  });

  it('does not treat a deadline months away as breaking soon', () => {
    assert.deepEqual(titles([
      finding({ title: 'in four months', proof: 'adoption only', effort: 'A project', deadline: '2027-02-26' }),
      finding({ title: 'gain', proof: 'vendor claim', effort: 'A day' }),
    ]), ['gain', 'in four months']);
  });

  it('then the biggest proven gain per hour of work', () => {
    assert.deepEqual(titles([
      finding({ title: 'adoption, hours', proof: 'adoption only', effort: 'Hours' }),
      finding({ title: 'measured, a day', proof: 'measured', effort: 'A day' }),
      finding({ title: 'vendor, a project', proof: 'vendor claim', effort: 'A project' }),
      finding({ title: 'vendor, hours', proof: 'vendor claim', effort: 'Hours' }),
    ]), ['vendor, hours', 'measured, a day', 'adoption, hours', 'vendor, a project']);
  });

  it('more effect words only break a tie', () => {
    assert.deepEqual(titles([
      finding({ title: 'one', effect: ['cheaper'] }),
      finding({ title: 'two', effect: ['cheaper', 'faster'] }),
    ]), ['two', 'one']);
  });

  it('numbers from 1, and never changes its input', () => {
    const input = Object.freeze([finding({ title: 'a' })]) as RankableFinding[];
    const { findings } = rankFindings(input, asOf);
    assert.equal(findings[0].rank, 1);
    assert.equal('rank' in input[0], false);
  });

  it('is stable: ties keep a fixed order by title', () => {
    assert.deepEqual(titles([finding({ title: 'b' }), finding({ title: 'a' })]), ['a', 'b']);
  });

  it('explains the order in one line', () => {
    const { explanation } = rankFindings([], asOf);
    assert.ok(!explanation.includes('\n'));
    assert.match(explanation, /30 days/);
    assert.match(explanation, /per hour/);
  });
});

describe('rankFindings against the answer key', () => {
  it('levers lead, by the founder\'s call: router, embedder, skills, and only then Gemini, whisper, tts', () => {
    const shuffled: RankableFinding[] = [
      finding({ title: 'skills', effect: ['new capability'], proof: 'adoption only', effort: 'A day or more' }),
      finding({ title: 'tts', effect: ['keeps working'], effort: 'A day or more', deadline: '2027-01-06', reach: 'sent' }),
      finding({ title: 'embedder', effect: ['better answers'], effort: 'A day or more' }),
      finding({ title: 'picker entries', effect: ['keeps working'], effort: 'Hours', deadline: '2027-03-15', reach: 'picker' }),
      finding({ title: 'whisper', effect: ['keeps working'], effort: 'A day', deadline: '2027-02-26', reach: 'sent' }),
      finding({ title: 'router', effect: ['cheaper', 'faster'], effort: 'A day' }),
      finding({ title: 'Gemini', effect: ['keeps working'], effort: 'A day', deadline: '2026-06-01', reach: 'sent' }),
    ];
    assert.deepEqual(titles(shuffled), ['router', 'embedder', 'skills', 'Gemini', 'whisper', 'tts', 'picker entries']);
  });

  it('two effect words break a tie, and never double a score', () => {
    assert.deepEqual(titles([
      finding({ title: 'one word, hours', effect: ['cheaper'], effort: 'Hours' }),
      finding({ title: 'two words, a day', effect: ['cheaper', 'faster'], effort: 'A day' }),
    ]), ['one word, hours', 'two words, a day']);
  });

  it('code that sends a deprecated model with no date comes after what has a date, and before nothing it outranks by effort alone', () => {
    assert.deepEqual(titles([
      finding({ title: 'no date yet', effect: ['keeps working'], effort: 'Hours', reach: 'undated' }),
      finding({ title: 'a gain', effect: ['better answers'], effort: 'A day or more' }),
      finding({ title: 'whisper', effect: ['keeps working'], effort: 'A day', deadline: '2027-02-26', reach: 'sent' }),
    ]), ['a gain', 'whisper', 'no date yet']);
  });

  it('a list entry that breaks soon still comes after what code sends', () => {
    assert.deepEqual(titles([
      finding({ title: 'only on a list', deadline: '2026-06-01', reach: 'picker' }),
      finding({ title: 'sent', deadline: '2026-08-01', reach: 'sent' }),
    ]), ['sent', 'only on a list']);
  });
});
