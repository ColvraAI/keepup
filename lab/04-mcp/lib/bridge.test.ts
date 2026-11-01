import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDockerBridge } from './bridge.ts';

const SHIM = join(import.meta.dirname, '..', 'harness', 'docker-shim.cjs');
const DOCKER_ON_PATH = join(import.meta.dirname, '..', 'harness', 'bin', 'docker');
const ARGV = ['run', '-i', '--rm', '-e', 'SIGNOZ_URL', '-e', 'SIGNOZ_API_KEY', 'image:1'];
const TOKEN = 'bridge-token-for-tests';

/** Stands in for the docker CLI: reports its argv and env, then echoes stdin in upper case until EOF. */
function fakeDocker(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'keepup-fake-docker-')), 'fake-docker.cjs');
  writeFileSync(file, `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), url: process.env.SIGNOZ_URL, key: process.env.SIGNOZ_API_KEY, other: process.env.NOT_PASSED ?? null }) + '\\n');
process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()));
process.stdin.on('end', () => process.exit(0));
`);
  return file;
}

function runShim(port: number, input: string, env: Record<string, string> = {}, argv: readonly string[] = ARGV, token = TOKEN): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, ...argv], {
      env: { PATH: process.env.PATH, BRIDGE_ADDR: `127.0.0.1:${port}`, BRIDGE_TOKEN: token, SIGNOZ_URL: 'http://signoz.test', SIGNOZ_API_KEY: 'key-value', NOT_PASSED: 'should stay out', ...env },
    });
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', (d) => { out.stdout += String(d); });
    child.stderr.on('data', (d) => { out.stderr += String(d); });
    child.on('close', (code) => resolve({ code, ...out }));
    // A refused shim can exit before this write, which gives EPIPE on a loaded machine. Its exit code and stderr are what the tests read.
    child.stdin.on('error', () => undefined);
    setTimeout(() => child.stdin.end(input), 300);
  });
}

test('the shim runs the allowed command through the bridge, with stdio and -e values intact', async () => {
  const bridge = await startDockerBridge({ allowed: [ARGV], command: [process.execPath, fakeDocker()], token: TOKEN });
  try {
    const { code, stdout } = await runShim(bridge.port, 'hello\n');
    assert.equal(code, 0);
    const [first, ...rest] = stdout.split('\n');
    const report = JSON.parse(first);
    assert.deepEqual(report.argv, ARGV);
    assert.equal(report.url, 'http://signoz.test');
    assert.equal(report.key, 'key-value');
    assert.equal(report.other, null, 'only the -e names cross the bridge');
    assert.equal(rest[0], 'HELLO');
  } finally {
    await bridge.close();
  }
});

test('a command the example did not ask for is refused and never started', async () => {
  const started: string[][] = [];
  const bridge = await startDockerBridge({ allowed: [ARGV], command: [process.execPath, fakeDocker()], token: TOKEN, onSpawn: (argv) => started.push([...argv]) });
  try {
    const { code, stdout, stderr } = await runShim(bridge.port, '', {}, ['run', '-v', '/:/host', 'image:1']);
    assert.notEqual(code, 0);
    assert.equal(stdout, '');
    assert.match(stderr, /not the command the example runs/);
    assert.deepEqual(started, []);
  } finally {
    await bridge.close();
  }
});

test('a wrong token is refused and never started', async () => {
  const started: string[][] = [];
  const bridge = await startDockerBridge({ allowed: [ARGV], command: [process.execPath, fakeDocker()], token: TOKEN, onSpawn: (argv) => started.push([...argv]) });
  try {
    const { code, stderr } = await runShim(bridge.port, '', {}, ARGV, 'wrong-token');
    assert.notEqual(code, 0);
    assert.match(stderr, /refused/);
    assert.deepEqual(started, []);
  } finally {
    await bridge.close();
  }
});

test('garbage on the socket is refused rather than crashing the bridge', async () => {
  const bridge = await startDockerBridge({ allowed: [ARGV], command: [process.execPath, fakeDocker()], token: TOKEN });
  try {
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(bridge.port, '127.0.0.1');
      let text = '';
      socket.on('data', (d) => { text += String(d); });
      socket.on('close', () => resolve(text));
      socket.write('this is not json\n');
    });
    assert.match(reply, /refused/);
    const { code } = await runShim(bridge.port, 'x\n');
    assert.equal(code, 0, 'the bridge still works afterwards');
  } finally {
    await bridge.close();
  }
});

test('a server keeps running for as long as its client is connected, and stops soon after it leaves', async () => {
  const stopped: number[] = [];
  const graceMs = 80;
  const bridge = await startDockerBridge({ allowed: [ARGV], command: [process.execPath, fakeDocker()], token: TOKEN, graceMs });
  try {
    const socket = connect(bridge.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    let seen = '';
    socket.on('data', (d) => { seen += String(d); });
    socket.write(`${JSON.stringify({ token: TOKEN, argv: ARGV, env: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, graceMs * 5));
    socket.write('still here\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.match(seen, /STILL HERE/, 'a long wait between requests must not lose the server');
    const closed = new Promise((resolve) => socket.once('close', () => { stopped.push(Date.now()); resolve(null); }));
    socket.end();
    await closed;
    assert.equal(stopped.length, 1);
  } finally {
    await bridge.close();
  }
});

test('a server that ignores its stdin closing is still stopped after the client leaves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-stubborn-'));
  const stubborn = join(dir, 'stubborn.cjs');
  const marker = join(dir, 'stopped');
  writeFileSync(stubborn, `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); setInterval(() => undefined, 1000); process.stdin.resume(); process.stdout.write('up');`);
  const bridge = await startDockerBridge({ allowed: [ARGV], command: [process.execPath, stubborn], token: TOKEN, graceMs: 50 });
  try {
    const socket = connect(bridge.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    const up = new Promise<void>((resolve) => socket.on('data', (d) => { if (String(d).includes('up')) resolve(); }));
    socket.write(`${JSON.stringify({ token: TOKEN, argv: ARGV, env: {} })}\n`);
    await up;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(!existsSync(marker), 'not while the client is connected');
    socket.destroy();
    for (let tries = 0; tries < 100 && !existsSync(marker); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(marker), 'and the grace period ends it');
  } finally {
    await bridge.close();
  }
});

test('the shim fails loudly when no bridge is configured', () => {
  const run = spawnSync(process.execPath, [SHIM, ...ARGV], { env: { PATH: process.env.PATH }, encoding: 'utf8', input: '' });
  assert.equal(run.status, 125);
  assert.match(run.stderr, /BRIDGE_ADDR/);
});

test('the docker command the sandbox finds on PATH is executable and runs the shim', () => {
  assert.ok(statSync(DOCKER_ON_PATH).mode & 0o111, 'harness/bin/docker is executable');
  chmodSync(DOCKER_ON_PATH, statSync(DOCKER_ON_PATH).mode);
  const run = spawnSync(DOCKER_ON_PATH, ARGV, { env: { PATH: process.env.PATH }, encoding: 'utf8', input: '' });
  assert.equal(run.status, 125);
  assert.match(run.stderr, /BRIDGE_ADDR/);
});
