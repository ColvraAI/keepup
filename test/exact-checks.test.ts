import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkDependencies, checkModels } from '../src/exact-checks.ts';
import type { Dependency } from '../src/manifests.ts';
import { registryInfo } from '../src/registry.ts';
import type { Retirement } from '../src/retirements.ts';

const retirement = (over: Partial<Retirement>): Retirement => ({
  provider: 'openai', id: 'whisper-1', name: null, status: 'retiring', announced: '2026-08-26', effective: '2027-02-26',
  successors: ['gpt-transcribe'], source: 'https://example.com/changelog', sentence: 'These models will shut down on February 26, 2027.', ...over,
});

const place = (over: object) => ({ file: 'a.js', line: 1, text: 'x', context: 'code' as const, commented: false, route: 'direct' as const, ...over });

describe('checkModels', () => {
  const asOf = '2026-10-31';

  it('reports a found id that the changelog retires, with where it sits', () => {
    const out = checkModels([{ id: 'whisper-1', provider: 'openai', places: [place({})] }], [retirement({})], asOf);
    assert.equal(out.length, 1);
    assert.equal(out[0].model, 'whisper-1');
    assert.equal(out[0].status, 'retiring');
    assert.equal(out[0].effective, '2027-02-26');
    assert.equal(out[0].announced, '2026-08-26');
    assert.deepEqual(out[0].successors, ['gpt-transcribe']);
    assert.equal(out[0].live_places.length, 1);
  });

  it('says nothing about an id with no retirement', () => {
    assert.deepEqual(checkModels([{ id: 'gpt-transcribe', provider: 'openai', places: [place({})] }], [retirement({})], asOf), []);
  });

  it('turns retiring into retired when the date has passed', () => {
    const out = checkModels([{ id: 'whisper-1', provider: 'openai', places: [place({})] }], [retirement({ effective: '2026-10-01' })], asOf);
    assert.equal(out[0].status, 'retired');
  });

  it('keeps a test-fixture, comment, docs or Bedrock place out of the live list, and says why', () => {
    const out = checkModels([{
      id: 'whisper-1', provider: 'openai', places: [
        place({ file: 'live.js' }),
        place({ file: 'test.rs', context: 'test', test_block_line: 210 }),
        place({ file: 'c.toml', commented: true }),
        place({ file: 'b.js', route: 'bedrock' }),
        place({ file: 'g.js', route: 'gateway' }),
        place({ file: 'd.js', context: 'docs' }),
      ],
    }], [retirement({})], asOf);
    assert.deepEqual(out[0].live_places.map((p) => p.file), ['live.js']);
    assert.deepEqual(out[0].not_live.map((p) => [p.file, p.why]), [
      ['test.rs', 'test'], ['c.toml', 'comment'], ['b.js', 'bedrock'], ['g.js', 'gateway'], ['d.js', 'docs'],
    ]);
  });
});

const dependency = (over: Partial<Dependency>): Dependency => ({
  name: 'x', spec: '1.0.0', ecosystem: 'npm', section: 'dependencies', file: 'package.json', line: 3, source: 'registry', ...over,
});

const NPM_RECORD = { source: 'npm', name: '@modelcontextprotocol/sdk', package: 'npm:@modelcontextprotocol/sdk', version: '1.32.2', updated: '2026-10-23', url: 'https://www.npmjs.com/package/@modelcontextprotocol/sdk' };

describe('checkModels and catalogs', () => {
  it('keeps a file that names many models out of the live list: it is a lookup table', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `gpt-${i}`, provider: 'openai' as const, places: [place({ file: 'map.js' })] }));
    const model = { id: 'whisper-1', provider: 'openai' as const, places: [place({ file: 'map.js' }), place({ file: 'real.js' })] };
    const [out] = checkModels([...many, model], [retirement({})], '2026-10-31');
    assert.deepEqual(out.live_places.map((p) => p.file), ['real.js']);
    assert.deepEqual(out.not_live.map((p) => [p.file, p.why]), [['map.js', 'catalog']]);
  });
});

describe('checkDependencies offline, from the database', () => {
  const asOf = '2026-10-31';
  const run = (deps: Dependency[]) => checkDependencies(deps, { records: [NPM_RECORD], asOf });

  it('recognises a range that already allows the new version', async () => {
    const [out] = await run([dependency({ name: '@modelcontextprotocol/sdk', spec: '^1.24.3', line: 36 })]);
    assert.equal(out.status, 'allowed-by-range');
    assert.equal(out.latest, '1.32.2');
    assert.equal(out.latest_date, '2026-10-23');
    assert.equal(out.basis, 'database');
    assert.deepEqual(out.places, [{ file: 'package.json', line: 36, spec: '^1.24.3' }]);
  });

  it('says behind when the pin does not allow it', async () => {
    const [out] = await run([dependency({ name: '@modelcontextprotocol/sdk', spec: '1.2.0' })]);
    assert.equal(out.status, 'behind');
    assert.equal(out.majors_behind, 0);
  });

  it('merges one dependency declared in two manifests', async () => {
    const out = await run([
      dependency({ name: '@modelcontextprotocol/sdk', spec: '^1.24.3', file: 'server/package.json', line: 36 }),
      dependency({ name: '@modelcontextprotocol/sdk', spec: '^1.24.3', file: 'collector/package.json', line: 9 }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].places.length, 2);
  });

  it('has no data for a package it can\'t see, and makes no network call', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('offline means offline'); };
    try {
      const [out] = await run([dependency({ name: 'left-pad' })]);
      assert.equal(out.status, 'no-data');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('leaves out git and path dependencies, and names git ones only as such', async () => {
    const out = await run([dependency({ name: 'rig-core', source: 'git', spec: '' }), dependency({ name: 'local', source: 'path', spec: '' })]);
    assert.deepEqual(out.map((d) => [d.name, d.status]), [['rig-core', 'git']]);
  });
});

const crateResponse = {
  crate: { max_stable_version: '3.8.0', max_version: '3.8.0' },
  versions: [
    { num: '3.8.0', created_at: '2026-10-26T22:03:56Z' },
    { num: '0.12.0', created_at: '2025-12-18T10:00:00Z' },
  ],
};
const npmResponse = {
  'dist-tags': { latest: '2.17.2' },
  time: { created: '2023-01-01T00:00:00Z', modified: '2024-05-29T14:37:06Z', '2.17.2': '2024-05-29T14:37:06Z', '2.14.0': '2024-01-11T00:00:00Z' },
};

function fakeFetch(calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('crates.io')) return new Response(JSON.stringify(crateResponse));
    if (String(url).includes('registry.npmjs.org')) return new Response(JSON.stringify(npmResponse));
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('checkDependencies online, through the registries', () => {
  const asOf = '2026-10-31';
  const withCache = async (fn: (cacheDir: string) => Promise<void>) => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'keepup-cache-'));
    try {
      await fn(cacheDir);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  };

  it('finds rmcp 0.12.0 three majors behind 3.8.0, with both dates', () => withCache(async (cacheDir) => {
    const [out] = await checkDependencies(
      [dependency({ name: 'rmcp', spec: '0.12.0', ecosystem: 'crates', file: 'Cargo.toml', line: 49 })],
      { records: [], asOf, online: true, cacheDir, fetchImpl: fakeFetch([]), crateDelayMs: 0 },
    );
    assert.equal(out.status, 'behind');
    assert.equal(out.latest, '3.8.0');
    assert.equal(out.latest_date, '2026-10-26');
    assert.equal(out.declared_date, '2025-12-18');
    assert.equal(out.majors_behind, 3);
    assert.equal(out.source, 'https://crates.io/crates/rmcp');
    assert.equal(out.basis, 'registry');
  }));

  it('marks a package with no release in 18 months as stale, even when the range allows its latest', () => withCache(async (cacheDir) => {
    const [out] = await checkDependencies(
      [dependency({ name: '@xenova/transformers', spec: '^2.14.0' })],
      { records: [], asOf, online: true, cacheDir, fetchImpl: fakeFetch([]) },
    );
    assert.equal(out.status, 'allowed-by-range');
    assert.equal(out.stale, true);
    assert.equal(out.latest_date, '2024-05-29');
  }));

  it('caches under the given folder, so a second run makes no call', () => withCache(async (cacheDir) => {
    const calls: string[] = [];
    const dep = { ecosystem: 'npm' as const, name: '@xenova/transformers' };
    await registryInfo(dep, { cacheDir, fetchImpl: fakeFetch(calls), today: asOf });
    await registryInfo(dep, { cacheDir, fetchImpl: fakeFetch(calls), today: asOf });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /%40xenova%2Ftransformers/);
  }));

  it('survives a registry failure and says so', () => withCache(async (cacheDir) => {
    const [out] = await checkDependencies(
      [dependency({ name: 'gone', ecosystem: 'pypi', spec: '==1.0.0' })],
      { records: [], asOf, online: true, cacheDir, fetchImpl: fakeFetch([]) },
    );
    assert.equal(out.status, 'no-data');
    assert.match(out.error ?? '', /404/);
  }));

  it('refuses a name that could walk out of the cache', () => withCache(async (cacheDir) => {
    const [out] = await checkDependencies(
      [dependency({ name: '../../etc/passwd' })],
      { records: [], asOf, online: true, cacheDir, fetchImpl: fakeFetch([]) },
    );
    assert.equal(out.status, 'no-data');
  }));
});
