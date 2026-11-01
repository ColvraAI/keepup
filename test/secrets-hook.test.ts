// A Read deny doesn't stop a shell command, so the hook does. It's a working-setup file that doesn't ship, so this skips without it.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

const HOOK = '.claude/hooks/secrets.sh';
const exitFor = (command: string) => spawnSync('bash', [HOOK], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' }).status;

describe('the secrets hook', { skip: existsSync(HOOK) ? false : 'a working-setup file, not in the public copy' }, () => {
  it('blocks a shell command that names a secret file', () => {
    for (const command of ['cat .env', 'cut -d= -f1 .env', 'source .env', 'cp .env.example .env', 'grep KEY ./.env', 'cat .env.local', 'cat ~/.ssh/id_rsa', 'ls $HOME/.aws/']) {
      assert.equal(exitFor(command), 2, command);
    }
  });

  it('lets the rest through', () => {
    for (const command of ['cat .env.example', 'node -e "console.log(process.env.HOME)"', 'grep -rn "process.env.KEY" src', 'npm test', 'git status --short', 'ls .environment']) {
      assert.equal(exitFor(command), 0, command);
    }
  });
});
