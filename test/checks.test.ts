import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { corpusOf, numberClaims, runChecks } from '../src/checks.ts';

const files = new Map([
  ['src/voice.ts', 'class V {\n  this.model = "whisper-1";\n}\n'],
  ['config.py', 'API_KEY = "[masked]"\n'],
]);
const finding = (over: object = {}) => ({
  title: 'Whisper-1 shuts down on 26 Feb 2027',
  effect: ['keeps working'],
  proof: 'vendor claim',
  effort: 'Hours',
  where: [{ file: 'src/voice.ts', line: 2, text: 'this.model = "whisper-1";' }],
  why: 'Announced on 26 Aug.',
  options: [],
  sources: ['https://developers.openai.com/api/docs/changelog'],
  lever: null,
  pr: null,
  evidence: ['Announced 2026-08-26. These models will shut down on February 26, 2027.'],
  ...over,
});
const check = (f: object) => runChecks({ findings: [f] as never, files, sourceText: () => '' });

describe('runChecks', () => {
  it('passes a finding that holds up, and counts each check', () => {
    const out = check(finding());
    assert.equal(out.findings.length, 1);
    assert.deepEqual(out.checks.dropped, []);
    assert.ok(out.checks.passed >= 3);
    assert.ok(!('evidence' in out.findings[0]) || out.findings[0].evidence);
  });

  it('drops a file that is not in the repo at this commit, loudly', () => {
    const out = check(finding({ where: [{ file: 'src/nope.ts', line: 2, text: 'x' }] }));
    assert.deepEqual(out.findings, []);
    assert.equal(out.checks.dropped.length, 1);
    assert.match(out.checks.dropped[0].why, /src\/nope\.ts/);
    assert.match(out.checks.dropped[0].what, /Whisper-1/);
  });

  it('drops a line past the end, or one that says something else', () => {
    assert.match(check(finding({ where: [{ file: 'src/voice.ts', line: 99, text: 'x' }] })).checks.dropped[0].why, /no line 99/);
    assert.match(check(finding({ where: [{ file: 'src/voice.ts', line: 1, text: 'this.model' }] })).checks.dropped[0].why, /says something else/);
  });

  it('drops a finding with no place at all', () => {
    assert.match(check(finding({ where: [] })).checks.dropped[0].why, /file and line/);
  });

  it('drops an effect word or proof label outside the rules', () => {
    assert.match(check(finding({ effect: ['safer'] })).checks.dropped[0].why, /effect/);
    assert.match(check(finding({ proof: 'trust me' })).checks.dropped[0].why, /proof/);
  });

  it('drops a source that is no real URL, and a finding with none', () => {
    assert.match(check(finding({ sources: ['see the docs'] })).checks.dropped[0].why, /source/);
    assert.match(check(finding({ sources: ['http://localhost/x'] })).checks.dropped[0].why, /source/);
    assert.match(check(finding({ sources: [] })).checks.dropped[0].why, /source/);
  });

  it('drops a number nobody can read from a source', () => {
    const out = check(finding({ why: 'It costs $0.10 and is 10x faster.' }));
    assert.match(out.checks.dropped[0].why, /\$0\.10|0\.10/);
  });

  it('accepts a number read from the source text', () => {
    const out = runChecks({
      findings: [finding({ why: 'It costs $0.10 per million and is 10x faster.' })] as never,
      files,
      sourceText: () => 'gpt-6-luna costs $0.10 per million input tokens; 10x faster than the Responses API',
    });
    assert.equal(out.findings.length, 1);
  });

  it('drops a date nobody can read from a source', () => {
    assert.match(check(finding({ title: 'Shuts down on 26 Mar 2027' })).checks.dropped[0].why, /26 Mar 2027/);
  });

  it('checks masked text against the masked line', () => {
    const out = check(finding({ where: [{ file: 'config.py', line: 1, text: 'API_KEY = "[masked]"' }] }));
    assert.equal(out.findings.length, 1);
  });

  it('never changes its input', () => {
    const input = Object.freeze([Object.freeze(finding())]);
    runChecks({ findings: input as never, files, sourceText: () => '' });
    assert.equal(input.length, 1);
  });
});

describe('numberClaims', () => {
  const claims = (text: string) => numberClaims(text);

  it('ignores model ids, versions in names, file paths and small plain counts', () => {
    assert.deepEqual(claims('whisper-1 and gpt-6-luna and claude-sonnet-4-5-20250929 in file.js:12'), []);
    assert.deepEqual(claims('2 Anthropic models and 3 majors'), []);
  });

  it('keeps prices, multiples, percentages, versions and big counts', () => {
    assert.deepEqual(claims('$0.10 and 10x and 73% and 3.8.0 and 41,799'), ['0.10', '10x', '73%', '3.8.0', '41799']);
  });

  it('a number with a unit or a hyphen joined to it is still a claim', () => {
    assert.deepEqual(claims('answers come back in 7ms-50ms'), ['7', '50']);
    assert.deepEqual(claims('9731-dimensional vectors'), ['9731']);
    assert.deepEqual(claims('768-dimensional'), ['768']);
    assert.deepEqual(claims('1.5s latency'), ['1.5']);
    assert.deepEqual(claims('a 512-token limit and 8192 tokens'), ['512', '8192']);
    assert.deepEqual(claims('took 3ms'), ['3']);
    assert.deepEqual(claims('a 2-hour job at 16GB'), ['2', '16']);
    assert.deepEqual(claims('$0.10-$0.50 a call'), ['0.10', '0.50']);
    assert.deepEqual(claims('8K-token context, 100+ languages'), ['8K', '100']);
    assert.deepEqual(claims('2x-3x faster'), ['2x', '3x']);
  });

  it('a plain small count stays uncounted, and what merely starts with a digit is not a number', () => {
    assert.deepEqual(claims('2 models and 3 majors, the 1st and 2nd, at commit 9caf2b4 and 5efb4e8'), []);
    assert.deepEqual(claims('a 3-5 day job'), [], 'a plain small range');
    assert.deepEqual(claims('gpt-4o-mini, Sonnet 5.5, claude-sonnet-4-5, text-embedding-3-small'), ['5.5']);
  });

  it('a line reference points at a place, so it is no claim', () => {
    assert.deepEqual(claims('the handler it requires (imported.js lines 15-23), and line 88'), []);
  });

  it('a source can hold a small number, so a claim with a unit can be read from it', () => {
    const corpus = corpusOf(['Replies take 7ms at best, and 50 ms at worst. 768-dimensional.']);
    for (const token of ['7', '50', '768']) assert.ok(corpus.has(token), token);
    assert.ok(!corpus.has('9731'));
  });

  it('reads dates in every form to one spelling', () => {
    assert.deepEqual(claims('26 Feb 2027, February 26, 2027 and 2027-02-26'), ['2027-02-26', '2027-02-26', '2027-02-26']);
    assert.deepEqual(claims('on 26 Aug or Aug 26'), ['--08-26', '--08-26']);
  });
});
