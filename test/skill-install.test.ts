// What the plugin needs to hold up on any repo: found by running it in a container on repos it had never seen (scripts/skill-session.sh).
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { renderRetired } from '../src/brief.ts';
import { onlyInTrailingComment } from '../src/exact-checks.ts';
import { dataDir } from '../src/session.ts';
import { recordingText } from '../scripts/record-skill-run.ts';
import { FIXTURES, fixtureRepo, ROOT } from './helpers.ts';

const SHIM = join(ROOT, 'plugin', 'bin', 'keepup');
const HELPER = join(ROOT, 'scripts', 'skill-session.sh');

function pluginRun(cwd: string, data: string, ...args: string[]) {
  return spawnSync(SHIM, args, { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: cwd } });
}

describe('two repos, one plugin data folder', () => {
  it('a session in one repo never reads what another repo prepared', () => {
    const one = fixtureRepo('quiet', { 'chat.py': 'client.chat.completions.create(model="gpt-4o-mini")\n' });
    const two = fixtureRepo('quiet', { 'other.py': 'print("no ai here")\n' });
    const data = mkdtempSync(join(tmpdir(), 'keepup-data-'));
    try {
      assert.equal(pluginRun(one.path, data, 'prepare', '.', '--dir', data).status, 0);
      assert.equal(pluginRun(two.path, data, 'prepare', '.', '--dir', data).status, 0);
      const seen = pluginRun(one.path, data, 'get', 'facts.ai_call_sites', '--dir', data);
      assert.equal(seen.status, 0, seen.stderr);
      assert.match(seen.stdout, /chat\.py/);
    } finally {
      one.cleanup();
      two.cleanup();
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('each repo keeps its own pull request text, so a yes waiting in one can\'t send another\'s words', () => {
    const one = fixtureRepo('quiet');
    const two = fixtureRepo('quiet');
    const data = mkdtempSync(join(tmpdir(), 'keepup-data-'));
    const finding = { rank: 1, title: 'Cache the policy', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'a.ts', line: 1, text: 'x' }], options: [], sources: [], lever: 'ADV-x', pr: null };
    const seed = (path: string, why: string) => {
      const own = dataDir(data, { KEEPUP_PLUGIN: '1', CLAUDE_PROJECT_DIR: path });
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, 'facts.json'), JSON.stringify({ repo: 'x/y', commit: 'abc1234' }));
      writeFileSync(join(own, 'verified.json'), JSON.stringify({ findings: [{ ...finding, why }] }));
    };
    const bodyFile = (stdout: string) => stdout.match(/^body: (.*)$/m)?.[1] ?? '';
    try {
      execFileSync('git', ['-C', one.path, 'remote', 'add', 'origin', 'git@github.com:acme/one.git']);
      execFileSync('git', ['-C', two.path, 'remote', 'add', 'origin', 'git@github.com:acme/two.git']);
      seed(one.path, 'The private words of repo one.');
      seed(two.path, 'The words of repo two.');
      const first = pluginRun(one.path, data, 'pr-body', '--finding', '1', '--dir', data, '--save');
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /^repo: acme\/one$/m);
      const before = readFileSync(bodyFile(first.stdout), 'utf8');
      assert.match(before, /private words of repo one/);
      const second = pluginRun(two.path, data, 'pr-body', '--finding', '1', '--dir', data, '--save');
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /^repo: acme\/two$/m);
      assert.notEqual(bodyFile(second.stdout), bodyFile(first.stdout));
      assert.match(readFileSync(bodyFile(second.stdout), 'utf8'), /words of repo two/);
      assert.equal(readFileSync(bodyFile(first.stdout), 'utf8'), before);
      assert.ok(!existsSync(join(data, 'pr-body.md')), 'nothing shared at the top of the data folder');
    } finally {
      one.cleanup();
      two.cleanup();
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('the weekly line', () => {
  it('reaches the person: an async hook\'s systemMessage only goes to Claude, so the hook is synchronous and quick', () => {
    const [{ hooks: [hook] }] = JSON.parse(readFileSync(join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8')).hooks.SessionStart;
    assert.notEqual(hook.async, true);
    assert.ok(hook.timeout <= 5, `a session start waits for this: ${hook.timeout}`);
    assert.match(readFileSync(join(ROOT, 'bin', 'keepup.ts'), 'utf8'), /HOOK_BUDGET_MS = 3_000/);
  });

  it('on an old Node it says so once, plainly, and never fails the session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-old-node-'));
    try {
      writeFileSync(join(dir, 'node'), '#!/bin/sh\necho v20.19.1\n');
      chmodSync(join(dir, 'node'), 0o755);
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
      const hook = () => spawnSync(SHIM, ['check', dir, '--weekly-state', join(dir, 'data', 'weekly.json'), '--hook'], { encoding: 'utf8', env });
      const first = hook();
      assert.equal(first.status, 0);
      assert.deepEqual(JSON.parse(first.stdout), { systemMessage: 'keepup needs Node 22.18 or later; this is v20.19.1. It stays quiet until you update.' });
      const second = hook();
      assert.equal(second.status, 0);
      assert.equal(second.stdout, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('where it can\'t run', () => {
  it('outside a git repo it says so in plain words, with no git error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-not a repo-'));
    try {
      const out = pluginRun(dir, dir, 'prepare', '.', '--dir', dir);
      assert.equal(out.status, 1);
      assert.equal(out.stderr, 'keepup: this folder isn\'t a git repo, and keepup reads only what git tracks. Run it from inside one.\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the hook never fails a session, even when it\'s refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-hook-'));
    try {
      const out = spawnSync(SHIM, ['check', '/nowhere', '--weekly-state', join(dir, 'w.json'), '--hook'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_PROJECT_DIR: dir } });
      assert.equal(out.status, 0);
      assert.equal(out.stdout, '');
      assert.equal(out.stderr, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Do line', () => {
  it('names the successor when the lever\'s own wording wouldn\'t fit a line', () => {
    const run = JSON.parse(readFileSync(join(FIXTURES, 'runs', 'full.json'), 'utf8'));
    const finding = {
      ...run.findings[0],
      why: 'gpt-3.5-turbo was shut down on 23 Oct 2026. Named successor: gpt-5.6-terra.',
      options: [{ name: 'gpt-3.5-turbo, gpt-4, gpt-4-turbo and o1 are shut down; move to GPT-5.6', what: 'Follow the page per id: gpt-3.5-turbo and o4-mini to gpt-5.6-terra.', needs: 'Nothing new.', source: run.findings[0].sources[0] }],
    };
    const text = renderRetired({ ...run, findings: [finding] });
    assert.match(text, /Do: move to gpt-5\.6-terra/);
    assert.ok(!/per id:\.\.\./.test(text));
  });
});

describe('the Do line, across several retired models', () => {
  it('follows a chain to the model that still exists, and never names one that was itself shut down', () => {
    const run = JSON.parse(readFileSync(join(FIXTURES, 'runs', 'full.json'), 'utf8'));
    const finding = {
      ...run.findings[0],
      why: 'text-davinci-003 was shut down on 4 Jan 2024. Named successor: gpt-3.5-turbo-instruct. gpt-3.5-turbo was shut down on 23 Oct 2026. Named successor: gpt-5.6-terra. gpt-3.5-turbo-instruct was itself shut down on 28 Sep 2026. OpenAI names gpt-5.6-terra after it.',
      options: [{ name: 'gpt-3.5-turbo, gpt-4, gpt-4-turbo and o1 are shut down; move to GPT-5.6', what: 'Follow the page per id: gpt-3.5-turbo and o4-mini to gpt-5.6-terra.', needs: 'Nothing new.', source: run.findings[0].sources[0] }],
    };
    const text = renderRetired({ ...run, findings: [finding] });
    assert.match(text, /Do: move to gpt-5\.6-terra\n/);
    assert.ok(!/Do: move to gpt-3\.5-turbo-instruct/.test(text));
  });
});

describe('a model id in a comment at the end of a line', () => {
  const cases: [string, string, string, boolean][] = [
    ['a.py', 'claude-2', 'model="claude-v1",  # "claude-2" for Claude 2 model', true],
    ['a.py', 'claude-v1', 'model="claude-v1",  # "claude-2" for Claude 2 model', false],
    ['a.ts', 'gpt-4', "const m = 'gpt-5'; // was gpt-4", true],
    ['a.ts', 'gpt-4', "const m = 'gpt-4'; // gpt-4 still", false],
    ['a.ts', 'gpt-4', "const url = 'https://x.dev/gpt-4'", false],
    ['a.py', 'gpt-4', 'm = "#gpt-4"', false],
    ['a.rb', 'gpt-4', 'x = 1 # gpt-4', true],
  ];
  for (const [file, id, text, expected] of cases) {
    it(`${text} -> ${id}: ${expected}`, () => assert.equal(onlyInTrailingComment(file, id, text), expected));
  }
});

describe('the session helper', () => {
  it('copies tracked files only, with what Claude Code could load from a repo removed', () => {
    const repo = fixtureRepo('quiet', { 'app.py': 'print("hi")\n', 'CLAUDE.md': 'x\n', 'AGENTS.md': 'x\n', '.mcp.json': '{}\n' });
    for (const file of ['.claude/settings.json', '.cursor/a', '.vscode/b', '.devcontainer/c', '.github/workflows/d.yml', 'nested/.claude/settings.json', 'nested/CLAUDE.md']) {
      mkdirSync(dirname(join(repo.path, file)), { recursive: true });
      writeFileSync(join(repo.path, file), 'x\n');
    }
    execFileSync('git', ['-C', repo.path, 'add', '-A']);
    execFileSync('git', ['-C', repo.path, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'risky']);
    const base = mkdtempSync(join(tmpdir(), 'keepup-copy with space-'));
    try {
      writeFileSync(join(repo.path, 'untracked.txt'), 'x\n');
      const env = { ...process.env, SKILL_SESSION_DIR: base };
      const commit = execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync(HELPER, ['copy', 'risky', join(repo.path, '.git'), commit], { env });
      const copy = join(base, 'risky', 'risky');
      assert.ok(existsSync(join(copy, 'app.py')));
      for (const gone of ['CLAUDE.md', 'AGENTS.md', '.mcp.json', '.claude', '.cursor', '.vscode', '.devcontainer', '.github', 'nested/.claude', 'nested/CLAUDE.md', 'untracked.txt', '.git']) {
        assert.ok(!existsSync(join(copy, gone)), gone);
      }
    } finally {
      repo.cleanup();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('never puts .env in what it mounts, and passes the key by name', () => {
    const base = mkdtempSync(join(tmpdir(), 'keepup-stage-'));
    try {
      execFileSync(HELPER, ['stage'], { env: { ...process.env, SKILL_SESSION_DIR: base } });
      assert.ok(existsSync(join(base, 'market', '.claude-plugin', 'marketplace.json')));
      assert.ok(!existsSync(join(base, 'market', '.env')));
      const helper = readFileSync(HELPER, 'utf8');
      assert.match(helper, /-e ANTHROPIC_API_KEY \\/);
      assert.ok(!/-e ANTHROPIC_API_KEY=/.test(helper));
      assert.ok(!/set -x/.test(helper));
      assert.match(helper, /--setting-sources user/);
      assert.ok(!/dangerously-skip/.test(helper));
      assert.match(helper, /target=\/market,readonly/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('a recorded session', () => {
  it('keeps the final output, the cost and the upstream commit, with a key masked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-record-'));
    try {
      const events = join(dir, 'a.jsonl');
      const key = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('-');
      writeFileSync(events, `${JSON.stringify({ type: 'system', model: 'sonnet' })}\n${JSON.stringify({ type: 'result', result: `keepup: x ${key}\nwant the change?`, total_cost_usd: 0.25, num_turns: 3, permission_denials: [] })}\n`);
      const text = recordingText({ repo: 'r', url: 'https://example.com/r', commit: 'abc', date: '2026-11-01', out: join(dir, 'o.md'), sessions: [{ title: '/keepup', events }] });
      assert.match(text, /want the change\?/);
      assert.match(text, /Cost: USD 0\.2500/);
      assert.match(text, /Commit: abc/);
      assert.ok(!text.includes(key));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
