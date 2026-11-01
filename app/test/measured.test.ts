// "Measured" has to mean a run happened: a result is held to what that run saved.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { outDirFor, parseResult, readResult, tryReadResult, writeResult, type LabResult } from '../../lab/shared/result.ts';
import { findSpec } from '../src/specs.ts';
import { isMeasured, labOf, renderBody, renderTitle } from '../src/template.ts';
import { installSpec, MEASURED_RESULT, measuredFor, NOT_RUN_RESULT, ORG, repoFixture, tempDir, writeMeasured, writeText } from './world.ts';

const TYPED = measuredFor('06-models', MEASURED_RESULT.replace('answers on 3 of 3 new models', '99x cheaper, typed by hand'));

function scene(): { root: string; lab: string } {
  const root = tempDir();
  installSpec(root, repoFixture(), { result: NOT_RUN_RESULT });
  rmSync(join(root, 'lab/06-models/out'), { recursive: true });
  return { root, lab: join(root, 'lab/06-models') };
}

function typeResult(lab: string): void {
  writeText(join(lab, 'result.md'), TYPED);
}

const cases: [string, (lab: string) => void][] = [
  ['no out/ at all', () => undefined],
  ['out/ holding only repo-tests.json', (lab) => writeText(join(lab, 'out/repo-tests.json'), '{"summary":"x"}')],
  ['out/ holding only repo-tests.log', (lab) => writeText(join(lab, 'out/repo-tests.log'), 'x')],
  ['out/ holding only .DS_Store', (lab) => writeText(join(lab, 'out/.DS_Store'), 'x')],
  ['out/ holding only an empty folder', (lab) => mkdirSync(join(lab, 'out/empty'), { recursive: true })],
  ['out/ holding a real-looking file and no manifest', (lab) => writeText(join(lab, 'out/raw.json'), '{}')],
];

for (const [name, arrange] of cases) {
  test(`a typed result with ${name} isn't measured, and no number goes out`, () => {
    const { root, lab } = scene();
    arrange(lab);
    typeResult(lab);
    const spec = findSpec('06', root);
    const view = labOf(spec, root);
    assert.equal(isMeasured(view), false);
    assert.match(view.problem ?? '', /holds no saved run/);
    assert.throws(() => renderTitle(spec.stages[0], view), /isn't measured/);
    const body = renderBody(spec, { org: ORG, applied: [spec.stages[0]], lab: view, allowUnmeasured: true });
    assert.doesNotMatch(body, /real numbers/);
    assert.doesNotMatch(body, /99x/);
  });
}

for (const file of ['repo-tests.json', 'repo-tests-jev.log', '.DS_Store']) {
  test(`a lab that saved only ${file} has no run to show, even going through writeResult`, () => {
    const { root, lab } = scene();
    writeText(join(lab, 'out', file), '{}');
    writeResult(join(lab, 'result.md'), parseResult(TYPED));
    assert.ok(!existsSync(join(lab, 'out/manifest.json')));
    assert.match(labOf(findSpec('06', root), root).problem ?? '', /holds no saved run/);
  });
}

test('a real run counts, and repo-tests or a .DS_Store arriving later change nothing', () => {
  const { root } = scene();
  writeMeasured(root, 'lab/06-models');
  writeText(join(root, 'lab/06-models/out/repo-tests.json'), '{"summary":"x"}');
  writeText(join(root, 'lab/06-models/out/.DS_Store'), 'x');
  assert.equal(isMeasured(labOf(findSpec('06', root), root)), true);
  writeFileSync(join(root, 'lab/06-models/out/repo-tests.json'), '{"summary":"a later run"}');
  assert.equal(isMeasured(labOf(findSpec('06', root), root)), true, 'its own lifecycle, so a newer one does not undo the run');
});

test('a result edited after the run isn\'t the run\'s result: the table, or the number', () => {
  for (const edit of [(t: string) => t.replace('| 0 | 3 |', '| 0 | 300 |'), (t: string) => t.replace('3 of 3', '30 of 30')]) {
    const { root, lab } = scene();
    writeMeasured(root, 'lab/06-models');
    const path = join(lab, 'result.md');
    writeFileSync(path, edit(readFileSync(path, 'utf8')));
    assert.match(labOf(findSpec('06', root), root).problem ?? '', /edited after the run/);
  }
});

test('a saved file that changed or went missing isn\'t what the run saved', () => {
  const { root, lab } = scene();
  writeMeasured(root, 'lab/06-models');
  writeFileSync(join(lab, 'out/raw.json'), '{"changed":true}');
  assert.match(labOf(findSpec('06', root), root).problem ?? '', /raw\.json isn't what the run saved/);
  rmSync(join(lab, 'out/raw.json'));
  assert.match(labOf(findSpec('06', root), root).problem ?? '', /raw\.json isn't what the run saved/);
});

test('a variant can\'t borrow its parent\'s run, and the parent doesn\'t count the variant\'s', () => {
  const root = tempDir();
  const fix = repoFixture();
  installSpec(root, fix, { labDir: 'lab/01-router', overrides: { id: '01', spec: 'docs/prs/01.md' } });
  installSpec(root, fix, { labDir: 'lab/01-router', file: 'pr-jev.json', result: null, overrides: { id: '01-jev', spec: 'docs/prs/01.md', branch: 'keepup/2026-10-22-router-jev' } });
  writeMeasured(root, 'lab/01-router');
  writeText(join(root, 'lab/01-router/result-jev.md'), measuredFor('01-router-jev'));
  const jev = findSpec('01-jev', root);
  assert.equal(isMeasured(labOf(jev, root)), false, 'out/ belongs to result.md');
  assert.match(labOf(jev, root).problem ?? '', /out\/jev\/ holds no saved run/);
  writeMeasured(root, 'lab/01-router', MEASURED_RESULT, 'result-jev.md', '01-router-jev');
  assert.equal(isMeasured(labOf(jev, root)), true);
  writeMeasured(root, 'lab/01-router');
  const main = JSON.parse(readFileSync(join(root, 'lab/01-router/out/manifest.json'), 'utf8')) as { files: { path: string }[]; variant: string | null };
  assert.equal(main.variant, null);
  assert.ok(!main.files.some((f) => f.path.startsWith('jev')), 'the variant\'s folder has its own manifest');
});

const measured: LabResult = { lab: '06-models', status: 'measured', measured_at: '2026-11-01', title_number: '3 of 3', body: '| a | b |\n| --- | --- |\n| 1 | 2 |' };

test('writeResult is atomic: a reader sees the old file or the new one, with no temp file left', () => {
  const dir = tempDir();
  const path = join(dir, 'result.md');
  writeResult(path, measured);
  assert.equal(readResult(path)?.title_number, '3 of 3');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('a measured result with no saved run writes no manifest and makes no out/', () => {
  const dir = tempDir();
  writeResult(join(dir, 'result.md'), measured);
  assert.ok(!existsSync(join(dir, 'out')));
});

test('writeResult replaces a file it can\'t read, because there\'s nothing in it to protect', () => {
  const dir = tempDir();
  const path = join(dir, 'result.md');
  writeFileSync(path, '---\nlab: x\nstatus: measured\n---\nhalf');
  assert.match(tryReadResult(path).problem ?? '', /measured_at/);
  assert.equal(writeResult(path, { lab: 'x', status: 'not_run', needs: 'a key', body: 'waiting' }).status, 'not_run');
  assert.equal(tryReadResult(path).problem, null);
});

test('the out dir follows the result file', () => {
  assert.equal(outDirFor('/l/result.md'), '/l/out');
  assert.equal(outDirFor('/l/result-jev.md'), '/l/out/jev');
});
