import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanText, countsAsDatabaseRecord, entryToRow } from './changelog.ts';
import { parsePatch, trimFile } from './diff.ts';
import { blobUrl, parseWhere } from './links.ts';


test('countsAsDatabaseRecord: only entries dated Sep or Oct 2026 count, so an older OpenAI entry with a yearless heading does not', () => {
  const e = (provider: 'openai' | 'anthropic' | 'gemini', date: string) => ({ provider, date });
  assert.equal(countsAsDatabaseRecord(e('openai', '2026-10-30')), true);
  assert.equal(countsAsDatabaseRecord(e('openai', '2024-09-03')), false);
  assert.equal(countsAsDatabaseRecord(e('openai', '2026-08-29')), false);
  assert.equal(countsAsDatabaseRecord(e('anthropic', '2025-10-01')), false);
  assert.equal(countsAsDatabaseRecord(e('gemini', '2026-09-01')), true);
});

test('entryToRow names the entry from its first clause and flags deprecations', () => {
  const row = entryToRow({
    provider: 'anthropic', date: '2026-09-30', change: null, tags: [], url: 'https://x.dev',
    text: 'We’ve deprecated Claude Sonnet 4.5 , with retirement on November 30, 2026. See the page.',
  });
  assert.equal(row.kind, 'deprecation');
  assert.equal(row.source, 'changelog');
  assert.equal(cleanText('Released GPT-6 , a model ( new ) .'), 'Released GPT-6, a model (new).');
  assert.equal(row.released, '2026-09-30');
  assert.match(row.name, /^Anthropic · We’ve deprecated Claude Sonnet 4\.5/);
  assert.ok(row.description.length > 0);
});

const PATCH = `From abc Mon Sep 17 00:00:00 2001
From: Some Person <person@example.com>
Date: Tue, 6 Oct 2026 10:00:00 +0000
Subject: [PATCH 1/2] feat: add the classifier

Body text.
---
 a.js | 3 ++-
 1 file changed

diff --git a/a.js b/a.js
index 111..222 100644
--- a/a.js
+++ b/a.js
@@ -10,3 +10,4 @@ function x() {
 keep
-old
+new
+more
 tail
diff --git a/new.txt b/new.txt
new file mode 100644
index 000..333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
\\ No newline at end of file
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
--
2.45.0
`;

test('parsePatch reads the subject, files and hunks, and drops the author', () => {
  const p = parsePatch(PATCH);
  assert.equal(p.subject, 'feat: add the classifier');
  assert.ok(!JSON.stringify(p).includes('person@example.com'));
  assert.deepEqual(p.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ['a.js', 'modified', 2, 1], ['new.txt', 'added', 1, 0], ['img.png', 'modified', 0, 0],
  ]);
  assert.equal(p.files[0].hunks[0].header, '@@ -10,3 +10,4 @@ function x() {');
  assert.deepEqual(p.files[0].hunks[0].lines, [' keep', '-old', '+new', '+more', ' tail']);
  assert.equal(p.files[1].hunks[0].lines.length, 2);
  assert.equal(p.files[2].binary, true);
});

test('trimFile caps a lockfile hard and says what it cut; a small file passes through', () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `+line ${i}`);
  const file = { path: 'package-lock.json', old_path: 'package-lock.json', status: 'modified' as const, additions: 5000, deletions: 0, binary: false,
    hunks: [{ header: '@@ -1 +1,5000 @@', old_start: 1, old_lines: 1, new_start: 1, new_lines: 5000, lines: huge }] };
  const trimmed = trimFile(file);
  assert.ok(trimmed.truncated);
  assert.equal(trimmed.truncated?.total_lines, 5000);
  assert.ok((trimmed.truncated?.shown_lines ?? 0) < 100);
  assert.equal(trimmed.additions, 5000, 'counts still describe the whole file');
  assert.equal(file.hunks[0].lines.length, 5000, 'the input is not mutated');
  const small = { ...file, path: 'a.js', hunks: [{ ...file.hunks[0], lines: ['+x'] }] };
  assert.equal(trimFile(small).truncated, undefined);
});

test('parseWhere finds real paths and lines, and ignores prose', () => {
  assert.deepEqual(parseWhere('collector/utils/OpenAiWhisper.js:11'), [{ path: 'collector/utils/OpenAiWhisper.js', line: 11 }]);
  assert.deepEqual(parseWhere('server/utils/helpers/customModels.js'), [{ path: 'server/utils/helpers/customModels.js' }]);
  assert.deepEqual(parseWhere('README.md (Integrations) and examples/complete/'), [{ path: 'README.md' }, { path: 'examples/complete', dir: true }]);
  assert.deepEqual(parseWhere('a/b.js:17–21'), [{ path: 'a/b.js', line: 17, end_line: 21 }]);
  assert.deepEqual(parseWhere(undefined), []);
});

test('blobUrl builds a permalink, on the fork when one is recorded', () => {
  assert.equal(blobUrl('https://github.com/a/b', 'abc', { path: 'x/y.js', line: 3 }), 'https://github.com/a/b/blob/abc/x/y.js#L3');
  assert.equal(blobUrl('https://github.com/a/b', 'abc', { path: 'x', dir: true }), 'https://github.com/a/b/tree/abc/x');
  assert.equal(blobUrl('https://github.com/a/b', 'abc', { path: 'x.js', line: 3, end_line: 9 }), 'https://github.com/a/b/blob/abc/x.js#L3-L9');
});
