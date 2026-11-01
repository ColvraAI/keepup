import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NeedsKeyError, parseEnvFile, requireKeys } from './env.ts';
import { costUsd, openRouterPrice } from './prices.ts';
import { parseResult, readResult, renderResult, validateResult, writeResult, type LabResult } from './result.ts';
import { accuracy, mean, median, percentile } from './stats.ts';

test('parseEnvFile reads plain, quoted and commented lines, and drops empty values', () => {
  assert.deepEqual(parseEnvFile(`# a comment\nA=1\nB="two words"\nC='x=y'\nEMPTY=\nnot a line\n`), { A: '1', B: 'two words', C: 'x=y' });
});

test('requireKeys names what is missing and never includes a value', () => {
  assert.throws(() => requireKeys(['X', 'Y'], { X: 'secret' }), (e: unknown) => {
    assert.ok(e instanceof NeedsKeyError);
    assert.deepEqual(e.keys, ['Y']);
    assert.ok(!e.message.includes('secret'));
    return true;
  });
  assert.deepEqual(requireKeys(['X'], { X: 'v' }), { X: 'v' });
});

test('percentile uses nearest rank', () => {
  const v = [5, 1, 4, 2, 3];
  assert.equal(percentile(v, 50), 3);
  assert.equal(percentile(v, 95), 5);
  assert.equal(percentile(v, 100), 5);
  assert.throws(() => percentile([], 50));
});

test('median averages the middle pair on an even count', () => {
  assert.equal(median([22, 35, 28]), 28);
  assert.equal(median([35, 28]), 31.5);
});

test('mean and accuracy', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(accuracy([{ predicted: 'a', expected: 'a' }, { predicted: null, expected: 'b' }]), 0.5);
});

const measured: LabResult = { lab: '01-router', status: 'measured', measured_at: '2026-11-01', title_number: '6.2x faster on 60 test messages', body: '| a | b |\n| - | - |' };

test('result.md round-trips', () => {
  assert.deepEqual(parseResult(renderResult(measured)), { ...measured, needs: undefined });
});

test('a lab that did not run cannot carry a number or a date', () => {
  assert.throws(() => validateResult({ lab: 'x', status: 'not_run', needs: 'KEY', title_number: '2x', body: '' }));
  assert.throws(() => validateResult({ lab: 'x', status: 'not_run', needs: 'KEY', measured_at: '2026-11-01', body: '' }));
});

test('a partial lab cannot put a number in a title, and must say what it needs', () => {
  assert.throws(() => validateResult({ lab: 'x', status: 'partial', measured_at: '2026-11-01', needs: 'KEY', title_number: '2x', body: '' }));
  assert.throws(() => validateResult({ lab: 'x', status: 'partial', measured_at: '2026-11-01', body: '' }));
});

test('writeResult never lets a weaker result replace a stronger one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-result-'));
  const path = join(dir, 'result.md');
  writeResult(path, measured);
  const before = readFileSync(path, 'utf8');
  const kept = writeResult(path, { lab: '01-router', status: 'not_run', needs: 'OPENAI_API_KEY', body: 'Waiting on a key.' });
  assert.equal(kept.status, 'measured');
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readResult(join(dir, 'nothing.md')), null);
});

test('writeResult lets a stronger result replace a weaker one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-result-'));
  const path = join(dir, 'result.md');
  writeFileSync(path, renderResult({ lab: '01-router', status: 'not_run', needs: 'OPENAI_API_KEY', body: 'Waiting.' }));
  assert.equal(writeResult(path, measured).status, 'measured');
  assert.equal(readResult(path)?.title_number, measured.title_number);
});

test('prices come from data/db and an unknown model throws instead of guessing', () => {
  const sol = openRouterPrice('openai/gpt-6.1-sol');
  assert.equal(sol.inputPerMTok, 2);
  assert.ok(sol.source.includes('openrouter.ai'));
  assert.throws(() => openRouterPrice('openai/not-a-model'));
});

test('costUsd is tokens times the price per million', () => {
  assert.equal(costUsd({ inputPerMTok: 0.1, outputPerMTok: 0.5 }, { input: 1_000_000, output: 2_000_000 }), 1.1);
});
