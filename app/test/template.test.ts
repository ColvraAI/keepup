import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findSpec } from '../src/specs.ts';
import { formatDate, isMeasured, labOf, NotMeasuredError, renderBody, renderTitle } from '../src/template.ts';
import { installSpec, MEASURED_RESULT, measuredFor, NOT_RUN_RESULT, ORG, repoFixture, tempDir, writeMeasured, writeText } from './world.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

function load(overrides: Record<string, unknown> = {}, result: string | null = MEASURED_RESULT) {
  const root = tempDir();
  installSpec(root, repoFixture(), { overrides, result });
  return { root, spec: findSpec('06', root) };
}

test('title reads its number from result.md', () => {
  const { root, spec } = load();
  assert.equal(renderTitle(spec.stages[0], labOf(spec, root)), 'Add GPT-6 Sol and GPT-6 Luna · answers on 3 of 3 new models');
  writeMeasured(root, 'lab/06-models', MEASURED_RESULT.replace('3 of 3', '2 of 3'));
  assert.equal(renderTitle(spec.stages[0], labOf(spec, root)), 'Add GPT-6 Sol and GPT-6 Luna · answers on 2 of 3 new models');
});

test('a numbered title refuses when the lab is not measured', () => {
  for (const result of [NOT_RUN_RESULT, null]) {
    const { root, spec } = load({}, result);
    assert.throws(() => renderTitle(spec.stages[0], labOf(spec, root)), (e: unknown) => {
      assert.ok(e instanceof NotMeasuredError);
      assert.match(e.message, /lab\/06-models/);
      assert.match(e.message, result ? /needs OPENAI_API_KEY/ : /needs a lab run/);
      return true;
    });
  }
});

test('a measured lab without title_number cannot fill a numbered title', () => {
  const { root, spec } = load({}, MEASURED_RESULT.replace('title_number: answers on 3 of 3 new models\n', ''));
  assert.throws(() => renderTitle(spec.stages[0], labOf(spec, root)), /title_number/);
});

test('titleUnmeasured is used only with --allow-unmeasured, and only until the lab is measured', () => {
  const stages = [{ date: '2026-09-22', patches: ['patches/0001.patch'], title: 'Add it · {{lab.title_number}}', titleUnmeasured: 'Add it', whatShipped: 'x', whatThisChanges: 'y', comment: null }];
  const { root, spec } = load({ stages }, NOT_RUN_RESULT);
  assert.throws(() => renderTitle(spec.stages[0], labOf(spec, root)), NotMeasuredError);
  assert.equal(renderTitle(spec.stages[0], labOf(spec, root), { allowUnmeasured: true }), 'Add it');
  writeMeasured(root, 'lab/06-models');
  assert.equal(renderTitle(spec.stages[0], labOf(spec, root), { allowUnmeasured: true }), 'Add it · answers on 3 of 3 new models');
});

test('a title with no placeholder needs no number', () => {
  const stages = [{ date: '2026-09-22', patches: ['patches/0001.patch'], title: 'Keeps working after 26 Feb', whatShipped: 'x', whatThisChanges: 'y', comment: null }];
  const { root, spec } = load({ stages }, NOT_RUN_RESULT);
  assert.equal(renderTitle(spec.stages[0], labOf(spec, root)), 'Keeps working after 26 Feb');
});

test('the body has exactly the shape of the template', () => {
  const { root, spec } = load();
  const sha = spec.baseCommit;
  const body = renderBody(spec, { org: ORG, applied: [spec.stages[0]], lab: labOf(spec, root) });
  const expected = [
    'keepup · 22 Sep 2026 · OpenAI API changelog',
    '',
    `**Where:** [server/utils/helpers/customModels.js:2](https://github.com/keepup-demo/anything-llm/blob/${sha}/server/utils/helpers/customModels.js#L2)`,
    '',
    '**What shipped:** GPT-6 Sol and GPT-6 Luna shipped on 22 Sep.',
    '',
    '**Why it fits your product:** The fallback list is what users pick from when the models API is unreachable.',
    '',
    '**What this changes:** customModels.js gains two entries. Nothing is switched on by default.',
    '',
    '**Measured on this fork:**',
    '',
    '| | before | after |',
    '| --- | --- | --- |',
    '| models answering | 0 | 3 |',
    '',
    '**Proof:** measured on this fork · vendor: GPT-6 Sol and Luna are generally available, https://developers.openai.com/api/docs/changelog · independent: none',
    '',
    '**Risks:** A model id could be wrong. The test checks the ids and that there are no duplicates.',
    '',
    '**Rollback:** Revert this pull request.',
    '',
    '**Sources:** https://developers.openai.com/api/docs/changelog · https://github.com/Mintplex-Labs/anything-llm/commit/5edf32b9',
    '',
    '---',
    '',
    `This is the keepup demo, a replay on a fork: real code, real numbers, simulated time and place. keepup would have opened it on 22 Sep 2026 against ${sha}; a person merges.`,
  ].join('\n');
  assert.equal(body, expected);
});

test('later stages add dated lines and every update line, oldest first', () => {
  const { root, spec } = load();
  const body = renderBody(spec, { org: ORG, applied: spec.stages, lab: labOf(spec, root) });
  assert.match(body, /\*\*What shipped:\*\*\n\n- 22 Sep 2026: GPT-6 Sol and GPT-6 Luna shipped on 22 Sep\.\n- 29 Sep 2026: GPT-6\.1 Sol shipped on 29 Sep\./);
  assert.match(body, /\*\*What this changes:\*\*\n\n- 22 Sep 2026: customModels\.js gains two entries/);
  assert.ok(body.indexOf('Updated 29 Sep: GPT-6.1 Sol shipped.') > body.indexOf('**Sources:**'));
  assert.ok(body.indexOf('Updated 29 Sep') < body.indexOf('This is the keepup demo'));
  assert.ok(body.startsWith('keepup · 22 Sep 2026 · OpenAI API changelog\n'), 'the first line keeps the date of the first new thing');
});

test('an unmeasured lab says so plainly, with no numbers, only when allowed', () => {
  const stages = [{ date: '2026-09-22', patches: ['patches/0001.patch'], title: 'No number here', whatShipped: 'x', whatThisChanges: 'y', comment: null }];
  const { root, spec } = load({ stages }, NOT_RUN_RESULT);
  assert.throws(() => renderBody(spec, { org: ORG, applied: spec.stages, lab: labOf(spec, root) }), NotMeasuredError);
  const body = renderBody(spec, { org: ORG, applied: spec.stages, lab: labOf(spec, root), allowUnmeasured: true });
  assert.match(body, /\*\*Measured on this fork:\*\* Not measured yet: needs OPENAI_API_KEY/);
  assert.match(body, /\*\*Proof:\*\* no lab result yet · vendor:/);
  assert.ok(!body.includes('| ---'), 'no table');
  assert.ok(!body.includes('Sends one real request'), 'no text from the result body');
  assert.ok(!body.includes('real numbers'), 'the footer claims no numbers it does not have');
  assert.match(body, /real code, no lab result yet, simulated time and place/);
});

test('a partial result never shows a partial table as if it were measured', () => {
  const partial = `---\nlab: 06-models\nstatus: partial\nmeasured_at: 2026-11-01\nneeds: ANTHROPIC_API_KEY\n---\n| | before | after |\n| --- | --- | --- |\n| ran | 1 | 2 |\n`;
  const stages = [{ date: '2026-09-22', patches: ['patches/0001.patch'], title: 'No number', whatShipped: 'x', whatThisChanges: 'y', comment: null }];
  const { root, spec } = load({ stages }, partial);
  const body = renderBody(spec, { org: ORG, applied: spec.stages, lab: labOf(spec, root), allowUnmeasured: true });
  assert.match(body, /Not measured yet: needs ANTHROPIC_API_KEY/);
  assert.ok(!body.includes('| ran | 1 | 2 |'));
});

test('a missing result.md asks for a lab run', () => {
  const stages = [{ date: '2026-09-22', patches: ['patches/0001.patch'], title: 'No number', whatShipped: 'x', whatThisChanges: 'y', comment: null }];
  const { root, spec } = load({ stages }, null);
  const body = renderBody(spec, { org: ORG, applied: spec.stages, lab: labOf(spec, root), allowUnmeasured: true });
  assert.match(body, /Not measured yet: needs a lab run/);
});

test('ciWorkflow adds the extra commit to the footer', () => {
  const { root, spec } = load();
  const ciSpec = { ...spec, ciWorkflow: 'lab/ci/aura.yml' };
  const body = renderBody(ciSpec, { org: ORG, applied: [spec.stages[0]], lab: labOf(spec, root) });
  assert.match(body, /The base branch has one extra commit on top of [0-9a-f]{40} that adds lab\/ci\/aura\.yml as \.github\/workflows\/keepup-ci\.yml and removes this repo's other workflow files/);
  const twoCommits = renderBody(ciSpec, { org: ORG, applied: [spec.stages[0]], lab: labOf(spec, root), baseExtraCommits: 2 });
  assert.match(twoCommits, /has 2 extra commits on top of [0-9a-f]{40} that add lab\/ci\/aura\.yml .* and remove this repo's other workflow files/);
});

test('independent proof and a where with no line', () => {
  const { root, spec } = load({
    proof: { vendor: null, independent: { claim: 'an outside benchmark', url: 'https://example.test/bench' } },
    where: [{ path: 'README.md' }],
  });
  const body = renderBody(spec, { org: ORG, applied: [spec.stages[0]], lab: labOf(spec, root) });
  assert.match(body, /vendor: none · independent: an outside benchmark, https:\/\/example\.test\/bench/);
  assert.match(body, /\[README\.md\]\(https:\/\/github\.com\/keepup-demo\/anything-llm\/blob\/[0-9a-f]{40}\/README\.md\)/);
});

test('measured needs its evidence: this lab\'s own result, a table and a saved run', () => {
  const cases: [string, (root: string) => void, RegExp][] = [
    ['another lab', (root) => writeText(join(root, 'lab/06-models/result.md'), measuredFor('01-router')), /from 01-router/],
    ['no table', (root) => writeText(join(root, 'lab/06-models/result.md'), `---\nlab: 06-models\nstatus: measured\nmeasured_at: 2026-11-01\ntitle_number: 99x faster\n---\n`), /no table/],
    ['no saved run', (root) => rmSync(join(root, 'lab/06-models/out'), { recursive: true }), /out\/ holds no saved run/],
  ];
  for (const [name, breakIt, pattern] of cases) {
    const { root, spec } = load();
    breakIt(root);
    const lab = labOf(spec, root);
    assert.equal(isMeasured(lab), false, name);
    assert.throws(() => renderTitle(spec.stages[0], lab), (e: unknown) => {
      assert.ok(e instanceof NotMeasuredError);
      assert.match(e.message, pattern);
      return true;
    }, name);
  }
});

test('resultFile in the spec names the result; the id is only the fallback', () => {
  const { root } = load({ resultFile: 'result-other.md' }, null);
  writeMeasured(root, 'lab/06-models', MEASURED_RESULT.replace('3 of 3', '4 of 4'), 'result-other.md', '06-models');
  const spec = findSpec('06', root);
  assert.match(renderTitle(spec.stages[0], labOf(spec, root)), /4 of 4/);
});

test('formatDate spells the date the way the demo does', () => {
  assert.equal(formatDate('2026-10-06'), '6 Oct 2026');
  assert.equal(formatDate('2026-09-22'), '22 Sep 2026');
});

test('a variant reads its own result file, never the main one', () => {
  const root = tempDir();
  const fix = repoFixture();
  installSpec(root, fix, { labDir: 'lab/01-router', overrides: { id: '01', spec: 'docs/prs/01.md' } });
  installSpec(root, fix, { labDir: 'lab/01-router', file: 'pr-jev.json', overrides: { id: '01-jev', spec: 'docs/prs/01.md', branch: 'keepup/2026-10-22-router-jev' } });
  const jev = findSpec('01-jev', root);
  assert.equal(labOf(jev, root).result, null, 'result.md belongs to the OpenAI path');
  writeMeasured(root, 'lab/01-router', MEASURED_RESULT.replace('3 of 3', '9 of 9'), 'result-jev.md', '01-router-jev');
  assert.match(renderTitle(jev.stages[0], labOf(jev, root)), /9 of 9/);
});
