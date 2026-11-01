// The promise is "no network calls", so it's tested at the socket under the real command line, not by stubbing fetch.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { type FixtureRepo, fixtureRepo, ROOT } from './helpers.ts';

const PRELOAD = pathToFileURL(join(ROOT, 'test', 'fixtures', 'no-network.mjs')).href;

describe('the offline commands, with sockets blocked', () => {
  let repo: FixtureRepo;
  let dir: string;
  let canary: string;
  before(() => {
    repo = fixtureRepo('manifests/js', { 'chat.js': 'const r = await client.chat.completions.create({ model: "gpt-4.1" });\n' });
    dir = mkdtempSync(join(tmpdir(), 'keepup-offline-'));
    canary = join(dir, 'canary');
    writeFileSync(join(dir, 'findings.json'), JSON.stringify({ findings: [] }));
  });
  after(() => {
    repo.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', PRELOAD, join(ROOT, 'bin', 'keepup.ts'), ...args], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: '', KEEPUP_NETWORK_CANARY: canary } });

  it('the block really blocks: a script that fetches trips it', () => {
    const tripped = join(dir, 'tripped');
    const script = join(dir, 'fetches.mjs');
    writeFileSync(script, "try { await fetch('https://example.com'); } catch { /* the block threw */ }\n");
    spawnSync(process.execPath, ['--import', PRELOAD, script], { env: { ...process.env, KEEPUP_NETWORK_CANARY: tripped } });
    assert.ok(existsSync(tripped));
  });

  for (const args of [['scan'], ['facts'], ['check'], ['run', '--no-judge']] as const) {
    it(args.join(' '), () => {
      const [command, ...flags] = args;
      const out = run(command, repo.path, ...flags, ...(command === 'run' ? ['--out', join(dir, 'run.json')] : []));
      assert.equal(out.status, 0, out.stderr);
      assert.ok(!existsSync(canary), 'it touched the network');
    });
  }

  it('search', () => {
    assert.equal(run('search', '{"any":["rerank"],"limit":1}').status, 0);
    assert.ok(!existsSync(canary));
  });

  it('show', () => {
    assert.equal(run('show', repo.path, 'chat.js', '1').status, 0);
    assert.ok(!existsSync(canary));
  });

  it('verify', () => {
    assert.equal(run('verify', repo.path, join(dir, 'findings.json')).status, 0);
    assert.ok(!existsSync(canary));
  });

  it('run --replay', { skip: !existsSync(join(ROOT, 'tmp', 'full', 'farfalle')) && 'no clone' }, () => {
    const out = run('run', join(ROOT, 'tmp', 'full', 'farfalle'), '--commit', 'HEAD', '--replay', '--out', join(dir, 'replay.json'));
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!existsSync(canary));
  });
});
