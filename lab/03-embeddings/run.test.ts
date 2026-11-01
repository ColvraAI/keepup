import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { patchMessage } from '../../app/src/spec-text.ts';
import { loadSpec } from '../../app/src/specs.ts';
import { hasPlaceholder, renderTitle } from '../../app/src/template.ts';
import { REPO_ROOT } from '../shared/env.ts';
import { manifestProblem, parseResult, readResult, renderResult } from '../shared/result.ts';
import { corpusSubset, parseCorpus, parseQrels, parseQueries, passageText, selectQueries, tinyCorpus } from './dataset.ts';
import { rankByCosine, recallAtK, reciprocalRankAtK } from './metrics.ts';
import { buildResult, checkCompat, CONTROL, MODELS, NOT_RUN_SENTENCE, rankAll, score, scrubSecrets, secondsForPassages, titleNumber, type Compat, type ModelRun } from './report.ts';
import { commandFor, main, pathsFor, pickTestSet, FULL_PASSAGES, FULL_QUERIES, TINY, type Deps, type RawDataset, type Step, type Paths } from './run.ts';

const LAB_DIR = import.meta.dirname;
const HARNESS = join(LAB_DIR, 'harness', 'embed.cjs');
const FAKE_EMBEDDER = join(LAB_DIR, 'harness', 'fake-embedder.cjs');
const CLONE = join(REPO_ROOT, 'tmp', 'anything-llm');
const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const pr = JSON.parse(readFileSync(join(LAB_DIR, 'pr.json'), 'utf8'));

const tempRoots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

// ---- metrics, against hand-worked answers

test('rankByCosine orders by cosine, ignores length, and breaks ties by the earlier row', () => {
  const matrix = new Float32Array([0, 1, /* row 1, same direction as the query */ 2, 0, /* row 2, 45 degrees */ 1, 1, /* row 3, tie with row 1 */ 5, 0]);
  const top = rankByCosine(new Float32Array([1, 0]), matrix, 2, 3);
  assert.deepEqual(top.map((t) => t.index), [1, 3, 2]);
  assert.ok(Math.abs(top[2].score - Math.SQRT1_2) < 1e-6);
});

test('rankByCosine refuses mismatched dimensions and zero vectors', () => {
  assert.throws(() => rankByCosine(new Float32Array([1, 0, 0]), new Float32Array([1, 0]), 2, 1), /3 dimensions/);
  assert.throws(() => rankByCosine(new Float32Array([0, 0]), new Float32Array([1, 0]), 2, 1), /all zeros/);
  assert.throws(() => rankByCosine(new Float32Array([1, 0]), new Float32Array([0, 0]), 2, 1), /row 0/);
});

test('recall@k counts the share of relevant documents in the top k', () => {
  const relevant = new Set(['a', 'b', 'c', 'd']);
  assert.equal(recallAtK(['a', 'x', 'b', 'y', 'z', 'c'], relevant, 5), 0.5);
  assert.equal(recallAtK(['x'], new Set(['a']), 5), 0);
  assert.throws(() => recallAtK(['a'], new Set(), 5), /at least one/);
});

test('reciprocal rank uses the first relevant document within k', () => {
  assert.equal(reciprocalRankAtK(['x', 'a', 'b'], new Set(['a', 'b']), 10), 0.5);
  assert.equal(reciprocalRankAtK(['x', 'y', 'a'], new Set(['a']), 2), 0);
  assert.equal(reciprocalRankAtK(['a'], new Set(['a']), 10), 1);
});

test('score averages over queries', () => {
  const qrels = new Map([['1', new Set(['a'])], ['2', new Set(['b', 'c'])]]);
  const rankings = [
    { query: '1', top: [{ id: 'x', score: 1 }, { id: 'a', score: 0.5 }] },
    { query: '2', top: [{ id: 'b', score: 1 }] },
  ];
  assert.deepEqual(score(rankings, qrels, 9), { recallAt5: (1 + 0.5) / 2, mrrAt10: (0.5 + 1) / 2, queries: 2, passages: 9 });
  assert.throws(() => score([{ query: '3', top: [] }], qrels, 9), /query 3/);
});

test('rankAll refuses vectors that do not match the test set', () => {
  assert.throws(() => rankAll(new Float32Array(2), new Float32Array(2), 2, [{ id: '1', text: '' }, { id: '2', text: '' }], ['a']), /query vectors/);
  assert.throws(() => rankAll(new Float32Array([1, 0]), new Float32Array(2), 2, [{ id: '1', text: '' }], ['a', 'b']), /passage vectors/);
});

test('the time for 1,000 passages adds whole segments and is null when fewer ran', () => {
  const segmentMs = [{ passages: 500, ms: 1000 }, { passages: 500, ms: 3000 }, { passages: 500, ms: 9000 }];
  assert.equal(secondsForPassages({ segmentMs }), 4);
  assert.equal(secondsForPassages({ segmentMs: segmentMs.slice(0, 1) }), null);
});

// ---- the dataset

const CORPUS = ['10', '20', '30', '40'].map((id) => JSON.stringify({ _id: id, title: `T${id}`, text: `body ${id}`, metadata: {} })).join('\n');
const QUERIES = ['100', '9', '20', '7'].map((id) => JSON.stringify({ _id: id, text: `claim ${id}` })).join('\n');
const QRELS = 'query-id\tcorpus-id\tscore\n9\t10\t1\n20\t30\t1\n100\t40\t1\n7\t99\t1\n';

test('queries sort by numeric id, and a query with no relevant document in the corpus is left out', () => {
  const picked = selectQueries(parseQueries(QUERIES), parseQrels(QRELS), parseCorpus(CORPUS), 3);
  assert.deepEqual(picked.map((q) => q.id), ['9', '20', '100']);
  assert.throws(() => selectQueries(parseQueries(QUERIES), parseQrels(QRELS), parseCorpus(CORPUS), 4), /only 3 usable/);
});

test('qrels need their header and drop a score of 0', () => {
  assert.throws(() => parseQrels('1\t2\t1\n'), /header/);
  assert.deepEqual([...parseQrels('query-id\tcorpus-id\tscore\n1\t2\t0\n1\t3\t1\n').get('1') ?? []], ['3']);
});

test('the tiny corpus keeps relevant documents, corpus order and its size', () => {
  const corpus = parseCorpus(CORPUS);
  const tiny = tinyCorpus(corpus, [{ id: '20', text: '' }], parseQrels(QRELS), 2);
  assert.deepEqual(tiny.map((d) => d.id), ['10', '30']);
});

const docs = (ids: string[]) => parseCorpus(ids.map((id) => JSON.stringify({ _id: id, title: `T${id}`, text: `body ${id}` })).join('\n'));

test('the subset is every relevant passage, then the lowest-id others, up to its size', () => {
  const qrels = parseQrels('query-id\tcorpus-id\tscore\n1\t900\t1\n1\t7\t1\n2\t500\t1\n3\t800\t1\n');
  const queries = [{ id: '1', text: '' }, { id: '2', text: '' }];
  const subset = corpusSubset(docs(['10', '500', '9', '900', '7', '800', '100']), queries, qrels, 5);
  assert.deepEqual(subset.map((d) => d.id), ['7', '9', '10', '500', '900'], '800 is only relevant to a query that was not picked');
});

test('the subset does not depend on the file order, and a small corpus comes back whole', () => {
  const qrels = parseQrels('query-id\tcorpus-id\tscore\n1\t30\t1\n');
  const queries = [{ id: '1', text: '' }];
  const a = corpusSubset(docs(['30', '10', '20', '40']), queries, qrels, 3).map((d) => d.id);
  const b = corpusSubset(docs(['40', '20', '30', '10']), queries, qrels, 3).map((d) => d.id);
  assert.deepEqual(a, ['10', '20', '30']);
  assert.deepEqual(b, a);
  assert.equal(corpusSubset(docs(['30', '10']), queries, qrels, 1000).length, 2);
});

test('the subset refuses to drop a relevant passage', () => {
  const qrels = parseQrels('query-id\tcorpus-id\tscore\n1\t1\t1\n1\t2\t1\n1\t3\t1\n');
  assert.throws(() => corpusSubset(docs(['1', '2', '3']), [{ id: '1', text: '' }], qrels, 2), /3 relevant passages/);
});

test('a passage is the title then the text', () => {
  assert.equal(passageText({ id: '1', title: 'A', text: 'b' }), 'A b');
  assert.equal(passageText({ id: '1', title: '', text: 'b' }), 'b');
});

// ---- the harness, on the host, with the fake embedder

function harnessFixture(): { input: string; out: string } {
  const dir = tempRoot('lab03-harness-');
  const input = join(dir, 'input');
  mkdirSync(input);
  writeFileSync(join(input, 'passages.jsonl'), Array.from({ length: 6 }, (_, i) => JSON.stringify({ id: String(i), text: `passage ${i}` })).join('\n'));
  writeFileSync(join(input, 'queries.jsonl'), Array.from({ length: 2 }, (_, i) => JSON.stringify({ id: String(i), text: `query ${i}` })).join('\n'));
  return { input, out: join(dir, 'out') };
}

function runHarness(fixture: { input: string; out: string }, env: Record<string, string> = {}, extra: string[] = []): number {
  const run = spawnSync(process.execPath, [HARNESS, '--model', 'fake/model', '--input', fixture.input, '--out', fixture.out, '--segment', '2', '--embedder', FAKE_EMBEDDER, ...extra], { encoding: 'utf8', env: { ...process.env, ...env } });
  return run.status ?? -1;
}

const readProgress = (out: string) => JSON.parse(readFileSync(join(out, 'progress.json'), 'utf8'));

test('the harness embeds everything, records its memory and uses the model\'s prefixes', () => {
  const fixture = harnessFixture();
  assert.equal(runHarness(fixture), 0);
  const progress = readProgress(fixture.out);
  assert.equal(progress.passages, 6);
  assert.equal(progress.queries, 2);
  assert.equal(progress.dim, 4);
  assert.ok(progress.peakRssKb > 0);
  assert.equal(progress.machine.node, process.version);
  assert.equal(progress.chunkChars, 1000);
  assert.equal(statSync(join(fixture.out, 'passages.f32')).size, 6 * 4 * 4);
  assert.equal(statSync(join(fixture.out, 'queries.f32')).size, 2 * 4 * 4);
});

test('a crash loses at most a segment, and the next run resumes with the same vectors', () => {
  const clean = harnessFixture();
  assert.equal(runHarness(clean), 0);
  const crashed = harnessFixture();
  assert.equal(runHarness(crashed, { FAKE_EMBEDDER_CRASH_AFTER: '3' }), 1);
  assert.equal(readProgress(crashed.out).passages, 2);
  assert.equal(runHarness(crashed), 0);
  const progress = readProgress(crashed.out);
  assert.equal(progress.passages, 6);
  assert.equal(progress.sessions, 2);
  assert.equal(progress.segmentMs.length, 3);
  assert.deepEqual(readFileSync(join(crashed.out, 'passages.f32')), readFileSync(join(clean.out, 'passages.f32')));
});

test('a resume cuts bytes written after the last checkpoint', () => {
  const clean = harnessFixture();
  assert.equal(runHarness(clean), 0);
  const torn = harnessFixture();
  assert.equal(runHarness(torn, { FAKE_EMBEDDER_CRASH_AFTER: '3' }), 1);
  writeFileSync(join(torn.out, 'passages.f32'), Buffer.concat([readFileSync(join(torn.out, 'passages.f32')), Buffer.alloc(7, 1)]));
  assert.equal(runHarness(torn), 0);
  assert.deepEqual(readFileSync(join(torn.out, 'passages.f32')), readFileSync(join(clean.out, 'passages.f32')));
});

test('an out-of-budget session exits with 75 and keeps its checkpoint', () => {
  const fixture = harnessFixture();
  assert.equal(runHarness(fixture, { FAKE_EMBEDDER_DELAY_MS: '50' }, ['--budget-min', '0.0005']), 75);
  assert.ok(readProgress(fixture.out).passages < 6);
  assert.equal(runHarness(fixture), 0);
  assert.equal(readProgress(fixture.out).passages, 6);
});

test('a session does not start a segment longer than the budget it has left', () => {
  const fixture = harnessFixture();
  assert.equal(runHarness(fixture, { FAKE_EMBEDDER_DELAY_MS: '1000' }, ['--budget-min', '0.025']), 75);
  assert.equal(readProgress(fixture.out).passages, 2, 'a second segment as long as the first would run past the 1.5 s budget');
  assert.equal(runHarness(fixture), 0);
  assert.equal(readProgress(fixture.out).passages, 6);
});

test('a session always gets one segment done, however long the last one took', () => {
  const fixture = harnessFixture();
  assert.equal(runHarness(fixture, { FAKE_EMBEDDER_DELAY_MS: '1000' }, ['--budget-min', '0.025']), 75);
  assert.equal(readProgress(fixture.out).passages, 2);
  runHarness(fixture, {}, ['--budget-min', '0.001']);
  assert.ok(readProgress(fixture.out).passages > 2, 'the last segment took longer than this whole budget, and it still moved on');
});

test('a long passage goes alone and order is kept, so one long text can\'t pad a whole batch', () => {
  const require = createRequire(import.meta.url);
  const { splitLongTexts } = require('./harness/embed.cjs');
  assert.deepEqual(splitLongTexts(['a', 'b', 'xxxxxx', 'c', 'yyyyyy', 'zzzzzz', 'd'], 3), [['a', 'b'], ['xxxxxx'], ['c'], ['yyyyyy'], ['zzzzzz'], ['d']]);
  assert.deepEqual(splitLongTexts(['a', 'b'], 3), [['a', 'b']]);
  assert.deepEqual(splitLongTexts([], 3), []);
});

test('the harness refuses to measure the wrong model', () => {
  const fixture = harnessFixture();
  const embedder = join(fixture.input, 'wrong.cjs');
  writeFileSync(embedder, 'module.exports = { NativeEmbedder: class { constructor() { this.model = "Xenova/all-MiniLM-L6-v2"; } } };');
  const run = spawnSync(process.execPath, [HARNESS, '--model', 'fake/model', '--input', fixture.input, '--out', fixture.out, '--embedder', embedder], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /embedder chose Xenova/);
});

// ---- the whole run, with a fake sandbox

const comparison = (minCosine: number) => ({ n: 3, oldDim: 4, newDim: 4, minCosine, meanCosine: minCosine });
const existingModel = (model: string) => ({ model, chunkChars: 1000, tokens: { texts: 6, differing: 0 }, chunks: comparison(0.995), queries: comparison(0.996) });

const goodCompat: Compat = {
  parity: { n: 3, oldDim: 4, newDim: 4, minCosine: 0.99999, meanCosine: 0.99999, chunkChars: 1000, wholePassageMinCosine: 0.997, wholePassageMeanCosine: 0.998 },
  oldFirst: { dim: 4, rerankScores: [0.9] },
  newFirst: { dim: 4, rerankScores: [0.9] },
  reuse: { n: 2, oldDim: 4, newDim: 4, minCosine: 0.99999, offline: true },
  batching: {
    batch: 25,
    tokens: { texts: 7, differing: 0 },
    runtimeAlone: comparison(0.91),
    runtimeBatched: comparison(0.92),
    batchingOld: comparison(0.93),
    batchingNew: comparison(0.94),
    repeatNew: comparison(0.95),
    queriesRuntimeAlone: comparison(0.96),
  },
  nomic: existingModel('Xenova/nomic-embed-text-v1'),
  e5: existingModel('MintplexLabs/multilingual-e5-small'),
};

function fakeDataset(queries = 210, passages = 30): RawDataset {
  return {
    corpus: Array.from({ length: passages }, (_, i) => JSON.stringify({ _id: String(i), title: `t${i}`, text: `text ${i}` })).join('\n'),
    queries: Array.from({ length: queries }, (_, i) => JSON.stringify({ _id: String(i), text: `claim ${i}` })).join('\n'),
    qrelsTest: `query-id\tcorpus-id\tscore\n${Array.from({ length: queries }, (_, i) => `${i}\t${i % passages}\t1`).join('\n')}\n`,
    sha256: 'abc',
    licence: `Claims CC BY 4.0, and a pasted key ${FAKE_KEY} that must not survive.`,
  };
}

/** Real harness code, fake embedder and fake compat answers: the run's whole shape with no Docker. */
function fakeSandbox(steps: Step[], failModel: string | null = null) {
  return async (step: Step, paths: Paths): Promise<number> => {
    steps.push(step);
    if (step.kind === 'install') return 0;
    if (step.kind === 'compat') {
      const key = { parity: 'parity', 'old-first': 'oldFirst', 'new-first': 'newFirst', reuse: 'reuse', batching: 'batching', nomic: 'nomic', e5: 'e5' }[step.check] as keyof Compat;
      writeFileSync(step.outFile, JSON.stringify(goodCompat[key]));
      return 0;
    }
    if (step.model === failModel) return 137;
    const run = spawnSync(process.execPath, [HARNESS, '--model', step.model, '--input', paths.input, '--out', step.outDir, '--segment', String(step.segment), '--embedder', FAKE_EMBEDDER], { encoding: 'utf8' });
    return run.status ?? 1;
  };
}

function fakeRoot(): { root: string; lab: string; deps: (over?: Partial<Deps>) => Deps; steps: Step[]; logs: string[]; removed: string[] } {
  const root = tempRoot('lab03-run-');
  const lab = join(root, 'lab', '03-embeddings');
  mkdirSync(lab, { recursive: true });
  const steps: Step[] = [];
  const logs: string[] = [];
  const removed: string[] = [];
  const base: Deps = {
    paths: (dry) => pathsFor(dry, lab, root),
    sandbox: fakeSandbox(steps),
    prepareTree: () => {},
    removeTree: (paths) => removed.push(paths.tree),
    dataset: async () => fakeDataset(),
    dockerAvailable: () => true,
    env: { OPENAI_API_KEY: FAKE_KEY },
    today: () => '2026-11-01',
    log: (line) => logs.push(line),
  };
  return { root, lab, steps, logs, removed, deps: (over = {}) => ({ ...base, ...over }) };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

test('the dry run writes only under lab/.work/03-embeddings/dry-run, and never result.md or out/', async () => {
  const { root, lab, deps, steps, logs } = fakeRoot();
  const measured = renderResult({ lab: '03-embeddings', status: 'measured', measured_at: '2026-10-31', title_number: 'recall@5 0.1 → 0.2 on SciFact', body: '| | a |' });
  writeFileSync(join(lab, 'result.md'), measured);
  assert.equal(await main(['--dry-run'], deps()), 0);
  assert.equal(readFileSync(join(lab, 'result.md'), 'utf8'), measured);
  assert.equal(existsSync(join(lab, 'out')), false);
  const outside = filesUnder(root).filter((f) => !relative(root, f).startsWith(join('lab', '.work', '03-embeddings', 'dry-run')) && f !== join(lab, 'result.md'));
  assert.deepEqual(outside, []);
  const dry = join(root, 'lab', '.work', '03-embeddings', 'dry-run');
  assert.equal(readFileSync(join(dry, 'input', 'passages.jsonl'), 'utf8').trim().split('\n').length, TINY.passages);
  assert.equal(readFileSync(join(dry, 'input', 'queries.jsonl'), 'utf8').trim().split('\n').length, TINY.queries);
  assert.ok(existsSync(join(dry, 'out', 'summary.md')));
  assert.deepEqual(steps.filter((s) => s.kind === 'embed').map((s) => (s as { model: string }).model), [...MODELS.map((m) => m.id), CONTROL.id]);
  assert.ok(logs.some((l) => l.includes('full run plan')));
  assert.ok(logs.some((l) => l.includes('allenai/scifact')), 'the licence is printed');
});

test('the dry run removes its worktree, and a full run keeps its own for the next session', async () => {
  const dry = fakeRoot();
  assert.equal(await main(['--dry-run'], dry.deps()), 0);
  assert.deepEqual(dry.removed, [join(dry.root, 'lab', '.work', '03-embeddings', 'dry-run', 'tree')]);
  const failing = fakeRoot();
  await assert.rejects(() => main(['--dry-run'], failing.deps({ sandbox: async () => 1 })), /failed with exit code 1/);
  assert.equal(failing.removed.length, 1, 'a dry run that fails leaves no worktree either');
  const full = fakeRoot();
  assert.equal(await main([], full.deps()), 0);
  assert.deepEqual(full.removed, []);
});

test('the dry run plans the full run on the subset, not the whole corpus', async () => {
  const { deps, logs } = fakeRoot();
  assert.equal(await main(['--dry-run'], deps({ dataset: async () => fakeDataset(210, FULL_PASSAGES + 200) })), 0);
  const plan = logs.find((l) => l.includes('full run plan')) ?? '';
  assert.match(plan, new RegExp(`ms × ${FULL_PASSAGES} \\+`));
  assert.doesNotMatch(plan, new RegExp(`× ${FULL_PASSAGES + 200}`));
});

test('MiniLM, its control on the old package and EmbeddingGemma 2 each run in their own sandbox process', async () => {
  const { deps, steps } = fakeRoot();
  assert.equal(await main([], deps()), 0);
  const embeds = steps.filter((s) => s.kind === 'embed') as Extract<Step, { kind: 'embed' }>[];
  assert.deepEqual(embeds.map((s) => [s.model, s.oldPackage]), [['Xenova/all-MiniLM-L6-v2', false], ['Xenova/all-MiniLM-L6-v2', true], ['onnx-community/embeddinggemma-2-ONNX', false]]);
  assert.equal(new Set(embeds.map((s) => s.outDir)).size, 3);
});

test('a full run writes a measured result with a computed title number, and scrubs keys from raw outputs', async () => {
  const { lab, deps } = fakeRoot();
  assert.equal(await main([], deps()), 0);
  const result = parseResult(readFileSync(join(lab, 'result.md'), 'utf8'));
  assert.equal(result.status, 'measured');
  assert.equal(result.measured_at, '2026-11-01');
  assert.match(result.title_number ?? '', /^recall@5 \d\.\d{3} → \d\.\d{3} on a 30-passage SciFact subset$/);
  assert.match(result.body, /\| recall@5 \|/);
  assert.match(result.body, /Same default: all-MiniLM-L6-v2 scores recall@5 \d\.\d{3} on the old package and \d\.\d{3} on the new one, and \d\.\d{3} when documents/);
  assert.match(result.body, /Each passage was embedded whole, with no text splitter, for both models/);
  assert.match(result.body, /not the chunked path the product uses/);
  const out = filesUnder(join(lab, 'out'));
  for (const name of ['compat-batching.json', 'dataset.json', 'rankings-minilm.jsonl', 'rankings-embeddinggemma-2.jsonl', 'run-minilm.json', 'compat-parity.json']) {
    assert.ok(out.some((f) => f.endsWith(name)), `${name} was saved`);
  }
  for (const file of out) assert.ok(!readFileSync(file, 'utf8').includes(FAKE_KEY), `${file} has a key in it`);
  const note = JSON.parse(readFileSync(join(lab, 'out', 'dataset.json'), 'utf8'));
  assert.match(note.licence, /\[scrubbed\]/);
  assert.equal(note.queries.length, FULL_QUERIES);
});

test('a full run embeds the subset, and says so in the title, the table and the notes', async () => {
  const { lab, deps, root } = fakeRoot();
  const passages = FULL_PASSAGES + 200;
  assert.equal(await main([], deps({ dataset: async () => fakeDataset(210, passages) })), 0);
  const written = readFileSync(join(root, 'lab', '.work', '03-embeddings', 'full', 'input', 'passages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
  assert.equal(written.length, FULL_PASSAGES);
  const result = parseResult(readFileSync(join(lab, 'result.md'), 'utf8'));
  assert.match(result.title_number ?? '', /^recall@5 \d\.\d{3} → \d\.\d{3} on a 1,000-passage SciFact subset$/);
  assert.match(result.body, /\| test set \| 200 queries against every passage relevant to them \(200\), plus the lowest-id other passages up to 1,000 \| same \|/);
  assert.match(result.body, /against a 1,000-passage SciFact subset: every passage relevant to those queries \(200\), plus the 800 lowest-id other passages, out of 1,200 in the corpus/);
  assert.match(result.body, /Recall on a subset isn't comparable to published SciFact scores, which search the whole corpus\./);
  assert.doesNotMatch(result.body, /against all /);
  const note = JSON.parse(readFileSync(join(lab, 'out', 'dataset.json'), 'utf8'));
  assert.equal(note.passages, FULL_PASSAGES);
  assert.equal(note.corpusPassages, passages);
  assert.equal(note.relevantPassages, 200);
  assert.equal(note.passageIds.length, FULL_PASSAGES);
});

test('a slow model gets as many sessions as it needs', async () => {
  const { lab, deps } = fakeRoot();
  const steps: Step[] = [];
  const base = fakeSandbox(steps);
  let continues = 0;
  const sandbox = async (step: Step, paths: Paths): Promise<number> => {
    if (step.kind === 'embed' && step.model === MODELS[1].id && continues < 30) {
      continues += 1;
      return 75;
    }
    return base(step, paths);
  };
  assert.equal(await main([], deps({ sandbox })), 0);
  const result = parseResult(readFileSync(join(lab, 'result.md'), 'utf8'));
  assert.equal(result.status, 'measured');
  assert.equal(manifestProblem(join(lab, 'result.md'), result), null, 'its raw output is saved before its result, so the App will count it');
});

test('when EmbeddingGemma 2 dies, MiniLM is kept as partial, with no number for what did not run', async () => {
  const { lab, deps } = fakeRoot();
  const steps: Step[] = [];
  await assert.rejects(() => main([], deps({ sandbox: fakeSandbox(steps, MODELS[1].id) })), /exit code 137/);
  const result = parseResult(readFileSync(join(lab, 'result.md'), 'utf8'));
  assert.equal(result.status, 'partial');
  assert.equal(result.title_number, undefined);
  assert.match(result.body, /did not finish/);
});

test('a broken default stops the lab before anything is written', async () => {
  const { lab, deps } = fakeRoot();
  const steps: Step[] = [];
  const base = fakeSandbox(steps);
  const sandbox = async (step: Step, paths: Paths): Promise<number> => {
    const code = await base(step, paths);
    if (step.kind === 'compat' && step.check === 'parity') writeFileSync(step.outFile, JSON.stringify({ ...goodCompat.parity, minCosine: 0.5 }));
    return code;
  };
  await assert.rejects(() => main([], deps({ sandbox })), /vectors moved/);
  assert.equal(existsSync(join(lab, 'result.md')), false);
});

test('not_run comes from the same writer, exits 3 and leaves a stronger result alone', async () => {
  const { lab, deps } = fakeRoot();
  assert.equal(await main(['--record-not-run'], deps()), 3);
  const result = parseResult(readFileSync(join(lab, 'result.md'), 'utf8'));
  assert.equal(result.status, 'not_run');
  assert.equal(result.body, NOT_RUN_SENTENCE);
  assert.match(result.body, /on a 1,000-passage SciFact subset/);
  assert.ok(!/\d\.\d/.test(result.body), 'not_run carries no numbers');

  const strong = renderResult({ lab: '03-embeddings', status: 'measured', measured_at: '2026-10-31', title_number: 'recall@5 0.1 → 0.2 on SciFact', body: '| | a |' });
  writeFileSync(join(lab, 'result.md'), strong);
  assert.equal(await main([], deps({ dockerAvailable: () => false })), 3);
  assert.equal(readFileSync(join(lab, 'result.md'), 'utf8'), strong);
});

test('a dry run with no Docker exits 3 and leaves result.md as it was, or absent', async () => {
  const { lab, deps } = fakeRoot();
  const noDocker = deps({ dockerAvailable: () => false });
  assert.equal(await main(['--dry-run'], noDocker), 3);
  assert.equal(existsSync(join(lab, 'result.md')), false);
  const earlier = renderResult({ lab: '03-embeddings', status: 'not_run', needs: 'something else', body: 'an earlier sentence' });
  writeFileSync(join(lab, 'result.md'), earlier);
  assert.equal(await main(['--dry-run'], noDocker), 3);
  assert.equal(readFileSync(join(lab, 'result.md'), 'utf8'), earlier);
});

test('an unknown option is refused rather than running a long job', async () => {
  const { deps } = fakeRoot();
  await assert.rejects(() => main(['--dryrun'], deps()), /Unknown option/);
});

test('the real test set is 200 queries in full and tiny in a dry run', () => {
  assert.equal(pickTestSet(fakeDataset(), false).queries.length, FULL_QUERIES);
  const tiny = pickTestSet(fakeDataset(), true);
  assert.equal(tiny.queries.length, TINY.queries);
  assert.equal(tiny.corpus.length, TINY.passages);
  assert.equal(tiny.fullRunPassages, 30);
});

test('the full test set keeps every relevant passage of its 200 queries in 1,000 passages', () => {
  const set = pickTestSet(fakeDataset(210, 1500), false);
  assert.equal(set.queries.length, 200);
  assert.equal(set.corpus.length, 1000);
  assert.equal(set.fullRunPassages, 1000);
  const ids = new Set(set.corpus.map((d) => d.id));
  for (const query of set.queries) for (const doc of set.qrels.get(query.id) ?? []) assert.ok(ids.has(doc), `${doc} is relevant to ${query.id}`);
  assert.equal(set.subset?.relevant, 200);
  assert.equal(set.subset?.others, 800);
  assert.equal(set.subset?.corpus, 1500);
  assert.equal(pickTestSet(fakeDataset(210, 1500), true).fullRunPassages, 1000, 'the dry run plans on what the full run embeds');
});

const SCIFACT = join(REPO_ROOT, 'lab', '.work', '03-embeddings', 'dataset', 'unzipped', 'scifact');

test('the real subset is what the notes say it is, counted from the dataset', { skip: existsSync(join(SCIFACT, 'corpus.jsonl')) ? false : 'SciFact has not been downloaded' }, () => {
  const read = (...path: string[]) => readFileSync(join(SCIFACT, ...path), 'utf8');
  const raw = { corpus: read('corpus.jsonl'), queries: read('queries.jsonl'), qrelsTest: read('qrels', 'test.tsv'), sha256: '', licence: '' };
  const set = pickTestSet(raw, false);
  const whole = parseCorpus(raw.corpus);
  const lengths = set.corpus.map((d) => passageText(d).length);
  const over = (limit: number) => lengths.filter((length) => length > limit).length;
  let shared = 0;
  while (set.corpus[shared]?.id === whole[shared]?.id) shared += 1;
  assert.equal(set.corpus.length, FULL_PASSAGES);
  const notes = readFileSync(join(LAB_DIR, 'testset-notes.md'), 'utf8');
  const stated = [
    `every passage relevant to those 200 queries (${set.subset?.relevant} of them), plus the ${set.subset?.others} lowest-id other passages, out of the ${set.subset?.corpus.toLocaleString('en-US')} in`,
    `here ${over(1000)} of the ${lengths.length.toLocaleString('en-US')} passages are over 1,000 characters, ${over(2000)} are over 2,000 and ${over(4000)} are over 4,000`,
    `first ${shared} passages in id order are the corpus's first ${shared}`,
    `the subset's longest passage is ${Math.max(...lengths).toLocaleString('en-US')} characters`,
    `claims of at most ${Math.max(...set.queries.map((q) => q.text.length))} characters`,
  ];
  for (const sentence of stated) assert.ok(notes.includes(sentence), sentence);
});

test('scrubSecrets removes named values and key shapes', () => {
  assert.equal(scrubSecrets(`a ${FAKE_KEY} b hf_abcdefghijklmnopqrstuv`, {}), 'a [scrubbed] b [scrubbed]');
  assert.equal(scrubSecrets('value mysecretvalue', { MY_TOKEN: 'mysecretvalue', PATH: 'value' }), 'value [scrubbed]');
});

test('sandbox commands use the sandbox paths and pass no keys', () => {
  const paths = pathsFor(true, '/r/lab/03-embeddings', '/r');
  const embed = commandFor({ kind: 'embed', model: 'm/x', outDir: join(paths.work, 'x'), segment: 5, oldPackage: false }, paths);
  assert.doesNotMatch(embed, /--embedder/);
  assert.match(commandFor({ kind: 'embed', model: 'm/x', outDir: join(paths.work, 'x'), segment: 5, oldPackage: true }, paths), /--embedder \/lab\/03-embeddings\/harness\/old-package-embedder\.cjs/);
  assert.match(embed, /STORAGE_DIR=\/hf-cache\/anything-llm node \/lab\/03-embeddings\/harness\/embed\.cjs --model m\/x --input \/lab-work\/03-embeddings\/dry-run\/input --out \/lab-work\/03-embeddings\/dry-run\/x/);
  assert.doesNotMatch(embed, /KEY/);
  assert.match(commandFor({ kind: 'install' }, paths), /--frozen-lockfile/);
});

test('checkCompat stops on a changed dimension, moved vectors or a re-download', () => {
  assert.doesNotThrow(() => checkCompat(goodCompat));
  assert.throws(() => checkCompat({ ...goodCompat, parity: { ...goodCompat.parity, newDim: 8 } }), /dimension/);
  assert.throws(() => checkCompat({ ...goodCompat, parity: { ...goodCompat.parity, minCosine: 0.9 } }), /moved/);
  assert.throws(() => checkCompat({ ...goodCompat, reuse: { ...goodCompat.reuse, offline: false } }), /reuse/);
  assert.throws(() => checkCompat({ ...goodCompat, oldFirst: { dim: 4, rerankScores: [] } }), /one process/);
});

test('another existing model stops the lab if its dimension changes, and its vector move is reported, not a gate', () => {
  const resized = { ...goodCompat.nomic, chunks: { ...comparison(0.999), newDim: 8 } };
  assert.throws(() => checkCompat({ ...goodCompat, nomic: resized }), /nomic-embed-text-v1 changed dimension/);
  const resizedQueries = { ...goodCompat.e5, queries: { ...comparison(0.999), oldDim: 8 } };
  assert.throws(() => checkCompat({ ...goodCompat, e5: resizedQueries }), /multilingual-e5-small changed dimension/);
  assert.doesNotThrow(() => checkCompat({ ...goodCompat, nomic: { ...goodCompat.nomic, queries: comparison(0.5) } }));
});

test('every existing model gets a real load in the lab, not only MiniLM', async () => {
  const { deps, steps, lab } = fakeRoot();
  assert.equal(await main([], deps()), 0);
  const checks = steps.filter((s) => s.kind === 'compat').map((s) => (s as { check: string }).check);
  assert.ok(checks.includes('nomic') && checks.includes('e5'), checks.join());
  const out = filesUnder(join(lab, 'out'));
  for (const name of ['compat-nomic.json', 'compat-e5.json']) assert.ok(out.some((f) => f.endsWith(name)), `${name} was saved`);
  const { body } = parseResult(readFileSync(join(lab, 'result.md'), 'utf8'));
  assert.match(body, /Xenova\/nomic-embed-text-v1: lowest cosine between packages 0\.995000 on 3 chunks, 0\.996000 on 3 queries, 4 dimensions on both, token ids differ on 0 of 6 texts/);
  assert.match(body, /MintplexLabs\/multilingual-e5-small: lowest cosine/);
});

test('the notes count the passages over each model\'s chunk limit from the corpus, and print the batching comparison', () => {
  const run = (limit: number): ModelRun => ({
    progress: { segmentMs: [], peakRssKb: 1024, dim: 4, chunkChars: limit, machine: { node: 'v18', arch: 'arm64', cpus: 1, totalMemMb: 1, transformers: '4.3.2' } },
    scores: { recallAt5: 0.5, mrrAt10: 0.5, queries: 1, passages: 4 },
  } as unknown as ModelRun);
  const same = { oldPackage: run(0).scores, oldDocumentsNewQueries: run(0).scores };
  const { body } = buildResult('2026-11-01', run(10), run(20), goodCompat, same, [5, 15, 25, 35], { relevant: 1, others: 3, corpus: 9 });
  assert.match(body, /3 of 4 passages are longer than the 10 characters the product cuts all-MiniLM-L6-v2 at/);
  assert.match(body, /2 of 4 are longer than the 20 it cuts EmbeddingGemma 2 \(q4\) at/);
  assert.match(body, /Batching: .*one at a time 0\.910000.*in batches of 25 0\.920000/);
  assert.match(body, /Token ids differ between packages on 0 of 7 of these texts/);
});

test('the title number is computed from the scores, and says it is a subset', () => {
  const run = (recallAt5: number): ModelRun['scores'] => ({ recallAt5, mrrAt10: 0, queries: 1, passages: 1000 });
  assert.equal(titleNumber(run(0.51234), run(0.6)), 'recall@5 0.512 → 0.600 on a 1,000-passage SciFact subset');
  const before = { progress: { segmentMs: [], peakRssKb: 1024, dim: 4, chunkChars: 1, machine: { node: 'v18', arch: 'arm64', cpus: 1, totalMemMb: 1, transformers: '4.3.2' } }, scores: run(0.5) } as unknown as ModelRun;
  assert.equal(buildResult('2026-11-01', before, null, goodCompat, { oldPackage: run(0.5), oldDocumentsNewQueries: run(0.5) }, [1], { relevant: 1, others: 0, corpus: 1 }).status, 'partial');
});

// ---- pr.json against docs/contracts.md and the base commit

test('pr.json has every field the contract asks for', () => {
  for (const field of ['schema', 'id', 'spec', 'upstream', 'fork', 'baseCommit', 'baseBranch', 'ciWorkflow', 'branch', 'lab', 'source', 'sourceUrl', 'where', 'founderLine', 'effect', 'effort', 'whyItFits', 'risks', 'rollback', 'proof', 'sources', 'stages']) {
    assert.ok(field in pr, `missing ${field}`);
  }
  assert.equal(pr.schema, 1);
  assert.equal(pr.id, '03');
  assert.ok(existsSync(join(REPO_ROOT, pr.spec)));
  assert.equal(pr.upstream, 'Mintplex-Labs/anything-llm');
  assert.equal(pr.fork, 'anything-llm');
  assert.match(pr.baseCommit, /^a72104c5[0-9a-f]{32}$/);
  assert.equal(pr.baseBranch, 'replay/a72104c5');
  assert.equal(pr.ciWorkflow, null);
  assert.equal(pr.branch, 'keepup/2026-10-04-embeddinggemma-2');
  assert.equal(pr.lab, 'lab/03-embeddings');
  assert.deepEqual(pr.effect, ['better answers']);
  assert.equal(pr.effort, 'A day');
  for (const url of [pr.sourceUrl, pr.proof.vendor.url, ...pr.sources]) assert.match(url, /^https:\/\/\S+$/);
});

test('the stages are in replay order, with existing patches and unique subjects', () => {
  assert.deepEqual(pr.stages.map((s: { date: string }) => s.date), ['2026-10-04', '2026-10-06', '2026-10-27']);
  assert.equal(pr.stages[0].comment, null);
  const subjects = new Set<string>();
  for (const stage of pr.stages) {
    assert.ok(stage.whatShipped && stage.whatThisChanges);
    for (const patch of stage.patches) {
      assert.ok(existsSync(join(LAB_DIR, patch)), `${patch} exists`);
      subjects.add(readFileSync(join(LAB_DIR, patch), 'utf8').match(/^Subject: (.+)$/m)?.[1] ?? '');
    }
  }
  assert.equal(subjects.size, pr.stages.flatMap((s: { patches: string[] }) => s.patches).length);
  assert.equal(pr.stages[2].title, 'EmbeddingGemma 2 for the native embedder · {{lab.title_number}}');
  assert.ok(pr.stages.slice(1).every((s: { comment: string }) => s.comment.length > 0));
  assert.ok(!pr.stages[0].title.includes('{{'), 'the first stage has no EmbeddingGemma 2 to measure');
});

test('the repo\'s own validator accepts pr.json, and every numbered title has a title with no number', () => {
  const spec = loadSpec(join(LAB_DIR, 'pr.json'), REPO_ROOT);
  const notMeasured = { lab: spec.lab, resultFile: 'result.md', result: null, problem: null };
  for (const stage of spec.stages.filter(hasPlaceholder)) {
    const title = renderTitle(stage, notMeasured, { allowUnmeasured: true });
    assert.ok(title.length > 0 && !title.includes('{{'));
    assert.doesNotMatch(title, /recall|tested|faster/i);
  }
  assert.ok(spec.stages.filter(hasPlaceholder).length >= 2);
});

test('nothing says switching re-embeds: it clears embeddings and removes documents, and re-embedding is by hand', () => {
  const patch = readFileSync(join(LAB_DIR, pr.stages[1].patches[0]), 'utf8');
  for (const text of [patch, pr.risks, pr.rollback, ...pr.stages.map((s: { whatThisChanges: string }) => s.whatThisChanges)]) {
    assert.doesNotMatch(text, /(switching|it|that) re-embeds|re-embeds (your|the)/i);
  }
  const picker = patch.match(/^\+\s+"(A multilingual model from Google.*)",$/m)?.[1] ?? '';
  assert.match(picker, /clears your embeddings and removes documents from your workspaces/);
  assert.match(picker, /add them again/);
  assert.match(pr.risks, /clears all embeddings and removes every document from every workspace/);
  assert.match(pr.risks, /nothing re-embeds on its own/);
  assert.match(pr.rollback, /clears embeddings and removes documents again/);
});

test('the vendor score says which checkpoint it is for, and what q4 is on the card', () => {
  assert.match(pr.proof.vendor.claim, /full-precision checkpoint/);
  assert.match(pr.proof.vendor.claim, /this pull request ships q4/);
  assert.match(pr.proof.vendor.claim, /0\.988/);
});

test('linux/x64 installs skip the CUDA download, and the risks say what skipping is for', () => {
  const patch = readFileSync(join(LAB_DIR, pr.stages[0].patches[0]), 'utf8');
  assert.match(patch, /\+\+\+ b\/server\/\.yarnrc[\s\S]*?\+onnxruntime-node-install skip/);
  assert.match(pr.risks, /server\/\.yarnrc skips/);
  assert.match(pr.stages[0].whatThisChanges, /server\/\.yarnrc/);
});

test('the MiniLM drift is worded to match what the batching check showed', () => {
  const stated = `${pr.risks} ${pr.stages[0].whatThisChanges}`;
  assert.doesNotMatch(stated, /query vectors don't move|moves document vectors/i);
  assert.match(pr.risks, /queries as well as documents/);
  assert.match(pr.risks, /batching alone moves them further/);
  assert.match(pr.risks, /linux\/arm64/);
});

test('the pull request does not lean on the token limit: chunks stop well before it', () => {
  assert.match(pr.whyItFits, /chunks here stop at 1,000 characters, so the limit rarely bites/);
  assert.match(pr.whyItFits, /languages/);
  assert.match(pr.whyItFits, /no release since 29 May 2024/);
  assert.doesNotMatch(pr.founderLine, /longer|long passages/i);
  const picker = readFileSync(join(LAB_DIR, pr.stages[1].patches[0]), 'utf8').match(/^\+\s+"(A multilingual model from Google.*)",$/m)?.[1] ?? '';
  assert.doesNotMatch(picker, /large token context/);
});

test('the risks say the library move is not opt-in for any existing model', () => {
  for (const model of ['all-MiniLM-L6-v2', 'nomic-embed-text-v1', 'multilingual-e5-small']) assert.ok(pr.risks.includes(model), model);
  assert.match(pr.risks, /library move is not opt-in for any existing model/);
  assert.match(pr.stages[0].whatThisChanges, /nomic-embed-text-v1/);
});

test('the risks print the measured vector moves of the other two models, from the saved evidence', () => {
  const read = (name: string) => JSON.parse(readFileSync(join(LAB_DIR, 'evidence', `existing-model-${name}.json`), 'utf8'));
  const [nomic, e5] = [read('nomic'), read('e5')];
  assert.ok(pr.risks.includes(nomic.chunks.minCosine.toFixed(3)), 'nomic chunks');
  assert.ok(pr.risks.includes(nomic.queries.minCosine.toFixed(3)), 'nomic queries');
  assert.ok(e5.chunks.minCosine > 0.999999 && e5.queries.minCosine > 0.999999);
  assert.match(pr.risks, /multilingual-e5-small[^.]*did not move/);
  assert.match(pr.risks, /has not been measured/);
});

test('the before and after of the failure handling is saved', () => {
  const read = (phase: string, name: string) => JSON.parse(readFileSync(join(LAB_DIR, 'evidence', `hf-unreachable-${phase}`, `${name}.json`), 'utf8'));
  assert.equal(read('before-fix', 'crash').exitCode, 1);
  assert.equal(read('before-fix', 'crash').documentsAfter, '0');
  assert.equal(read('after-fix', 'crash').exitCode, 0);
  assert.equal(read('after-fix', 'crash').serverStillUp, true);
  assert.equal(read('before-fix', 'transient').afterBack.outcome, 'rejected');
  assert.equal(read('after-fix', 'transient').afterBack.outcome, 'loaded');
  assert.equal(read('before-fix', 'after-minilm').gemma.outcome, 'rejected');
  assert.equal(read('after-fix', 'after-minilm').gemma.outcome, 'loaded');
  assert.equal(read('after-fix', 'external-data').load.outcome, 'rejected');
});

test('the memory risk gives the measured peak on Chinese text, and the log is in evidence/', () => {
  const log = readFileSync(join(LAB_DIR, 'evidence', 'memory-probe.log'), 'utf8');
  const peak = (language: string, chars: number): number => {
    const line = log.split('\n').find((l) => l.includes(`"language":"${language}"`) && l.includes(`"chars":${chars},`));
    return JSON.parse(line ?? '{}').peakMb;
  };
  const [zh, en] = [peak('zh', 2000), peak('en', 2000)];
  assert.ok(zh > 2048, 'over 2 GB at the cap on Chinese text');
  assert.ok(pr.risks.includes(`${zh.toLocaleString('en-US')} MB`), `risks say ${zh} MB`);
  assert.ok(pr.risks.includes(`${en} MB`), `risks say ${en} MB`);
  assert.match(pr.risks, /Chinese/);
  assert.match(pr.risks, /2 GB/);
  assert.match(pr.risks, /evidence\/memory-probe\.log/);
});

test('the risks and the picker say what happens when Hugging Face is unreachable', () => {
  const patch = readFileSync(join(LAB_DIR, pr.stages[1].patches[0]), 'utf8');
  const picker = patch.match(/^\+\s+"(A multilingual model from Google.*)",$/m)?.[1] ?? '';
  assert.match(picker, /downloads only from Hugging Face/);
  assert.match(picker, /can't be embedded/);
  assert.match(pr.risks, /only from Hugging Face/);
  assert.match(pr.risks, /documents have already been cleared/);
  assert.match(pr.risks, /logged/);
  assert.match(patch, /\+\+\+ b\/server\/utils\/helpers\/updateENV\.js/);
  assert.match(pr.stages[1].whatThisChanges, /server\/utils\/helpers\/updateENV\.js/);
});

test('the 27 Oct bump says why it matters to this model', () => {
  const patch = readFileSync(join(LAB_DIR, pr.stages[2].patches[0]), 'utf8');
  assert.doesNotMatch(patch, /has no change that affects/);
  assert.match(patch, /\.onnx_data/);
  assert.match(patchMessage(patch), /transformers\.js\/commit\/3fe4fbee/, 'the fix is linked by its commit, which leaves nothing on anyone\'s timeline');
  assert.doesNotMatch(pr.stages[2].whatThisChanges, /Nothing else changes/);
  assert.match(pr.stages[2].whatShipped, /\.onnx_data/);
  assert.match(pr.stages[2].whatThisChanges, /4\.3\.1/);
  assert.match(pr.stages[2].comment, /download/);
});

test('nothing public links to an upstream issue or pull request', () => {
  const messages = pr.stages.flatMap((s: { patches: string[] }) => s.patches).map((p: string) => patchMessage(readFileSync(join(LAB_DIR, p), 'utf8')));
  const fields = [pr.whyItFits, pr.risks, pr.rollback, pr.sourceUrl, ...pr.sources, ...pr.stages.flatMap((s: Record<string, string>) => [s.whatShipped, s.whatThisChanges, s.comment ?? ''])];
  for (const text of [...messages, ...fields]) assert.doesNotMatch(text, /\/(pull|issues|discussions)\/\d+|[\w-]+\/[\w.-]+#\d+/, text.slice(0, 80));
});

test('stage 3 says a failed weights download ended the process on 4.3.1, as the saved run shows, not that it hung', () => {
  const server = (dir: string) => JSON.parse(readFileSync(join(LAB_DIR, 'evidence', dir, 'external-data-server.json'), 'utf8'));
  const [before, after] = [server('hf-unreachable-4.3.1'), server('hf-unreachable-after-fix')];
  assert.equal(before.transformers, '4.3.1');
  assert.notEqual(before.exitCode, 0);
  assert.equal(before.serverStillUp, false);
  assert.match(before.stderrTail, /simulated failure of the external data download/);
  assert.equal(after.transformers, '4.3.2');
  assert.equal(after.exitCode, 0);
  assert.equal(after.serverStillUp, true);
  assert.match(after.stderrTail, /Failed to download embedding model/);
  const message = patchMessage(readFileSync(join(LAB_DIR, pr.stages[2].patches[0]), 'utf8'));
  for (const text of [message, pr.stages[2].whatThisChanges, pr.stages[2].comment]) {
    assert.match(text, /end(ed|ing)? the server process/, text);
    assert.doesNotMatch(text, /\bhang/, text);
  }
  assert.match(pr.stages[1].whatThisChanges, /on 4\.3\.1 a failed download of the \.onnx_data weights still ended the process/);
  assert.match(patchMessage(readFileSync(join(LAB_DIR, pr.stages[1].patches[0]), 'utf8')), /\.onnx_data/);
});

test('long chat messages are capped for this model, the risks say so, and the numbers come from the saved runs', () => {
  const patch = readFileSync(join(LAB_DIR, pr.stages[1].patches[0]), 'utf8');
  assert.match(patch, /\+\s+capQueryLength: true/);
  assert.match(patch, /1e\+?30|model_max_length/);
  assert.match(pr.stages[1].whatThisChanges, /embedTextInput/);
  assert.match(pr.risks, /first 2,000 characters/);
  const peaks = (name: string) => readFileSync(join(LAB_DIR, 'evidence', name), 'utf8').split('\n');
  const line = (lines: string[], chars: number, language: string, field: string) => lines.map((l) => (l.startsWith('{') ? JSON.parse(l) : {})).find((row) => row.chars === chars && row.language === language && field in row);
  const before = peaks('query-cap-before.log');
  const capped = peaks('query-cap-after.log');
  assert.ok(before.includes('[60000 en] exit 137'), 'before the cap, 60,000 characters of English ran the container out of memory');
  assert.ok(before.includes('[16000 zh] exit 137'), 'before the cap, 16,000 characters of Chinese ran the container out of memory');
  assert.equal(line(capped, 60000, 'en', 'peakMb').dims, 768);
  assert.equal(line(capped, 16000, 'zh', 'peakMb').dims, 768);
  assert.ok(line(capped, 60000, 'en', 'sentChars').sentChars <= 2000 + 'task: search result | query: '.length);
  const mb = (n: number) => `${n.toLocaleString('en-US')} MB`;
  assert.ok(pr.risks.includes(mb(line(capped, 16000, 'zh', 'peakMb').peakMb)), 'the risks give the capped peak on Chinese text');
  assert.ok(line(capped, 16000, 'zh', 'sentChars').tokenizerLimit > 1e29, 'the real tokenizer has no effective limit');
});

test('the Hugging Face date says what the repo creation date is, and the launch post is a source', () => {
  assert.match(pr.stages[0].whatShipped, /repo for the ONNX build of EmbeddingGemma 2 was created on 4 Oct 2026, and Google launched the model on 6 Oct/);
  assert.doesNotMatch(pr.stages[0].whatShipped, /appeared/);
  const spec = readFileSync(join(REPO_ROOT, pr.spec), 'utf8');
  const listed = spec.slice(spec.indexOf('## Sources')).match(/https:\/\/\S+/g) ?? [];
  assert.ok(listed.length > 0);
  for (const url of listed) assert.ok(pr.sources.includes(url), url);
  for (const patch of pr.stages.flatMap((s: { patches: string[] }) => s.patches)) assert.doesNotMatch(patchMessage(readFileSync(join(LAB_DIR, patch), 'utf8')), /published on 4 Oct/);
});

test('whyItFits is two lines and the risks are short sentences', () => {
  assert.ok(pr.whyItFits.length <= 320, `whyItFits is ${pr.whyItFits.length} characters`);
  const sentences = pr.risks.split(/(?<=[.!?])\s+/);
  const longest = sentences.reduce((a: string, b: string) => (b.split(/\s+/).length > a.split(/\s+/).length ? b : a));
  assert.ok(longest.split(/\s+/).length <= 30, `longest: ${longest}`);
  assert.ok(pr.risks.includes('\n\n'), 'the risks are split by subject');
  assert.match(pr.risks.split('\n\n')[0], /clears all embeddings/, 'the risk people meet first comes first');
});

test('the dimension in the repo test comes from the model\'s saved real config', () => {
  const patch = readFileSync(join(LAB_DIR, pr.stages[1].patches[0]), 'utf8');
  assert.doesNotMatch(patch, /fakeTransformers\(768\)[\s\S]{0,200}toHaveLength\(768\)/, 'a vector length the test passes in proves nothing');
  assert.match(patch, /"embedding_dim": 768/);
  assert.match(patch, /"model_max_length": 1000000000000000019884624838656/);
  assert.match(patch, /text_config\.embedding_dim/);
});

const CLAIMS: Record<string, RegExp> = {
  'server/utils/EmbeddingEngines/native/index.js:8': /static defaultModel = "Xenova\/all-MiniLM-L6-v2"/,
  'server/package.json:41': /@xenova\/transformers/,
  'collector/package.json:20': /@xenova\/transformers/,
  'server/utils/EmbeddingEngines/native/constants.js:1': /SUPPORTED_NATIVE_EMBEDDING_MODELS/,
};

test('"where" lines point at what they claim at the base commit', { skip: existsSync(join(CLONE, '.git')) ? false : 'tmp/anything-llm is not here' }, () => {
  for (const { path, line } of pr.where) {
    const pattern = CLAIMS[`${path}:${line}`];
    assert.ok(pattern, `no claim recorded for ${path}:${line}`);
    const text = execFileSync('git', ['-C', CLONE, 'show', `${pr.baseCommit}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n')[line - 1];
    assert.match(text, pattern);
  }
});

test('the committed result.md is written by the lab and parses', () => {
  const result = readResult(join(LAB_DIR, 'result.md'));
  assert.ok(result, 'result.md exists');
  if (result?.status === 'not_run') assert.equal(result.body, NOT_RUN_SENTENCE);
});
