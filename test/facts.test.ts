import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { buildFacts } from '../src/facts.ts';
import { type FixtureRepo, fixtureRepo } from './helpers.ts';

describe('buildFacts on a Rust repo', () => {
  let repo: FixtureRepo;
  let facts: ReturnType<typeof buildFacts>;
  before(() => {
    repo = fixtureRepo('manifests/rust');
    facts = buildFacts(repo.path, { commit: repo.commit });
  });
  after(() => repo.cleanup());

  const places = (id: string) => facts.model_ids.find((m) => m.id === id)?.places ?? [];

  it('carries the version, repo and commit', () => {
    assert.equal(facts.version, 1);
    assert.equal(facts.commit, repo.commit);
    assert.equal(facts.commit_date, '2026-10-30');
  });

  it('reads manifests in any folder, with dependency lines', () => {
    const root = facts.manifests.find((m) => m.file === 'Cargo.toml');
    assert.equal(root?.dependencies.find((d) => d.name === 'rmcp')?.line, 6);
    assert.ok(facts.manifests.some((m) => m.file === 'crates/core/Cargo.toml'));
  });

  it('finds model ids in TOML examples, and marks what kind of line each is', () => {
    assert.deepEqual(places('claude-sonnet-4-20250514'), [
      { file: 'examples/minimal.toml', line: 3, text: 'model = "claude-sonnet-4-20250514"', context: 'example', commented: false, route: 'direct' },
    ]);
    assert.equal(places('gpt-4.5-preview')[0].commented, true);
  });

  it('tells a #[cfg(test)] fixture from real code in the same file', () => {
    assert.deepEqual(places('claude-3-sonnet-20240229'), [
      { file: 'crates/core/src/lib.rs', line: 8, text: 'model = "claude-3-sonnet-20240229"', context: 'test', commented: false, route: 'direct', test_block_line: 4 },
    ]);
    assert.equal(places('claude-sonnet-4-5-20250929')[0].context, 'code');
  });

  it('tells test files and test folders from real code', () => {
    assert.equal(places('claude-opus-4-1-20250805')[0].context, 'test');
    assert.equal(places('whisper-1')[0].context, 'test');
  });

  it('gives the dashboard a timed list of steps with what each found', () => {
    assert.deepEqual(facts.steps.map((s) => s.name), ['List files', 'Read manifests', 'Read the README', 'Measure languages', 'Run signals', 'Find model ids']);
    for (const step of facts.steps) {
      assert.equal(typeof step.ms, 'number');
      assert.ok(step.detail.length > 0, step.name);
    }
  });

  it('measures the language mix', () => {
    assert.equal(facts.languages[0].language, 'TOML');
    assert.ok(facts.languages.some((l) => l.language === 'Rust'));
    const total = facts.languages.reduce((sum, l) => sum + l.share, 0);
    assert.ok(Math.abs(total - 1) < 0.01);
  });
});

describe('buildFacts on a JS repo', () => {
  it('reads declared dependencies and call sites, and tells routes apart', () => {
    const repo = fixtureRepo('manifests/js');
    try {
      const facts = buildFacts(repo.path);
      const server = facts.manifests.find((m) => m.file === 'server/package.json');
      assert.equal(server?.dependencies.find((d) => d.name === '@modelcontextprotocol/sdk')?.line, 5);
      assert.equal(facts.model_ids.find((m) => m.id === 'whisper-1')?.places[0].line, 3);
      assert.equal(facts.model_ids.find((m) => m.id === 'claude-3-5-haiku-20241022')?.places[0].route, 'bedrock');
      assert.equal(facts.model_ids.find((m) => m.id === 'claude-3-opus-20240229')?.places[0].route, 'gateway');
      assert.ok(!facts.model_ids.some((m) => m.id === 'claude-code'));
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildFacts and secrets', () => {
  it('never prints a fake key, wherever it sits', () => {
    const repo = fixtureRepo('fake-key', { 'README.md': 'Set OPENAI_API_KEY=sk-FAKEfakeFAKEfakeFAKEfake0123456789\n' });
    try {
      const out = JSON.stringify(buildFacts(repo.path));
      for (const fake of ['sk-FAKE', 'sk-ant-api03', 'ghp_FAKE', 'gho_FAKE', 'github_pat_FAKE', 'xoxb-FAKE', 'AIzaFAKE', 'AKIAIOSFODNN7EXAMPLE', 'c2VjcmV0', 'RkFLRWZha2V', 'tok9f8a7b']) {
        assert.ok(!out.includes(fake), fake);
      }
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildFacts on a quiet repo', () => {
  it('finds nothing to report and still reads the README', () => {
    const repo = fixtureRepo('quiet');
    try {
      const facts = buildFacts(repo.path);
      assert.deepEqual(facts.model_ids, []);
      assert.deepEqual(facts.ai_call_sites, []);
      assert.match(facts.readme?.head ?? '', /A small app/);
    } finally {
      repo.cleanup();
    }
  });
});
