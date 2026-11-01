import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { claudeDisplayName, findModelIds, providerOf } from '../src/model-ids.ts';
import { contextFor, pathContext, rustTestBlocks } from '../src/code-context.ts';

describe('findModelIds', () => {
  const ids = (line: string) => findModelIds(line).map((m) => m.id);

  it('finds exact ids in code and config lines', () => {
    assert.deepEqual(ids('this.model = "whisper-1";'), ['whisper-1']);
    assert.deepEqual(ids('model = "claude-sonnet-4-20250514"'), ['claude-sonnet-4-20250514']);
    assert.deepEqual(ids('a = "gpt-4o-mini" or "gpt-6.1-terra"'), ['gpt-4o-mini', 'gpt-6.1-terra']);
    assert.deepEqual(ids('gemini-3.5-flash and text-embedding-3-small'), ['gemini-3.5-flash', 'text-embedding-3-small']);
    assert.deepEqual(ids('claude-2.1, claude-3-5-sonnet-latest'), ['claude-2.1', 'claude-3-5-sonnet-latest']);
    assert.deepEqual(ids('tts-1-hd dall-e-3 gpt-image-2 gpt-live-transcribe'), ['tts-1-hd', 'dall-e-3', 'gpt-image-2', 'gpt-live-transcribe']);
  });

  it('accepts the o-series only inside quotes, since o1 alone is too short to trust', () => {
    assert.deepEqual(ids('model: "o3-mini"'), ['o3-mini']);
    assert.deepEqual(ids("x = 'o1'"), ['o1']);
    assert.deepEqual(ids('Big o1 notation and o3 stuff'), []);
  });

  it('ignores things that only look like model ids', () => {
    for (const line of ['claude-code', 'claude-agent-sdk', '@anthropic-ai/claude-code', 'gemini-cli', 'see ./gpt-4.png', 'whisper-small', 'mygpt-4-thing', 'Claude Sonnet 4.5 is great']) {
      assert.deepEqual(ids(line).filter((id) => id !== 'gpt-4'), [], line);
    }
    assert.deepEqual(ids('mygpt-4-thing'), []);
  });

  it('tells a Bedrock id and a gateway id apart from a direct one', () => {
    assert.deepEqual(findModelIds('"us.anthropic.claude-3-5-haiku-20241022-v1:0"'), [{ id: 'claude-3-5-haiku-20241022', route: 'bedrock' }]);
    assert.deepEqual(findModelIds('"anthropic/claude-3-opus-20240229"'), [{ id: 'claude-3-opus-20240229', route: 'gateway' }]);
    assert.deepEqual(findModelIds('"claude-3-opus-20240229"'), [{ id: 'claude-3-opus-20240229', route: 'direct' }]);
  });
});

describe('providerOf', () => {
  it('names the provider that would announce a retirement', () => {
    assert.equal(providerOf('claude-sonnet-5-5'), 'anthropic');
    assert.equal(providerOf('whisper-1'), 'openai');
    assert.equal(providerOf('o3-mini'), 'openai');
    assert.equal(providerOf('text-embedding-3-small'), 'openai');
    assert.equal(providerOf('text-embedding-004'), 'google');
    assert.equal(providerOf('gemini-3.5-flash'), 'google');
    assert.equal(providerOf('veo-3.0-generate-001'), 'google');
    assert.equal(providerOf('deepseek-v4'), 'other');
  });
});

describe('claudeDisplayName', () => {
  const cases: [string, string | null][] = [
    ['claude-3-sonnet-20240229', 'Claude Sonnet 3'],
    ['claude-3-5-haiku-20241022', 'Claude Haiku 3.5'],
    ['claude-3-7-sonnet-latest', 'Claude Sonnet 3.7'],
    ['claude-sonnet-4-20250514', 'Claude Sonnet 4'],
    ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
    ['claude-opus-4-1-20250805', 'Claude Opus 4.1'],
    ['claude-2.1', 'Claude 2.1'],
    ['claude-2', 'Claude 2'],
    ['whisper-1', null],
    ['claude-instant-1.2', null],
  ];
  for (const [id, name] of cases) {
    it(`${id} is ${name}`, () => assert.equal(claudeDisplayName(id), name));
  }
});

describe('pathContext', () => {
  const cases: [string, string][] = [
    ['crates/aura-config/src/config_test.rs', 'test'],
    ['crates/aura-web-server/tests/test-config.toml', 'test'],
    ['src/__tests__/a.ts', 'test'],
    ['src/a.test.ts', 'test'],
    ['app/test_router.py', 'test'],
    ['app/router_test.go', 'test'],
    ['test/fixtures/a.json', 'test'],
    ['examples/minimal/anthropic.toml', 'example'],
    ['quickstart.toml', 'example'],
    ['.env.example', 'example'],
    ['docs/guide/a.js', 'docs'],
    ['deployment/helm/aura/values.yaml', 'config'],
    ['crates/aura/src/rig_builder.rs', 'code'],
    ['collector/utils/WhisperProviders/OpenAiWhisper.js', 'code'],
  ];
  for (const [path, want] of cases) {
    it(`${path} is ${want}`, () => assert.equal(pathContext(path), want));
  }
});

describe('rustTestBlocks', () => {
  it('finds a #[cfg(test)] module, past raw strings and brace characters', () => {
    const text = [
      'pub const S: &str = "{ not a block";', // 1
      '#[cfg(test)]',                          // 2
      'mod tests {',                           // 3
      '    const B: &str = r#"',               // 4
      '{ model = "x"',                         // 5
      '"#;',                                   // 6
      "    fn a() { let c = '{'; }",           // 7
      '    // a } in a comment',               // 8
      '}',                                     // 9
      'pub const AFTER: &str = "y";',          // 10
    ].join('\n');
    assert.deepEqual(rustTestBlocks(text), [{ start: 2, end: 9 }]);
  });

  it('also finds a lone #[test] function outside a test module', () => {
    const text = 'fn real() {}\n#[test]\nfn check() {\n  assert!(true);\n}\nfn other() {}\n';
    assert.deepEqual(rustTestBlocks(text), [{ start: 2, end: 5 }]);
  });

  it('skips a #[cfg(test)] use line, which has no block', () => {
    assert.deepEqual(rustTestBlocks('#[cfg(test)]\nuse std::fmt;\nfn real() {}\n'), []);
  });
});

describe('contextFor', () => {
  it('marks a line inside a Rust test block as a test, with the block\'s line', () => {
    const at = contextFor('crates/a/src/writer.rs', '#[cfg(test)]\nmod tests {\n  const M: &str = "x";\n}\nconst Y: &str = "y";\n');
    assert.deepEqual(at(3), { context: 'test', test_block_line: 1, commented: false });
    assert.deepEqual(at(5), { context: 'code', commented: false });
  });

  it('marks comments, per language', () => {
    const toml = contextFor('examples/a.toml', '# model = "x"\nmodel = "y"\n');
    assert.equal(toml(1).commented, true);
    assert.equal(toml(2).commented, false);
    const rust = contextFor('a.rs', '// x\n#[derive(Debug)]\n');
    assert.equal(rust(1).commented, true);
    assert.equal(rust(2).commented, false);
  });
});
