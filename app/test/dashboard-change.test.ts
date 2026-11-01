import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDashboard, type DashboardServer } from '../src/dashboard/server.ts';

const ID = 'change-abcdef0-1-abcdef';

describe('the change API', () => {
  let server: DashboardServer;
  let calls: string[] = [];
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  before(async () => {
    server = await startDashboard({
      root: '/nonexistent', port: 0, scan: async () => undefined, judge: async () => undefined, judgeAvailable: () => true, appConfigured: () => false,
      change: async (repo, rank, emit) => {
        calls = [...calls, `${repo}#${rank}`];
        emit({ type: 'step', name: 'Read the places', detail: 'masked' });
        emit({ type: 'change', change: { id: ID } });
        emit({ type: 'done' });
      },
      openPr: async (id) => ({ state: 'needs_app', id }),
      repos: () => [{ repo: 'a/b' }],
      readRun: (repo) => (repo === 'a/b' ? { repo } : null),
    });
  });
  after(() => server.close());

  it('streams steps, then the change', async () => {
    const text = await (await post('/api/change', { repo: 'a/b', finding: 3 })).text();
    assert.deepEqual(text.trim().split('\n').map((line) => (JSON.parse(line) as { type: string }).type), ['step', 'change', 'done']);
    assert.deepEqual(calls, ['a/b#3']);
  });

  it('refuses a bad slug, a bad rank, a foreign origin and the wrong method', async () => {
    const before = calls.length;
    assert.equal((await post('/api/change', { repo: '../etc', finding: 1 })).status, 400);
    for (const finding of [0, -1, 1.5, '1', 1000, null]) assert.equal((await post('/api/change', { repo: 'a/b', finding })).status, 400);
    assert.equal((await post('/api/change', { repo: 'a/b', finding: 1 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/change`)).status, 405);
    assert.equal(calls.length, before);
  });

  it('open-pr takes only an id keepup could have made', async () => {
    for (const changeId of ['../../etc/passwd', 'change-x', '', 7, null]) assert.equal((await post('/api/open-pr', { changeId })).status, 400);
    assert.equal((await post('/api/open-pr', { changeId: ID }, { origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(await (await post('/api/open-pr', { changeId: ID })).json(), { state: 'needs_app', id: ID });
  });

  it('lists this session’s repos and reads a run', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    assert.deepEqual(await (await fetch(`${base}/api/repos`)).json(), { ok: true, repos: [{ repo: 'a/b' }] });
    assert.equal((await fetch(`${base}/api/run?repo=a/b`)).status, 200);
    assert.equal((await fetch(`${base}/api/run?repo=../x`)).status, 400);
    assert.equal((await fetch(`${base}/api/run?repo=c/d`)).status, 404);
  });

  it('health says whether the App is set up, and never what its values are', async () => {
    assert.equal(((await (await fetch(`http://127.0.0.1:${server.port}/api/health`)).json()) as { app: boolean }).app, false);
  });
});
