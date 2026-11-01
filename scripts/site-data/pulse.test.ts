import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnfit, oneLine, readable } from './feed-filter.ts';
import { buildFeed, feedLink, interleaveByDay, roundRobinByWeek, tractionOf } from './feed.ts';
import { assertAgreesWithEngine, assertReconciles, buildPulse, parseReadmeCounts, recordDate, registryPublishers, type DbRow } from './pulse.ts';

const WINDOW = { from: '2026-09-01', to: '2026-10-31', fetched: '2026-10-31' };

const row = (over: Partial<DbRow>): DbRow => ({
  source: 'github', kind: 'repo', name: 'thing', url: 'https://github.com/a/thing', description: 'An AI agent toolkit', released: '2026-10-01', ...over,
});

test('recordDate prefers a release in the window, then an update in it', () => {
  assert.deepEqual(recordDate(row({ released: '2026-10-01' }), WINDOW), { date: '2026-10-01', date_kind: 'released', in_window: true });
  assert.deepEqual(recordDate(row({ released: null, updated: '2026-10-23' }), WINDOW), { date: '2026-10-23', date_kind: 'updated', in_window: true });
  assert.deepEqual(recordDate(row({ released: '2026-06-09', updated: '2026-10-18' }), WINDOW), { date: '2026-10-18', date_kind: 'updated', in_window: true });
  assert.deepEqual(recordDate(row({ released: '2024-09-03' }), WINDOW), { date: '2024-09-03', date_kind: 'released', in_window: false });
});

test('registryPublishers counts the mass publishers by namespace, so the caveat is computed', () => {
  const mcp = (name: string): DbRow => row({ source: 'mcp-registry', registry_name: name, name });
  const rows = [...Array.from({ length: 3 }, (_, i) => mcp(`io.github.many/s${i}`)), mcp('io.github.few/s'), row({})];
  assert.deepEqual(registryPublishers(rows, 3), { threshold: 3, publishers: 1, records: 3 });
});

const README = `# x

41,785 things, fetched by a one-off fetcher on 31 Oct (UTC):

| Source | Records | Note |
| --- | --- | --- |
| Official MCP Registry | 2 | Servers |
| GitHub | 1 | Created |
`;

test('parseReadmeCounts reads the stated total and the per-source table', () => {
  const r = parseReadmeCounts(README);
  assert.equal(r.total, 41785);
  assert.equal(r.bySource['Official MCP Registry'], 2);
  assert.equal(r.bySource['GitHub'], 1);
});

test('assertReconciles fails loudly when the computed total disagrees with the README', () => {
  const stated = { total: 3, bySource: { 'Official MCP Registry': 2, GitHub: 1 } };
  const by = [{ id: 'mcp-registry', label: 'Official MCP Registry', count: 2 }, { id: 'github', label: 'GitHub', count: 1 }];
  assert.doesNotThrow(() => assertReconciles(3, by, stated));
  assert.throws(() => assertReconciles(4, by, stated), /4.*3/);
  assert.throws(() => assertReconciles(3, [{ ...by[0], count: 1 }, { ...by[1], count: 2 }], stated), /Official MCP Registry/);
});

test('assertAgreesWithEngine holds the pulse and src/db.ts to the same counts', () => {
  const info = { records: 3 };
  assert.doesNotThrow(() => assertAgreesWithEngine({ total: 3, in_window: 3 }, info));
  assert.throws(() => assertAgreesWithEngine({ total: 4, in_window: 3 }, info), /src\/db\.ts/);
  assert.throws(() => assertAgreesWithEngine({ total: 3, in_window: 2 }, info), /src\/db\.ts/);
});

test('buildPulse separates records in the database from records dated in the window', () => {
  const rows = [
    row({ released: '2026-09-01' }),
    row({ released: '2026-09-01', name: 'b', source: 'github' }),
    row({ released: '2026-10-31', name: 'c', source: 'hn', kind: 'launch', points: 50 }),
    row({ released: '2024-09-03', name: 'old', source: 'changelog', provider: 'openai', kind: 'api-feature' }),
  ];
  const p = buildPulse(rows, WINDOW);
  assert.equal(p.total, 4);
  assert.equal(p.in_window, 3);
  assert.equal(p.outside_window.count, 1);
  assert.deepEqual(p.outside_window.by_source, { changelog: 1 });
  assert.equal(p.by_day.days.length, 61);
  assert.equal(p.by_day.days[0], '2026-09-01');
  assert.equal(p.by_day.days[60], '2026-10-31');
  assert.equal(p.by_day.by_source.github[0], 2);
  assert.equal(p.by_day.by_source.hn[60], 1);
  assert.equal(p.by_day.by_source.changelog.reduce((a: number, b: number) => a + b, 0), 0);
  assert.equal(p.by_source.find((s) => s.id === 'changelog')?.count, 1);
  assert.equal(p.by_source.find((s) => s.id === 'changelog')?.in_window, 0);
});

test('feedLink: an MCP record without a URL links to the registry search, never to nothing', () => {
  const mcp = { source: 'mcp-registry', kind: 'mcp-server', description: 'x', released: '2026-10-01' };
  assert.equal(feedLink({ ...mcp, name: 'ac.snag/snag', url: '', registry_name: 'ac.snag/snag' }), 'https://registry.modelcontextprotocol.io/v0.1/servers?search=ac.snag%2Fsnag');
  assert.equal(feedLink({ ...mcp, name: 'y', url: 'https://github.com/o/y', registry_name: 'y' }), 'https://github.com/o/y');
  assert.equal(feedLink({ ...mcp, name: 'y', url: 'http://plain.example', registry_name: 'y' }), 'https://registry.modelcontextprotocol.io/v0.1/servers?search=y');
  assert.equal(feedLink({ source: 'hn', kind: 'launch', name: 'h', description: '', released: null, url: 'http://x.example', hn_url: 'https://news.ycombinator.com/item?id=1' }), 'https://news.ycombinator.com/item?id=1');
  assert.equal(feedLink({ source: 'yc', kind: 'launch', name: 'c', description: '', released: null, url: '', yc_url: 'https://www.ycombinator.com/companies/c' }), 'https://www.ycombinator.com/companies/c');
  assert.equal(feedLink({ source: 'github', kind: 'repo', name: 'g', description: '', released: null, url: 'http://x.example' }), null);
});

test('isUnfit catches adult, hateful, scammy and personal items without false matches on substrings', () => {
  assert.ok(isUnfit('Uncensored model', ''));
  assert.ok(isUnfit('hot-bot', 'an NSFW companion'));
  assert.ok(isUnfit('rug', 'memecoin sniper for pump.fun'));
  assert.ok(isUnfit('x', 'reach me at someone@example.com'));
  assert.ok(!isUnfit('Essex model', 'A class-based sextant reader'), 'sex must match as a word');
  assert.ok(!isUnfit('cheatsheet', 'hackathon starter for agents'));
});

test('buildFeed: a registry name loses its publisher handle, and a repeated record shows once', () => {
  const mcp = (over: Partial<DbRow>) => row({ source: 'mcp-registry', kind: 'mcp-server', packages: ['npm:p'], released: '2026-10-01', ...over });
  const npm = row({ source: 'npm', kind: 'package', name: 'p', package: 'npm:p', downloads_week: 9000, released: null, updated: '2026-10-01', description: 'An MCP package' });
  const feed = buildFeed([
    npm,
    mcp({ name: 'io.github.some-person/trace-mcp', registry_name: 'io.github.some-person/trace-mcp', description: 'Code graph server for agents' }),
    mcp({ name: 'Same Thing', registry_name: 'com.a/same', description: 'Repeated description of a server, word for word' }),
    mcp({ name: 'Same Thing', registry_name: 'com.b/same', description: 'Another description entirely, nothing alike here' }),
  ], WINDOW);
  const names = feed.filter((f) => f.source === 'mcp-registry').map((f) => f.name);
  assert.ok(names.includes('trace-mcp'));
  assert.ok(!JSON.stringify(feed).includes('some-person/trace-mcp@'));
  assert.equal(names.filter((n) => n === 'Same Thing').length, 1);
});

test('readable keeps Latin text for a projector, and oneLine cleans what the sources send', () => {
  assert.equal(readable('PhotoCraft: an editor'), true);
  assert.equal(readable('高性价比人生指南长寿防病急救省钱理财'), false);
  assert.equal(readable('Mika — 你手机上的私人 AI 助理，替你操作 App、上网、把事办成。An on-device agent'), false);
  assert.equal(oneLine('  See [GPT-6](https://x.dev) **now**\n\n<b>ok</b> '), 'See GPT-6 now ok');
  assert.equal(oneLine('\u{1F6E1}\uFE0F BLA shield'), 'BLA shield');
  const long = oneLine('word '.repeat(100));
  assert.ok(long.length <= 181);
  assert.ok(long.endsWith('…'));
});

test('tractionOf reads the right metric per source, and joins MCP records to npm and GitHub', () => {
  const ctx = { npmDownloads: new Map([['npm:mcp-x', 9000]]), githubStars: new Map([['o/y', 500]]) };
  assert.deepEqual(tractionOf(row({ stars: 700 }), ctx), { metric: 'stars', value: 700 });
  assert.deepEqual(tractionOf(row({ source: 'npm', downloads_week: 12 }), ctx), { metric: 'downloads a week', value: 12 });
  assert.deepEqual(tractionOf(row({ source: 'mcp-registry', packages: ['npm:mcp-x'], url: '' }), ctx), { metric: 'npm downloads a week', value: 9000 });
  assert.deepEqual(tractionOf(row({ source: 'mcp-registry', url: 'https://github.com/O/y.git' }), ctx), { metric: 'stars', value: 500 });
  assert.equal(tractionOf(row({ source: 'mcp-registry', url: '' }), ctx), null);
});

test('roundRobinByWeek spreads a quota across weeks, best first in each', () => {
  const items = [
    { date: '2026-10-30', score: 100, id: 'a' }, { date: '2026-10-30', score: 90, id: 'b' }, { date: '2026-10-30', score: 80, id: 'c' },
    { date: '2026-09-02', score: 5, id: 'd' },
  ];
  assert.deepEqual(roundRobinByWeek(items, 3).map((i) => i.id).sort(), ['a', 'b', 'd']);
});

test('interleaveByDay is newest first, and alternates sources inside a day', () => {
  const items = [
    { date: '2026-10-01', source: 'npm', name: 'n1' }, { date: '2026-10-01', source: 'npm', name: 'n2' },
    { date: '2026-10-01', source: 'github', name: 'g1' }, { date: '2026-10-02', source: 'npm', name: 'n3' },
  ];
  assert.deepEqual(interleaveByDay(items).map((i) => i.name), ['n3', 'g1', 'n1', 'n2']);
});

test('buildFeed: only safe, dated, linked items, only whitelisted fields, and no source drowns the rest', () => {
  const many = Array.from({ length: 500 }, (_, i) => row({
    source: 'mcp-registry', kind: 'mcp-server', name: `server-${i}`, url: `https://github.com/o${i}/s`, registry_name: `io.github.o${i}/s`,
    packages: [`npm:s${i}`], released: '2026-10-01', description: `MCP server number ${i}`,
  }));
  const npmRows = many.map((_, i) => row({ source: 'npm', kind: 'package', name: `s${i}`, package: `npm:s${i}`, released: null, updated: '2026-10-01', downloads_week: 50_000 + i, url: `https://www.npmjs.com/package/s${i}`, description: `An AI package ${i}`, repo_url: 'https://github.com/private/person' }));
  const bad = row({ name: 'nsfw thing', stars: 999_999 });
  const old = row({ name: 'old thing', stars: 999_998, released: '2024-01-01' });
  const good = row({ name: 'agent-kit', stars: 5000, homepage: 'https://x.dev', repo: 'a/thing' });
  const feed = buildFeed([...many, ...npmRows, bad, old, good], WINDOW);
  assert.ok(feed.length > 0);
  assert.ok(feed.some((f) => f.name === 'agent-kit'));
  assert.ok(!feed.some((f) => f.name === 'nsfw thing' || f.name === 'old thing'));
  const mcpShown = feed.filter((f) => f.source === 'mcp-registry').length;
  assert.ok(mcpShown < many.length / 2, `${mcpShown} of ${many.length} MCP records got through the quota`);
  const allowed = new Set(['key', 'source', 'source_label', 'kind', 'provider', 'name', 'description', 'date', 'date_kind', 'url', 'traction']);
  for (const f of feed) {
    assert.ok(f.url.startsWith('https://'));
    assert.ok(f.name.trim());
    for (const k of Object.keys(f)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  }
});
