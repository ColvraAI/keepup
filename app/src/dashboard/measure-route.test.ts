import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDashboard } from './server.ts';

const none = async () => undefined;

async function withServer(measure: Parameters<typeof startDashboard>[0]['measure'], work: (port: number) => Promise<void>): Promise<void> {
  const app = await startDashboard({ root: '/nonexistent', port: 0, scan: none, judge: none, judgeAvailable: () => false, measure });
  try { await work(app.port); } finally { await app.close(); }
}

const post = (port: number, body: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/api/measure`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('/api/measure has the same doors as /api/change', async () => {
  await withServer(undefined, async (port) => assert.equal((await post(port, { repo: 'a/b', finding: 1 })).status, 404));
  const calls: unknown[] = [];
  await withServer(async (repo, rank, emit) => { calls.push([repo, rank]); emit({ type: 'measure', measure: { id: 'x' } }); emit({ type: 'done' }); }, async (port) => {
    assert.equal((await post(port, { repo: 'not a repo', finding: 1 })).status, 400);
    assert.equal((await post(port, { repo: 'a/b', finding: 0 })).status, 400);
    assert.equal((await post(port, { repo: 'a/b', finding: 1 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/measure`)).status, 405);
    assert.equal(calls.length, 0);
    const ok = await post(port, { repo: 'a/b', finding: 2 });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /"type":"measure"/);
    assert.deepEqual(calls, [['a/b', 2]]);
  });
});

test('a missing key is the measure\'s own answer, not a refusal at the door', async () => {
  await withServer(async (_repo, _rank, emit) => { emit({ type: 'measure', measure: { rows: [{ status: 'not measured', needs: 'ANTHROPIC_API_KEY' }] } }); emit({ type: 'done' }); }, async (port) => {
    assert.match(await (await post(port, { repo: 'a/b', finding: 1 })).text(), /not measured/);
  });
});
