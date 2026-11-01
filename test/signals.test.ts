import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { compileRegex, excludedFromSignals, loadSignals, runSignals, signalsApplyTo } from '../src/signals.ts';

describe('loadSignals', () => {
  const spec = loadSignals();

  it('loads all 43 signals from db/signals.json as data', () => {
    assert.equal(spec.signals.length, 43);
    assert.ok(spec.signals.some((s) => s.name === 'jev'));
  });

  it('compiles every signal, including the strict ones, to a JS regex', () => {
    assert.ok(spec.strict.length > 0);
    for (const s of [...spec.signals, ...spec.strict]) assert.ok(s.re instanceof RegExp, s.name);
  });
});

describe('compileRegex', () => {
  it('turns a leading (?i) into a JS flag', () => {
    const re = compileRegex('(?i)classify (the|this)');
    assert.equal(re.flags, 'i');
    assert.ok(re.test('CLASSIFY THIS'));
  });

  it('keeps an explicit flag and drops the stateful ones', () => {
    assert.equal(compileRegex('abc', 'gi').flags, 'i');
  });

  it('smart case: all lowercase ignores case, an uppercase letter does not', () => {
    assert.equal(compileRegex('ollama', undefined, { smartCase: true }).flags, 'i');
    assert.equal(compileRegex('MAX_HISTORY', undefined, { smartCase: true }).flags, '');
    assert.equal(compileRegex('import\\s+\\S+', undefined, { smartCase: true }).flags, 'i');
  });

  it('names the bad pattern in its error', () => {
    assert.throws(() => compileRegex('(unclosed', undefined, { label: 'db/patterns/PAT-x.json' }), /PAT-x/);
  });
});

describe('which files signals read', () => {
  const spec = loadSignals();

  it('honours the excluded directories and globs, at any depth', () => {
    for (const path of ['node_modules/a.js', 'src/docs/a.js', 'test/a.ts', 'a/tests/b.py', 'src/a.test.ts', 'x/a.spec.js', 'public/a.js', 'examples/a.py']) {
      assert.ok(excludedFromSignals(path, spec), path);
    }
    assert.ok(!excludedFromSignals('src/router.ts', spec));
  });

  it('reads code files only, and skips hidden folders the way ripgrep does', () => {
    assert.ok(signalsApplyTo('server/index.js', spec));
    assert.ok(!signalsApplyTo('server/config.toml', spec));
    assert.ok(!signalsApplyTo('.github/scripts/a.js', spec));
  });
});

describe('runSignals', () => {
  const spec = loadSignals();
  const files = [
    { path: 'src/a.ts', text: "import OpenAI from 'openai';\nclient.chat.completions.create({});\nconst k = 'sk-FAKEfakeFAKEfakeFAKEfake0123456789'; client.messages.create({});\n" },
    { path: 'src/b.py', text: 'from openai import OpenAI\n' },
    { path: 'tests/c.py', text: 'from openai import OpenAI\n' },
    { path: 'src/d.ts', text: "import a from 'openai';\n".repeat(6) },
  ];

  it('counts hits and files, and keeps four masked samples at most, like inventory.py', () => {
    const out = runSignals(files, spec);
    assert.deepEqual([out.sdk_openai.hits, out.sdk_openai.files], [8, 3]);
    assert.equal(out.sdk_openai.samples.length, 4);
    assert.deepEqual(out.sdk_openai.samples[0], { file: 'src/a.ts', line: 1, text: "import OpenAI from 'openai';" });
    assert.equal(out.llm_call.hits, 2);
    assert.ok(!JSON.stringify(out).includes('sk-FAKE'));
  });

  it('treats a line over the limit as data', () => {
    const text = `import a from 'openai'; // ${'x'.repeat(30_000)}\nimport b from 'openai';\n`;
    const out = runSignals([{ path: 'src/a.ts', text }], spec);
    assert.equal(out.sdk_openai.hits, 1);
    assert.equal(out.sdk_openai.samples[0].line, 2);
  });

  it('leaves out signals with no hits', () => {
    assert.equal(runSignals(files, spec).jev, undefined);
  });
});
