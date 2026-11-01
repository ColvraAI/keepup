import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { parseResult, writeResult } from '../../lab/shared/result.ts';
import { buildManifest } from './manifest.ts';
import { cacheMultipliers, buildMoonshot } from './moonshot.ts';
import { buildPrs, parseResultTable, renderPrTitle } from './prs.ts';
import { buildReplay, replayHeadline, replayHeadlineParts, weeksOfWindow } from './replay.ts';
import { addPermalinks, applyFindingPrs, buildRuns, readFindingPrs } from './runs.ts';
import { buildWeekly } from './weekly.ts';
import { readTimeline, type Timeline } from '../replay-summary.ts';
import { localShaResolver } from './links.ts';

const WINDOW = { from: '2026-09-01', to: '2026-10-31', fetched: '2026-10-31' };
const temp = mkdtempSync(join(tmpdir(), 'keepup-site-data-'));
after(() => rmSync(temp, { recursive: true, force: true }));

function fresh(name: string): string {
  const dir = join(temp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const timeline: Timeline = {
  window: WINDOW,
  repos: [{
    repo: 'a/b', fork: '<demo-org>/b', pinned_commit: 'abc1234',
    events: [
      { date: '2026-09-01', thing: 'one', kind: 'model', source_url: 'https://x.dev', where: 'x/y.js:11', keepup: { action: 'pr_opened', pr: '01', summary: 's' }, base_commit: 'def5678',
        team: { date: '2026-09-11', commit: 'c0ffee1', days_after: 10, note: 'n' } },
      { date: '2026-10-31', thing: 'two', kind: 'model', source_url: 'https://x.dev', keepup: { action: 'held_back', summary: 's' } },
    ],
  }],
};

test('weeksOfWindow: Mondays clipped to the window', () => {
  const w = weeksOfWindow(WINDOW);
  assert.equal(w.length, 9);
  assert.deepEqual(w[0], { monday: '2026-08-31', start: '2026-09-01', end: '2026-09-06' });
  assert.deepEqual(w[8], { monday: '2026-10-26', start: '2026-10-26', end: '2026-10-31' });
});

test('buildReplay groups by repo and week, keeps quiet weeks, and links each location at the pinned commit', () => {
  const r = buildReplay(timeline, { forks: {} });
  const repo = r.repos[0];
  assert.equal(repo.weeks.length, 9);
  assert.equal(repo.weeks[0].events.length, 1);
  assert.equal(repo.weeks[1].events.length, 0);
  const e = repo.weeks[0].events[0];
  assert.equal(e.locations[0].url, 'https://github.com/a/b/blob/abc1234/x/y.js#L11');
  assert.equal(e.team?.commit_url, 'https://github.com/a/b/commit/c0ffee1');
  assert.equal(e.team?.relation, 'later');
  assert.equal(e.base_url, 'https://github.com/a/b/tree/def5678');
  assert.equal(r.summary.overall.prs_opened, 1);
  assert.match(r.headline, /opened 1 pull request .*held back 1 thing.*got to 1 of the things keepup built a pull request for, a median 10 days later/);
  assert.doesNotMatch(r.headline, /raised/, 'a point on a hand-specified pull request is not something the engine raised');
  assert.doesNotMatch(r.headline, /same change/, 'a later commit near a row is not proof of the same change');
});

test('buildReplay: a row marked where_at base links its lines at its base commit, not the pin', () => {
  const events = [{ ...timeline.repos[0].events[0], where_at: 'base' as const }];
  const r = buildReplay({ ...timeline, repos: [{ ...timeline.repos[0], events }] }, { forks: {} });
  assert.equal(r.repos[0].weeks[0].events[0].locations[0].url, 'https://github.com/a/b/blob/def5678/x/y.js#L11');
});

test('buildReplay: code links move to the fork the moment one is recorded; the team commit stays upstream', () => {
  const r = buildReplay(timeline, { forks: { b: 'https://github.com/keepup-demo/b' } });
  const e = r.repos[0].weeks[0].events[0];
  assert.equal(e.locations[0].url, 'https://github.com/keepup-demo/b/blob/abc1234/x/y.js#L11');
  assert.equal(e.team?.commit_url, 'https://github.com/a/b/commit/c0ffee1');
});

test('buildReplay refuses an event outside the window rather than dropping it', () => {
  const bad = { ...timeline, repos: [{ ...timeline.repos[0], events: [{ ...timeline.repos[0].events[0], date: '2026-11-02' }] }] };
  assert.throws(() => buildReplay(bad, { forks: {} }), /2026-11-02/);
});

test('renderPrTitle resolves the placeholder only when measured', () => {
  const stage = { title: 'Route messages · {{lab.title_number}}' };
  assert.deepEqual(renderPrTitle(stage, { lab: 'x', status: 'measured', measured_at: '2026-11-01', title_number: '6x faster', body: '' }), { title: 'Route messages · 6x faster', state: 'measured' });
  assert.deepEqual(renderPrTitle(stage, { lab: 'x', status: 'not_run', needs: 'OPENAI_API_KEY', body: '' }), { title: 'Route messages', state: 'not measured yet', needs: 'OPENAI_API_KEY' });
  assert.deepEqual(renderPrTitle(stage, null), { title: 'Route messages', state: 'not measured yet', needs: 'a lab run' });
  assert.deepEqual(renderPrTitle({ title: 'Keeps working after 26 Feb' }, null), { title: 'Keeps working after 26 Feb', state: 'no number' });
});

test('parseResultTable reads the first table, and leaves the prose', () => {
  const t = parseResultTable('Intro.\n\n| | before | after |\n| --- | --- | --- |\n| p50 | 10 | 2 |\n\nNotes here.');
  assert.deepEqual(t.headers, ['', 'before', 'after']);
  assert.deepEqual(t.rows, [['p50', '10', '2']]);
  assert.equal(t.notes, 'Intro.\n\nNotes here.');
  assert.deepEqual(parseResultTable('No table.').rows, []);
});

function writeLab(root: string): void {
  const lab = join(root, 'lab', '01-router');
  mkdirSync(join(lab, 'patches'), { recursive: true });
  const pr = {
    schema: 1, id: '01', spec: 'docs/prs/01.md', upstream: 'a/b', fork: 'b', baseCommit: 'a'.repeat(40), baseBranch: 'replay/aaaa', ciWorkflow: null,
    branch: 'keepup/x', lab: 'lab/01-router', source: 'OpenAI', sourceUrl: 'https://x.dev', where: [{ path: 'x/y.js', line: 71 }],
    founderLine: 'Plain words.', effect: ['faster'], effort: 'A day', whyItFits: 'Fits.', risks: 'Risks.', rollback: 'Set a flag.',
    proof: { vendor: { claim: 'c', url: 'https://x.dev' }, independent: null }, sources: ['https://x.dev'],
    stages: [
      { date: '2026-10-06', patches: ['patches/0001.patch'], title: 'Route · {{lab.title_number}}', whatShipped: 'w1', whatThisChanges: 'c1', comment: null },
      { date: '2026-10-22', patches: ['patches/0002-missing.patch'], title: 'Route · {{lab.title_number}}', whatShipped: 'w2', whatThisChanges: 'c2', comment: 'Updated 22 Oct.' },
    ],
  };
  writeFileSync(join(lab, 'pr.json'), JSON.stringify(pr));
  writeFileSync(join(lab, 'pr-jev.json'), JSON.stringify({ ...pr, id: '01-jev', stages: [pr.stages[0]] }));
  mkdirSync(join(lab, 'out', 'jev'), { recursive: true });
  writeFileSync(join(lab, 'out', 'jev', 'raw.json'), '{}\n');
  writeResult(join(lab, 'result-jev.md'), parseResult('---\nlab: 01-router-jev\nstatus: measured\nmeasured_at: 2026-11-01\ntitle_number: 3x faster\n---\n| | before | after |\n| --- | --- | --- |\n| p50 | 3 | 1 |\n'));
  writeFileSync(join(lab, 'patches', '0001.patch'), 'From a\nSubject: [PATCH] first\n---\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  mkdirSync(join(root, 'lab', 'bad'), { recursive: true });
  writeFileSync(join(root, 'lab', 'bad', 'pr.json'), '{ not json');
}

test('buildPrs: ready by default, not measured says so, and a broken lab does not crash the build', () => {
  const root = fresh('prs');
  writeLab(root);
  const { prs, problems } = buildPrs(root, { forks: {}, prs: {} });
  const main = prs.find((p) => p.id === '01');
  const jev = prs.find((p) => p.id === '01-jev');
  assert.ok(main && jev);
  assert.equal(main.status, 'ready');
  assert.equal(main.status_label, 'Ready to open · waits for the keepup App');
  assert.equal(main.github, null);
  assert.equal(main.title, 'Route');
  assert.equal(main.title_state, 'not measured yet');
  assert.equal(main.lab.status, 'absent');
  assert.equal(jev.title, 'Route · 3x faster', 'the variant reads its own result-jev.md');
  assert.deepEqual(jev.lab.table.rows, [['p50', '3', '1']]);
  assert.equal(main.stages[0].diff.files[0].path, 'x');
  assert.equal(main.stages[0].diff.additions, 1);
  assert.deepEqual(main.stages[1].diff.missing, ['patches/0002-missing.patch']);
  assert.equal(main.stages[1].comment, 'Updated 22 Oct.');
  assert.equal(main.base_commit_url, `https://github.com/a/b/tree/${'a'.repeat(40)}`);
  assert.equal(main.where[0].url, `https://github.com/a/b/blob/${'a'.repeat(40)}/x/y.js#L71`);
  assert.ok(problems.some((p) => p.includes('bad')));
});

test('buildPrs: a recorded pull request links, and is the only way to get a GitHub link', () => {
  const root = fresh('prs-open');
  writeLab(root);
  const record = {
    number: 7, url: 'https://github.com/keepup-demo/b/pull/7', title: 'Route · from GitHub', state: 'open', base: 'replay/aaaa', head: 'keepup/x', author: 'keepup[bot]',
    stagesApplied: ['2026-10-06'], ci: { state: 'success', url: 'https://github.com/keepup-demo/b/actions/runs/1' }, checkedAt: '2026-11-01T09:00:00Z',
  };
  const { prs } = buildPrs(root, { forks: { b: 'https://github.com/keepup-demo/b' }, prs: { '01': record, '01-jev': { ...record, state: 'merged' } } });
  const main = prs.find((p) => p.id === '01');
  assert.equal(main?.status, 'open');
  assert.equal(main?.github?.url, record.url);
  assert.equal(main?.title, 'Route · from GitHub');
  assert.equal(main?.where[0].url.startsWith('https://github.com/keepup-demo/b/blob/'), true);
  assert.equal(prs.find((p) => p.id === '01-jev')?.status, 'merged');
});

test('buildPrs with no labs at all is an empty list', () => {
  assert.deepEqual(buildPrs(fresh('none'), { forks: {}, prs: {} }), { prs: [], problems: [] });
});

test('addPermalinks links file:line strings and path objects without changing the input', () => {
  const input = { repo: 'a/b', findings: [{ where: 'x/y.js:3', title: 'version 1.2:3 is prose' }, { file: 'z.rs', line: 4 }, { path: 'q.py' }] };
  const out = addPermalinks(input, 'https://github.com/a/b', 'abc') as { findings: Record<string, unknown>[] };
  assert.equal(out.findings[0].where_url, 'https://github.com/a/b/blob/abc/x/y.js#L3');
  assert.equal(out.findings[0].title_url, undefined);
  assert.equal(out.findings[1].permalink, 'https://github.com/a/b/blob/abc/z.rs#L4');
  assert.equal(out.findings[2].permalink, 'https://github.com/a/b/blob/abc/q.py');
  assert.equal(Object.keys(input.findings[0]).length, 2);
});

test('addPermalinks leaves anything that is not a repo path alone', () => {
  const out = addPermalinks({ file: '/abs/x.js', path: 'two words.md' }, 'https://github.com/a/b', 'abc') as Record<string, unknown>;
  assert.equal(out.permalink, undefined);
});

test('buildRuns copes with no runs, and with a broken one', () => {
  assert.deepEqual(buildRuns(fresh('runs-none'), { forks: {} }), { runs: [], problems: [] });
  const root = fresh('runs');
  mkdirSync(join(root, 'data', 'runs'), { recursive: true });
  writeFileSync(join(root, 'data', 'runs', 'good.json'), JSON.stringify({ repo: 'a/b', commit: 'abc', findings: [{ where: 'x.js:1' }] }));
  writeFileSync(join(root, 'data', 'runs', 'bad.json'), 'nope');
  const { runs, problems } = buildRuns(root, { forks: {} });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].file, 'good.json');
  assert.equal((runs[0].run as { findings: { where_url: string }[] }).findings[0].where_url, 'https://github.com/a/b/blob/abc/x.js#L1');
  assert.equal(problems.length, 1);
  writeFileSync(join(root, 'data', 'runs', 'bad.json'), JSON.stringify({ repo: 'https://github.com/c/d.git', commit: 'def', where: [{ file: 'y.rs', line: 2, text: 'code' }] }));
  writeFileSync(join(root, 'data', 'runs', 'local.json'), JSON.stringify({ repo: '/Users/x/project', commit: 'def', where: [{ file: 'y.rs', line: 2 }] }));
  const again = buildRuns(root, { forks: {} }).runs;
  assert.equal(again[0].repo, 'c/d');
  assert.equal((again[0].run as { where: { permalink: string }[] }).where[0].permalink, 'https://github.com/c/d/blob/def/y.rs#L2');
  assert.equal((again[2].run as { where: Record<string, unknown>[] }).where[0].permalink, undefined, 'a local folder has nothing to link to');
});

test('buildWeekly reads data/weekly, and is absent when nothing can produce it', async () => {
  assert.equal(await buildWeekly(fresh('weekly-none'), { issues: {} }, WINDOW), null);
  const root = fresh('weekly');
  mkdirSync(join(root, 'data', 'weekly'), { recursive: true });
  writeFileSync(join(root, 'data', 'weekly', 'aura-2026-10-26.md'), '# keepup · week of 26 Oct\n\nBody.\n');
  writeFileSync(join(root, 'data', 'weekly', 'notes.txt'), 'ignored');
  const w = await buildWeekly(root, { issues: { 'aura/2026-10-26': { number: 9, url: 'https://github.com/o/aura/issues/9' } } }, WINDOW);
  assert.equal(w?.source, 'data/weekly');
  assert.equal(w?.briefs.length, 1);
  assert.deepEqual([w?.briefs[0].repo, w?.briefs[0].week, w?.briefs[0].title], ['aura', '2026-10-26', 'keepup · week of 26 Oct']);
  assert.equal(w?.briefs[0].issue?.number, 9);
});

test('cacheMultipliers quotes the printed sentence and its date', () => {
  const entry = { change: null, tags: [], url: 'https://x.dev' };
  const quotes = cacheMultipliers([
    { ...entry, provider: 'anthropic', date: '2026-10-07', text: 'Unrelated news. We\u2019ve lowered the price of prompt cache reads on Claude Sonnet 5.5 from $0.20 USD to $0.10 USD per million tokens: 0.05x the base input price instead of 0.1x. Cache writes are unchanged.' },
    { ...entry, provider: 'anthropic', date: '2024-01-01', text: 'Old 0.5x the base input price.' },
    { ...entry, provider: 'openai', date: '2026-09-22', text: 'New pricing: GPT-6 Sol: $2 input, $0.20 cached input, and $10 output. GPT-6 Luna: $0.10 input, $0.01 cached input, and $0.50 output.' },
  ], WINDOW);
  assert.equal(quotes.length, 3);
  assert.equal(quotes[0].multiplier, 0.05);
  assert.equal(quotes[0].date, '2026-10-07');
  assert.match(quotes[0].quote, /^We.ve lowered.*instead of 0\.1x\.$/);
  assert.equal(quotes[0].printed, true);
  assert.deepEqual(quotes[0].models, ['Claude Sonnet 5.5']);
  assert.deepEqual(quotes.slice(1).map((q) => [q.models[0], q.multiplier, q.printed]), [['GPT-6 Sol', 0.1, false], ['GPT-6 Luna', 0.1, false]]);
});

test('buildMoonshot takes prices only from records, and says which are missing', () => {
  const rows = [{ source: 'openrouter', kind: 'model', name: 'OpenAI: GPT-6 Luna', url: 'https://openrouter.ai/openai/gpt-6-luna', description: '', released: '2026-09-22', model_id: 'openai/gpt-6-luna', price_in_per_m: 0.1, price_out_per_m: 0.5 }];
  const replay = buildReplay(timeline, { forks: {} });
  const m = buildMoonshot({ rows, entries: [], window: WINDOW, replay, runs: { runs: [] }, modelIds: ['openai/gpt-6-luna', 'openai/nope'], fallback: null });
  assert.deepEqual(m.prices.map((p) => p.model_id), ['openai/gpt-6-luna']);
  assert.equal(m.prices[0].price_in_per_m, 0.1);
  assert.equal(m.prices[0].released, '2026-09-22');
  assert.equal(m.prices[0].fetched, '2026-10-31');
  assert.deepEqual(m.missing_prices, ['openai/nope']);
  assert.equal(m.fleet[0].repo, 'a/b');
  assert.equal(m.fleet[0].prs_opened, 1);
  assert.equal(m.fleet[0].runs, 0);
});

test('buildManifest says what exists on GitHub right now, which tonight is nothing', () => {
  const root = fresh('manifest');
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'manifest.json'), JSON.stringify({ name: 'what-was-asked-for', default_permissions: { contents: 'write' } }));
  const m = buildManifest(root, { forks: {}, prs: {}, issues: {} }, WINDOW, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(m.app.permissions, { contents: 'write' });
  assert.equal(m.github.exists, false);
  assert.equal(m.github.pull_requests, 0);
  assert.equal(m.database_fetched, '2026-10-31');
  assert.equal(m.built_at, '2026-11-01T00:00:00.000Z');
  assert.equal(buildManifest(fresh('manifest-none'), { forks: {}, prs: {}, issues: {} }, WINDOW, 'x').app.permissions, null);
  assert.equal(m.app.name, null, 'nothing is registered, so the site names no App');
  const registered = buildManifest(root, { app: { slug: 'what-github-called-it', url: 'https://github.com/apps/x', bot: 'x[bot]' }, forks: {}, prs: {}, issues: {} }, WINDOW, 'x');
  assert.equal(registered.app.name, 'what-github-called-it', 'the name is the one GitHub gave it, not the one asked for');
});

test('replayHeadline: says apart what the engine raised and what was specified by hand, and that the points are one commit', () => {
  const point = (days_after: number, commit = '5edf32b9aaaa') => ({ date: '2026-09-01', thing: 't', action: 'pr_opened', team_date: '2026-10-27', commit, days_after });
  const points = [point(56), point(35), point(28)];
  const base = { prs_opened: 5, held_back: 5, team_later: 3, team_later_on_prs: 3, team_later_engine: 1, team_later_engine_on_prs: 1, team_ahead: 2, team_points: points, median_days_later: 35 };
  const counts = (extra: object) => ({ ...base, ...extra }) as Parameters<typeof replayHeadline>[0];
  assert.equal(replayHeadline(counts({})),
    'keepup would have opened 5 pull requests and held back 5 things. Your team got to 3 of the things keepup raised or built a pull request for, a median 35 days later. The engine raised 1, and its pull request was written by hand; the other 2 were specified by hand. All 3 are one commit, 5edf32b9.');
  assert.match(replayHeadline(counts({ team_later_engine: 0, team_later_engine_on_prs: 0 })), /got to 3 of the things keepup built a pull request for.*All 3 are on pull requests written by hand\. All 3 are one commit/);
  assert.match(replayHeadline(counts({ team_later: 2, team_later_on_prs: 1, team_later_engine: 1, team_later_engine_on_prs: 0, team_points: [point(10), point(20, 'c0ffee1')] })), /The engine raised 1; the other 1 was specified by hand\.$/);
  assert.equal(replayHeadline(counts({ team_later: 2, team_later_on_prs: 0, team_later_engine: 2, team_later_engine_on_prs: 0, team_points: [point(10), point(20, 'c0ffee1')] })),
    'keepup would have opened 5 pull requests and held back 5 things. Your team got to 2 of the things keepup raised, a median 35 days later.');
  assert.equal(replayHeadline(counts({ team_later: 0, team_later_on_prs: 0, team_later_engine: 0, team_later_engine_on_prs: 0, team_points: [], median_days_later: null })),
    'keepup would have opened 5 pull requests and held back 5 things.');
});

test('replayHeadlineParts: the short sentence for the room, the qualifiers beside it, from the same counts', () => {
  const points = [56, 35, 28].map((days_after) => ({ date: '2026-09-01', thing: 't', action: 'pr_opened', team_date: '2026-10-27', commit: '5edf32b9aaaa', days_after }));
  const parts = replayHeadlineParts({ prs_opened: 5, held_back: 5, team_later: 3, team_later_on_prs: 3, team_later_engine: 1, team_later_engine_on_prs: 1, team_ahead: 2, team_points: points, median_days_later: 35 } as Parameters<typeof replayHeadlineParts>[0]);
  assert.equal(parts.big, 'keepup would have opened 5 pull requests and held back 5 things.');
  assert.equal(parts.short, 'Your team got to 3, a median 35 days later.');
  assert.equal(parts.commit, 'All 3 are one commit, 5edf32b9: 56, 35 and 28 days after each date.');
  assert.equal(parts.ahead, 'Your team was ahead of keepup 2 times, and keepup stayed quiet.');
});

test('buildReplay: a pull request row the team later fixed reads the code at the pull request\'s own base, not after the fix', () => {
  const where = [{ path: 'x/y.js', line: 7, url: 'https://github.com/a/b/blob/base01/x/y.js#L7' }];
  const r = buildReplay(timeline, { forks: {} }, undefined, [{ id: '01', where }]);
  const e = r.repos[0].weeks[0].events[0];
  assert.equal(e.locations[0].url, where[0].url);
  assert.equal(e.locations[0].line, 7);
  const none = buildReplay(timeline, { forks: {} }, undefined, [{ id: '01', where: [{ path: 'other.js', line: 1, url: 'https://x.dev' }] }]);
  assert.equal(none.repos[0].weeks[0].events[0].locations[0].url, 'https://github.com/a/b/blob/abc1234/x/y.js#L11', 'a pull request that names another file changes nothing');
});

test('the real GPT-6 rows link to code from before the team\'s fix, where the list has no GPT-6 yet', { skip: !existsSync(join(import.meta.dirname, '..', '..', 'tmp', 'anything-llm', '.git')) }, () => {
  const root = join(import.meta.dirname, '..', '..');
  const { prs } = buildPrs(root, { forks: {}, prs: {} });
  const replay = buildReplay(readTimeline(root), { forks: {} }, localShaResolver(root), prs);
  const rows = replay.repos[0].weeks.flatMap((week) => week.events).filter((event) => event.pr === '06');
  assert.ok(rows.length >= 2);
  rows.flatMap((row) => row.locations).forEach((location) => {
    const commit = /\/blob\/([0-9a-f]+)\//.exec(location.url)?.[1] ?? '';
    const file = spawnSync('git', ['-C', join(root, 'tmp', 'anything-llm'), 'show', `${commit}:${location.path}`], { encoding: 'utf8', maxBuffer: 8_000_000 });
    assert.equal(file.status, 0);
    const lines = file.stdout.split('\n');
    assert.match(lines[(location.line ?? 1) - 1] ?? '', /return \[/, 'the line is the start of the fallback list');
    assert.doesNotMatch(file.stdout, /gpt-6\.1-sol/, 'the change isn\'t already made at that commit');
  });
});

test('applyFindingPrs: a finding gets a pull request only from the explicit map, and a stale entry is reported', () => {
  const problems: string[] = [];
  const findings = [{ title: 'Your default gemini-2.0-flash-lite was shut down', pr: null }, { title: 'whisper-1 and 2 more shut down', pr: null }];
  const map = [{ repo: 'a/b', finding: 'whisper-1', pr: '02', shared: 'whisper' }, { repo: 'a/b', finding: 'gone', pr: '09', shared: 'x' }];
  const out = applyFindingPrs(findings, 'a/b', map, 'run.json', problems);
  assert.deepEqual(out.map((f) => f.pr), [null, '02']);
  assert.equal(findings[1].pr, null, 'the input is not changed');
  assert.match(problems[0], /"gone".*run\.json/);
});

test('the real map: every chip names the same thing as its finding, and the dead Gemini default has no pull request', () => {
  const root = join(import.meta.dirname, '..', '..');
  const { runs } = buildRuns(root, { forks: {} });
  const { prs } = buildPrs(root, { forks: {}, prs: {} });
  const map = readFindingPrs(root);
  const allFindings = runs.flatMap((view) => (view.run as { findings: { title: string; why: string; pr: string | null }[] }).findings.map((finding) => ({ ...finding, repo: view.repo })));
  const gemini = allFindings.find((finding) => /gemini-2\.0-flash-lite/.test(finding.title));
  assert.ok(gemini, 'the recorded run still raises the Gemini default');
  assert.equal(gemini.pr, null);
  const chips = allFindings.filter((finding) => finding.pr);
  assert.ok(chips.length >= 5);
  chips.forEach((finding) => {
    const entry = map.find((row) => row.repo === finding.repo && row.pr === finding.pr && finding.title.includes(row.finding));
    assert.ok(entry, `${finding.title} has a map entry`);
    const pr = prs.find((item) => item.id === finding.pr);
    assert.ok(pr, `PR ${finding.pr} exists`);
    const shared = new RegExp(entry.shared, 'i');
    assert.match(`${finding.title} ${finding.why}`, shared);
    assert.match(`${pr.title} ${pr.founder_line} ${pr.stages.map((stage) => stage.what_changes).join(' ')}`, shared);
  });
});

test('buildPrs holds a result to its saved run, as npm run pr does: typed or edited, it shows nothing', () => {
  const root = fresh('prs-typed');
  writeLab(root);
  const lab = join(root, 'lab', '01-router');
  writeFileSync(join(lab, 'result.md'), '---\nlab: 01-router\nstatus: measured\nmeasured_at: 2026-11-01\ntitle_number: 99x cheaper, typed by hand\n---\n| | before | after |\n| --- | --- | --- |\n| cost | $100 | $1 |\n');
  const { prs, problems } = buildPrs(root, { forks: {}, prs: {} });
  const main = prs.find((p) => p.id === '01');
  assert.ok(main);
  assert.equal(main.title, 'Route');
  assert.equal(main.title_state, 'not measured yet');
  assert.equal(main.proof.measured_on_fork, false);
  assert.deepEqual(main.lab.table.rows, []);
  assert.equal(main.lab.title_number, null);
  assert.ok(!JSON.stringify(main).includes('99x'));
  assert.ok(problems.some((p) => /result\.md: left off the site, because .*holds no saved run/.test(p)), problems.join('\n'));
  const edited = join(lab, 'result-jev.md');
  writeFileSync(edited, readFileSync(edited, 'utf8').replace('3x faster', '30x faster'));
  const jev = buildPrs(root, { forks: {}, prs: {} }).prs.find((p) => p.id === '01-jev');
  assert.equal(jev?.title_state, 'not measured yet', 'edited after the run');
  assert.ok(!JSON.stringify(jev).includes('30x'));
});

test('buildWeekly leaves a file holding a secret off the site, and says so', async () => {
  const root = fresh('weekly-secret');
  mkdirSync(join(root, 'data', 'weekly'), { recursive: true });
  writeFileSync(join(root, 'data', 'weekly', 'aura-2026-10-26.md'), '# keepup · week of 26 Oct\n\nkey sk-canary-in-a-weekly-file-0123456789\n');
  writeFileSync(join(root, 'data', 'weekly', 'anything-llm-2026-10-26.md'), '# keepup · week of 26 Oct\n\nNothing new.\n');
  const problems: string[] = [];
  const weekly = await buildWeekly(root, { issues: {} }, WINDOW, problems);
  assert.deepEqual(weekly?.briefs.map((b) => b.repo), ['anything-llm']);
  assert.ok(!JSON.stringify(weekly).includes('sk-canary'));
  assert.ok(problems.some((p) => /aura-2026-10-26\.md holds a secret/.test(p)));
  assert.ok(!problems.join().includes('sk-canary'));
});
