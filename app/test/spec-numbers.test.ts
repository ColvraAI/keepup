// What a spec may say in numbers: the forms a typed result takes, and the exact numbers a source backs.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { listSpecs, findSpec } from '../src/specs.ts';
import { measuredHits, unsourcedNumbers } from '../src/spec-text.ts';
import { installSpec, repoFixture, specJson, tempDir } from './world.ts';

function rootWithSpec(overrides: Record<string, unknown>): string {
  const root = tempDir();
  installSpec(root, repoFixture(), { overrides });
  return root;
}

const RESULT_FORMS = ['3/3 tests passed', '60/60 messages', '7 days faster', '2.5h saved', '10k requests', '0.92 recall', '40 per cent', 'twice as fast', '90 req/s', '3 tests passed'];

test('the forms a result takes that used to get through are refused in a title', () => {
  const base = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  for (const typed of RESULT_FORMS) {
    assert.throws(() => findSpec('06', rootWithSpec({ stages: [{ ...base[0], title: `Route messages · ${typed}` }] })), /types a measured number/, typed);
  }
});

test('and in a founder line', () => {
  for (const typed of RESULT_FORMS) {
    assert.throws(() => findSpec('06', rootWithSpec({ founderLine: `It is now ${typed}.` })), /founderLine must hold no measured number/, typed);
  }
});

test('a placeholder and a date in a title are still fine', () => {
  const base = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  const title = 'Keep audio uploads working after 26 Feb 2027 · {{lab.title_number}}';
  assert.equal(findSpec('06', rootWithSpec({ stages: [{ ...base[0], title }] })).stages[0].title, title);
  assert.ok(findSpec('06', rootWithSpec({ founderLine: 'Audio stops working on 26 Feb 2027, so this moves it.' })));
});

test('versions, names and links are not read as results', () => {
  for (const text of ['GPT-6.1 Sol', '6.1 Sol', 'Node 20.9', 'transformers 4.3.2', 'v1.5', 'linux/arm64', 'https://example.test/2026/10', 'https://example.test/v1/2', 'half of it', 'double-check it']) {
    assert.deepEqual(measuredHits(text), [], text);
  }
});

test('a number is sourced only when that exact number is listed, not when it is part of one', () => {
  const one = (text: string, listed: string) => unsourcedNumbers(text, [{ text: listed, source: 'https://x.dev' }]);
  assert.deepEqual(one('It costs 25 times normal input.', '1.25 times'), ['25 times']);
  assert.deepEqual(one('It costs 5 times normal input.', '1.25 times'), ['5 times']);
  assert.deepEqual(one('Saves 40%.', '140%'), ['40%']);
  assert.deepEqual(one('A limit of 5 MB.', '25 MB'), ['5 MB']);
  assert.deepEqual(one('It costs 1.25 times normal input.', '1.25 times'), []);
  assert.deepEqual(one('It costs 1.25  TIMES normal input.', '1.25 times'), [], 'case and spacing do not matter');
  assert.deepEqual(one('Reads $0.10 and $1.20.', '$0.20, $1.20, $0.10, $0.40'), [], 'a listed line can hold several numbers');
});

test('a spec with a number that is a suffix of a listed one does not load', () => {
  assert.throws(() => findSpec('06', rootWithSpec({ whyItFits: 'It costs 25 times normal input.', sourcedNumbers: [{ text: '1.25 times', source: 'https://x.dev' }] })), /states 25 times/);
});

test('every real spec loads, and every number in its words is listed with a source', () => {
  const { specs, invalid } = listSpecs(REPO_ROOT);
  assert.deepEqual(invalid, []);
  assert.ok(specs.length >= 7);
});

test("PR 03's cosines and PR 06's context window are listed, pointing at what really holds them", () => {
  const listed = (id: string) => findSpec(id, REPO_ROOT).sourcedNumbers ?? [];
  const sourceOf = (id: string, text: string) => listed(id).find((n) => n.text === text)?.source;
  assert.equal(sourceOf('03', '0.986'), 'lab/03-embeddings/evidence/existing-model-nomic.json');
  assert.equal(sourceOf('03', '0.977'), 'lab/03-embeddings/evidence/existing-model-nomic.json');
  assert.equal(sourceOf('06', '1,050,000'), 'https://developers.openai.com/api/docs/models/gpt-6-sol');
});
