// Recomputes what the site shows from the source files, by a separate path from
// the builder, so a number on screen can always be traced back to data/.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { median } from '../lab/shared/stats.ts';
import { buildAll, type SiteData } from './build-site-data.ts';
import type { Timeline } from './replay-summary.ts';

const ROOT = join(import.meta.dirname, '..');
const DB = join(ROOT, 'data', 'db');
let site: SiteData;

const lines = (file: string): Record<string, unknown>[] =>
  gunzipSync(readFileSync(join(DB, file))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

before(async () => {
  site = await buildAll(ROOT, '2026-11-01T00:00:00.000Z');
});

test('pulse: each source count is the number of records in its file', () => {
  const files = readdirSync(DB).filter((f) => f.endsWith('.jsonl.gz'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const rows = lines(file);
    const id = String(rows[0].source);
    assert.equal(site.pulse.by_source.find((s) => s.id === id)?.count, rows.length, id);
  }
});

test('pulse: the total is the sum of the sources, and matches what the README states', () => {
  const sum = site.pulse.by_source.reduce((n, s) => n + s.count, 0);
  assert.equal(site.pulse.total, sum);
  const readme = readFileSync(join(ROOT, 'data/briefs/README.md'), 'utf8');
  const stated = Number(readme.match(/^([\d,]+) things, fetched/m)?.[1].replaceAll(',', ''));
  assert.equal(site.pulse.total, stated);
});

test('pulse: by_day adds up to in_window, per source and overall, and the rest is itemised', () => {
  const { by_day, by_source, in_window, total, outside_window } = site.pulse;
  assert.equal(by_day.days.length, 61);
  for (const s of by_source) {
    const days = by_day.by_source[s.id];
    assert.equal(days.length, 61);
    assert.equal(days.reduce((a, b) => a + b, 0), s.in_window, s.id);
  }
  assert.equal(by_day.totals.reduce((a, b) => a + b, 0), in_window);
  assert.equal(in_window + outside_window.count, total);
  assert.equal(outside_window.items.length, outside_window.count);
  for (const i of outside_window.items) assert.ok(i.date < by_day.days[0] || i.date > by_day.days[60], i.date);
});

test('pulse: the record dates recount the window independently', () => {
  const inWindow = (d: unknown) => typeof d === 'string' && d >= '2026-09-01' && d <= '2026-10-31';
  for (const file of ['github.jsonl.gz', 'npm.jsonl.gz', 'mcp-registry.jsonl.gz']) {
    const rows = lines(file);
    const n = rows.filter((r) => inWindow(r.released) || inWindow(r.updated)).length;
    assert.equal(site.pulse.by_source.find((s) => s.id === rows[0].source)?.in_window, n, file);
  }
});

test('feed: about 600 real items, https links only, none empty, newest first, no single source dominant', () => {
  const { feed } = site.pulse;
  assert.ok(feed.length >= 450 && feed.length <= 650, `feed has ${feed.length}`);
  const seen = new Set<string>();
  for (const item of feed) {
    assert.ok(item.url.startsWith('https://'), item.url);
    assert.ok(item.name.trim().length > 0);
    assert.ok(item.description.trim().length > 0, item.name);
    assert.ok(item.date >= '2026-09-01' && item.date <= '2026-10-31', item.date);
    assert.ok(!seen.has(item.key), item.key);
    seen.add(item.key);
  }
  for (let i = 1; i < feed.length; i += 1) assert.ok(feed[i - 1].date >= feed[i].date);
  const counts = Object.groupBy(feed, (f) => f.source);
  assert.ok(Object.keys(counts).length >= 8, 'the feed mixes sources');
  for (const [source, items] of Object.entries(counts)) assert.ok((items?.length ?? 0) / feed.length < 0.3, source);
});

test('feed: every non-changelog item is a record that really exists in the database', () => {
  const names = new Map<string, Set<string>>();
  for (const file of readdirSync(DB).filter((f) => f.endsWith('.jsonl.gz'))) {
    const rows = lines(file);
    const shown = rows.flatMap((r) => [String(r.name), String(r.name).split('/').at(-1) ?? '']);
    names.set(String(rows[0].source), new Set(shown));
  }
  for (const item of site.pulse.feed) {
    if (item.source !== 'changelog') assert.ok(names.get(item.source)?.has(item.name), item.name);
  }
});

test('replay: the summary recomputes from timeline.json, including the median', () => {
  const timeline = JSON.parse(readFileSync(join(ROOT, 'data/timeline.json'), 'utf8')) as Timeline;
  const events = timeline.repos.flatMap((r) => r.events);
  const later = events.flatMap((e) => (e.team?.days_after != null && e.team.days_after > 0 ? [e.team.days_after] : []));
  const s = site.replay.summary.overall;
  assert.equal(s.prs_opened, events.filter((e) => e.keepup.action === 'pr_opened').length);
  assert.equal(s.prs_updated, events.filter((e) => e.keepup.action === 'pr_updated').length);
  assert.equal(s.team_later, later.length);
  assert.equal(s.median_days_later, later.length ? median(later) : null);
  const placed = site.replay.repos.flatMap((r) => r.weeks.flatMap((w) => w.events));
  assert.equal(placed.length, events.length, 'every event lands in exactly one week');
  for (const r of site.replay.repos) {
    for (const w of r.weeks) for (const e of w.events) assert.ok(e.date >= w.start && e.date <= w.end);
  }
});

test('replay: every location is a permalink at a commit, and the headline carries the computed numbers', () => {
  for (const r of site.replay.repos) {
    for (const w of r.weeks) {
      for (const e of w.events) {
        for (const l of e.locations) assert.match(l.url, /^https:\/\/github\.com\/.+\/(blob|tree)\/[0-9a-f]{7,40}\//);
      }
    }
  }
  const s = site.replay.summary.overall;
  assert.ok(site.replay.headline.includes(String(s.prs_opened)));
  assert.ok(site.replay.headline.includes(String(s.median_days_later)));
});

test('prs: nothing claims to be on GitHub unless data/github-objects.json says so', () => {
  const path = join(ROOT, 'data/github-objects.json');
  const objects = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { prs?: Record<string, unknown> } : { prs: {} };
  for (const pr of site.prs.prs) {
    const recorded = Boolean(objects.prs?.[pr.id]);
    assert.equal(pr.github !== null, recorded, pr.id);
    if (!recorded) assert.equal(pr.status, 'ready', pr.id);
    if (pr.title_state === 'not measured yet') assert.ok(!pr.title.includes('{{'), pr.id);
    assert.ok(!/\{\{/.test(JSON.stringify(pr.stages.map((s) => s.title))), pr.id);
  }
});

test('moonshot: each price is the OpenRouter record, and each quote is a line of the changelog', () => {
  const rows = lines('openrouter.jsonl.gz');
  assert.ok(site.moonshot.prices.length >= 4);
  for (const p of site.moonshot.prices) {
    const r = rows.find((x) => x.model_id === p.model_id);
    assert.equal(p.price_in_per_m, r?.price_in_per_m);
    assert.equal(p.price_out_per_m, r?.price_out_per_m);
    assert.equal(p.released, r?.released);
  }
  const anthropic = gunzipSync(readFileSync(join(DB, 'changelog-anthropic.txt.gz'))).toString('utf8');
  const quotes = site.moonshot.cache.filter((c) => c.provider === 'anthropic');
  assert.ok(quotes.length > 0);
  for (const c of quotes) assert.ok(anthropic.includes(c.quote.slice(0, 40)), c.quote);
  assert.ok(quotes.some((c) => c.multiplier === 0.05 && c.date === '2026-10-07'));
});

test('moonshot: the fleet table is the replay summary and the runs, per repo', () => {
  for (const row of site.moonshot.fleet) {
    assert.equal(row.prs_opened, site.replay.summary.repos[row.repo].prs_opened);
    assert.equal(row.runs, site.runs.runs.filter((r) => r.repo === row.repo).length);
  }
});

test('manifest: reads the app manifest and the fetch date, and tells the truth about GitHub', () => {
  const path = join(ROOT, 'data/github-objects.json');
  const objects = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { prs?: object } : {};
  assert.equal(site.manifest.database_fetched, '2026-10-31');
  assert.equal(site.manifest.github.pull_requests, Object.keys(objects.prs ?? {}).length);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'app/manifest.json'), 'utf8'));
  assert.deepEqual(site.manifest.app.permissions, manifest.default_permissions);
});
