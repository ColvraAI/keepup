// A real Claude Code session, on the plugin as it ships: the permission check that refused a heredoc can only be seen from inside one.
// It costs a little and needs a login, so it runs only with KEEPUP_SMOKE=1, and fails on any denial.
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fixtureRepo, ROOT } from './helpers.ts';

const PLUGIN = join(ROOT, 'plugin');
const TIMEOUT_MS = 600_000;
const skip = process.env.KEEPUP_SMOKE === '1' ? false : 'a real session: set KEEPUP_SMOKE=1 to run it';

function allowedTools(): string[] {
  const line = readFileSync(join(ROOT, 'skills', 'keepup', 'SKILL.md'), 'utf8').match(/^allowed-tools: (.*)$/m)?.[1] ?? '';
  return line.split(', ');
}

interface SessionResult {
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly permission_denials?: readonly unknown[];
  readonly is_error?: boolean;
}

function session(cwd: string, prompt: string, budget: string, tools: readonly string[] = []): SessionResult {
  const out = spawnSync('claude', ['-p', prompt, '--plugin-dir', PLUGIN, '--model', 'haiku', '--max-budget-usd', budget, '--output-format', 'json', ...(tools.length ? ['--allowedTools', ...tools] : [])], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, input: '', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout.trim().split('\n').at(-1) as string) as SessionResult;
  process.stderr.write(`smoke: spent ${result.total_cost_usd}\n`);
  return result;
}

describe('the plugin in a real session', { skip }, () => {
  it('verify --findings runs with the skill\'s tools, apostrophe and all, with no denial', () => {
    const repo = fixtureRepo('quiet', { 'chat.py': 'client.chat.completions.create(model="gpt-6-luna")\n' });
    try {
      const dir = join(repo.path, '..', 'keepup-smoke-data');
      const command = `keepup verify . --findings '{"findings":[],"watching":[],"held_back":[],"jobs":["don&apos;t care"]}' --brief --dir ${process.env.HOME}/.claude/plugins/data/keepup-smoke`;
      const result = session(repo.path, `Run this exact Bash command, as one Bash call, and print what it prints: ${command}`, '0.2', allowedTools());
      assert.deepEqual(result.permission_denials, [], dir);
      assert.match(result.result ?? '', /keepup:|Not checked against/);
    } finally {
      repo.cleanup();
      execFileSync('rm', ['-rf', `${process.env.HOME}/.claude/plugins/data/keepup-smoke`]);
    }
  });

  it('a session can\'t reach keepup run without a person', () => {
    const repo = fixtureRepo('quiet', { 'chat.py': 'client.chat.completions.create(model="gpt-6-luna")\n' });
    try {
      const result = session(repo.path, 'Run this exact Bash command, as one Bash call, and print what it prints: keepup run . --no-judge', '0.2', allowedTools());
      assert.ok((result.permission_denials ?? []).length > 0 || /person|terminal|permission|approve/i.test(result.result ?? ''), JSON.stringify(result));
    } finally {
      repo.cleanup();
    }
  });

  it('/keepup itself ends in a checked brief, with no denial', () => {
    const repo = fixtureRepo('quiet', { 'chat.py': 'import openai\nclient = openai.OpenAI()\nreply = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])\n' });
    try {
      const result = session(repo.path, '/keepup:keepup', '0.8');
      assert.deepEqual(result.permission_denials, [], JSON.stringify(result.permission_denials));
      assert.match(result.result ?? '', /keepup: /);
      assert.match(result.result ?? '', /gpt-4o-mini/);
    } finally {
      repo.cleanup();
    }
  });
});
