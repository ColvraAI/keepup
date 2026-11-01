import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeStatus, formatStatus, type Status } from '../src/status.ts';
import { updateObjects, type PrRecord } from '../src/objects.ts';
import { createWorld, installSpec, installTimeline, MEASURED_RESULT, NOT_RUN_RESULT, ORG, recordFor, repoFixture, specJson, tempDir, writeJson, writeText } from './world.ts';

const item = (s: Status, n: number) => {
  const found = s.items.find((i) => i.n === n);
  if (!found) throw new Error(`no item ${n}`);
  return found;
};

test('with no .env at all it works, says what is missing and gives the one next command', async () => {
  const root = tempDir();
  const status = await computeStatus({ root, env: {} });
  assert.equal(status.items.length, 5);
  assert.ok(status.items.every((i) => !i.ok));
  assert.equal(status.next.command, 'npm run setup -- --org <name>');
  assert.ok(status.setup.missing.includes('DEMO_ORG'));
  const text = formatStatus(status);
  assert.match(text, /✗ 1\. The demo site is live/);
  assert.match(text, /✗ 2\. Pull requests 01–05 are open/);
  assert.match(text, /Next: npm run setup -- --org <name>/);
  assert.match(text, /Missing: DEMO_ORG/);
});

test('every lab is listed with its status, from its own result.md', async () => {
  const root = tempDir();
  const fix = repoFixture();
  installSpec(root, fix);
  writeText(join(root, 'lab/06-models/run.ts'), '');
  installSpec(root, fix, { labDir: 'lab/02-whisper', result: NOT_RUN_RESULT, overrides: { id: '02', spec: 'docs/prs/02.md' } });
  writeText(join(root, 'lab/02-whisper/run.ts'), '');
  writeText(join(root, 'lab/05-empty/run.ts'), '');
  const status = await computeStatus({ root, env: {} });
  assert.deepEqual(status.labs.map((l) => [l.dir, l.status, l.needs ?? null]), [
    ['02-whisper', 'not_run', 'OPENAI_API_KEY'], ['05-empty', 'no result yet', null], ['06-models', 'measured', null],
  ]);
  assert.match(formatStatus(status), /✓ 06-models: measured/);
});

function fullWorld(): string {
  const root = tempDir();
  const fix = repoFixture();
  const stage = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  const stagesOf: Record<string, string[]> = { '01': ['2026-10-06', '2026-10-22'], '04': ['2026-09-25', '2026-10-30'] };
  for (const id of ['01', '02', '03', '04', '05']) {
    const dates = stagesOf[id] ?? ['2026-09-22'];
    const stages = dates.map((date, i) => ({ ...stage[0], date, title: 'Keeps working', comment: i === 0 ? null : 'Updated.' }));
    installSpec(root, fix, { labDir: `lab/${id}-x`, overrides: { id, spec: `docs/prs/${id}.md`, stages }, result: MEASURED_RESULT });
  }
  updateObjects(root, (o) => ({
    ...o, org: ORG, app: { slug: 'keepup-ai', url: 'https://github.com/apps/keepup-ai', bot: 'keepup-ai[bot]' },
    prs: Object.fromEntries(['01', '02', '03', '04', '05'].map((id) => [id, recordFor(root, id, { number: Number(id) })])),
    issues: { 'anything-llm/2026-10-26': { number: 9, url: 'x' }, 'aura/2026-10-26': { number: 3, url: 'y' } },
  }));
  installTimeline(root, [{ repo: 'a/b', events: [1, 2, 3].map((n) => ({ date: '2026-10-01', team: { date: '2026-10-02', commit: `c${n}`, days_after: n } })) }]);
  writeJson(join(root, 'data/replay-summary.json'), { pull_requests_opened: 5 });
  writeText(join(root, 'site/package.json'), '{}');
  writeText(join(root, 'site/public/data/timeline.json'), '{}');
  writeJson(join(root, 'data/site.json'), { url: 'https://keepup-demo.example.test' });
  writeJson(join(root, 'data/run-through.json'), { recorded: '2026-11-01', video: 'x.mp4' });
  return root;
}

test('every done-when item ticks only from real state', async () => {
  const root = fullWorld();
  const status = await computeStatus({ root, env: {} });
  assert.deepEqual(status.items.map((i) => [i.n, i.ok]), [[1, true], [2, true], [3, true], [4, true], [5, true]]);
  assert.match(formatStatus(status), /✓ 2\. Pull requests/);
});

test('pull request items fall when a fact falls', async () => {
  const cases: [Partial<PrRecord>, string, RegExp][] = [
    [{ state: 'closed' }, '02', /PR 02/],
    [{ author: 'a-person' }, '02', /a-person/],
    [{ ci: { state: 'pending', url: null } }, '02', /CI pending/],
    [{ ci: { state: 'none', url: null } }, '03', /CI none/],
    [{ stagesApplied: ['2026-10-06'] }, '01', /2026-10-22/],
    [{ stagesApplied: ['2026-09-25'] }, '04', /2026-10-30/],
    [{ base: 'replay/other' }, '02', /base replay\/other/],
    [{ title: 'Another title' }, '02', /isn't what the lab's result gives/],
    [{ bodyDigest: 'something-else' }, '02', /isn't what the lab's result gives/],
  ];
  for (const [patch, id, pattern] of cases) {
    const root = fullWorld();
    updateObjects(root, (o) => ({ ...o, prs: { ...o.prs, [id]: { ...o.prs[id], ...patch } } }));
    const status = await computeStatus({ root, env: {} });
    assert.equal(item(status, 2).ok, false);
    assert.match(item(status, 2).checks.filter((c) => !c.ok).map((c) => `${c.label} ${c.detail ?? ''}`).join('\n'), pattern);
  }
});

test('a merged pull request still counts: the founder clicked Merge', async () => {
  const root = fullWorld();
  updateObjects(root, (o) => ({ ...o, prs: { ...o.prs, '02': { ...o.prs['02'], state: 'merged' } } }));
  assert.equal(item(await computeStatus({ root, env: {} }), 2).ok, true);
});

test('an unmeasured lab keeps a pull request from counting', async () => {
  const root = fullWorld();
  writeText(join(root, 'lab/02-x/result.md'), NOT_RUN_RESULT);
  const status = await computeStatus({ root, env: {} });
  assert.equal(item(status, 2).ok, false);
  assert.match(formatStatus(status), /lab isn't measured/);
});

test('fewer than three team points, or no summary, keeps item 4 open', async () => {
  const root = fullWorld();
  installTimeline(root, [{ repo: 'a/b', events: [{ date: 'x', team: { date: 'y', commit: 'c1', days_after: 3 } }, { date: 'x', team: { date: null, commit: null, days_after: null } }] }]);
  const status = await computeStatus({ root, env: {} });
  assert.equal(item(status, 4).ok, false);
  assert.match(formatStatus(status), /1 real team points/);
});

test('item 3 needs the issue on both forks', async () => {
  const root = fullWorld();
  updateObjects(root, (o) => ({ ...o, issues: { 'aura/2026-10-26': { number: 3, url: 'y' } } }));
  const status = await computeStatus({ root, env: {} });
  assert.equal(item(status, 3).ok, false);
  assert.match(formatStatus(status), /✗ anything-llm issue, week of 26 Oct: not posted yet/);
});

test('the run-through is a person\'s to do, and says so', async () => {
  const root = tempDir();
  const status = await computeStatus({ root, env: {} });
  assert.match(formatStatus(status), /a person records this/);
});

test('--live re-reads pull requests and CI from GitHub, and it wins over the file', async () => {
  const w = await createWorld();
  const repo = w.fake.repo(ORG, 'anything-llm');
  if (!repo) throw new Error('fixture');
  repo.pulls.push({ number: 1, title: 'live', body: '', state: 'closed', merged_at: '2026-11-01T00:00:00Z', user: 'keepup[bot]', created_at: 'x', comments: [], head: 'main', headSha: w.fix.mainTip, base: 'main' });
  repo.checks = [{ name: 't', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/live/1', details_url: 'https://github.com/live/1' }];
  w.fake.addRepo(ORG, 'aura', w.fix.bare, { fork: true, parent: 'mezmo/aura', workflows: [] });
  const fix = repoFixture();
  installSpec(w.root, fix, { overrides: { id: '01', spec: 'docs/prs/01.md' }, labDir: 'lab/01-x' });
  updateObjects(w.root, (o) => ({ ...o, org: ORG, prs: { '01': recordFor(w.root, '01', { url: `https://github.com/${ORG}/anything-llm/pull/1`, ci: { state: 'success', url: 'x' } }) } }));
  const status = await computeStatus({ root: w.root, env: w.env, live: true });
  assert.equal(status.live, true);
  assert.match(formatStatus(status), /CI failure/);
  assert.equal(item(status, 2).ok, false);
  assert.equal(w.fake.writeRequests().filter((r) => !r.path.endsWith('/access_tokens')).length, 0, 'status never writes');
});

test('--live with no credentials says so and still reports', async () => {
  const status = await computeStatus({ root: tempDir(), env: {}, live: true });
  assert.equal(status.live, false);
  assert.match(formatStatus(status), /--live needs/);
});

test('--live says plainly when GitHub could not be read', async () => {
  const w = await createWorld();
  await w.fake.close();
  updateObjects(w.root, (o) => ({ ...o, prs: { '01': { number: 1, url: `https://github.com/${ORG}/anything-llm/pull/1`, title: 't', state: 'open', base: 'b', head: 'h', author: 'keepup[bot]', stagesApplied: [], ci: { state: 'none', url: null }, checkedAt: 'x' } } }));
  const status = await computeStatus({ root: w.root, env: w.env, live: true });
  assert.equal(status.live, false);
  assert.match(formatStatus(status), /Couldn't read GitHub/);
  assert.ok(!formatStatus(status).includes('ghs_'));
});

test('with setup done and work left, the next command is go', async () => {
  const w = await createWorld();
  const status = await computeStatus({ root: w.root, env: w.env });
  assert.equal(status.setup.ok, true);
  assert.equal(status.next.command, 'npm run go');
});

test('a broken spec is reported as the next thing to fix', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix, { overrides: { baseCommit: 'nope' } });
  const status = await computeStatus({ root: w.root, env: w.env });
  assert.match(status.next.why, /baseCommit/);
  assert.equal(status.specs.invalid.length, 1);
});
