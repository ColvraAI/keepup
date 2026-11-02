// A real install copies plugin/ into Claude Code's cache and follows its links, so nothing above plugin/ comes along.
// Running in place hid that: the first real install from GitHub couldn't start. Node took the module type from a package.json
// above the cache that the person's other tools had put there, because the plugin brought none of its own.
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtureRepo, ROOT } from './helpers.ts';

const ANSWER = readFileSync(join(ROOT, 'examples/support-bot/src/answer.ts'), 'utf8');
const CACHING = 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching';
const callLine = ANSWER.split('\n').findIndex((line) => line.includes('messages.create')) + 1;

const findings = {
  findings: [{
    title: 'Cache the long policy', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours',
    where: [{ file: 'answer.ts', line: callLine, text: ANSWER.split('\n')[callLine - 1] }], why: 'The same long policy goes out on every call.',
    options: [{ name: "Claude's prompt caching", what: 'Marks the policy for caching.', needs: 'One cache_control block.', source: CACHING }], sources: [CACHING], lever: 'ADV-2026-1007-anthropic-prompt-caching',
  }],
  watching: [], held_back: [], jobs: ['Write replies'],
};

describe('the plugin as a real install leaves it, copied with its links followed', () => {
  let home: string;
  let shim: string;
  let data: string;
  let repo: ReturnType<typeof fixtureRepo>;
  const run = (...args: string[]) => spawnSync(shim, args, { cwd: repo.path, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: repo.path } });
  const ok = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, `keepup ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'keepup-copy-'));
    writeFileSync(join(home, 'package.json'), '{"type":"commonjs"}\n');
    // cp itself, because Node's cpSync keeps a link at the top of a folder even when told to follow it.
    execFileSync('cp', ['-RL', join(ROOT, 'plugin'), join(home, 'plugin')]);
    shim = join(home, 'plugin', 'bin', 'keepup');
    data = join(home, 'data');
    repo = fixtureRepo('quiet', { 'answer.ts': ANSWER });
  });

  after(() => {
    repo.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  it('holds real files, not links back into the repo', () => {
    for (const part of ['bin', 'src', 'db', 'skills', 'data/db']) assert.equal(lstatSync(join(home, 'plugin', part)).isSymbolicLink(), false, part);
    assert.ok(existsSync(join(home, 'plugin', 'package.json')), 'plugin/package.json says the code is modules, and nothing above it comes along');
  });

  it('runs the whole free path: prepare, read, verify, the brief and the words for a pull request', () => {
    ok('prepare', '.', '--dir', data);
    assert.match(ok('get', 'facts.ai_call_sites', '--dir', data), /answer\.ts/);
    assert.match(ok('levers', 'PAT-label-picking-call'), /ADV-2026-0915-typesafe-jev/);
    assert.match(ok('show', '.', 'answer.ts', String(callLine), '--dir', data), /messages\.create/);
    assert.match(ok('search', JSON.stringify({ query: 'prompt caching' }), '--dir', data), /prompt|caching/i);
    assert.match(ok('verify', '.', '--findings', JSON.stringify(findings), '--brief', '--dir', data), /Biggest lever: Cache the long policy/);
    assert.match(ok('pr-body', '--finding', '1', '--dir', data, '--save'), /^body: .*pr-body\.md\nrepo: none\n$/);
    assert.match(ok('issue-body', '--dir', data, '--save'), /^body: .*issue\.md\n$/);
  });

  it('the weekly notice runs from the copy, and never fails a session', () => {
    assert.equal(run('check', repo.path, '--weekly-state', join(data, 'weekly-check.json'), '--hook').status, 0);
  });
});
