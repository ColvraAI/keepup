import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildCandidates, isOfficialServer, massPublishers, offProvider } from '../src/candidates.ts';
import type { Profile } from '../src/run-shape.ts';
import { type DbRecord, searchRecords } from '../src/search.ts';
import { codeLanguages, stackLock } from '../src/stack-lock.ts';

const rust = { languages: [{ language: 'Rust', files: 200, lines: 90000, share: 0.8 }, { language: 'Markdown', files: 10, lines: 9000, share: 0.1 }, { language: 'Python', files: 3, lines: 2600, share: 0.02 }] };
const node = { languages: [{ language: 'JavaScript', files: 1000, lines: 90000, share: 0.9 }] };
const python = { languages: [{ language: 'Python', files: 100, lines: 9000, share: 0.9 }] };

const record = (fields: Partial<DbRecord> & { source: string; name: string }): DbRecord => ({ url: `https://x.example/${fields.name}`, description: '', ...fields });

describe('the stack lock', () => {
  it('reads the code languages, ignoring small ones and docs', () => {
    assert.deepEqual(codeLanguages(rust), ['Rust']);
    assert.deepEqual(codeLanguages(node), ['JavaScript']);
  });

  it('a Rust repo skips Python and TS libraries unless they ship an MCP server or an API', () => {
    const { allows } = stackLock(rust);
    assert.equal(allows(record({ source: 'npm', name: 'left-pad-ai', description: 'A helper library' })), false);
    assert.equal(allows(record({ source: 'pypi', name: 'lang-helper', description: 'A helper library' })), false);
    assert.equal(allows(record({ source: 'npm', name: '@sentry/mcp-server', description: 'MCP server for Sentry' })), true);
    assert.equal(allows(record({ source: 'github', name: 'py-thing', language: 'Python', description: 'Library' })), false);
    assert.equal(allows(record({ source: 'github', name: 'rust-thing', language: 'Rust' })), true);
    assert.equal(allows(record({ source: 'mcp-registry', name: 'anything' })), true);
    assert.equal(allows(record({ source: 'skills', name: 'anything' })), true);
  });

  it("a Node app's local models need ONNX or transformers.js weights", () => {
    const { allows } = stackLock(node);
    assert.equal(allows(record({ source: 'huggingface', name: 'google/embeddinggemma-2', library: 'transformers' })), false);
    assert.equal(allows(record({ source: 'huggingface', name: 'unsloth/embeddinggemma-2-GGUF' })), false);
    assert.equal(allows(record({ source: 'huggingface', name: 'onnx-community/embeddinggemma-2-ONNX', library: 'transformers.js' })), true);
    assert.equal(allows(record({ source: 'npm', name: 'any' })), true);
    assert.equal(allows(record({ source: 'pypi', name: 'any' })), false);
  });

  it('a Python app can load any local model', () => {
    assert.equal(stackLock(python).allows(record({ source: 'huggingface', name: 'google/embeddinggemma-2', library: 'transformers' })), true);
  });

  it('says its rules in words', () => {
    assert.match(stackLock(rust).rules.join(' '), /Rust/);
    assert.match(stackLock(node).rules.join(' '), /ONNX or transformers\.js/);
  });
});

describe('official servers', () => {
  it('match the vendor namespace, and look-alikes do not', () => {
    for (const name of ['io.github.getsentry/sentry-mcp', 'io.github.SigNoz/signoz-mcp-server', 'io.github.dynatrace-oss/dynatrace-managed-mcp']) {
      assert.equal(isOfficialServer(record({ source: 'mcp-registry', name, registry_name: name })), true, name);
    }
    for (const name of ['io.github.someone/sentry-mcp', 'io.github.alice/observability-gateway']) {
      assert.equal(isOfficialServer(record({ source: 'mcp-registry', name, registry_name: name })), false, name);
    }
  });

  it('namespaces with more than 50 servers are mass publishers', () => {
    const rows = Array.from({ length: 51 }, (_, index) => record({ source: 'mcp-registry', name: `s${index}`, registry_name: `io.github.mass/s${index}` }));
    assert.deepEqual([...massPublishers([...rows, record({ source: 'mcp-registry', name: 'one', registry_name: 'io.github.small/one' })])], ['io.github.mass']);
  });
});

describe('the provider setting', () => {
  it('cuts another provider\'s API and models, and leaves neutral tools', () => {
    assert.equal(offProvider(record({ source: 'changelog', name: 'a', provider: 'openai' }), 'anthropic'), true);
    assert.equal(offProvider(record({ source: 'changelog', name: 'a', provider: 'anthropic' }), 'anthropic'), false);
    assert.equal(offProvider(record({ source: 'openrouter', name: 'a', model_id: 'openai/gpt-6-luna' }), 'anthropic'), true);
    assert.equal(offProvider(record({ source: 'npm', name: 'jev-adapter' }), 'anthropic'), false);
    assert.equal(offProvider(record({ source: 'changelog', name: 'a', provider: 'openai' }), undefined), false);
  });
});

describe('buildCandidates', () => {
  const rows: DbRecord[] = [
    record({ source: 'mcp-registry', name: 'io.github.getsentry/sentry-mcp', registry_name: 'io.github.getsentry/sentry-mcp', description: 'error monitoring' }),
    ...Array.from({ length: 40 }, (_, index) => record({ source: 'mcp-registry', name: `io.github.dev${index}/errors-${index}`, registry_name: `io.github.dev${index}/errors-${index}`, description: 'error monitoring' })),
    ...Array.from({ length: 60 }, (_, index) => record({ source: 'mcp-registry', name: `io.github.mass/m${index}`, registry_name: `io.github.mass/m${index}`, description: 'error monitoring' })),
    record({ source: 'pypi', name: 'py-errors', description: 'error monitoring' }),
    record({ source: 'npm', name: 'dep', package: 'dep', description: 'error monitoring' }),
  ];
  const profile: Profile = { one_liner: '', stack: [], stack_lock: [], jobs: [
    { job: 'Watch errors', how: '', where: [], search_terms: ['error monitoring'] },
    { job: 'Same again', how: '', where: [], search_terms: ['error monitoring'] },
  ] };
  const search = (query: Parameters<typeof searchRecords>[1]) => searchRecords(rows, query).matches;

  it('applies the lock, drops mass publishers, ranks official servers first and counts every cut', () => {
    const { candidates, log } = buildCandidates(profile, search, { lock: stackLock(node), declaredPackages: new Set(['dep']) });
    const first = log.jobs[0];
    assert.equal(first.matched, rows.length);
    assert.equal(first.cut_by_stack_lock, 1);
    assert.equal(first.cut_mass_publisher, 60);
    assert.ok(first.cut_by_cap > 0);
    assert.equal(first.matched, first.cut_by_stack_lock + first.cut_mass_publisher + first.cut_by_provider + first.cut_seen_in_earlier_job + first.cut_by_cap + first.kept);
    assert.equal(candidates[0].record.name, 'io.github.getsentry/sentry-mcp');
    assert.equal(candidates[0].official, true);
    assert.ok(candidates.some((c) => c.record.name === 'dep' && c.declared === true));
    assert.ok(!candidates.some((c) => c.record.name === 'py-errors'));
  });

  it('shows a record once, under the first job that found it', () => {
    const { candidates, log } = buildCandidates(profile, search, { lock: stackLock(node), declaredPackages: new Set() });
    assert.equal(new Set(candidates.map((c) => c.record.name)).size, candidates.length);
    assert.ok(log.jobs[1].cut_seen_in_earlier_job > 0);
  });
});
