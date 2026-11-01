// signals.ts promised "the run says so" when a repo stalls the scan. These hold that promise all the way to what a founder reads.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderBrief, renderSummary } from '../src/brief.ts';
import { buildFacts } from '../src/facts.ts';
import { listRepoFiles } from '../src/git-files.ts';
import { runPipeline } from '../src/pipeline.ts';
import { scanFiles } from '../src/scan.ts';
import { loadSignals, runSignalsCounted } from '../src/signals.ts';
import { fixtureRepo, ROOT } from './helpers.ts';

const FILES = { 'chat.py': 'client.chat.completions.create(model="gpt-6-luna")\n' };
const keepup = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'bin', 'keepup.ts'), ...args], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: '', ...env } });

describe('a scan that runs out of time', () => {
  it('signals count what they never reached', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ path: `src/f${index}.py`, text: 'x = 1\n' }));
    const counted = runSignalsCounted(files, loadSignals(), undefined, 4, -1);
    assert.deepEqual(counted.results, {});
    assert.equal(counted.over_time, 50);
  });

  it('the patterns count too', () => {
    const files = [{ path: 'a.py', text: 'x = 1\n' }];
    const patterns = [{ id: 'P', name: 'p', find: [], skipIfNear: [], files: ['**/*.py'], skipFiles: [], skipIfInFile: [] }];
    assert.equal(scanFiles(files, patterns, -1).checked.over_time, 1);
  });

  it('one deadline holds over the whole read: files past it are counted, not read', () => {
    const repo = fixtureRepo('quiet', FILES);
    try {
      const listed = listRepoFiles(repo.path, { commit: 'HEAD', budgetMs: -1 });
      assert.equal(listed.files.length, 0);
      assert.ok((listed.skipped.over_time ?? 0) > 0);
    } finally {
      repo.cleanup();
    }
  });

  it('facts carry the count, and a run says it stopped rather than that nothing applies', async () => {
    const repo = fixtureRepo('quiet', FILES);
    try {
      const facts = buildFacts(repo.path, { commit: 'HEAD', listed: listRepoFiles(repo.path, { commit: 'HEAD', budgetMs: -1 }) });
      assert.ok((facts.checked.over_time ?? 0) > 0);
      const run = await runPipeline(repo.path, { commit: 'HEAD', readBudgetMs: -1 });
      assert.match(run.incomplete?.reason ?? '', /time budget/);
      assert.ok(run.incomplete?.skipped.some((item) => /not read/.test(item)));
      for (const text of [renderSummary({ ...run, ran: { search: true, judge: true, online: false } }), renderBrief({ ...run, ran: { search: true, judge: true, online: false } })]) {
        assert.ok(!/nothing new applies/.test(text), text);
        assert.match(text, /stopped early/i);
        assert.match(text, /time budget/);
      }
      for (const text of [renderSummary(run), renderBrief(run)]) assert.ok(!/nothing retired/.test(text), text);
    } finally {
      repo.cleanup();
    }
  });

  it('a run that finished in time claims nothing about stopping', async () => {
    const repo = fixtureRepo('quiet', FILES);
    try {
      assert.equal((await runPipeline(repo.path, { commit: 'HEAD' })).incomplete, undefined);
    } finally {
      repo.cleanup();
    }
  });

  it('through the command line: check and the hook both say so, even with nothing else to say', () => {
    const repo = fixtureRepo('quiet', FILES);
    const dir = mkdtempSync(join(tmpdir(), 'keepup-late-'));
    try {
      const env = { KEEPUP_READ_BUDGET_MS: '-1' };
      const check = keepup(env, 'check', repo.path);
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /^keepup: stopped early/);
      assert.ok(!/no model you use/.test(check.stdout));
      const hook = keepup(env, 'check', repo.path, '--weekly-state', join(dir, 'state.json'), '--hook');
      assert.match(JSON.parse(hook.stdout).systemMessage, /stopped early/);
    } finally {
      repo.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
