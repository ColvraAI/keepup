// install.sh, with a fake claude and a fake node on PATH under a temp dir, so nothing real is installed.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ROOT } from './helpers.ts';

const SCRIPT = join(ROOT, 'install.sh');
const dirs: string[] = [];

interface World { bin: string; log: string; dir: string }

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function world(options: { nodeVersion?: string | null; claude?: boolean } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-install-'));
  dirs.push(dir);
  const log = join(dir, 'claude.log');
  const { nodeVersion = 'v22.18.0', claude = true } = options;
  if (nodeVersion) executable(join(dir, 'node'), `echo ${nodeVersion}`);
  if (claude) executable(join(dir, 'claude'), `echo "$*" >> "${log}"`);
  return { bin: dir, log, dir };
}

/** Only the fake dir and what the script's own shell needs. */
function run(w: World, args: string[] = [], env: Record<string, string> = {}, input?: string) {
  for (const tool of ['bash', 'sh']) {
    const link = join(w.bin, tool);
    if (!existsSync(link)) symlinkSync(`/bin/${tool}`, link);
  }
  return spawnSync(join(w.bin, 'bash'), input === undefined ? [SCRIPT, ...args] : ['-s', '--', ...args], {
    encoding: 'utf8',
    input,
    env: { PATH: w.bin, ...env },
  });
}

const calls = (w: World) => (existsSync(w.log) ? readFileSync(w.log, 'utf8').trim().split('\n') : []);

describe('install.sh', () => {
  after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

  it('runs the two commands in order with --yes, and says what to do next', () => {
    const w = world();
    const result = run(w, ['--yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(w), ['plugin marketplace add ColvraAI/keepup', 'plugin install keepup@keepup']);
    assert.match(result.stdout, /cd your-repo/);
    assert.match(result.stdout, /\/keepup:keepup/);
  });

  it('prints the commands, what they change and how to undo it, before it asks', () => {
    const w = world();
    const { stdout } = run(w, ['--yes']);
    for (const text of ['claude plugin marketplace add ColvraAI/keepup', 'claude plugin install keepup@keepup', "Claude Code's settings", 'claude plugin uninstall keepup@keepup', 'claude plugin marketplace remove keepup']) {
      assert.ok(stdout.includes(text), text);
    }
  });

  it('refuses with no yes and no terminal, and runs nothing', () => {
    const w = world();
    const result = run(w, [], { KEEPUP_TTY: join(w.dir, 'no-such-terminal') });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--yes/);
    assert.deepEqual(calls(w), []);
  });

  it('runs nothing when the answer is no or empty', () => {
    for (const answer of ['n\n', '\n', 'maybe\n']) {
      const w = world();
      const tty = join(w.dir, 'tty');
      writeFileSync(tty, answer);
      const result = run(w, [], { KEEPUP_TTY: tty });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /nothing was changed/);
      assert.deepEqual(calls(w), []);
    }
  });

  it('runs them when the answer is y, reading the terminal even when the script itself is stdin', () => {
    const w = world();
    const tty = join(w.dir, 'tty');
    writeFileSync(tty, 'y\n');
    const result = run(w, [], { KEEPUP_TTY: tty }, readFileSync(SCRIPT, 'utf8'));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(w), ['plugin marketplace add ColvraAI/keepup', 'plugin install keepup@keepup']);
  });

  it('KEEPUP_SOURCE replaces the source', () => {
    const w = world();
    assert.equal(run(w, ['--yes'], { KEEPUP_SOURCE: '/some/checkout' }).status, 0);
    assert.equal(calls(w)[0], 'plugin marketplace add /some/checkout');
  });

  it('an old node gets a clear message and the fix, and nothing runs', () => {
    for (const version of ['v20.11.1', 'v22.17.9', 'v8.0.0']) {
      const w = world({ nodeVersion: version });
      const result = run(w, ['--yes']);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(version), result.stderr);
      assert.match(result.stderr, /22\.18 or later/);
      assert.match(result.stderr, /nvm install 22|nodejs\.org/);
      assert.deepEqual(calls(w), []);
    }
  });

  it('takes the versions that are new enough', () => {
    for (const version of ['v22.18.0', 'v22.100.0', 'v23.0.0', 'v100.1.1']) {
      assert.equal(run(world({ nodeVersion: version }), ['--yes']).status, 0, version);
    }
  });

  it('no node and no claude each say what to install', () => {
    const noNode = run(world({ nodeVersion: null }), ['--yes']);
    assert.notEqual(noNode.status, 0);
    assert.match(noNode.stderr, /Node isn't on your PATH/);
    const noClaude = run(world({ claude: false }), ['--yes']);
    assert.notEqual(noClaude.status, 0);
    assert.match(noClaude.stderr, /npm install -g @anthropic-ai\/claude-code/);
  });

  it('stops at a failing command rather than going on to the next', () => {
    const w = world();
    executable(join(w.bin, 'claude'), `echo "$*" >> "${w.log}"; exit 3`);
    const result = run(w, ['--yes']);
    assert.notEqual(result.status, 0);
    assert.equal(calls(w).length, 1);
    assert.ok(!/Done\./.test(result.stdout));
  });

  it('a second run is the same two commands, so it is safe to run again', () => {
    const w = world();
    run(w, ['--yes']);
    assert.equal(run(w, ['--yes']).status, 0);
    assert.equal(calls(w).length, 4);
  });

  it('refuses an unknown option', () => {
    const w = world();
    const result = run(w, ['--force']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown option/);
    assert.deepEqual(calls(w), []);
  });
});
