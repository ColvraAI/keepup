import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { searchRecords, signalOf } from '../src/search.ts';

const rows = [
  { source: 'npm', kind: 'package', name: 'rerank-kit', description: 'a reranker', url: 'u1', released: '2026-10-01', downloads_week: 1000 },
  { source: 'github', kind: 'repo', name: 'agent-rerank', description: 'rerank for agents', url: 'u2', released: '2026-09-15', stars: 5000, topics: ['llm'] },
  { source: 'huggingface', kind: 'model', name: 'x/embedder', description: 'feature-extraction', url: 'u3', released: '2026-08-15', likes: 100, task: 'feature-extraction' },
  { source: 'npm', kind: 'package', name: 'prerankless', description: 'prerank is not a word match', url: 'u4', updated: '2026-10-02', downloads_week: 9 },
  { source: 'mcp-registry', kind: 'mcp-server', name: 'io.github.acme/sentry', registry_name: 'io.github.acme/sentry', description: 'Sentry tools', url: '', released: '2026-10-05' },
];
const names = (q: object) => searchRecords(rows, q).matches.map((m) => m.record.name);

describe('searchRecords', () => {
  it('matches on word boundaries, not substrings', () => {
    assert.deepEqual(names({ any: ['rerank'] }).sort(), ['agent-rerank', 'rerank-kit']);
  });

  it('ranks by term hits first, then traction', () => {
    assert.deepEqual(names({ any: ['rerank', 'agents'] }), ['agent-rerank', 'rerank-kit']);
    assert.deepEqual(names({ any: ['rerank'] }), ['agent-rerank', 'rerank-kit']);
  });

  it('filters by all, none, sources, kinds, tasks, since, min_signal and limit', () => {
    assert.deepEqual(names({ all: ['rerank', 'agents'] }), ['agent-rerank']);
    assert.deepEqual(names({ any: ['rerank'], none: ['agents'] }), ['rerank-kit']);
    assert.deepEqual(names({ any: ['rerank'], sources: ['npm'] }), ['rerank-kit']);
    assert.deepEqual(names({ kinds: ['model'] }), ['x/embedder']);
    assert.deepEqual(names({ tasks: ['feature-extraction'] }), ['x/embedder']);
    assert.deepEqual(names({ since: '2026-10-02' }), ['prerankless', 'io.github.acme/sentry']);
    assert.deepEqual(names({ any: ['rerank'], min_signal: 1000 }), ['agent-rerank']);
    assert.equal(names({ limit: 2 }).length, 2);
  });

  it('counts every match even when the limit is smaller', () => {
    const out = searchRecords(rows, { any: ['rerank'], limit: 1 });
    assert.equal(out.total, 2);
    assert.equal(out.of, 5);
    assert.equal(out.matches.length, 1);
  });

  it('searches the registry name too', () => {
    assert.deepEqual(names({ any: ['io.github.acme/sentry'] }), ['io.github.acme/sentry']);
  });

  it('scores like search.py', () => {
    assert.equal(signalOf({ stars: 100, downloads_week: 1000 }), 500);
    assert.equal(signalOf({}), 0);
    assert.equal(searchRecords(rows, { any: ['rerank'] }).matches[0].score, 10 + Math.log10(5001));
  });
});
