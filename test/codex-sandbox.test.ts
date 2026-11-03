// keepup prepare inside Codex's own sandbox, as a $keepup session runs it, with the data folder as the one writable root.
// `codex sandbox` starts no model session and costs nothing, but it needs Codex CLI on this machine, so it runs only with KEEPUP_CODEX=1.
// HOME is a temp folder, so the person's ~/.codex and ~/.agents are never read or written.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtureRepo, ROOT } from './helpers.ts';

const skip = process.env.KEEPUP_CODEX === '1' ? false : 'needs Codex CLI: set KEEPUP_CODEX=1 to run it';

describe('keepup prepare under codex sandbox', { skip }, () => {
  let dir: string;
  let home: string;
  let data: string;
  let shim: string;
  let repo: ReturnType<typeof fixtureRepo>;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'keepup-codex-sandbox-')));
    home = join(dir, 'home');
    mkdirSync(home);
    const install = spawnSync('/bin/bash', [join(ROOT, 'install.sh'), '--codex', '--yes'], { encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), KEEPUP_SOURCE: ROOT } });
    assert.equal(install.status, 0, install.stderr);
    data = join(home, '.keepup', 'data');
    shim = join(home, '.keepup', 'repo', 'plugin', 'bin', 'keepup');
    repo = fixtureRepo('quiet', { 'answer.ts': readFileSync(join(ROOT, 'examples/support-bot/src/answer.ts'), 'utf8') });
  });

  after(() => {
    repo.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const sandboxed = (...args: string[]) => spawnSync('codex', ['sandbox', '-c', `sandbox_workspace_write.writable_roots=["${data}"]`, '--', shim, ...args], {
    cwd: repo.path,
    encoding: 'utf8',
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: home, CODEX_HOME: join(home, '.codex') },
  });

  it('writes inside the data folder with no prompt', () => {
    const result = sandboxed('prepare', '.', '--dir', data);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readdirSync(data, { recursive: true }).some((file) => String(file).endsWith('bundles.json')));
  });

  it('fails to write outside it', () => {
    assert.notEqual(sandboxed('prepare', '.', '--dir', join(dir, 'elsewhere')).status, 0);
  });
});
