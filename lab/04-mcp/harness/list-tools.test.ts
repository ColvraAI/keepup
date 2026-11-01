import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { ServerSpec } from '../lib/example.ts';
import type { ToolsFailure, ToolsRecord } from '../lib/records.ts';
import { listTools, startedAs, type ListStep } from './list-tools.ts';
import { connectMini } from './mini-client.ts';
import { stderrTail } from './sdk-client.ts';

const EXAMPLE_PATH = 'examples/complete/incident-response-signoz.toml';
const FAKE_SERVER = join(import.meta.dirname, '..', 'fake', 'fake-mcp-server.ts');
const EXAMPLE = `[mcp.servers.signoz]
transport = "stdio"
cmd = ["docker"]
args = ["run", "-i", "-e", "SIGNOZ_API_KEY", "image:1"]
env = { SIGNOZ_API_KEY = "{{ env.SIGNOZ_API_KEY | default: '' }}" }

[mcp.servers.sentry]
transport = "http_streamable"
url = "https://mcp.example.com/mcp"

[mcp.servers.sentry.headers]
Authorization = "Sentry-Bearer {{ env.SENTRY_ACCESS_TOKEN | default: '' }}"
`;

function repoWithExample(): string {
  const repo = mkdtempSync(join(tmpdir(), 'keepup-repo-'));
  mkdirSync(dirname(join(repo, EXAMPLE_PATH)), { recursive: true });
  writeFileSync(join(repo, EXAMPLE_PATH), EXAMPLE);
  return repo;
}

const step = (extra: Partial<ListStep> = {}): ListStep => ({ repo: repoWithExample(), server: 'signoz', example: EXAMPLE_PATH, credentials: 'fake', env: { ...process.env }, ...extra });

test('a stdio server listed through a real pipe gives a full record', async () => {
  const record = await listTools(step({ override: { cmd: [process.execPath, FAKE_SERVER, 'signoz'] } }), connectMini) as ToolsRecord;
  assert.equal(record.ok, true);
  assert.deepEqual(record.toolNames, ['fake_signoz_details', 'fake_signoz_search']);
  assert.deepEqual(record.serverInfo, { name: 'fake-signoz', version: '0.0.0-fake' });
  assert.equal(record.client, 'dry-run stand-in client');
  assert.equal(record.tools.length, 2);
  assert.ok(record.elapsedMs >= 0);
  assert.equal(new Date(record.measuredAt).toISOString(), record.measuredAt);
});

test('a server that cannot start becomes a failure record, not a crash', async () => {
  const record = await listTools(step({ override: { cmd: ['/nonexistent/server'] } }), async () => { throw new Error('spawn failed'); }) as ToolsFailure;
  assert.equal(record.ok, false);
  assert.match(record.error, /spawn failed/);
});

test('the connection is closed whether or not listing worked', async () => {
  let closed = 0;
  const connect = async () => ({ client: 'c', serverInfo: null, listAllTools: async () => { throw new Error('nope'); }, close: async () => { closed += 1; } });
  const record = await listTools(step(), connect);
  assert.equal(record.ok, false);
  assert.equal(closed, 1);
});

test('the example decides how the server starts, and its templates are filled from the env', async () => {
  let seen: ServerSpec | null = null;
  const connect = async (spec: ServerSpec) => { seen = spec; return { client: 'c', serverInfo: null, listAllTools: async () => [{ name: 'a' }], close: async () => undefined }; };
  const record = await listTools(step({ env: { SIGNOZ_API_KEY: 'k' } }), connect) as ToolsRecord;
  assert.equal(record.startedAs, 'docker run -i -e SIGNOZ_API_KEY image:1');
  assert.deepEqual((seen as unknown as { env: object }).env, { SIGNOZ_API_KEY: 'k' });
});

test('the record never carries an env value or a header', async () => {
  const secret = 'sntrys_secret_value_for_test';
  const connect = async () => ({ client: 'c', serverInfo: null, listAllTools: async () => [{ name: 'a' }], close: async () => undefined });
  const record = await listTools(step({ server: 'sentry', env: { SENTRY_ACCESS_TOKEN: secret } }), connect) as ToolsRecord;
  assert.equal(record.startedAs, 'https://mcp.example.com/mcp');
  assert.ok(!JSON.stringify(record).includes(secret));
});

test('startedAs prints the command for stdio and the URL for http', () => {
  assert.equal(startedAs({ name: 'x', transport: 'stdio', cmd: ['npx'], args: ['-y', 'p@1'], env: {} }), 'npx -y p@1');
  assert.equal(startedAs({ name: 'x', transport: 'http_streamable', url: 'https://u/mcp', headers: { Authorization: 'secret' } }), 'https://u/mcp');
});

test('stderrTail keeps only the end of what a server said', async () => {
  const stream = new PassThrough();
  const tail = stderrTail(stream, 5);
  stream.write('abcdefgh');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tail(), 'defgh');
  assert.equal(stderrTail(null)(), '');
});
