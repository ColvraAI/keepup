// install.sh --codex, with HOME under a temp dir and a fake codex and node on PATH, so the real ~/.codex and ~/.agents are never touched.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtureRepo, ROOT } from './helpers.ts';

const SCRIPT = join(ROOT, 'install.sh');
const dirs: string[] = [];

interface World { bin: string; home: string; dir: string }

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function world(options: { codex?: boolean } = {}): World {
  // realpath, because macOS puts tmp behind a link and the paths the script writes should match what the test reads.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'keepup-codex-')));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  executable(join(bin, 'node'), 'echo v22.18.0');
  if (options.codex !== false) executable(join(bin, 'codex'), 'exit 0');
  return { bin, home, dir };
}

function run(w: World, args: string[], env: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, KEEPUP_SOURCE: ROOT, ...env },
  });
}

const paths = (w: World) => {
  const keepup = join(w.home, '.keepup');
  return {
    repo: join(keepup, 'repo'),
    data: join(keepup, 'data'),
    shim: join(keepup, 'repo', 'plugin', 'bin', 'keepup'),
    skill: join(w.home, '.agents', 'skills', 'keepup', 'SKILL.md'),
    apply: join(w.home, '.agents', 'skills', 'keepup-apply', 'SKILL.md'),
    config: join(w.home, '.codex', 'config.toml'),
    hooks: join(w.home, '.codex', 'hooks.json'),
  };
};

/** Undoes the install's edits, so what's left must be the source exactly. */
function reverse(text: string, w: World, allowedTools: string | undefined): string {
  const p = paths(w);
  const back = text
    .split(`${p.shim} `).join('keepup ')
    .split(p.data).join('${CLAUDE_PLUGIN_DATA}')
    .split('$keepup-apply').join('/keepup:apply')
    .split('$keepup').join('/keepup')
    .replace(/^name: keepup-apply$/m, 'name: apply')
    .replace(/<!-- made by keepup install\.sh --codex -->\n$/, '');
  if (allowedTools === undefined) return back;
  const lines = back.split('\n');
  const at = lines.findIndex((line) => line.startsWith('description:')) + 1;
  return [...lines.slice(0, at), allowedTools, ...lines.slice(at)].join('\n');
}

const installed = (w: World) => {
  const result = run(w, ['--codex', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  return result;
};

describe('install.sh --codex', () => {
  after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

  it('writes the two skills with no Claude names left, and each reverses to its source', () => {
    const w = world();
    installed(w);
    const p = paths(w);
    const source = readFileSync(join(ROOT, 'skills/keepup/SKILL.md'), 'utf8');
    const allowedTools = source.split('\n').find((line) => line.startsWith('allowed-tools:'));
    for (const [file, name, src, tools] of [[p.skill, 'keepup', source, allowedTools], [p.apply, 'keepup-apply', readFileSync(join(ROOT, 'skills/apply/SKILL.md'), 'utf8'), undefined]] as const) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /\$\{CLAUDE_/, file);
      assert.doesNotMatch(text, /allowed-tools/, file);
      assert.doesNotMatch(text.split(paths(w).shim).join('').split(w.dir).join(''), /\/keepup/, file);
      assert.match(text, new RegExp(`^name: ${name}$`, 'm'));
      assert.equal(reverse(text, w, tools), src, `${file} is its source plus the four edits and nothing else`);
    }
    assert.match(readFileSync(p.skill, 'utf8'), /\$keepup-apply/);
    assert.ok(readFileSync(p.skill, 'utf8').includes(`${p.shim} prepare . --dir "${p.data}"`));
  });

  it('links the checkout, makes the data folder a writable root and adds the weekly hook', () => {
    const w = world();
    const { stdout } = installed(w);
    const p = paths(w);
    assert.ok(lstatSync(p.repo).isSymbolicLink());
    assert.ok(existsSync(p.shim));
    assert.ok(existsSync(p.data));
    assert.match(readFileSync(p.config, 'utf8'), new RegExp(`\\[sandbox_workspace_write\\]\\nwritable_roots = \\["${p.data}"\\]`));
    const hooks = JSON.parse(readFileSync(p.hooks, 'utf8'));
    const hook = hooks.hooks.SessionStart[0].hooks[0];
    assert.equal(hook.command, `${p.shim} check . --weekly-state ${p.data}/weekly-check.json --hook`);
    assert.equal(hook.timeout, 5);
    assert.equal(hooks.hooks.SessionStart[0].matcher, undefined);
    for (const text of ['$keepup', '$keepup-apply', '/hooks', '--codex --uninstall']) assert.ok(stdout.includes(text), text);
  });

  it('leaves a config.toml with its own sandbox table and an existing hooks.json as they were, and prints what to add', () => {
    const w = world();
    const p = paths(w);
    mkdirSync(dirname(p.config), { recursive: true });
    const config = 'model = "x"\n[sandbox_workspace_write]\nnetwork_access = false\n';
    const hooks = '{"hooks":{}}\n';
    writeFileSync(p.config, config);
    writeFileSync(p.hooks, hooks);
    const { stdout } = installed(w);
    assert.equal(readFileSync(p.config, 'utf8'), config);
    assert.equal(readFileSync(p.hooks, 'utf8'), hooks);
    assert.ok(stdout.includes(`writable_roots = ["${p.data}"]`));
    assert.ok(stdout.includes(`${p.shim} check . --weekly-state`));
  });

  it('appends the table to a config.toml that has none, keeping what was there', () => {
    const w = world();
    const p = paths(w);
    mkdirSync(dirname(p.config), { recursive: true });
    writeFileSync(p.config, 'model = "x"');
    installed(w);
    assert.match(readFileSync(p.config, 'utf8'), /^model = "x"\n\n\[sandbox_workspace_write\]\nwritable_roots = /);
  });

  it('runs again safely', () => {
    const w = world();
    installed(w);
    const config = readFileSync(paths(w).config, 'utf8');
    installed(w);
    assert.equal(readFileSync(paths(w).config, 'utf8'), config);
  });

  it('with no codex, or a no, changes nothing', () => {
    const noCodex = world({ codex: false });
    const result = run(noCodex, ['--codex', '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codex/i);
    assert.ok(!existsSync(join(noCodex.home, '.keepup')));
    const w = world();
    const tty = join(w.dir, 'tty');
    writeFileSync(tty, 'n\n');
    const no = run(w, ['--codex'], { KEEPUP_TTY: tty });
    assert.equal(no.status, 0);
    assert.match(no.stdout, /nothing was changed/);
    for (const path of [join(w.home, '.keepup'), join(w.home, '.agents'), join(w.home, '.codex')]) assert.ok(!existsSync(path), path);
  });

  it('refuses a HOME it would have to quote, before writing anything', () => {
    const w = world();
    const odd = join(w.dir, 'my home');
    mkdirSync(odd);
    const result = run(w, ['--codex', '--yes'], { HOME: odd });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(join(odd, '.keepup')));
  });

  it('--uninstall takes back what it wrote and leaves the data and the files the person had', () => {
    const w = world();
    installed(w);
    const p = paths(w);
    writeFileSync(join(p.data, 'kept.json'), '{}');
    const result = run(w, ['--codex', '--uninstall', '--yes']);
    assert.equal(result.status, 0, result.stderr);
    for (const path of [p.repo, dirname(p.skill), dirname(p.apply), p.hooks]) assert.ok(!existsSync(path), path);
    assert.doesNotMatch(existsSync(p.config) ? readFileSync(p.config, 'utf8') : '', /writable_roots/);
    assert.ok(existsSync(join(p.data, 'kept.json')));
    assert.ok(result.stdout.includes(p.data));
  });

  it('--uninstall leaves a config.toml and hooks.json it did not write, and prints what to take out', () => {
    const w = world();
    const p = paths(w);
    mkdirSync(dirname(p.config), { recursive: true });
    const config = '[sandbox_workspace_write]\nnetwork_access = false\n';
    writeFileSync(p.config, config);
    writeFileSync(p.hooks, '{"hooks":{}}\n');
    installed(w);
    const result = run(w, ['--codex', '--uninstall', '--yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(p.config, 'utf8'), config);
    assert.equal(readFileSync(p.hooks, 'utf8'), '{"hooks":{}}\n');
    assert.ok(result.stdout.includes('weekly-check.json --hook'));
  });

  it('--uninstall keeps the table header when the person added a key under it after a blank line', () => {
    const w = world();
    const p = paths(w);
    mkdirSync(dirname(p.config), { recursive: true });
    writeFileSync(p.config, 'model = "x"');
    installed(w);
    writeFileSync(p.config, `${readFileSync(p.config, 'utf8')}\n# mine\nnetwork_access = true\n`);
    const result = run(w, ['--codex', '--uninstall', '--yes']);
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(p.config, 'utf8');
    assert.doesNotMatch(config, /writable_roots/);
    assert.match(config, /^\[sandbox_workspace_write\]\n(?:\n|#.*\n)*network_access = true$/m);
  });

  it('leaves a keepup skill the person already had, on install and on uninstall', () => {
    const w = world();
    const p = paths(w);
    const own = 'name: keepup\ndescription: my own skill\n';
    mkdirSync(join(dirname(p.skill), 'scripts'), { recursive: true });
    writeFileSync(p.skill, own);
    writeFileSync(join(dirname(p.skill), 'scripts', 'x.sh'), 'echo mine\n');
    const { stdout } = installed(w);
    assert.equal(readFileSync(p.skill, 'utf8'), own);
    assert.ok(stdout.includes(p.skill), 'says which skill it left alone');
    assert.ok(existsSync(p.apply));
    const result = run(w, ['--codex', '--uninstall', '--yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(p.skill, 'utf8'), own);
    assert.ok(existsSync(join(dirname(p.skill), 'scripts', 'x.sh')));
    assert.ok(!existsSync(dirname(p.apply)));
  });

  it('names an uninstall command that exists after a curl install', () => {
    const w = world();
    const { stdout } = installed(w);
    assert.ok(stdout.includes(`${paths(w).repo}/install.sh --codex --uninstall`));
    assert.ok(!stdout.includes('./install.sh --codex --uninstall'));
  });

  it('adds the table to a config.toml that only mentions it in a comment', () => {
    const w = world();
    const p = paths(w);
    mkdirSync(dirname(p.config), { recursive: true });
    writeFileSync(p.config, '# the sandbox_workspace_write table is below\nmodel = "x"\n');
    installed(w);
    assert.match(readFileSync(p.config, 'utf8'), new RegExp(`\\[sandbox_workspace_write\\]\\nwritable_roots = \\["${p.data}"\\]`));
  });

  it('--uninstall alone is refused, so the Claude path never changes', () => {
    const result = run(world(), ['--uninstall', '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /claude plugin uninstall/);
  });
});

describe('the engine from the path the Codex skills name', () => {
  let w: World;
  let p: ReturnType<typeof paths>;
  let repo: ReturnType<typeof fixtureRepo>;
  before(() => {
    w = world();
    installed(w);
    p = paths(w);
    repo = fixtureRepo('quiet', { 'answer.ts': readFileSync(join(ROOT, 'examples/support-bot/src/answer.ts'), 'utf8') });
  });
  after(() => { repo.cleanup(); rmSync(w.dir, { recursive: true, force: true }); });
  // No CLAUDE_PLUGIN_DATA and no CLAUDE_PROJECT_DIR, as in a Codex session: the project is the cwd and the data folder is under ~/.keepup.
  const engine = (...args: string[]) => {
    const env: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.home };
    return spawnSync(p.shim, args, { cwd: repo.path, encoding: 'utf8', env });
  };

  it('prepares into the data folder, and refuses another folder and run', () => {
    const ok = engine('prepare', '.', '--dir', p.data);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(readdirSync(p.data, { recursive: true }).some((file) => String(file).endsWith('bundles.json')), 'bundles.json is under the data folder');
    const elsewhere = engine('prepare', '.', '--dir', join(w.dir, 'elsewhere'));
    assert.notEqual(elsewhere.status, 0);
    assert.match(elsewhere.stderr, /data folder/);
    const spend = engine('run', '.');
    assert.notEqual(spend.status, 0);
    assert.match(spend.stderr, /Nothing ran/);
  });

  it('runs the weekly hook exactly as hooks.json names it, and exits 0', () => {
    const hook = JSON.parse(readFileSync(p.hooks, 'utf8')).hooks.SessionStart[0].hooks[0].command as string;
    const [, ...args] = hook.split(' ');
    assert.equal(engine(...args).status, 0);
  });
});
