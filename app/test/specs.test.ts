import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { findSpec, listSpecs, loadSpec, looksMeasured, SpecError } from '../src/specs.ts';
import { installSpec, repoFixture, specJson, tempDir, writeJson } from './world.ts';

function rootWithSpec(overrides: Record<string, unknown> = {}): string {
  const root = tempDir();
  installSpec(root, repoFixture(), { overrides });
  return root;
}

test('loadSpec returns a valid spec, with absolute paths to its patches', () => {
  const root = rootWithSpec();
  const spec = findSpec('06', root);
  assert.equal(spec.id, '06');
  assert.equal(spec.stages.length, 2);
  assert.ok(spec.stages[0].patchFiles[0].startsWith(root));
  assert.equal(spec.labDir, join(root, 'lab/06-models'));
});

test('a bad spec names every problem, by field', () => {
  const root = rootWithSpec({
    baseCommit: 'abc123',
    upstream: 'no-slash',
    branch: 'main',
    baseBranch: 'develop',
    sources: [],
    where: [{ path: 'a.js', line: 0 }],
    proof: { vendor: { claim: 'x' }, independent: null },
  });
  assert.throws(() => findSpec('06', root), (e: unknown) => {
    assert.ok(e instanceof SpecError);
    for (const part of ['baseCommit', 'upstream', 'branch', 'baseBranch', 'sources', 'where[0].line', 'proof.vendor.url']) {
      assert.ok(e.message.includes(part), `message should name ${part}: ${e.message}`);
    }
    return true;
  });
});

test('every required field is required', () => {
  const required = ['id', 'spec', 'upstream', 'fork', 'baseCommit', 'baseBranch', 'branch', 'lab', 'source', 'sourceUrl', 'where', 'founderLine', 'effect', 'effort', 'whyItFits', 'risks', 'rollback', 'proof', 'sources', 'stages'];
  for (const field of required) {
    const root = rootWithSpec();
    const json = { ...specJson(repoFixture().baseCommit) };
    delete json[field];
    writeJson(join(root, 'lab/06-models/pr.json'), json);
    assert.throws(() => loadSpec(join(root, 'lab/06-models/pr.json'), root), new RegExp(field), `missing ${field}`);
  }
});

test('effect and effort take only the contract words', () => {
  assert.throws(() => findSpec('06', rootWithSpec({ effect: ['wonderful'] })), /effect must be a list from/);
  assert.throws(() => findSpec('06', rootWithSpec({ effect: [] })), /effect must be a list from/);
  assert.throws(() => findSpec('06', rootWithSpec({ effort: 'a week' })), /effort must be one of: Hours, A day, A project/);
  assert.deepEqual(findSpec('06', rootWithSpec({ effect: ['cheaper', 'faster'], effort: 'A day' })).effect, ['cheaper', 'faster']);
});

test('titleUnmeasured is optional, and can hold no placeholder', () => {
  const stages = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  assert.throws(() => findSpec('06', rootWithSpec({ stages: [{ ...stages[0], titleUnmeasured: 'Add x · {{lab.title_number}}' }] })), /titleUnmeasured can't hold a placeholder/);
  assert.equal(findSpec('06', rootWithSpec({ stages: [{ ...stages[0], titleUnmeasured: 'Add x' }] })).stages[0].titleUnmeasured, 'Add x');
  assert.equal(findSpec('06', rootWithSpec({ stages: [{ ...stages[0], titleUnmeasured: null }] })).stages[0].titleUnmeasured, null);
});

test('stages are checked: date format, real dates, ascending, patches on disk, comments', () => {
  const base = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  const cases: [Record<string, unknown>[], RegExp][] = [
    [[{ ...base[0], date: '22 Sep' }], /stages\[0\]\.date/],
    [[{ ...base[0], date: '2026-02-30' }], /stages\[0\]\.date/],
    [[{ ...base[0], patches: ['patches/missing.patch'] }], /missing\.patch/],
    [[{ ...base[0], patches: ['../../outside.patch'] }], /stays inside/],
    [[{ ...base[0], patches: [] }], /stages\[0\]\.patches/],
    [[{ ...base[0], comment: 'not for the first' }], /stages\[0\]\.comment/],
    [[base[0], { ...base[1], comment: null }], /stages\[1\]\.comment/],
    [[base[1], base[0]], /oldest first/],
    [[{ ...base[0], title: 'Bad {{lab.other}}' }], /placeholder/],
    [[], /stages/],
  ];
  for (const [stages, pattern] of cases) {
    const root = rootWithSpec({ stages });
    assert.throws(() => findSpec('06', root), pattern, String(pattern));
  }
});

test('ciWorkflow, when set, must exist on disk', () => {
  const root = rootWithSpec({ ciWorkflow: 'lab/ci/aura.yml' });
  mkdirSync(join(root, 'lab/ci'), { recursive: true });
  assert.throws(() => findSpec('06', root), /ciWorkflow/);
  writeJson(join(root, 'lab/ci/aura.yml'), {});
  assert.equal(findSpec('06', root).ciWorkflow, 'lab/ci/aura.yml');
});

test('ciWorkflow is the one route to a public repo, so it stays under lab/ci and holds nothing secret', () => {
  for (const path of ['.env', '../outside.pem', 'lab/ci/../../.env', 'lab/ci/sub/x.yml', 'lab/ci/x.pem', '/etc/passwd']) {
    const root = rootWithSpec({ ciWorkflow: path });
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-canary-should-never-leave\n');
    assert.throws(() => findSpec('06', root), /ciWorkflow must be a YAML file directly under lab\/ci/, path);
  }
  const key = rootWithSpec({ ciWorkflow: 'lab/ci/aura.yml' });
  writeJson(join(key, 'lab/ci/aura.yml'), {});
  writeFileSync(join(key, 'lab/ci/aura.yml'), '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
  assert.throws(() => findSpec('06', key), /holds something secret/);
  const token = rootWithSpec({ ciWorkflow: 'lab/ci/aura.yml' });
  writeJson(join(token, 'lab/ci/aura.yml'), {});
  writeFileSync(join(token, 'lab/ci/aura.yml'), 'env:\n  X: sk-canary-should-never-leave\n');
  assert.throws(() => findSpec('06', token), /holds something secret/);
  const link = rootWithSpec({ ciWorkflow: 'lab/ci/aura.yml' });
  writeJson(join(link, 'lab/ci/keep.yml'), {});
  writeFileSync(join(link, 'outside.yml'), 'name: x\n');
  symlinkSync(join(link, 'outside.yml'), join(link, 'lab/ci/aura.yml'));
  assert.throws(() => findSpec('06', link), /points outside lab\/ci/);
});

test('nobody types a number in: titles and founder lines refuse what reads as a result', () => {
  const base = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  const refused: [Record<string, unknown>, RegExp][] = [
    [{ stages: [{ ...base[0], title: 'Route messages · 6.2x faster on 60 test messages' }] }, /types a measured number/],
    [{ stages: [{ ...base[0], title: '40% cheaper · {{lab.title_number}}' }] }, /types a measured number/],
    [{ stages: [{ ...base[0], title: 'Answers on 3 of 3 models' }] }, /types a measured number/],
    [{ stages: [{ ...base[0], titleUnmeasured: 'Add incident integrations · 3 official MCP servers' }] }, /titleUnmeasured must hold no number/],
    [{ stages: [{ ...base[0], titleUnmeasured: 'Route messages · 120ms faster' }] }, /titleUnmeasured must hold no number/],
    [{ founderLine: 'It answers 6.2x faster.' }, /founderLine must hold no measured number/],
  ];
  for (const [overrides, pattern] of refused) assert.throws(() => findSpec('06', rootWithSpec(overrides)), pattern, JSON.stringify(overrides));
  const fine = [
    'Keep audio uploads working after 26 Feb 2027 · whisper-1 → gpt-transcribe',
    'Add GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol to the OpenAI model list · released today',
    'Examples on retired Claude models fail today · move to claude-sonnet-5-5',
    'Add GPT-6 Sol, Luna and 6.1 Sol',
    'EmbeddingGemma 2 for the native embedder',
    'Move the native embedder to @huggingface/transformers, ready for EmbeddingGemma 2',
  ];
  for (const title of fine) {
    assert.equal(findSpec('06', rootWithSpec({ stages: [{ ...base[0], title, titleUnmeasured: title }] })).stages[0].title, title);
  }
});

test('findSpec finds the 01-jev variant in pr-jev.json', () => {
  const root = tempDir();
  const fix = repoFixture();
  installSpec(root, fix, { labDir: 'lab/01-router', overrides: { id: '01', spec: 'docs/prs/01.md' } });
  installSpec(root, fix, { labDir: 'lab/01-router', file: 'pr-jev.json', overrides: { id: '01-jev', spec: 'docs/prs/01.md', branch: 'keepup/2026-10-22-router-jev' } });
  assert.equal(findSpec('01-jev', root).branch, 'keepup/2026-10-22-router-jev');
  assert.equal(findSpec('01', root).id, '01');
});

test('findSpec says what exists when an id is unknown', () => {
  const root = rootWithSpec();
  assert.throws(() => findSpec('99', root), /No pull request spec for 99.*06/s);
});

test('listSpecs sorts oldest first and reports a broken file without hiding the good ones', () => {
  const root = tempDir();
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(root, fix, { labDir: 'lab/02-later', overrides: { id: '02', stages: [{ ...stages[0], date: '2026-10-01' }] } });
  installSpec(root, fix, { labDir: 'lab/06-models' });
  writeFileSync(join(root, 'lab/06-models/pr-broken.json'), '{ not json');
  const { specs, invalid } = listSpecs(root);
  assert.deepEqual(specs.map((s) => s.id), ['06', '02']);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].message, /pr-broken\.json/);
});

test('listSpecs is empty when no lab has a spec yet', () => {
  const root = tempDir();
  assert.deepEqual(listSpecs(root), { specs: [], invalid: [] });
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(listSpecs(root), { specs: [], invalid: [] });
});

test('two files claiming one id is an error', () => {
  const root = tempDir();
  const fix = repoFixture();
  installSpec(root, fix);
  installSpec(root, fix, { labDir: 'lab/06-copy' });
  assert.throws(() => findSpec('06', root), /more than one/);
});

test('no two real pull requests share a base branch, so merging one can never conflict another', () => {
  const { specs, invalid } = listSpecs(REPO_ROOT);
  assert.deepEqual(invalid, []);
  const bases = specs.map((s) => `${s.fork}/${s.baseBranch}`);
  assert.equal(new Set(bases).size, bases.length, bases.join('\n'));
});

test('every form of a typed result is refused in a title and a founder line', () => {
  const base = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  for (const typed of ['cost -40%', 'latency -120ms', 'x6 faster', '×6 faster', '120 milliseconds faster', '3 out of 3', '6.2-fold faster', '1.5s faster', '40 pct', '0.02 USD', '6.2x', '40%', '120ms', '3 of 3', '$0.02', '3.5 GB']) {
    assert.throws(() => findSpec('06', rootWithSpec({ stages: [{ ...base[0], title: `Route messages · ${typed}` }] })), /types a measured number/, typed);
    assert.throws(() => findSpec('06', rootWithSpec({ founderLine: `It is ${typed}.` })), /founderLine must hold no measured number/, typed);
  }
});

test('names, versions and dates are not results', () => {
  for (const text of ['whisper-1', 'GPT-6.1 Sol', 'linux-x64', 'on x64 and x86', 'claude-sonnet-5-5', '4.3.2', '26 Feb 2027', '6 Oct', 'EmbeddingGemma 2', '100+ languages', '768 dimensions']) assert.equal(looksMeasured(text), false, text);
});

test('free text can state a number only with where it came from', () => {
  const base = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  const sourced = [{ text: '1.25 times', source: 'https://developers.openai.com/api/docs/guides/prompt-caching' }];
  const cases: [Record<string, unknown>, string][] = [
    [{ whyItFits: 'It costs 1.25 times normal input.' }, 'whyItFits'],
    [{ risks: 'A batch ran a 3.5 GB container out of memory.' }, 'risks'],
    [{ rollback: 'Takes 2 minutes to revert.' }, 'rollback'],
    [{ stages: [{ ...base[0], whatShipped: 'It answers 6.2x faster.' }] }, 'stages[0].whatShipped'],
    [{ stages: [{ ...base[0], whatThisChanges: 'Saves 40% on calls.' }] }, 'stages[0].whatThisChanges'],
    [{ stages: [base[0], { ...base[1], comment: 'Now 40% cheaper.' }] }, 'stages[1].comment'],
  ];
  for (const [overrides, field] of cases) assert.throws(() => findSpec('06', rootWithSpec(overrides)), new RegExp(`${field.replace(/[[\]]/g, '\\$&')} states .*which nothing backs`), field);
  assert.equal(findSpec('06', rootWithSpec({ risks: 'A write costs 1.25 times normal input.', sourcedNumbers: sourced })).sourcedNumbers?.[0].text, '1.25 times');
  assert.throws(() => findSpec('06', rootWithSpec({ risks: 'A write costs 1.25 times and 40% more.', sourcedNumbers: sourced })), /states 40%/);
});

test('a listed number has to say where from, and that place has to exist', () => {
  assert.throws(() => findSpec('06', rootWithSpec({ sourcedNumbers: [{ text: '40%' }] })), /sourcedNumbers\[0\] must be/);
  assert.throws(() => findSpec('06', rootWithSpec({ sourcedNumbers: [{ text: '40%', source: 'lab/nowhere.log' }] })), /must be a URL or a file in this repo/);
  assert.throws(() => findSpec('06', rootWithSpec({ sourcedNumbers: 'x' })), /sourcedNumbers must be a list/);
});

test('a reference that lands on someone else\'s timeline is refused, wherever it is', () => {
  const base = specJson(repoFixture().baseCommit).stages as Record<string, unknown>[];
  const refs = ['https://github.com/huggingface/transformers.js/pull/1804', 'github.com/mezmo/aura/issues/4', 'https://github.com/a/b/discussions/9', 'huggingface/transformers.js#1804', 'fixes #12', 'Closes mezmo/aura#3', 'resolved #9'];
  for (const ref of refs) {
    assert.throws(() => findSpec('06', rootWithSpec({ risks: `See ${ref}.` })), /risks references .*timeline/, ref);
    assert.throws(() => findSpec('06', rootWithSpec({ sources: [`https://x.test/`, ref.startsWith('http') ? ref : 'https://x.test/2'], stages: [{ ...base[0], whatShipped: `See ${ref}.` }] })), /references .*timeline/, ref);
  }
  const fine = ['https://redirect.github.com/huggingface/transformers.js/pull/1804', 'https://github.com/huggingface/transformers.js/releases/tag/4.3.2', 'https://github.com/Mintplex-Labs/anything-llm/commit/5edf32b9', 'https://developers.openai.com/api/docs/deprecations#2026-08-26-transcription-models'];
  assert.deepEqual(findSpec('06', rootWithSpec({ sources: fine })).sources, fine);
});

function patchWith(root: string, change: (text: string) => string): void {
  const file = join(root, 'lab/06-models/patches/0001.patch');
  writeFileSync(file, change(readFileSync(file, 'utf8')));
}

test('a patch message may not reference someone else\'s pull request either, though its diff can say anything', () => {
  const root = rootWithSpec();
  patchWith(root, (t) => t.replace('\n---\n', '\nhttps://github.com/huggingface/transformers.js/pull/1804\n---\n'));
  assert.throws(() => findSpec('06', root), /the message of patches\/0001\.patch references https:\/\/github\.com\/huggingface.*timeline/);
  const inDiff = rootWithSpec();
  patchWith(inDiff, (t) => t.replace('+  { name: "GPT-6 Sol", id: "gpt-6-sol" },', '+  { name: "GPT-6 Sol", id: "gpt-6-sol" }, // https://github.com/a/b/pull/1'));
  assert.equal(findSpec('06', inDiff).id, '06');
});

test('a patch with a secret in it does not load', () => {
  const root = rootWithSpec();
  patchWith(root, (t) => t.replace('\n---\n', '\nsk-canary-in-patch-0123456789\n---\n'));
  assert.throws(() => findSpec('06', root), (e: unknown) => e instanceof SpecError && /holds something secret/.test(e.message) && !e.message.includes('sk-canary'));
});

test('every real spec passes all of this, and links through nothing that leaves a mark', () => {
  const { specs, invalid } = listSpecs(REPO_ROOT);
  assert.deepEqual(invalid, []);
  assert.ok(specs.length >= 7);
});

test('a spec that names another lab can\'t borrow its numbers', () => {
  const root = tempDir();
  installSpec(root, repoFixture(), { labDir: 'lab/06-models', overrides: { lab: 'lab/01-router' } });
  assert.throws(() => loadSpec(join(root, 'lab/06-models/pr.json'), root), /lab must be lab\/06-models, got lab\/01-router/);
});

test('a fork name can\'t climb out of the org, encoded or not', () => {
  for (const fork of ['%2e%2e/mezmo/aura', '../mezmo/aura', 'mezmo/aura', 'a b']) {
    assert.throws(() => findSpec('06', rootWithSpec({ fork })), /fork must be a bare repository name/, fork);
  }
});
