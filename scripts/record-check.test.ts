import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkLine, recordLine } from './record-check.ts';

describe('record-check', () => {
  it('takes the one keepup line from stdout', () => {
    assert.equal(checkLine('keepup: 1 model you use is already shut down · /keepup\n'), 'keepup: 1 model you use is already shut down · /keepup');
  });

  it('refuses output that is not the one line', () => {
    assert.throws(() => checkLine(''), /one keepup line/);
    assert.throws(() => checkLine('hello\n'), /one keepup line/);
    assert.throws(() => checkLine('keepup: a\nkeepup: b\n'), /one keepup line/);
  });

  it('records what ran, where and when', () => {
    const record = recordLine({ repo: 'mezmo/aura', name: 'aura', clone: 'tmp/aura', commit: 'abc', asOf: '2026-10-31', stdout: 'keepup: x\n', recordedAt: '2026-11-01T00:00:00.000Z' });
    assert.deepEqual(record, {
      repo: 'mezmo/aura',
      name: 'aura',
      commit: 'abc',
      as_of: '2026-10-31',
      command: 'keepup check tmp/aura --as-of 2026-10-31',
      line: 'keepup: x',
      recorded_at: '2026-11-01T00:00:00.000Z',
    });
  });
});
