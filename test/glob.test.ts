import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { matchesGlob } from '../src/glob.ts';

describe('matchesGlob', () => {
  const cases: [string, string, boolean][] = [
    ['*.ts', 'a/b/c.ts', true],
    ['*.ts', 'a/b/c.tsx', false],
    ['*.test.*', 'src/a.test.ts', true],
    ['src/**/*.py', 'src/a/b/c.py', true],
    ['src/**/*.py', 'src/c.py', true],
    ['src/**/*.py', 'lib/c.py', false],
    ['**/*.js', 'c.js', true],
    ['*.{ts,js}', 'a/c.js', true],
    ['*.{ts,js}', 'a/c.py', false],
    ['.mcp.json', 'a/.mcp.json', true],
    ['promptfooconfig*', 'promptfooconfig.yaml', true],
    ['server/*.js', 'server/a/b.js', false],
    ['a?c.js', 'abc.js', true],
    // The forms db/patterns uses.
    ['**/*.py', 'a.py', true],
    ['**/*.py', 'a/b/c.py', true],
    ['**/*.py', 'a/b/c.pyc', false],
    ['**/__tests__/**', 'server/__tests__/a.js', true],
    ['**/__tests__/**', '__tests__/deep/a.js', true],
    ['**/__tests__/**', 'server/not__tests__/a.js', false],
    ['**/*.test.*', 'server/a.test.js', true],
    ['**/test_*', 'app/test_router.py', true],
    ['**/test_*', 'app/latest_router.py', false],
    ['**/test-*', 'test-utils.js', true],
    ['**/anthropic/**/*.js', 'server/anthropic/index.js', true],
    ['**/anthropic/**/*.js', 'server/anthropic/deep/index.js', true],
    ['**/*anthropic*.py', 'x/my_anthropic_client.py', true],
    ['**/cron/**', 'jobs/cron/a.py', true],
    ['**/nightly*', 'nightly.py', true],
  ];
  for (const [glob, path, want] of cases) {
    it(`${glob} ${want ? 'matches' : 'does not match'} ${path}`, () => {
      assert.equal(matchesGlob(path, glob), want);
    });
  }
});
