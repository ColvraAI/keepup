import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CHANGE_RULES } from '../../src/change.ts';
import { existingChange, saveRun, savedChanges, savedRun, savedSlugs, tidySaved } from '../src/dashboard/saved.ts';
import { worthChecking } from '../src/dashboard/live-scan.ts';

const roots: string[] = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const base = () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-saved-'));
  roots.push(dir);
  return dir;
};

function change(dir: string, id: string, fields: Record<string, unknown>): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'change.json'), JSON.stringify({ id, repo: 'a/b', commit: 'c1', finding_rank: 1, rules: CHANGE_RULES, ...fields }));
}

test('a run saved here comes back after a restart', () => {
  const dir = base();
  const from = join(dir, 'run.json');
  writeFileSync(from, JSON.stringify({ repo: 'a/b', findings: [] }));
  saveRun(dir, 'a/b', from);
  assert.deepEqual(savedSlugs(dir), ['a/b']);
  assert.deepEqual(savedRun(dir, 'a/b'), { repo: 'a/b', findings: [] });
  assert.equal(savedRun(dir, 'c/d'), null);
});

test('an existing change is found, a refused one can be tried again, and one under older rules is ignored', () => {
  const dir = base();
  change(dir, 'change-abcdef0-1-aaaaaa', { kind: 'swap' });
  change(dir, 'change-abcdef0-2-aaaaaa', { finding_rank: 2, refused: 'no' });
  change(dir, 'change-abcdef0-3-aaaaaa', { finding_rank: 3, rules: CHANGE_RULES - 1 });
  assert.equal(existingChange(dir, 'a/b', 'c1', 1)?.id, 'change-abcdef0-1-aaaaaa');
  assert.equal(existingChange(dir, 'a/b', 'c1', 2), null);
  assert.equal(existingChange(dir, 'a/b', 'c1', 3), null);
  assert.deepEqual(savedChanges(dir, 'a/b').map((item) => item.finding_rank).sort(), [1, 2]);
  assert.deepEqual(savedChanges(dir, 'x/y'), []);
});

test('tidying leaves only masked text, and takes what is past the age limit', () => {
  const dir = base();
  const id = 'change-abcdef0-1-bbbbbb';
  change(dir, id, {});
  mkdirSync(join(dir, id, 'repo'));
  mkdirSync(join(dir, id, 'syntax'));
  writeFileSync(join(dir, id, 'change.patch'), ' KEY = "sk-ant-FAKEfake0123456789"\n');
  mkdirSync(join(dir, 'scan-x'));
  mkdirSync(join(dir, 'pinned-x'));
  const stale = 'change-abcdef0-9-cccccc';
  change(dir, stale, {});
  const long = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(join(dir, stale), long, long);
  tidySaved(dir);
  assert.equal(existsSync(join(dir, id, 'repo')), false);
  assert.equal(existsSync(join(dir, id, 'syntax')), false);
  assert.ok(!readFileSync(join(dir, id, 'change.patch'), 'utf8').includes('sk-ant'));
  assert.equal(existsSync(join(dir, 'scan-x')), false);
  assert.equal(existsSync(join(dir, 'pinned-x')), false);
  assert.equal(existsSync(join(dir, stale)), false);
});

// rakaar/repochat-gemini-streamlit: one model id in one place, no pattern hits. AkashHiremath856/GeminiStreamlitApp: three in six.
test('a repo with model ids and no pattern hits is worth checking', () => {
  assert.equal(worthChecking({ model_ids: [{ id: 'gemini-1.5-flash' }], ai_call_sites: [] }, 0), true);
  assert.equal(worthChecking({ model_ids: [{ id: 'embedding-001' }, { id: 'gemini-pro' }, { id: 'gemini-1.5-pro' }], ai_call_sites: [] }, 0), true);
});
test('a repo that calls an AI API, or has a hit, is worth checking; one with none of these is not', () => {
  assert.equal(worthChecking({ model_ids: [], ai_call_sites: [{ file: 'a.py' }] }, 0), true);
  assert.equal(worthChecking({ model_ids: [], ai_call_sites: [] }, 3), true);
  assert.equal(worthChecking({ model_ids: [], ai_call_sites: [] }, 0), false);
  assert.equal(worthChecking({ model_ids: [], ai_call_sites: [], signals: { openai: { present: true } } } as Parameters<typeof worthChecking>[0], 0), false);
});
