import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { dbInfo, loadRecords, query } from '../src/db.ts';

describe('dbInfo', () => {
  const info = dbInfo();

  it('reconciles each source with data/briefs/README.md', () => {
    assert.deepEqual(info.by_source, {
      'mcp-registry': 35587,
      npm: 3953,
      github: 1088,
      huggingface: 455,
      pypi: 281,
      hn: 133,
      yc: 120,
      openrouter: 94,
      skills: 4,
      changelog: 70,
    });
  });

  it('states the real total, and shows how the kit got 84 and 41,799', () => {
    assert.equal(info.records, 41785);
    assert.equal(info.reconciliation.changelog_year_blind, 84);
    assert.equal(info.reconciliation.records_year_blind, 41799);
    assert.match(info.reconciliation.note, /14/);
  });

  it('dates itself from the data', () => {
    assert.equal(info.fetched, '2026-10-31');
    assert.deepEqual(info.window, { since: '2026-09-01', until: '2026-10-31' });
  });
});

describe('loadRecords', () => {
  it('drops personal fields as data comes in', () => {
    const personal = new Set(['author', 'authors', 'owner', 'owner_handle', 'ownerHandle', 'maintainer', 'maintainers', 'publisher', 'publishers', 'email', 'emails']);
    for (const r of loadRecords(['github', 'npm', 'skills'])) {
      for (const key of Object.keys(r)) assert.ok(!personal.has(key), key);
    }
  });

  it('reads only what it is asked for, and caches per process', () => {
    const first = loadRecords(['skills']);
    assert.equal(first.length, 4);
    assert.equal(loadRecords(['skills'])[0], first[0]);
  });

  it('gives changelog entries the same record shape, with their deadlines', () => {
    const rows = loadRecords(['changelog']);
    assert.equal(rows.length, 70);
    assert.ok(rows.every((r) => r.source === 'changelog' && r.url?.startsWith('https://') && r.released));
    assert.ok(rows.every((r) => r.kind === 'api-feature' || r.kind === 'deprecation'));
    const sonnet = rows.find((r) => r.description?.includes('claude-sonnet-4-5-20250929') && r.kind === 'deprecation');
    assert.deepEqual(sonnet?.deadline, ['2026-11-30']);
  });
});

describe('query', () => {
  it('runs search.py\'s query over the needed sources only', () => {
    const out = query({ any: ['rerank'], sources: ['huggingface'], limit: 3 });
    assert.equal(out.of, 455);
    assert.ok(out.total >= 1);
    assert.ok(out.matches.length <= 3);
  });
});
