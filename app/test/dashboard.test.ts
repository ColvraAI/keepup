import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkRequest, parseSlug } from '../src/dashboard/guard.ts';
import { resolveStatic } from '../src/dashboard/static.ts';
import { startDashboard, type DashboardServer } from '../src/dashboard/server.ts';
import { cloneByteCap, runBounded } from '../src/dashboard/live-scan.ts';

describe('parseSlug', () => {
  const good = ['Mintplex-Labs/anything-llm', 'mezmo/aura', 'a/b', 'stackblitz/bolt.new', 'owner/name_with-mix.2'];
  for (const slug of good) it(`accepts ${slug}`, () => assert.equal(parseSlug(slug), slug));

  const bad = [
    '', 'owner', 'owner/', '/name', 'a/b/c', '../etc', 'owner/..', 'owner/.', 'owner/.git', 'owner/name.git',
    '-owner/name', 'owner/-name', 'own er/name', 'owner/na me', 'owner/name;rm -rf', 'owner/$(whoami)', 'owner/`id`',
    'owner/name\n', 'https://github.com/owner/name', 'git@github.com:owner/name', 'owner/--upload-pack=x',
    'owner-/name', 'ow--ner/name', `${'a'.repeat(40)}/name`, `owner/${'a'.repeat(101)}`,
  ];
  for (const slug of bad) it(`refuses ${JSON.stringify(slug)}`, () => assert.equal(parseSlug(slug), null));

  for (const value of [null, undefined, 7, {}, ['a/b']]) {
    it(`refuses non-strings: ${JSON.stringify(value)}`, () => assert.equal(parseSlug(value), null));
  }
});

describe('checkRequest', () => {
  const PORT = 4317;
  const allowed = (host?: string, origin?: string) => checkRequest({ host, origin }, PORT).ok;

  it('accepts its own host, with or without an origin', () => {
    assert.equal(allowed('127.0.0.1:4317'), true);
    assert.equal(allowed('localhost:4317'), true);
    assert.equal(allowed('127.0.0.1:4317', 'http://127.0.0.1:4317'), true);
    assert.equal(allowed('localhost:4317', 'http://localhost:4317'), true);
  });

  it('refuses a missing or foreign host: DNS rebinding arrives with the attacker\'s name', () => {
    assert.equal(allowed(undefined), false);
    assert.equal(allowed('evil.example:4317'), false);
    assert.equal(allowed('127.0.0.1:9999'), false);
    assert.equal(allowed('127.0.0.1'), false);
    assert.equal(allowed('127.0.0.1:4317.evil.example'), false);
  });

  it('refuses a foreign origin: a website cannot drive this server', () => {
    assert.equal(allowed('127.0.0.1:4317', 'https://evil.example'), false);
    assert.equal(allowed('127.0.0.1:4317', 'http://127.0.0.1:9999'), false);
    assert.equal(allowed('127.0.0.1:4317', 'http://127.0.0.1:4317.evil.example'), false);
    assert.equal(allowed('127.0.0.1:4317', 'https://127.0.0.1:4317'), false);
    assert.equal(allowed('127.0.0.1:4317', 'null'), false);
  });
});

describe('resolveStatic', () => {
  let root: string;
  let outside: string;

  before(() => {
    const base = mkdtempSync(join(tmpdir(), 'keepup-static-'));
    root = join(base, 'out');
    outside = join(base, 'secret.txt');
    mkdirSync(join(root, '_next'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html>');
    writeFileSync(join(root, '404.html'), 'missing');
    writeFileSync(join(root, '_next', 'a.js'), 'js');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'link.txt'));
  });

  after(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('serves index for the root and files by path', () => {
    assert.equal(resolveStatic(root, '/'), join(root, 'index.html'));
    assert.equal(resolveStatic(root, '/_next/a.js'), join(root, '_next', 'a.js'));
    assert.equal(resolveStatic(root, '/404'), join(root, '404.html'));
  });

  const escapes = [
    '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/_next/../../secret.txt', '/..\\secret.txt',
    '/%2e%2e%5csecret.txt', '/index.html%00.js', '/%', '/%E0%A4%A', '//etc/passwd',
  ];
  for (const path of escapes) it(`refuses ${path}`, () => assert.equal(resolveStatic(root, path), null));

  it('refuses a symlink that leaves the root', () => assert.equal(resolveStatic(root, '/link.txt'), null));
  it('refuses a dotfile path', () => assert.equal(resolveStatic(root, '/.env'), null));
  it('misses cleanly', () => assert.equal(resolveStatic(root, '/nope.js'), null));
});

describe('the server', () => {
  let server: DashboardServer;
  let root: string;
  let base: string;
  let scans: string[];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'keepup-serve-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>keepup</title>');
    writeFileSync(join(root, '404.html'), 'missing');
    scans = [];
    server = await startDashboard({
      root,
      port: 0,
      judgeAvailable: () => false,
      scan: async (slug, emit) => {
        scans.push(slug);
        emit({ type: 'step', name: 'Fake', detail: 'one step', ms: 1 });
        emit({ type: 'done' });
      },
      judge: async (_slug, emit) => emit({ type: 'done' }),
    });
    const { port } = server.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('listens on loopback only', () => {
    assert.equal((server.server.address() as AddressInfo).address, '127.0.0.1');
  });

  it('answers health, with no key or path in it', async () => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, { ok: true, service: 'keepup-dashboard', judge: false });
  });

  it('serves the export with a strict policy', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('gives a 404 for traversal through raw paths', async () => {
    for (const path of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    }
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('streams a scan for a valid slug', async () => {
    const response = await post({ repo: 'mezmo/aura' });
    assert.equal(response.status, 200);
    const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(lines.map((line) => line.type), ['step', 'done']);
    assert.ok(scans.includes('mezmo/aura'));
  });

  it('refuses a bad slug before anything runs', async () => {
    const before = scans.length;
    assert.equal((await post({ repo: '../etc' })).status, 400);
    assert.equal((await post({ repo: 'a/b;rm' })).status, 400);
    assert.equal((await post('{not json')).status, 400);
    assert.equal(scans.length, before);
  });

  it('refuses a foreign origin', async () => {
    const before = scans.length;
    assert.equal((await post({ repo: 'mezmo/aura' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(scans.length, before);
  });

  it('refuses a form post, which needs no preflight', async () => {
    const response = await post({ repo: 'mezmo/aura' }, { 'content-type': 'text/plain' });
    assert.equal(response.status, 415);
  });

  it('refuses a body over its limit', async () => {
    const response = await post({ repo: 'a/b', padding: 'x'.repeat(20_000) });
    assert.equal(response.status, 413);
  });

  it('refuses the judge when no key is configured', async () => {
    const response = await fetch(`${base}/api/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'mezmo/aura' }),
    });
    assert.equal(response.status, 409);
  });

  it('allows only POST on the scan route', async () => {
    assert.equal((await fetch(`${base}/api/scan`)).status, 405);
  });
});

describe('the live scan\'s limits', () => {
  it('a repo whose size GitHub did not report gets a much lower byte cap', () => {
    assert.ok(cloneByteCap(null) < cloneByteCap(100_000));
    assert.ok(cloneByteCap(null) <= 200_000_000);
  });

  it('stopping kills the whole process group, not just the command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-group-'));
    const pidFile = join(dir, 'pid');
    const abort = new AbortController();
    const run = runBounded('sh', ['-c', `sleep 60 & echo $! > "${pidFile}"; wait`], { limitMs: 30_000, signal: abort.signal });
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) await new Promise((done) => setTimeout(done, 20));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.doesNotThrow(() => process.kill(pid, 0), 'the grandchild is running');
    abort.abort();
    await assert.rejects(run, /Stopped/);
    await new Promise((done) => setTimeout(done, 100));
    assert.throws(() => process.kill(pid, 0), 'the grandchild is gone too');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('/api/health', () => {
  it('says how long a clone is kept, so the page never types it', async () => {
    const server = await startDashboard({ root: tmpdir(), port: 0, scan: async () => undefined, judge: async () => undefined, judgeAvailable: () => false, keepMinutes: 20 });
    const body = await (await fetch(`http://127.0.0.1:${server.port}/api/health`)).json() as { keep_minutes?: number };
    assert.equal(body.keep_minutes, 20);
    await server.close();
  });
});
