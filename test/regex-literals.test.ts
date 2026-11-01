import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { literalGate, mayMatch, requiredLiterals } from '../src/regex-literals.ts';

describe('requiredLiterals', () => {
  const cases: [string, string[] | null][] = [
    ['classify ', ['classify ']],
    ['JSON\\.parse', ['JSON.parse']],
    ['(?:JSON\\.parse|json\\.loads)\\(', ['JSON.parse', 'json.loads']],
    ['\\bclassify (?:the|this)', ['classify ']],
    // The real shape: anchors and lookaheads say nothing about what must be present.
    ['^(?!\\s*(?:#|//))(?!.*(?:tiktoken|encoding)).*(?:["\'`](?:code-davinci-001|code-cushman-002)["\'`](?!\\s*:)|[=:]\\s*(?:code-davinci-001|code-cushman-002)\\s*$)', ['code-davinci-001', 'code-cushman-002']],
    // Optional parts can't be required.
    ['abc?def', ['def']],
    ['(?:foo)?bar', ['bar']],
    ['foo*bar', ['bar']],
    ['fo{0,3}bar', ['bar']],
    ['foo+bar', ['foo']],
    ['foo{2,3}barx', ['barx']],
    ['fo{2}', ['fo']],
    // Nothing certain: no gate, so nothing can be lost.
    ['\\d+', null],
    ['a|\\d+', null],
    ['(?:foo|)', null],
    ['(?:foo)?', null],
    ['[abc]+', null],
    ['.*', null],
    ['x', null],
    // A character class or a backreference ends a literal, and a class may hold a ] when escaped.
    ['ab[\\]c]de', ['ab']],
    ['(ab)\\1cd', ['ab']],
    // Odd syntax is either read correctly or refused.
    ['a{b}c', ['a{b}c']],
    ['\\u0041bc', ['bc']],
    ['\\x41bc', ['bc']],
    ['\\cAbc', ['bc']],
    ['(?<name>abc)\\k<name>', ['abc']],
    ['(?<=abc)def', ['def']],
    ['(?<!abc)def', ['def']],
    ['(?=abc)def', ['def']],
  ];
  for (const [source, want] of cases) {
    it(`${source} needs ${JSON.stringify(want)}`, () => {
      assert.deepEqual(requiredLiterals(new RegExp(source)), want);
    });
  }

  it('prefers the most selective part of a sequence', () => {
    assert.deepEqual(requiredLiterals(/ab.*(?:longer-one|longer-two)/), ['longer-one', 'longer-two']);
  });

  it('lowercases under the i flag, so one literal stands for every spelling', () => {
    assert.deepEqual(requiredLiterals(/Classify (?:THE|this)/i), ['classify ']);
  });

  it('refuses a malformed code escape, which is a plain letter and swallows nothing', () => {
    // In these the | is a real alternation, so a line holding only the letter matches.
    for (const source of ['\\x|aword|cdef', '\\x4|aword', '\\u12|aword|cdef', '\\c|aword|cdef', '\\k|aword>|cdef']) {
      const re = new RegExp(source);
      assert.equal(requiredLiterals(re), null, source);
    }
  });

  it('refuses u and v flag syntax, and anything it cannot read', () => {
    assert.equal(requiredLiterals(/abc\p{L}/u), null);
    assert.equal(requiredLiterals(/café-ole/), null);
  });
});

describe('mayMatch', () => {
  it('passes a text holding a literal, and rejects one holding none', () => {
    const gate = literalGate(/(?:JSON\.parse|json\.loads)\(/);
    assert.equal(mayMatch(gate, 'x = json.loads(y)'), true);
    assert.equal(mayMatch(gate, 'x = yaml.load(y)'), false);
  });

  it('honours case-insensitive regexes', () => {
    assert.equal(mayMatch(literalGate(/classify this/i), 'CLASSIFY THIS NOW'), true);
    assert.equal(mayMatch(literalGate(/classify this/), 'CLASSIFY THIS NOW'), false);
  });

  it('passes everything when the regex has no certain literal', () => {
    assert.equal(mayMatch(literalGate(/\d+/), 'no digits'), true);
  });

  it('escapes what its literals hold', () => {
    const gate = literalGate(/a\.b\(c\)\/d\[e\]\$f/);
    assert.equal(mayMatch(gate, 'a.b(c)/d[e]$f'), true);
    assert.equal(mayMatch(gate, 'aXb(c)/d[e]$f'), false);
  });

  it('never rejects a line its regex matches', () => {
    const rules = [
      /(?:foo|bar)baz/, /foo?bar/, /^(?!#).*(?:["'](?:gpt-4|gpt-5)["'])/, /colou?r/i, /a(?:b|c)+d/, /x{1,2}yz/,
      /(?:ab|cd)(?:ef|gh)/, /\bword\b/, /a\.b/, /a\/b/, /["']model["']\s*:/, /(?:^|\s)key=/,
    ];
    const lines = ['foobaz', 'barbaz', 'fobar', 'foobar', 'x = "gpt-4"', "y 'gpt-5'", 'color', 'COLOUR', 'abd', 'acbcd', 'xyz', 'xxyz', 'abgh', 'cdef', 'a word here', 'a.b', 'a/b', '"model": 1', "'model':", 'key=1', ' key=2'];
    for (const re of rules) {
      const gate = literalGate(re);
      for (const line of lines) {
        if (re.test(line)) assert.ok(mayMatch(gate, line), `${re} on ${line}`);
      }
    }
  });
});
