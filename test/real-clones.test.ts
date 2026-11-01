// Proof on the two real repos at their pinned commits. Runs only when the clones exist under tmp/.
// The dependency checks that need a registry read tmp/registry-cache, filled by `keepup run --online`,
// and skip when it's empty, so the suite never needs the network.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { renderBrief } from '../src/brief.ts';
import { loadRecords, retirements } from '../src/db.ts';
import { checkDependencies, checkModels, type DependencyCheck, type ModelCheck } from '../src/exact-checks.ts';
import { buildFacts, type Facts } from '../src/facts.ts';
import { runPipeline } from '../src/pipeline.ts';
import { DEFAULT_CACHE_DIR } from '../src/registry.ts';
import { scanRepo } from '../src/scan.ts';
import { weeklyCheck } from '../src/weekly.ts';
import { ROOT } from './helpers.ts';

const CLONES = {
  llm: { path: join(ROOT, 'tmp', 'anything-llm'), commit: '9caf2b4', full: '9caf2b4c29d9782f1cba4142be2525ebfa0ecd43', brief: 'anythingllm.md' },
  aura: { path: join(ROOT, 'tmp', 'aura'), commit: '5efb4e8', full: '5efb4e8b1c00d4d3d03d28e89d1500238904fd35', brief: 'aura.md' },
};
const skip = !existsSync(CLONES.llm.path) || !existsSync(CLONES.aura.path) ? 'the clones are not under tmp/' : false;
const AS_OF = '2026-10-31';

function lineAt(repo: string, commit: string, file: string, line: number): string | undefined {
  return execFileSync('git', ['-C', repo, 'cat-file', 'blob', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')[line - 1];
}

/** Every path:line cited in a brief, with ranges like 17–21 read as their first line. */
function citedPlaces(brief: string): { file: string; line: number }[] {
  const text = readFileSync(join(ROOT, 'data', 'briefs', brief), 'utf8');
  return [...text.matchAll(/([\w@./-]+\.[a-z]+):(\d+)/g)].map((m) => ({ file: m[1], line: Number(m[2]) }));
}

function modelCheck(checks: readonly ModelCheck[], model: string): ModelCheck {
  const found = checks.find((check) => check.model === model);
  assert.ok(found, `${model} should be found`);
  return found;
}

describe('AnythingLLM at 9caf2b4', { skip }, () => {
  const { path, commit, full } = CLONES.llm;
  let facts: Facts;
  let models: ModelCheck[];
  let dependencies: DependencyCheck[];
  before(async () => {
    facts = buildFacts(path, { commit });
    models = checkModels(facts.model_ids, retirements(), AS_OF);
    dependencies = await checkDependencies(facts.manifests.flatMap((m) => m.dependencies), { records: loadRecords(['npm', 'pypi']), asOf: AS_OF });
  });

  it('reads the pinned commit', () => {
    assert.equal(facts.commit, full);
    assert.equal(facts.commit_date, '2026-10-30');
    assert.equal(facts.repo, 'Mintplex-Labs/anything-llm');
    assert.equal(facts.languages[0].language, 'JavaScript');
  });

  it('every file:line the brief cites exists at the commit', () => {
    for (const { file, line } of citedPlaces(CLONES.llm.brief)) {
      assert.notEqual(lineAt(path, full, file, line), undefined, `${file}:${line}`);
    }
  });

  it('the lines say what the brief says they say', () => {
    const cases: [string, number, RegExp][] = [
      ['collector/utils/WhisperProviders/OpenAiWhisper.js', 11, /this\.model = "whisper-1"/],
      ['server/utils/agents/aibitat/plugins/router-classifier.js', 71, /classifyWithLLM/],
      ['server/utils/agents/aibitat/plugins/router-classifier.js', 24, /select_category/],
      ['server/utils/EmbeddingEngines/native/index.js', 8, /Xenova\/all-MiniLM-L6-v2/],
      ['server/utils/EmbeddingRerankers/native/index.js', 23, /ms-marco-MiniLM-L-6-v2/],
      ['server/package.json', 41, /@xenova\/transformers/],
      ['collector/package.json', 20, /@xenova\/transformers/],
      ['server/package.json', 36, /"@modelcontextprotocol\/sdk": "\^1\.24\.3"/],
    ];
    for (const [file, line, want] of cases) assert.match(lineAt(path, full, file, line) ?? '', want, `${file}:${line}`);
  });

  it('facts carry the dependencies at the lines the brief cites', () => {
    const declared = facts.manifests.flatMap((m) => m.dependencies);
    const at = (name: string, file: string) => declared.find((d) => d.name === name && d.file === file);
    assert.equal(at('@xenova/transformers', 'server/package.json')?.line, 41);
    assert.equal(at('@xenova/transformers', 'collector/package.json')?.line, 20);
    assert.equal(at('@modelcontextprotocol/sdk', 'server/package.json')?.line, 36);
  });

  it('whisper-1: shutdown 26 Feb 2027, announced 26 Aug, successors named, in real code', () => {
    const check = modelCheck(models, 'whisper-1');
    assert.equal(check.status, 'retiring');
    assert.equal(check.effective, '2027-02-26');
    assert.equal(check.announced, '2026-08-26');
    assert.deepEqual([...check.successors].sort(), ['gpt-live-transcribe', 'gpt-transcribe']);
    assert.equal(check.source, 'https://developers.openai.com/api/docs/changelog');
    assert.ok(check.live_places.some((p) => p.file === 'collector/utils/WhisperProviders/OpenAiWhisper.js' && p.line === 11));
  });

  it('holds back the MCP SDK: ^1.24.3 already allows 1.32.2', () => {
    const check = dependencies.find((d) => d.name === '@modelcontextprotocol/sdk');
    assert.equal(check?.status, 'allowed-by-range');
    assert.equal(check?.latest, '1.32.2');
    assert.equal(check?.latest_date, '2026-10-23');
    assert.deepEqual(check?.places, [{ file: 'server/package.json', line: 36, spec: '^1.24.3' }]);
  });

  it('@xenova/transformers has had no release since May 2024', { skip: !existsSync(join(DEFAULT_CACHE_DIR, 'npm', '%40xenova%2Ftransformers.json')) && 'no cached registry answer' }, async () => {
    const declared = facts.manifests.flatMap((m) => m.dependencies).filter((d) => d.name === '@xenova/transformers');
    const [check] = await checkDependencies(declared, { records: [], asOf: AS_OF, online: true });
    assert.equal(check.latest, '2.17.2');
    assert.equal(check.latest_date, '2024-05-29');
    assert.equal(check.stale, true);
    assert.equal(check.status, 'allowed-by-range');
    assert.deepEqual(check.places.map((p) => `${p.file}:${p.line}`).sort(), ['collector/package.json:20', 'server/package.json:41']);
  });

  it('a whole run keeps its findings honest and its held-back items out of the findings', async () => {
    const run = await runPipeline(path, { commit });
    assert.deepEqual(run.checks.dropped, []);
    const text = JSON.stringify(run.findings);
    assert.ok(run.findings.some((f) => /whisper-1/.test(`${f.title} ${f.why}`)));
    assert.ok(!text.includes('Nemotron'));
    assert.ok(!text.includes('@modelcontextprotocol/sdk'));
    assert.ok(run.held_back.some((h) => h.thing === '@modelcontextprotocol/sdk 1.32.2'));
    assert.match(renderBrief(run), /^# keepup brief: Mintplex-Labs\/anything-llm\n\nCommit 9caf2b4 \(30 Oct 2026\)/);
  });

  it('the weekly check sees whisper-1 the week it was announced, and not the week after', async () => {
    const that = await weeklyCheck(path, { commit, asOf: '2026-08-27' });
    assert.ok(that.applies.some((c) => c.kind === 'model' && c.model === 'whisper-1'), that.line);
    const later = await weeklyCheck(path, { commit, asOf: '2026-09-10' });
    assert.ok(!later.applies.some((c) => c.kind === 'model' && c.model === 'whisper-1'), later.line);
    assert.equal(later.line.split('\n').length, 1);
  });
});

describe('AURA at 5efb4e8', { skip }, () => {
  const { path, commit, full } = CLONES.aura;
  let facts: Facts;
  let models: ModelCheck[];
  before(() => {
    facts = buildFacts(path, { commit });
    models = checkModels(facts.model_ids, retirements(), AS_OF);
  });

  it('reads the pinned commit', () => {
    assert.equal(facts.commit, full);
    assert.equal(facts.commit_date, '2026-10-30');
    assert.equal(facts.repo, 'mezmo/aura');
    assert.equal(facts.languages[0].language, 'Rust');
  });

  it('every file:line the brief cites exists at the commit', () => {
    for (const { file, line } of citedPlaces(CLONES.aura.brief)) {
      assert.notEqual(lineAt(path, full, file, line), undefined, `${file}:${line}`);
    }
  });

  it('the lines say what the brief says they say', () => {
    const cases: [string, number, RegExp][] = [
      ['Cargo.toml', 40, /rig-core/],
      ['Cargo.toml', 49, /rmcp = \{ version = "0\.12\.0"/],
      ['examples/minimal/anthropic.toml', 14, /claude-sonnet-4-20250514/],
      ['examples/complete/reasoning-models.toml', 61, /claude-sonnet-4-5-20250929/],
      ['crates/aura-config/src/writer.rs', 225, /claude-3-sonnet-20240229/],
      ['crates/aura-config/src/writer.rs', 210, /#\[cfg\(test\)\]/],
      ['examples/reference.toml', 234, /# prompt_caching = true/],
      ['crates/aura-config/src/config.rs', 102, /prompt_caching/],
      ['crates/aura-config/src/config_test.rs', 355, /prompt_caching/],
    ];
    for (const [file, line, want] of cases) assert.match(lineAt(path, full, file, line) ?? '', want, `${file}:${line}`);
  });

  it('facts carry rmcp and rig-core at the lines the brief cites', () => {
    const root = facts.manifests.find((m) => m.file === 'Cargo.toml');
    assert.deepEqual(root?.dependencies.filter((d) => d.name === 'rmcp').map((d) => [d.line, d.spec, d.source]), [[49, '0.12.0', 'registry']]);
    assert.deepEqual(root?.dependencies.filter((d) => d.name === 'rig-core').map((d) => [d.line, d.source]), [[40, 'git']]);
  });

  it('claude-sonnet-4-20250514 is retired, and live in the minimal example', () => {
    const check = modelCheck(models, 'claude-sonnet-4-20250514');
    assert.equal(check.status, 'retired');
    assert.equal(check.effective, '2026-06-15');
    assert.ok(check.live_places.some((p) => p.file === 'examples/minimal/anthropic.toml' && p.line === 14 && p.context === 'example'));
    assert.ok(check.not_live.some((p) => p.why === 'test'));
  });

  it('claude-sonnet-4-5-20250929 retires 30 Nov 2026, announced 30 Sep, successor Sonnet 5.5', () => {
    const check = modelCheck(models, 'claude-sonnet-4-5-20250929');
    assert.equal(check.status, 'retiring');
    assert.equal(check.effective, '2026-11-30');
    assert.equal(check.announced, '2026-09-30');
    assert.deepEqual(check.successors, ['claude-sonnet-5-5']);
    assert.ok(check.live_places.some((p) => p.file === 'examples/complete/reasoning-models.toml' && p.line === 61));
  });

  it('claude-3-sonnet-20240229 in writer.rs is marked as a test fixture inside #[cfg(test)], line 210', () => {
    const check = modelCheck(models, 'claude-3-sonnet-20240229');
    assert.equal(check.status, 'retired');
    assert.deepEqual(check.live_places, []);
    const place = check.not_live.find((p) => p.file === 'crates/aura-config/src/writer.rs' && p.line === 225);
    assert.equal(place?.why, 'test');
    assert.equal(place?.test_block_line, 210);
  });

  it('rmcp 0.12.0 is three majors behind 3.8.0', { skip: !existsSync(join(DEFAULT_CACHE_DIR, 'crates', 'rmcp.json')) && 'no cached registry answer' }, async () => {
    const root = facts.manifests.find((m) => m.file === 'Cargo.toml');
    const [check] = await checkDependencies((root?.dependencies ?? []).filter((d) => d.name === 'rmcp'), { records: [], asOf: AS_OF, online: true });
    assert.equal(check.latest, '3.8.0');
    assert.equal(check.latest_date, '2026-10-26');
    assert.equal(check.declared_date, '2025-12-18');
    assert.equal(check.majors_behind, 3);
    assert.equal(check.status, 'behind');
    assert.deepEqual(check.places, [{ file: 'Cargo.toml', line: 49, spec: '0.12.0' }]);
  });

  it('a whole run lands the retired models as a finding and the fixture as held back', async () => {
    const run = await runPipeline(path, { commit });
    assert.deepEqual(run.checks.dropped, []);
    const anthropic = run.findings.find((f) => /Anthropic/.test(f.title));
    assert.ok(anthropic?.where.some((w) => w.file === 'examples/minimal/anthropic.toml' && w.line === 14));
    assert.ok(anthropic?.where.some((w) => w.file === 'examples/complete/reasoning-models.toml' && w.line === 61));
    assert.ok(!JSON.stringify(run.findings).includes('writer.rs'));
    const fixture = run.held_back.find((h) => /claude-3-sonnet-20240229/.test(h.thing));
    assert.ok(fixture, 'the fixture is held back');
    assert.match(fixture.reason, /test/);
  });
});

describe('the scan on real repos', { skip }, () => {
  it('scans three real repos in under a minute, and makes no network call', () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('the scan must stay offline'); };
    const started = performance.now();
    try {
      const outs = [
        scanRepo(CLONES.llm.path, { commit: CLONES.llm.commit }),
        scanRepo(CLONES.aura.path, { commit: CLONES.aura.commit }),
        scanRepo(ROOT),
      ];
      for (const out of outs) {
        assert.equal(out.version, 1);
        assert.ok(out.checked.files > 0);
      }
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(performance.now() - started < 60_000);
  });
});
