// The dashboard shows only runs that really searched and judged.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildRuns } from '../scripts/site-data/runs.ts';

describe('buildRuns', () => {
  it('skips a run nobody judged, and keeps one that was', () => {
    const root = mkdtempSync(join(tmpdir(), 'keepup-site-'));
    try {
      mkdirSync(join(root, 'data', 'runs'), { recursive: true });
      writeFileSync(join(root, 'data', 'runs', 'floor.json'), JSON.stringify({ repo: 'a/floor', commit: 'abc', usage: null }));
      writeFileSync(join(root, 'data', 'runs', 'judged.json'), JSON.stringify({ repo: 'a/judged', commit: 'abc', usage: { usd: 0.4 } }));
      const { runs, problems } = buildRuns(root, { forks: {} });
      assert.deepEqual(runs.map((run) => run.file), ['judged.json']);
      assert.deepEqual(problems, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
