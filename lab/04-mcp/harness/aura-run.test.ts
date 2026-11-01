import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFrames, summarize } from '../lib/sse.ts';
import { FAKE_ANSWER, nextFrames, startFakeProvider } from '../fake/fake-provider.ts';
import { ask, discover, freePort, withAura } from './aura-run.ts';

const FAKE_AURA = join(import.meta.dirname, '..', 'fake', 'fake-aura.ts');
const CONFIG = `[mcp.servers.pagerduty]
transport = "http_streamable"
url = "https://x"

[mcp.servers.signoz]
transport = "stdio"
cmd = ["docker"]

[agent]
name = "x"
alias = "incident-response/signoz"
`;

function options() {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-aura-'));
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, CONFIG);
  return { command: [process.execPath, FAKE_AURA], configPath, env: { PATH: process.env.PATH }, logFile: join(dir, 'aura.log'), cwd: dir };
}

test('withAura starts the server, answers through it and stops it', async () => {
  let base = '';
  const names = await withAura(options(), async (baseUrl) => {
    base = baseUrl;
    return discover(baseUrl, 'incident-response/signoz');
  });
  assert.deepEqual(names, { signoz: ['fake_signoz_details', 'fake_signoz_search'] });
  await assert.rejects(fetch(`${base}/health`), 'the server is gone afterwards');
});

test('ask reads the stream as it arrives and times it', async () => {
  const answer = await withAura(options(), (baseUrl) => ask(baseUrl, 'incident-response/signoz', 'why?'));
  assert.equal(answer.status, 200);
  const stream = summarize(parseFrames(answer.raw));
  assert.equal(stream.done, true);
  assert.match(stream.answer, /Fake answer/);
  assert.deepEqual(stream.toolCalls.map((c) => c.name), ['fake_signoz_search']);
  assert.ok(answer.firstTextMs !== null && answer.firstTextMs <= answer.totalMs);
});

test('a server that dies at start is an error, not a hang', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-aura-'));
  const dead = join(dir, 'dead.cjs');
  writeFileSync(dead, 'process.exit(7);');
  await assert.rejects(withAura({ ...options(), command: [process.execPath, dead] }, async () => 'never'), /exited with code 7/);
});

test('a command that cannot be spawned is an error, not a hang', async () => {
  await assert.rejects(withAura({ ...options(), command: ['/nonexistent/aura'] }, async () => 'never'), /ENOENT/);
});

test('discover names an unknown agent rather than returning nothing', async () => {
  await withAura(options(), async (baseUrl) => {
    await assert.rejects(discover(baseUrl, 'not-the-agent'), /no agent/);
  });
});

test('freePort gives a port this process can bind', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1',()=>process.exit(0))`]);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
});

test('the fake provider asks for a preferred tool first, then answers once the tool has run', () => {
  const tools = [{ function: { name: 'a' } }, { function: { name: 'signoz_list_services' } }];
  const first = nextFrames({ tools, messages: [{ role: 'user', content: 'q' }] }, ['signoz_list_services']).join('');
  assert.match(first, /"name":"signoz_list_services"/);
  assert.match(first, /tool_calls/);
  const second = nextFrames({ tools, messages: [{ role: 'user', content: 'q' }, { role: 'tool', content: 'r' }] }, ['signoz_list_services']).join('');
  assert.ok(second.includes(FAKE_ANSWER));
  assert.ok(!second.includes('tool_calls'));
  const none = nextFrames({ tools: [], messages: [{ role: 'user', content: 'q' }] }, []).join('');
  assert.ok(none.includes(FAKE_ANSWER), 'with no tools offered it just answers');
});

test('a scripted fake provider asks for each offered call in turn, with its arguments, then answers', () => {
  const tools = [{ function: { name: 'a' } }, { function: { name: 'b' } }];
  const calls = [{ name: 'a', arguments: { q: 1 } }, { name: 'not_offered' }, { name: 'b' }];
  const after = (n: number) => ({ tools, messages: [{ role: 'user', content: 'q' }, ...Array.from({ length: n }, () => ({ role: 'tool', content: 'r' }))] });
  const first = nextFrames(after(0), [], calls).join('');
  assert.match(first, /"name":"a"/);
  assert.ok(first.includes(JSON.stringify(JSON.stringify({ q: 1 }))), 'the arguments go as the JSON string the API sends');
  const second = nextFrames(after(1), [], calls).join('');
  assert.match(second, /"name":"b"/);
  assert.notEqual(second.match(/"id":"(call_[^"]+)"/)?.[1], first.match(/"id":"(call_[^"]+)"/)?.[1], 'a stream told apart by tool id needs them distinct');
  assert.ok(nextFrames(after(2), [], calls).join('').includes(FAKE_ANSWER));
});

test('a scripted call can wait, so a server can finish starting first', async () => {
  const provider = await startFakeProvider([], { calls: [{ name: 'a', delayMs: 120 }] });
  try {
    const began = Date.now();
    await (await fetch(`http://127.0.0.1:${provider.port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }], tools: [{ function: { name: 'a' } }] }) })).text();
    assert.ok(Date.now() - began >= 100);
  } finally {
    await provider.close();
  }
});

test('in answer-only mode the fake provider never asks for a tool, so a probe touches no backend', async () => {
  const provider = await startFakeProvider(['signoz_list_services'], { answerOnly: true });
  try {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'q' }], tools: [{ function: { name: 'signoz_list_services' } }] });
    const text = await (await fetch(`http://127.0.0.1:${provider.port}/v1/chat/completions`, { method: 'POST', body })).text();
    assert.ok(text.includes(FAKE_ANSWER));
    assert.ok(!text.includes('tool_calls'));
    assert.equal(provider.requests().length, 1);
  } finally {
    await provider.close();
  }
});

test('the fake provider serves chat completions, records them and refuses other routes', async () => {
  const provider = await startFakeProvider();
  const base = `http://127.0.0.1:${provider.port}/v1`;
  try {
    const res = await fetch(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }], tools: [] }) });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(FAKE_ANSWER));
    assert.equal(provider.requests().length, 1);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally {
    await provider.close();
  }
});
