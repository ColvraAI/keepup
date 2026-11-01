import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { summarize, teamRelation, type Timeline } from './replay-summary.ts';

const ROOT = join(import.meta.dirname, '..');
const WINDOW = { from: '2026-09-01', to: '2026-10-31', fetched: '2026-10-31' };

function timeline(events: Timeline['repos'][number]['events']): Timeline {
  return { window: WINDOW, repos: [{ repo: 'a/b', fork: '<demo-org>/b', pinned_commit: 'abc1234', events }] };
}

const event = (action: string, extra: object = {}) => ({
  date: '2026-09-10', thing: 'x', kind: 'model', source_url: 'https://example.com', keepup: { action, summary: 's' }, ...extra,
});

test('teamRelation: a positive gap means a later team commit overlaps the row', () => {
  assert.equal(teamRelation({ days_after: 22 }), 'later');
  assert.equal(teamRelation({ days_after: -6 }), 'ahead');
  assert.equal(teamRelation({ days_after: null }), 'unchanged');
  assert.equal(teamRelation({ days_after: 0 }), 'same_day');
  assert.equal(teamRelation(undefined), null);
});

test('summarize counts each action and tolerates missing optional fields', () => {
  const s = summarize(timeline([
    event('pr_opened'), event('pr_opened'), event('pr_updated'), event('held_back'),
    event('watching'), event('brief_only'), event('finding'), event('none'),
  ]));
  const r = s.repos['a/b'];
  assert.equal(r.prs_opened, 2);
  assert.equal(r.prs_updated, 1);
  assert.equal(r.held_back, 1);
  assert.equal(r.watching, 1);
  assert.equal(r.brief_only, 1);
  assert.equal(r.findings, 1);
  assert.equal(r.events, 8);
  assert.equal(r.team_later, 0);
  assert.equal(r.median_days_later, null);
  assert.deepEqual(s.overall.team_points, []);
});

test('summarize: the median is over later points only, overall across repos', () => {
  const t: Timeline = {
    window: WINDOW,
    repos: [
      { repo: 'a/b', fork: 'f/b', pinned_commit: 'a', events: [
        event('finding', { team: { date: '2026-09-20', commit: 'c1', days_after: 10, note: '' } }),
        event('held_back', { team: { date: '2026-09-04', commit: 'c2', days_after: -6, note: '' } }),
      ] },
      { repo: 'c/d', fork: 'f/d', pinned_commit: 'b', events: [
        event('pr_opened', { team: { date: '2026-09-30', commit: 'c3', days_after: 20, note: '' } }),
        event('pr_opened', { team: { date: null, commit: null, days_after: null, note: 'still' } }),
      ] },
    ],
  };
  const s = summarize(t);
  assert.equal(s.repos['a/b'].median_days_later, 10);
  assert.equal(s.repos['a/b'].team_ahead, 1);
  assert.equal(s.repos['c/d'].team_unchanged, 1);
  assert.equal(s.overall.team_later, 2);
  assert.equal(s.overall.median_days_later, 15);
  assert.equal(s.overall.prs_opened, 2);
});

test('summarize: each team point keeps its action, and points on pull request rows are counted apart', () => {
  const team = { date: '2026-09-20', commit: 'c1', days_after: 10, note: '' };
  const s = summarize(timeline([event('finding', { team }), event('pr_opened', { team }), event('pr_updated', { team }), event('held_back', { team: { ...team, days_after: -1 } })]));
  assert.deepEqual(s.overall.team_points.map((p) => p.action), ['finding', 'pr_opened', 'pr_updated']);
  assert.equal(s.overall.team_later, 3);
  assert.equal(s.overall.team_later_on_prs, 2);
});

test('summarize: only a row with a live run counts as raised by the engine', () => {
  const team = { date: '2026-09-20', commit: 'c1', days_after: 10, note: '' };
  const s = summarize(timeline([event('pr_opened', { team, run: 'data/runs/replay-checks/x.json' }), event('pr_updated', { team }), event('finding', { team, run: 'data/runs/replay-checks/y.json' })]));
  assert.equal(s.overall.team_later_engine, 2);
  assert.equal(s.overall.team_later_engine_on_prs, 1);
});

test('an unknown action is counted, not lost', () => {
  const s = summarize(timeline([event('something_new')]));
  assert.equal(s.overall.other, 1);
});

test('the real timeline: counts match a hand-free recount, and each days_after matches its dates', () => {
  const real = JSON.parse(readFileSync(join(ROOT, 'data/timeline.json'), 'utf8')) as Timeline;
  const all = real.repos.flatMap((r) => r.events);
  const s = summarize(real);
  assert.equal(s.overall.events, all.length);
  assert.equal(s.overall.prs_opened, all.filter((e) => e.keepup.action === 'pr_opened').length);
  assert.equal(s.overall.held_back, all.filter((e) => e.keepup.action === 'held_back').length);
  for (const e of all) {
    if (!e.team?.date) continue;
    const gap = (Date.parse(e.team.date) - Date.parse(e.date)) / 86_400_000;
    assert.equal(e.team.days_after, gap, `${e.date} ${e.thing}`);
  }
});
