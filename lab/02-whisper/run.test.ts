import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { loadSpec } from '../../app/src/specs.ts';
import { renderTitle, type LabView } from '../../app/src/template.ts';
import { manifestProblem, parseResult } from '../shared/result.ts';
import { AFTER_MODEL, BEFORE_MODEL, buildResult, fakeTranscript, fakeTranscripts, KEY_NAME, NOT_RUN_SENTENCE, parseRaw, parsePrices, renderBody, scrubSecrets, titleNumberFor, UNKNOWN_MODEL, type Raw } from './report.ts';
import { INTERMITTENT, parseChecks, summarize, summaryLine } from './repo-tests.ts';
import { main, type Deps, type SandboxRequest } from './run.ts';
import { ensureAudio, retryingFetch } from './audio.ts';
import { cutPoints } from './local-check.ts';
import { extractText, lengthToSeconds, parseCatalogRows, parseTestSet, pickRow, sha1Of, verifyAudio, type Recording, type TestSet } from './testset.ts';
import { renderTestSetNotes, type LocalCheck } from './testset-notes.ts';
import { changedPaths, prepareArchiveTree, prepareWorktree, removeWorktree } from './tree.ts';
import { scoreTranscript } from './wer.ts';

const LAB_DIR = import.meta.dirname;
const REPO_ROOT = join(LAB_DIR, '..', '..');
const CLONE = join(REPO_ROOT, 'tmp', 'anything-llm');
const LAB = '02-whisper';
const FAKE_KEY = 'sk-proj-this-is-a-fake-key-for-the-test-1234567890';

const AUDIO_BYTES = new TextEncoder().encode('not really an mp3');

function fakeRecording(id: string, text: string): Recording {
  return {
    id,
    title: `Title ${id}`,
    author: 'An Author',
    reader: `Reader ${id}`,
    catalogUrl: `https://librivox.org/${id}/`,
    catalogLength: '00:01:30',
    archiveItemUrl: `https://archive.org/details/${id}`,
    audioUrl: `https://archive.org/download/${id}/${id}_64kb.mp3`,
    audioFile: `${id}_64kb.mp3`,
    audioBytes: AUDIO_BYTES.length,
    audioSha1: sha1Of(AUDIO_BYTES),
    audioLength: '01:30',
    audioLicence: 'http://creativecommons.org/publicdomain/mark/1.0/',
    textPageUrl: `https://www.gutenberg.org/ebooks/${id}`,
    textUrl: `https://www.gutenberg.org/ebooks/${id}.txt.utf-8`,
    textNote: 'A note.',
    text,
  };
}

const TEST_SET: TestSet = {
  schema: 1,
  fetched: '2026-11-01',
  selectionRule: 'A rule.',
  licenceNote: 'A licence note.',
  recordings: [fakeRecording('one', 'the quick brown fox jumps over the lazy dog'), fakeRecording('two', 'to be or not to be that is the question')],
};

const PRICES = {
  source: 'https://developers.openai.com/api/docs/pricing',
  fetched: '2026-11-01',
  perMinuteUsd: { 'whisper-1': 0.006, 'gpt-transcribe': 0.0045 },
};

const PR = {
  baseCommit: 'a'.repeat(40),
  stages: [{ patches: ['patches/0001-a.patch'] }],
};

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'keepup-02-'));
  const lab = join(root, 'lab', LAB);
  mkdirSync(lab, { recursive: true });
  writeFileSync(join(lab, 'testset.json'), JSON.stringify(TEST_SET));
  writeFileSync(join(lab, 'prices.json'), JSON.stringify(PRICES));
  writeFileSync(join(lab, 'pr.json'), JSON.stringify(PR));
  return root;
}

function listFiles(dir: string, base: string = dir): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, listFiles(path, base));
    else out[relative(base, path)] = createHash('sha1').update(readFileSync(path)).digest('hex');
  }
  return out;
}

const run = (recording: string, model: string, content: string, ms: number) => ({
  recording,
  model,
  ms,
  content,
  error: null as string | null,
  request: { fields: ['file', 'model', 'temperature'], model },
  response: { fields: model === 'gpt-transcribe' ? ['languages', 'text', 'usage'] : ['text'] },
});

const CLEAR_ERROR = `OpenAI refused the transcription model "${UNKNOWN_MODEL}". Check the Transcription Model setting (WHISPER_OPEN_AI_MODEL); the default is gpt-transcribe. OpenAI said: 404 The model does not exist.`;

/** What the real harness would save: one wrong word for whisper-1 on "one", and a key leaked into an error. */
function cannedRaw(overrides: Partial<Raw> = {}): Raw {
  return {
    schema: 1,
    fake: false,
    startedAt: '2026-11-01T10:00:00.000Z',
    finishedAt: '2026-11-01T10:01:00.000Z',
    nodeVersion: 'v18.20.0',
    sdkVersion: '4.95.1',
    runs: [
      run('one', 'whisper-1', 'A LibriVox preamble. The quick brown box jumps over the lazy dog. End of poem.', 3000),
      run('one', 'gpt-transcribe', 'A LibriVox preamble. The quick brown fox jumps over the lazy dog. End of poem.', 5000),
      run('two', 'whisper-1', 'To be or not to be, that is the question.', 2000),
      run('two', 'gpt-transcribe', 'To be or not to be, that is the question.', 4000),
    ],
    unknownModel: { model: UNKNOWN_MODEL, content: '', error: CLEAR_ERROR, apiStatus: 404, apiCode: 'model_not_found', apiMessage: 'The model does not exist.' },
    ...overrides,
  };
}

interface Harnessed {
  deps: Deps;
  requests: SandboxRequest[];
  logs: string[];
  trees: string[];
}

function makeDeps(root: string, raw: Raw | ((request: SandboxRequest) => Raw) | null, env: Record<string, string | undefined> = {}): Harnessed {
  const requests: SandboxRequest[] = [];
  const logs: string[] = [];
  const trees: string[] = [];
  const makeTree = (_pr: unknown, dest: string) => {
    trees.push(dest);
    mkdirSync(dest, { recursive: true });
  };
  const deps: Deps = {
    root,
    env,
    sandbox: (request) => {
      requests.push(request);
      if (!raw) return { status: 1, output: `boom ${FAKE_KEY}` };
      const value = typeof raw === 'function' ? raw(request) : raw;
      const outFile = join(root, 'lab', '.work', request.out.replace('/lab-work/', ''));
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify(value));
      return { status: 0, output: `sandbox log with ${FAKE_KEY}` };
    },
    prepareLabTree: makeTree,
    removeLabTree: (dest) => rmSync(dest, { recursive: true, force: true }),
    prepareDryTree: makeTree,
    fetchAudio: async () => AUDIO_BYTES,
    today: () => '2026-11-01',
    log: (line) => logs.push(line),
  };
  return { deps, requests, logs, trees };
}

const labPath = (root: string, ...parts: string[]) => join(root, 'lab', LAB, ...parts);

test('with no key it writes not_run, exits 3, and says what running it will measure', async () => {
  const root = makeRoot();
  const { deps, requests } = makeDeps(root, cannedRaw());
  assert.equal(await main([], deps), 3);
  const result = parseResult(readFileSync(labPath(root, 'result.md'), 'utf8'));
  assert.equal(result.status, 'not_run');
  assert.equal(result.needs, KEY_NAME);
  assert.equal(result.body, NOT_RUN_SENTENCE);
  assert.equal(requests.length, 0);
  assert.ok(!existsSync(labPath(root, 'out')));
});

test('a not_run result holds no numbers, only one sentence', () => {
  assert.equal(NOT_RUN_SENTENCE.split(/[.!?]\s/).length, 1);
  assert.doesNotMatch(NOT_RUN_SENTENCE.replaceAll('whisper-1', ''), /\d/);
});

test('--no-keys never reads .env, even when a key is in it', async () => {
  const root = makeRoot();
  writeFileSync(join(root, '.env'), `${KEY_NAME}=${FAKE_KEY}\n`);
  const { deps, requests } = makeDeps(root, cannedRaw(), { [KEY_NAME]: FAKE_KEY });
  assert.equal(await main(['--no-keys'], deps), 3);
  assert.equal(requests.length, 0);
  assert.equal(parseResult(readFileSync(labPath(root, 'result.md'), 'utf8')).status, 'not_run');
});

test('with no key it leaves an earlier measured result alone', async () => {
  const root = makeRoot();
  const measured = makeDeps(root, cannedRaw(), { [KEY_NAME]: FAKE_KEY });
  assert.equal(await main([], measured.deps), 0);
  const before = readFileSync(labPath(root, 'result.md'), 'utf8');
  const noKey = makeDeps(root, null);
  assert.equal(await main([], noKey.deps), 3);
  assert.equal(readFileSync(labPath(root, 'result.md'), 'utf8'), before);
  assert.ok(noKey.logs.some((line) => line.includes('Kept the earlier measured result')));
});

test('--dry-run needs no key, runs the fake provider, and writes only under its own folder', async () => {
  const root = makeRoot();
  writeFileSync(labPath(root, 'result.md'), parseableMeasured());
  mkdirSync(labPath(root, 'out'));
  writeFileSync(labPath(root, 'out', 'keep.json'), '{}');
  const outside = () => {
    const files = listFiles(root);
    return Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith(join('lab', '.work', LAB, 'dry-run'))));
  };
  const before = outside();
  const { deps, requests, logs } = makeDeps(root, (request) => fakeRunFromInput(root, request));
  assert.equal(await main(['--dry-run'], deps), 0);
  assert.deepEqual(outside(), before);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].fake, true);
  assert.deepEqual(requests[0].env, { SANDBOX_ENV: '' });
  const preview = readFileSync(join(root, 'lab', '.work', LAB, 'dry-run', 'result.preview.md'), 'utf8');
  assert.match(preview, /fake provider/);
  assert.match(preview, /Nothing here is measured/);
  assert.ok(logs.length > 0);
});

test('--dry-run never reaches for a key, even with one in .env and the environment', async () => {
  const root = makeRoot();
  writeFileSync(join(root, '.env'), `${KEY_NAME}=${FAKE_KEY}\n`);
  const { deps, requests } = makeDeps(root, (request) => fakeRunFromInput(root, request), { [KEY_NAME]: FAKE_KEY });
  assert.equal(await main(['--dry-run'], deps), 0);
  assert.deepEqual(requests[0].env, { SANDBOX_ENV: '' });
  assert.ok(!existsSync(labPath(root, 'result.md')));
  assert.ok(!existsSync(labPath(root, 'out')));
  for (const path of Object.keys(listFiles(join(root, 'lab', '.work')))) {
    assert.ok(!readFileSync(join(root, 'lab', '.work', path), 'utf8').includes(FAKE_KEY), `${path} holds the key`);
  }
});

test('a failed dry run exits 1 and still touches nothing outside its folder', async () => {
  const root = makeRoot();
  const { deps, logs } = makeDeps(root, null);
  assert.equal(await main(['--dry-run'], deps), 1);
  assert.ok(!existsSync(labPath(root, 'result.md')));
  assert.ok(logs.some((line) => line.includes('dry run failed')));
});

test('a dry run where the provider gives no text or no clear error fails, so a broken patch shows up', async () => {
  const root = makeRoot();
  const broken = (request: SandboxRequest) => ({ ...fakeRunFromInput(root, request), unknownModel: { ...cannedRaw().unknownModel, error: '404 something' } });
  const { deps, logs } = makeDeps(root, broken);
  assert.equal(await main(['--dry-run'], deps), 1);
  assert.ok(logs.some((line) => line.includes('a clear error from the provider for an unknown model')));
  assert.ok(!existsSync(labPath(root, 'result.md')));
});

test('a run with a key writes the table, saves raw outputs and passes the key by name only', async () => {
  const root = makeRoot();
  const { deps, requests, trees } = makeDeps(root, cannedRaw(), { [KEY_NAME]: FAKE_KEY });
  assert.equal(await main([], deps), 0);
  const result = parseResult(readFileSync(labPath(root, 'result.md'), 'utf8'));
  assert.equal(result.status, 'measured');
  assert.equal(manifestProblem(labPath(root, 'result.md'), result), null, 'its raw output is saved before its result, so the App will count it');
  assert.equal(result.measured_at, '2026-11-01');
  assert.equal(result.title_number, 'whisper-1 → gpt-transcribe, word error rate 5.3% → 0.0% on 2 recordings');
  assert.equal(requests[0].fake, false);
  assert.equal(requests[0].env.SANDBOX_ENV, KEY_NAME);
  assert.equal(requests[0].env[KEY_NAME], FAKE_KEY);
  assert.ok(!JSON.stringify([requests[0].worktree, requests[0].input, requests[0].out]).includes(FAKE_KEY));
  assert.equal(trees[0], join(root, 'tmp', 'lab-wt-02'));
  assert.ok(!existsSync(trees[0]), 'the lab worktree is removed afterwards');
  assert.ok(existsSync(labPath(root, 'out', 'responses.json')));
  const input = JSON.parse(readFileSync(join(root, 'lab', '.work', LAB, 'run', 'input.json'), 'utf8'));
  assert.deepEqual(input.models, [BEFORE_MODEL, AFTER_MODEL]);
  assert.equal(input.unknownModel, UNKNOWN_MODEL);
  assert.equal(input.fakeTranscripts, undefined);
  assert.equal(input.recordings[0].path, '/lab-work/02-whisper/audio/one_64kb.mp3');
});

test('raw outputs never hold a key, even when an error message or the log carries one', async () => {
  const root = makeRoot();
  const leaky = cannedRaw({
    runs: cannedRaw().runs.map((r) => ({ ...r, content: `${r.content}` })),
    unknownModel: { ...cannedRaw().unknownModel, apiMessage: `Incorrect API key provided: ${FAKE_KEY}, or sk-proj-***abcd.` },
  });
  const { deps } = makeDeps(root, leaky, { [KEY_NAME]: FAKE_KEY });
  await main([], deps);
  for (const [path] of Object.entries(listFiles(root))) {
    const text = readFileSync(join(root, path), 'utf8');
    assert.ok(!text.includes(FAKE_KEY), `${path} holds the key`);
    assert.doesNotMatch(text, /sk-proj-/, `${path} holds a key-shaped string`);
  }
  assert.ok(listFiles(root)[join('lab', LAB, 'out', 'sandbox.log')]);
});

test('scrubSecrets removes exact values and key-shaped strings, and nothing else', () => {
  assert.equal(scrubSecrets('a secretvalue b', ['secretvalue']), 'a [scrubbed] b');
  assert.equal(scrubSecrets('key sk-abcdefgh1234 and sk-proj-***abcd end', []), 'key [scrubbed] and [scrubbed] end');
  assert.equal(scrubSecrets('risk-averse tasks stay', []), 'risk-averse tasks stay');
  assert.equal(scrubSecrets('nothing', ['']), 'nothing');
});

test('the table reads its numbers from the run and prints the price source and date', () => {
  const body = renderBody(parseRaw(JSON.stringify(cannedRaw()), TEST_SET), TEST_SET, parsePrices(JSON.stringify(PRICES)));
  assert.match(body, /^\| \| before: whisper-1 \| after: gpt-transcribe \|$/m);
  assert.match(body, /\| Word error rate, all 2 recordings \(19 published words\) \| 5\.3% \| 0\.0% \|/);
  assert.match(body, /\| Title one, read by Reader one: 9 words \| 11\.1% \| 0\.0% \|/);
  assert.match(body, /\| Title two, read by Reader two: 10 words \| 0\.0% \| 0\.0% \|/);
  assert.match(body, /\| Median time to the result, per upload \| 2\.5 s \| 4\.5 s \|/);
  assert.match(body, /\| Price per minute of audio \(OpenAI pricing page, fetched 2026-11-01\) \| \$0\.006 \| \$0\.0045 \|/);
  assert.match(body, /\| Uploads that gave text back in the provider's \{content, error\} shape \| 2 of 2 \| 2 of 2 \|/);
  assert.match(body, /\| Fields in OpenAI's response \| text \| languages, text, usage \|/);
  assert.match(body, /https:\/\/developers\.openai\.com\/api\/docs\/pricing/);
  assert.match(body, /unbroken run/);
  assert.match(body, /Words left out/);
  assert.match(body, /Unknown model/);
  assert.ok(body.includes(CLEAR_ERROR));
});

test('the title takes the word error rate only when gpt-transcribe scores better at the precision the table prints', () => {
  const plain = 'whisper-1 → gpt-transcribe';
  assert.equal(titleNumberFor(0.021, 0.014, 3), `${plain}, word error rate 2.1% → 1.4% on 3 recordings`);
  assert.equal(titleNumberFor(0.014, 0.021, 3), plain, 'worse');
  assert.equal(titleNumberFor(0.021, 0.021, 3), plain, 'level');
  assert.equal(titleNumberFor(0.0214, 0.0211, 3), plain, 'the table would print 2.1% for both');
});

test('a measured run where gpt-transcribe scores worse keeps the plain title, and the table still shows the rates', () => {
  const swapped = cannedRaw().runs.map((r) => ({ ...r, model: r.model === BEFORE_MODEL ? AFTER_MODEL : BEFORE_MODEL }));
  const result = buildResult({ raw: cannedRaw({ runs: swapped }), testSet: TEST_SET, prices: parsePrices(JSON.stringify(PRICES)), measuredAt: '2026-11-01' });
  assert.equal(result?.status, 'measured');
  assert.equal(result?.title_number, 'whisper-1 → gpt-transcribe');
  assert.match(result?.body ?? '', /\| Word error rate, all 2 recordings \(19 published words\) \| 0\.0% \| 5\.3% \|/);
});

test('a model that failed on one recording makes the run partial, with that row marked and no overall number', () => {
  const failed = cannedRaw();
  const runs = failed.runs.map((r) => (r.recording === 'two' && r.model === 'gpt-transcribe' ? { ...r, content: '', error: '400 temperature is not supported' } : r));
  const result = buildResult({ raw: { ...failed, runs }, testSet: TEST_SET, prices: parsePrices(JSON.stringify(PRICES)), measuredAt: '2026-11-01' });
  assert.ok(result);
  assert.equal(result.status, 'partial');
  assert.equal(result.title_number, undefined);
  assert.match(result.needs ?? '', /gpt-transcribe/);
  assert.match(result.body, /400 temperature is not supported/);
  assert.doesNotMatch(result.body, /Word error rate, all/);
  assert.doesNotMatch(result.body, /Median time/);
  assert.match(result.body, /\| Title one, read by Reader one: 9 words \| 11\.1% \| 0\.0% \|/);
});

test('when no transcript came back there is no result to write: exit 1 and nothing is claimed', async () => {
  const root = makeRoot();
  const runs = cannedRaw().runs.map((r) => ({ ...r, content: '', error: '401 bad key' }));
  const { deps } = makeDeps(root, cannedRaw({ runs }), { [KEY_NAME]: FAKE_KEY });
  assert.equal(await main([], deps), 1);
  assert.ok(!existsSync(labPath(root, 'result.md')));
});

test('an unclear answer to an unknown model makes the run partial: the spec asks for a clear error', () => {
  const raw = cannedRaw({ unknownModel: { ...cannedRaw().unknownModel, error: '400 invalid model ID' } });
  const result = buildResult({ raw, testSet: TEST_SET, prices: parsePrices(JSON.stringify(PRICES)), measuredAt: '2026-11-01' });
  assert.equal(result?.status, 'partial');
  assert.match(result?.needs ?? '', /unknown model/);
});

test('a failed sandbox run writes no result and exits 1', async () => {
  const root = makeRoot();
  const { deps } = makeDeps(root, null, { [KEY_NAME]: FAKE_KEY });
  assert.equal(await main([], deps), 1);
  assert.ok(!existsSync(labPath(root, 'result.md')));
  const log = readFileSync(join(root, 'lab', '.work', LAB, 'run', 'sandbox.log'), 'utf8');
  assert.ok(!log.includes(FAKE_KEY));
});

test('parseRaw refuses output that is not what the harness writes', () => {
  assert.throws(() => parseRaw('not json', TEST_SET));
  assert.throws(() => parseRaw(JSON.stringify({ schema: 2 }), TEST_SET), /schema/);
  const missing = cannedRaw({ runs: cannedRaw().runs.slice(1) });
  assert.throws(() => parseRaw(JSON.stringify(missing), TEST_SET), /whisper-1 on one/);
  const fakeData = cannedRaw({ fake: true });
  assert.equal(parseRaw(JSON.stringify(fakeData), TEST_SET).fake, true);
});

test('a run marked fake can never produce a measured result', () => {
  assert.throws(() => buildResult({ raw: cannedRaw({ fake: true }), testSet: TEST_SET, prices: parsePrices(JSON.stringify(PRICES)), measuredAt: '2026-11-01' }), /fake/);
});

test('an unknown flag is refused', async () => {
  const { deps } = makeDeps(makeRoot(), cannedRaw());
  await assert.rejects(main(['--nope'], deps), /Unknown flag/);
});

// A stand-in for the fork's provider, in a temp folder, so this test runs no upstream code on the host.
const STUB_PROVIDER = `
const fs = require("fs");
const path = require("path");
class OpenAiWhisper {
  constructor({ options }) {
    const key = options.openAiKey;
    this.model = options.WhisperOpenAiModel;
    this.openai = { audio: { transcriptions: { create: async ({ file, model }) => {
      const form = new FormData();
      form.set("file", new Blob([fs.readFileSync(file)]), path.basename(file));
      form.set("model", model);
      form.set("temperature", "0");
      const res = await fetch(process.env.OPENAI_BASE_URL + "/audio/transcriptions", { method: "POST", body: form, headers: { Authorization: "Bearer " + key } });
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(res.status + " " + json.error.message), { status: res.status, code: json.error.code });
      return json;
    } } } };
  }
  async processFile(p) {
    return this.openai.audio.transcriptions.create({ file: p, model: this.model })
      .then((r) => ({ content: r.text, error: null }))
      .catch((e) => ({ content: "", error: 'refused "' + this.model + '" WHISPER_OPEN_AI_MODEL: ' + e.message }));
  }
}
module.exports = { OpenAiWhisper };
`;

test('harness.cjs and the fake provider run end to end: real multipart, the model sent, the answer shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-02-harness-'));
  const repo = join(dir, 'repo');
  const providerDir = join(repo, 'collector', 'utils', 'WhisperProviders');
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(join(providerDir, 'OpenAiWhisper.js'), STUB_PROVIDER);
  const audio = join(dir, 'one_64kb.mp3');
  writeFileSync(audio, AUDIO_BYTES);
  const inputPath = join(dir, 'input.json');
  const out = join(dir, 'raw.json');
  writeFileSync(
    inputPath,
    JSON.stringify({
      models: [BEFORE_MODEL, AFTER_MODEL],
      unknownModel: UNKNOWN_MODEL,
      recordings: [{ id: 'one', path: audio }],
      fakeTranscripts: { 'one_64kb.mp3': { [BEFORE_MODEL]: 'before words', [AFTER_MODEL]: 'after words' } },
    }),
  );
  const child = spawnSync(process.execPath, [join(LAB_DIR, 'harness.cjs'), '--repo', repo, '--input', inputPath, '--out', out, '--fake'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  const raw = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(raw.fake, true);
  assert.equal(raw.runs.length, 2);
  const byModel = Object.fromEntries(raw.runs.map((r: { model: string }) => [r.model, r]));
  assert.equal(byModel[BEFORE_MODEL].content, 'before words');
  assert.equal(byModel[AFTER_MODEL].content, 'after words');
  assert.equal(byModel[AFTER_MODEL].error, null);
  assert.ok(byModel[AFTER_MODEL].ms >= 0);
  assert.deepEqual(byModel[AFTER_MODEL].request.fields, ['file', 'model']);
  assert.deepEqual(byModel[AFTER_MODEL].response.fields, ['languages', 'text', 'usage']);
  assert.deepEqual(byModel[BEFORE_MODEL].response.fields, ['text']);
  assert.equal(raw.unknownModel.model, UNKNOWN_MODEL);
  assert.equal(raw.unknownModel.apiStatus, 404);
  assert.match(raw.unknownModel.error, /WHISPER_OPEN_AI_MODEL/);
});

test('fake transcripts carry a spoken preamble and closing and read the same for both models, so a dry run favours neither', () => {
  const recording = fakeRecording('one', 'the quick brown fox');
  assert.match(fakeTranscript(recording), /preamble/);
  assert.match(fakeTranscript(recording), /closing/);
  const byFile = fakeTranscripts({ ...TEST_SET, recordings: [recording] })[recording.audioFile];
  assert.equal(byFile[BEFORE_MODEL], byFile[AFTER_MODEL]);
});

test('bad data files are refused with a clear message', () => {
  assert.throws(() => parsePrices('{"source":"s","fetched":"d","perMinuteUsd":{"whisper-1":1}}'), /gpt-transcribe/);
  assert.throws(() => parsePrices('{"perMinuteUsd":{"whisper-1":1,"gpt-transcribe":2}}'), /source and date/);
  assert.throws(() => parseTestSet('{"schema":1,"recordings":[]}'), /no recordings/);
  assert.throws(() => parseTestSet('{"schema":1,"recordings":[{"id":"x"}]}'), /x has no title/);
});

test('ensureAudio downloads once, checks the hash, and refuses a file that is not the named one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-02-audio-'));
  const recording = fakeRecording('one', 'x');
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    return AUDIO_BYTES;
  };
  const path = await ensureAudio(recording, dir, fetcher);
  assert.deepEqual(new Uint8Array(readFileSync(path)), AUDIO_BYTES);
  await ensureAudio(recording, dir, fetcher);
  assert.equal(fetches, 1);
  writeFileSync(path, 'tampered');
  await ensureAudio(recording, dir, fetcher);
  assert.equal(fetches, 2);
  await assert.rejects(ensureAudio(fakeRecording('two', 'x'), dir, async () => new Uint8Array([1, 2, 3])), /bytes/);
  assert.throws(() => verifyAudio({ audioFile: 'a', audioBytes: 1, audioSha1: 'nope' }, new Uint8Array([1])), /sha1/);
});

test('retryingFetch tries again after a server error or a dropped connection, and not after a 404', async () => {
  const answers = (list: (Response | Error)[]) => {
    const calls = { count: 0 };
    const get = async () => {
      const answer = list[calls.count];
      calls.count += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { get, calls };
  };
  const flaky = answers([new Response('', { status: 500 }), new Error('reset'), new Response('ok')]);
  assert.deepEqual(new TextDecoder().decode(await retryingFetch(flaky.get, 0)('u')), 'ok');
  assert.equal(flaky.calls.count, 3);
  const missing = answers([new Response('', { status: 404 })]);
  await assert.rejects(retryingFetch(missing.get, 0)('u'), /u answered 404/);
  assert.equal(missing.calls.count, 1);
  const down = answers([new Response('', { status: 500 }), new Response('', { status: 503 }), new Response('', { status: 500 })]);
  await assert.rejects(retryingFetch(down.get, 0)('u'), /u answered 500/);
  assert.equal(down.calls.count, 3);
});

function makeGitRepoWithPatch(): { repo: string; patch: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), 'keepup-02-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  mkdirSync(join(repo, 'a'));
  writeFileSync(join(repo, 'a', 'kept.txt'), 'one\n');
  writeFileSync(join(repo, 'a', 'changed.txt'), 'before\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a', 'changed.txt'), 'after\n');
  writeFileSync(join(repo, 'a', 'new.txt'), 'new\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'change');
  const patch = join(mkdtempSync(join(tmpdir(), 'keepup-02-patch-')), 'one.patch');
  writeFileSync(patch, git('format-patch', '--stdout', `${base}..HEAD`) + '\n');
  return { repo, patch, base };
}

test('prepareWorktree makes the base plus the patch and removeWorktree takes it away again', () => {
  const { repo, patch, base } = makeGitRepoWithPatch();
  const dest = join(mkdtempSync(join(tmpdir(), 'keepup-02-wt-')), 'lab-wt');
  prepareWorktree(repo, dest, base, [patch]);
  assert.equal(readFileSync(join(dest, 'a', 'changed.txt'), 'utf8'), 'after\n');
  assert.equal(readFileSync(join(dest, 'a', 'new.txt'), 'utf8'), 'new\n');
  prepareWorktree(repo, dest, base, [patch]);
  assert.equal(readFileSync(join(dest, 'a', 'new.txt'), 'utf8'), 'new\n');
  removeWorktree(repo, dest);
  assert.ok(!existsSync(dest));
});

test('prepareArchiveTree applies the patch outside any repo, and changedPaths leaves new files out', () => {
  const { repo, patch, base } = makeGitRepoWithPatch();
  assert.deepEqual(changedPaths(readFileSync(patch, 'utf8')), ['a/changed.txt']);
  // Inside this repo on purpose: that is where a plain `git apply` would silently skip every file.
  mkdirSync(join(LAB_DIR, '..', '.work'), { recursive: true });
  const dest = mkdtempSync(join(LAB_DIR, '..', '.work', 'test-tree-'));
  try {
    prepareArchiveTree(repo, dest, base, [patch], []);
    assert.equal(readFileSync(join(dest, 'a', 'changed.txt'), 'utf8'), 'after\n');
    assert.equal(readFileSync(join(dest, 'a', 'new.txt'), 'utf8'), 'new\n');
    assert.ok(!existsSync(join(dest, 'a', 'kept.txt')), 'only what was asked for is unpacked');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('the catalog parser and selection rule pick the first reader between one and two minutes', () => {
  const row = (title: string, reader: string, length: string, file: string) =>
    `<tr><td><a class="play-btn">Play</a> 01</td><td>${title}</td><td><a href="x">${reader}</a></td><td>${length}</td><td><a href="https://www.archive.org/download/item/${file}_64kb.mp3">mp3</a></td></tr>`;
  const html = `<table>${row('A', 'Short', '00:00:54', 'a')}${row('B', 'First &amp; Fits', '00:01:06', 'b')}${row('C', 'Also Fits', '00:01:10', 'c')}</table><tr><td>no audio</td></tr>`;
  const rows = parseCatalogRows(html);
  assert.equal(rows.length, 3);
  const picked = pickRow(rows);
  assert.equal(picked.reader, 'First & Fits');
  assert.equal(picked.audioUrl, 'https://www.archive.org/download/item/b_64kb.mp3');
  assert.throws(() => pickRow(rows.slice(0, 1)), /between one and two minutes/);
  assert.equal(lengthToSeconds('01:06'), 66);
  assert.equal(lengthToSeconds('00:01:06'), 66);
  assert.throws(() => lengthToSeconds('66.0'));
});

test('cutPoints cuts at the last silence in reach, and at the limit when there is none', () => {
  assert.deepEqual(cutPoints([10, 20, 30, 44], 60, 25), [0, 20, 44, 60]);
  assert.deepEqual(cutPoints([], 60, 25), [0, 25, 50, 60]);
  assert.deepEqual(cutPoints([5], 20, 25), [0, 20]);
});

test('the repo-tests summary is read from jest and the exit codes, and names what failed', () => {
  const report = {
    numTotalTests: 3,
    numPassedTests: 2,
    numFailedTests: 1,
    testResults: [
      { name: '/repo/a/one.test.js', assertionResults: [{ fullName: 'one passes', status: 'passed' }] },
      { name: '/repo/a/two.test.js', assertionResults: [{ fullName: 'two passes', status: 'passed' }, { fullName: 'two fails', status: 'failed' }] },
    ],
  };
  const checks = parseChecks('jest=1\nserver lint=0\ncollector lint=0\n');
  assert.deepEqual(checks, { jest: 1, 'server lint': 0, 'collector lint': 0 });
  const evidence = summarize(report, checks, 'abc', '2026-11-01');
  assert.equal(evidence.summary, '2 of 3 repo tests pass in the sandbox on Node 18, 1 fail, unexplained (two fails), and every linter and check passed.');
  assert.deepEqual(evidence.failed_tests, [{ file: 'a/two.test.js', test: 'two fails' }]);
  assert.match(summarize(report, { jest: 1, 'server lint': 1 }, 'abc', '2026-11-01').summary, /server lint failed/);
  const ffmpeg = { file: 'collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', test: 'x' };
  assert.match(summaryLine({ total: 3, passed: 2, failed: 1 }, [ffmpeg], {}), /1 fail, all in ffmpeg\/index\.test\.js because the sandbox image has no ffmpeg binary, and every/);
});

test('a failure the sandbox does not explain is named, and the ffmpeg failures keep their reason', () => {
  const ffmpeg = { file: 'collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', test: 'x' };
  const other = { file: 'server/a.test.js', test: 'A thing writes the cache' };
  const checks = { jest: 1, 'server lint': 0 };
  assert.equal(
    summaryLine({ total: 9, passed: 6, failed: 3 }, [other, ffmpeg, ffmpeg], checks),
    '6 of 9 repo tests pass in the sandbox on Node 18, 3 fail: 2 in ffmpeg/index.test.js because the sandbox image has no ffmpeg binary, 1 unexplained (A thing writes the cache), and every linter and check passed.',
  );
  assert.equal(
    summaryLine({ total: 9, passed: 8, failed: 1 }, [other], checks),
    '8 of 9 repo tests pass in the sandbox on Node 18, 1 fail, unexplained (A thing writes the cache), and every linter and check passed.',
  );
  assert.equal(summaryLine({ total: 9, passed: 9, failed: 0 }, [], { 'server lint': 0 }), '9 of 9 repo tests pass in the sandbox on Node 18, 0 fail, and every linter and check passed.');
});

test('the pricing test that fails under load gets its reason beside the ffmpeg ones, and a new failure stays unexplained', () => {
  const ffmpeg = { file: 'collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', test: 'x' };
  const [flake] = INTERMITTENT;
  const pricing = { file: flake.file, test: flake.test };
  const sameFile = { file: flake.file, test: 'ModelPricing something else' };
  assert.equal(
    summaryLine({ total: 9, passed: 5, failed: 4 }, [pricing, ffmpeg, ffmpeg, ffmpeg], { jest: 1 }),
    '5 of 9 repo tests pass in the sandbox on Node 18, 4 fail: 3 in ffmpeg/index.test.js because the sandbox image has no ffmpeg binary, 1 in modelPricing/index.test.js because it waits a fixed 25 ms for file writes, which a busy machine can miss, and every linter and check passed.',
  );
  assert.match(summaryLine({ total: 9, passed: 8, failed: 1 }, [sameFile], {}), /1 fail, unexplained \(ModelPricing something else\)/);
});

test('a run where the pricing test passed still says, on the line the site prints, that it fails on others', () => {
  const [flake] = INTERMITTENT;
  const checks = { jest: 1, 'server lint': 0 };
  const ffmpeg = { name: '/repo/collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', assertionResults: [{ fullName: 'FFMPEGWrapper x', status: 'failed' }] };
  const pricing = (status: string, name = `/repo/${flake.file}`, fullName = flake.test) => ({ name, assertionResults: [{ fullName, status }] });
  const summaryOf = (...files: (typeof ffmpeg)[]) => {
    const all = files.flatMap((f) => f.assertionResults);
    const count = (status: string) => all.filter((a) => a.status === status).length;
    return summarize({ numTotalTests: all.length, numPassedTests: count('passed'), numFailedTests: count('failed'), testResults: files }, checks, 'abc', '2026-11-01').summary;
  };

  assert.equal(
    summaryOf(ffmpeg, pricing('passed')),
    '1 of 2 repo tests pass in the sandbox on Node 18, 1 fail, all in ffmpeg/index.test.js because the sandbox image has no ffmpeg binary, and every linter and check passed. ModelPricing timing tests passed here but fail on some runs, because they wait a fixed 25 ms for file writes, which a busy machine can miss.',
  );
  // All of them passing still reads as one sentence.
  assert.equal(
    summaryOf(ffmpeg, ...INTERMITTENT.map((f) => pricing('passed', `/repo/${f.file}`, f.test))).match(/ModelPricing timing tests/g)?.length,
    1,
  );
  // When it fails, the failure's own reason says it, once.
  assert.equal(
    summaryOf(ffmpeg, pricing('failed')),
    '0 of 2 repo tests pass in the sandbox on Node 18, 2 fail: 1 in ffmpeg/index.test.js because the sandbox image has no ffmpeg binary, 1 in modelPricing/index.test.js because it waits a fixed 25 ms for file writes, which a busy machine can miss, and every linter and check passed.',
  );
  // One failing and another passing: "passed here" would be half true, and the reason is already there.
  const [first, second] = INTERMITTENT;
  assert.equal(
    summaryOf(ffmpeg, pricing('failed', `/repo/${first.file}`, first.test), pricing('passed', `/repo/${second.file}`, second.test)),
    '1 of 3 repo tests pass in the sandbox on Node 18, 2 fail: 1 in ffmpeg/index.test.js because the sandbox image has no ffmpeg binary, 1 in modelPricing/index.test.js because it waits a fixed 25 ms for file writes, which a busy machine can miss, and every linter and check passed.',
  );
  // A run that didn't pass it, or passed a same-named test elsewhere, can't say "passed here".
  for (const summary of [summaryOf(ffmpeg), summaryOf(ffmpeg, pricing('pending')), summaryOf(ffmpeg, pricing('passed', '/repo/server/other.test.js'))]) {
    assert.doesNotMatch(summary, /ModelPricing|modelPricing/);
  }
});

test('the saved evidence accounts for every failure and for the pricing test on its one line', (t) => {
  const path = join(LAB_DIR, 'out', 'repo-tests.json');
  if (!existsSync(path)) return t.skip('out/repo-tests.json is not here');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.doesNotMatch(saved.summary, /unexplained/);
  assert.match(saved.summary, /ffmpeg\/index\.test\.js because the sandbox image has no ffmpeg binary/);
  assert.match(saved.summary, /[Mm]odelPricing.*because (it waits|they wait) a fixed 25 ms for file writes/);
  assert.equal(saved.tests.total - saved.tests.passed, saved.failed_tests.length, 'every failure should be listed');
  assert.deepEqual(saved.intermittent.map((i: { test: string }) => i.test), INTERMITTENT.map((i) => i.test));
});

test('both pricing tests a full run has failed get the reason, in the words that run would now print', () => {
  const fullRun = JSON.parse(readFileSync(join(LAB_DIR, 'pricing-full-run.json'), 'utf8'));
  const { passed, total, failed } = fullRun.tests;
  assert.equal(
    summaryLine(fullRun.tests, fullRun.failed_tests, fullRun.checks),
    `${passed} of ${total} repo tests pass in the sandbox on Node 18, ${failed} fail: 3 in ffmpeg/index.test.js because the sandbox image has no ffmpeg binary, 2 in modelPricing/index.test.js because it waits a fixed 25 ms for file writes, which a busy machine can miss, and every linter and check passed.`,
  );
});

test('each test the timing reason covers failed in a saved run, at a line inside that test', (t) => {
  const underLoad = readFileSync(join(LAB_DIR, 'pricing-under-load.txt'), 'utf8');
  const fullRun = JSON.parse(readFileSync(join(LAB_DIR, 'pricing-full-run.json'), 'utf8'));
  for (const flake of INTERMITTENT) {
    assert.ok(underLoad.includes(`> ${flake.line} |`), `pricing-under-load.txt should show line ${flake.line} failing`);
    assert.match(flake.seen, new RegExp(`failing at line ${flake.line} `));
    assert.equal(flake.seen.includes('pricing-full-run.json'), fullRun.failed_tests.some((f: { test: string }) => f.test === flake.test), flake.test);
  }
  if (!hasClone) return t.skip('tmp/anything-llm is not here');
  const base = realPr().baseCommit;
  const lines = execFileSync('git', ['-C', CLONE, 'show', `${base}:${INTERMITTENT[0].file}`], { encoding: 'utf8' }).split('\n');
  for (const flake of INTERMITTENT) {
    const opening = lines.slice(0, flake.line).findLast((line) => /^\s+it\("/.test(line)) ?? '';
    assert.equal(`ModelPricing cache mechanics ${opening.match(/it\("(.*)", async/)?.[1]}`, flake.test, `line ${flake.line}`);
  }
});

test('the 25 ms and the evidence behind the pricing test\'s reason are real', (t) => {
  const [flake] = INTERMITTENT;
  const saved = readFileSync(join(LAB_DIR, 'pricing-under-load.txt'), 'utf8');
  assert.match(flake.seen, / pricing-under-load\.txt /);
  assert.ok(saved.includes(`\u25cf ${flake.test.replace('ModelPricing cache mechanics ', 'ModelPricing \u203a cache mechanics \u203a ')}`), 'the saved run should show this test failing');
  assert.match(saved, /Received: ""/);
  if (!hasClone) return t.skip('tmp/anything-llm is not here');
  const base = realPr().baseCommit;
  const source = execFileSync('git', ['-C', CLONE, 'show', `${base}:${flake.file}`], { encoding: 'utf8' });
  assert.ok(source.split('\n')[34].includes('setTimeout(resolve, 25)'), 'index.test.js:35 should wait 25 ms');
  const touched = execFileSync('git', ['-C', CLONE, 'show', `${base}:server/utils/helpers/modelPricing/index.js`], { encoding: 'utf8' });
  assert.match(touched, /fs\.promises\.writeFile\(CACHE_FILES\.etag, etag\)/);
  for (const patch of realPr().stages.flatMap((s: { patches: string[] }) => s.patches)) assert.doesNotMatch(readFileSync(join(LAB_DIR, patch), 'utf8'), /modelPricing/i);
});

test('each failed test keeps the first line of what jest said, without colour codes', () => {
  const report = {
    numTotalTests: 1,
    numPassedTests: 0,
    numFailedTests: 1,
    testResults: [{ name: '/repo/a/one.test.js', assertionResults: [{ fullName: 'one fails', status: 'failed', failureMessages: ['\u001b[31mError: FFMPEG binary not found.\u001b[39m\n    at stack (file.js:1:1)'] }] }],
  };
  assert.deepEqual(summarize(report, { jest: 1 }, 'abc', '2026-11-01').failed_tests, [{ file: 'a/one.test.js', test: 'one fails', message: 'Error: FFMPEG binary not found.' }]);
});

test('extractText takes the first span between its markers and drops editor line numbers', () => {
  const source = 'Title\nNear the door\n  second line   _5\nthe end.\nLater: Near the door again.\nthe end.';
  assert.equal(extractText(source, 'Near the door', 'the end.'), 'Near the door\nsecond line\nthe end.');
  const wrapped = 'one two\n    three four';
  assert.equal(extractText(wrapped, 'one two three', 'four'), 'one two\nthree four');
  assert.throws(() => extractText(source, 'missing', 'the end.'), /missing/);
  assert.throws(() => extractText(source, 'Near', 'missing'), /missing/);
  assert.throws(() => extractText(`start ${'word '.repeat(1000)} end`, 'start', 'end'), /too long/);
});

// The checked-in files: these read the real lab folder.

const realTestSet = () => parseTestSet(readFileSync(join(LAB_DIR, 'testset.json'), 'utf8'));
const realPr = () => JSON.parse(readFileSync(join(LAB_DIR, 'pr.json'), 'utf8'));
const hasClone = existsSync(CLONE);

test('testset.json holds three public-domain recordings with their sources and text', () => {
  const set = realTestSet();
  assert.equal(set.recordings.length, 3);
  assert.equal(new Set(set.recordings.map((r) => r.reader)).size, 3);
  for (const r of set.recordings) {
    assert.match(r.audioLicence, /creativecommons\.org\/(publicdomain|licenses\/publicdomain)/);
    assert.match(r.audioUrl, /^https:\/\/archive\.org\/download\/.+_64kb\.mp3$/);
    assert.match(r.catalogUrl, /^https:\/\/librivox\.org\//);
    assert.match(r.textPageUrl, /^https:\/\/www\.gutenberg\.org\/ebooks\/\d+$/);
    assert.match(r.audioSha1, /^[0-9a-f]{40}$/);
    const seconds = lengthToSeconds(r.audioLength);
    assert.ok(seconds >= 60 && seconds <= 120, `${r.id} runs ${seconds} s`);
    assert.ok(r.text.split(/\s+/).length > 50, `${r.id} is too short`);
    assert.doesNotMatch(r.text, /_\d+/);
  }
});

test('testset.md is what the notes renderer makes from testset.json', () => {
  const checkPath = join(LAB_DIR, 'testset-check.json');
  const check = existsSync(checkPath) ? JSON.parse(readFileSync(checkPath, 'utf8')) : null;
  assert.equal(readFileSync(join(LAB_DIR, 'testset.md'), 'utf8'), renderTestSetNotes(realTestSet(), check));
});

test('testset-check.json agrees with wer.ts, and on those real transcripts the rule leaves out only LibriVox words', () => {
  const check = JSON.parse(readFileSync(join(LAB_DIR, 'testset-check.json'), 'utf8')) as LocalCheck;
  const rows = new Map(check.recordings.map((row) => [row.id, row]));
  for (const recording of realTestSet().recordings) {
    const row = rows.get(recording.id);
    assert.ok(row, recording.id);
    const score = scoreTranscript(recording.text, row.transcript);
    assert.equal(score.wer, row.wer);
    assert.deepEqual(score.droppedBefore, row.droppedBefore);
    assert.deepEqual(score.droppedAfter, row.droppedAfter);
    assert.ok(score.wer < 0.2, `${recording.id}: the file should hold the published text, got ${score.wer}`);
    assert.match(row.droppedBefore.join(' '), /\bby\b/, 'the preamble says who wrote or read it');
    assert.ok(row.droppedAfter.length > 0, 'the closing is left out');
  }
  assert.match(rows.get('in-flanders-fields')?.droppedAfter.join(' ') ?? '', /end of poem this recording is in the public domain/);
  assert.match(rows.get('ozymandias')?.droppedAfter.join(' ') ?? '', /end of poem this recording is in the public domain/);
});

test('no audio is ever kept in the lab folder', () => {
  const audio = Object.keys(listFiles(LAB_DIR)).filter((path) => /\.(mp3|wav|m4a|m4b|ogg|flac|f32)$/i.test(path));
  assert.deepEqual(audio, []);
});

test('prices.json matches the vendor pricing page, where that page has been fetched', (t) => {
  const page = join(REPO_ROOT, 'tmp', 'vendor-docs', 'openai-pricing.md');
  if (!existsSync(page)) return t.skip('tmp/vendor-docs/openai-pricing.md is not here');
  const text = readFileSync(page, 'utf8');
  const prices = parsePrices(readFileSync(join(LAB_DIR, 'prices.json'), 'utf8'));
  assert.ok(text.includes(`| gpt-transcribe | Transcription | - | - | $${prices.perMinuteUsd['gpt-transcribe']} / minute |`));
  assert.ok(text.includes(`| Whisper | Transcription | - | - | $${prices.perMinuteUsd['whisper-1']} / minute |`));
  assert.equal(prices.source, 'https://developers.openai.com/api/docs/pricing');
  assert.match(prices.fetched, /^\d{4}-\d{2}-\d{2}$/);
});

const EFFECTS = ['cheaper', 'faster', 'better answers', 'keeps working', 'new capability'];
const SPEC_TITLE = 'Keep audio uploads working after 26 Feb 2027 · whisper-1 → gpt-transcribe';

test('pr.json has every field the contract asks for', () => {
  const pr = realPr();
  assert.equal(pr.schema, 1);
  assert.equal(pr.id, '02');
  assert.equal(pr.spec, 'docs/prs/02-anythingllm-whisper-retirement.md');
  assert.ok(existsSync(join(REPO_ROOT, pr.spec)));
  assert.equal(pr.upstream, 'Mintplex-Labs/anything-llm');
  assert.equal(pr.fork, 'anything-llm');
  assert.match(pr.baseCommit, /^bbefbc7f[0-9a-f]{32}$/);
  assert.equal(pr.baseBranch, 'replay/bbefbc7f');
  assert.equal(pr.ciWorkflow, null);
  assert.equal(pr.branch, 'keepup/2026-09-01-whisper-retirement');
  assert.equal(pr.lab, 'lab/02-whisper');
  assert.ok(pr.source);
  assert.match(pr.sourceUrl, /^https:\/\//);
  for (const field of ['founderLine', 'whyItFits', 'risks', 'rollback', 'effort']) assert.ok(pr[field], field);
  assert.ok(pr.effect.length > 0 && pr.effect.every((e: string) => EFFECTS.includes(e)));
  assert.ok(['Hours', 'A day', 'A project'].includes(pr.effort));
  assert.match(pr.proof.vendor.url, /^https:\/\//);
  assert.ok(pr.proof.vendor.claim);
  assert.ok(pr.sources.length > 0 && pr.sources.every((s: string) => s.startsWith('https://')));
});

test('pr.json has one stage, on the replay date, with the title the spec gives', () => {
  const [stage, ...others] = realPr().stages;
  assert.deepEqual(others, []);
  assert.equal(stage.date, '2026-09-01');
  assert.equal(stage.title, 'Keep audio uploads working after 26 Feb 2027 · {{lab.title_number}}');
  assert.equal(stage.titleUnmeasured, SPEC_TITLE);
  assert.ok(stage.whatShipped);
  assert.ok(stage.whatThisChanges);
  assert.equal(stage.comment, null);
  assert.ok(stage.patches.length > 0);
  for (const patch of stage.patches) assert.ok(existsSync(join(LAB_DIR, patch)), patch);
});

test('the App accepts pr.json, and renders the spec title with no measured lab and with one that found no gain', () => {
  const [stage] = loadSpec(join(LAB_DIR, 'pr.json'), REPO_ROOT).stages;
  const view = (result: LabView['result']): LabView => ({ lab: 'lab/02-whisper', resultFile: 'result.md', result, problem: null });
  const measured = (title_number: string) => view({ lab: LAB, status: 'measured', measured_at: '2026-11-01', title_number, body: '' });
  assert.equal(renderTitle(stage, view(null), { allowUnmeasured: true }), SPEC_TITLE);
  assert.throws(() => renderTitle(stage, view(null)), /isn't measured/);
  assert.equal(renderTitle(stage, measured(titleNumberFor(0.02, 0.02, 3))), SPEC_TITLE);
  assert.equal(renderTitle(stage, measured(titleNumberFor(0.021, 0.014, 3))), `${SPEC_TITLE}, word error rate 2.1% → 1.4% on 3 recordings`);
});

test('the risks name the upload formats the lab leaves untested, which the collector really accepts at the base commit', (t) => {
  const pr = realPr();
  assert.match(pr.risks, /\.ogg, \.oga and \.opus/);
  assert.match(pr.risks, /lab sends only mp3/);
  assert.match(pr.risks, /guide and its API reference disagree on ogg/);
  if (!hasClone) return t.skip('tmp/anything-llm is not here');
  const constants = execFileSync('git', ['-C', CLONE, 'show', `${pr.baseCommit}:collector/utils/constants.js`], { encoding: 'utf8' });
  for (const extension of ['.ogg', '.oga', '.opus']) assert.ok(constants.includes(`"${extension}": "./convert/asAudio.js"`), extension);
});

/** The spec names these three as not covered, and says the risks say so. */
const NOT_COVERED = ['server/utils/SpeechToText/openAi/index.js:8', 'frontend/src/components/SpeechToText/OpenAiOptions/index.jsx:76', 'server/utils/helpers/customModels.js:306'];
const FALLBACK_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];

test('the risks name all three places the spec says this leaves on whisper-1, and each holds it at the base commit', (t) => {
  const pr = realPr();
  const spec = readFileSync(join(REPO_ROOT, pr.spec), 'utf8');
  for (const place of NOT_COVERED) {
    assert.ok(spec.includes(place), `the spec should name ${place}`);
    assert.ok(pr.risks.includes(place), `the risks should name ${place}`);
  }
  if (!hasClone) return t.skip('tmp/anything-llm is not here');
  for (const place of NOT_COVERED) {
    const [path, line] = place.split(':');
    const text = execFileSync('git', ['-C', CLONE, 'show', `${pr.baseCommit}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.ok(text.split('\n')[Number(line) - 1].includes('"whisper-1"'), `${place} should hold whisper-1`);
  }
});

test('the risks say the fallback list\'s other models shut down the same day, as OpenAI\'s page has it', (t) => {
  const pr = realPr();
  for (const model of FALLBACK_MODELS) assert.ok(pr.risks.includes(model), `the risks should name ${model}`);
  assert.match(pr.risks, /shut down the same day/);
  if (hasClone) {
    const list = execFileSync('git', ['-C', CLONE, 'show', `${pr.baseCommit}:server/utils/helpers/customModels.js`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const fallback = list.slice(list.indexOf('async function openAiSttModels'), list.indexOf('const { OpenAI: OpenAIApi }', list.indexOf('async function openAiSttModels')));
    for (const model of FALLBACK_MODELS) assert.ok(fallback.includes(`id: "${model}"`), `the fallback list should hold ${model}`);
  }
  const page = join(REPO_ROOT, 'tmp', 'vendor-docs', 'deprecations.md');
  if (!existsSync(page)) return t.skip('tmp/vendor-docs/deprecations.md is not here');
  const text = readFileSync(page, 'utf8');
  for (const model of ['whisper-1', ...FALLBACK_MODELS]) assert.match(text, new RegExp(`Feb 26, 2027\\s+\\|\\s+\`${model}\``), model);
});

const WHERE_CLAIMS: Record<string, string> = {
  'collector/utils/WhisperProviders/OpenAiWhisper.js': 'this.model = "whisper-1"',
  'frontend/src/components/TranscriptionSelection/OpenAiOptions/index.jsx': 'Whisper Large',
  'frontend/src/pages/GeneralSettings/TranscriptionPreference/index.jsx': 'OpenAI Whisper-large model',
};

test('the where lines in pr.json point at what they claim, at the base commit', (t) => {
  if (!hasClone) return t.skip('tmp/anything-llm is not here');
  const pr = realPr();
  assert.deepEqual(pr.where.map((w: { path: string }) => w.path).sort(), Object.keys(WHERE_CLAIMS).sort());
  for (const { path, line } of pr.where) {
    const text = execFileSync('git', ['-C', CLONE, 'show', `${pr.baseCommit}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.ok(text.split('\n')[line - 1].includes(WHERE_CLAIMS[path]), `${path}:${line} should hold ${WHERE_CLAIMS[path]}`);
  }
});

test('the patches apply in order at the base commit, and carry the replay date', (t) => {
  if (!hasClone) return t.skip('tmp/anything-llm is not here');
  const pr = realPr();
  const patches = pr.stages.flatMap((s: { patches: string[] }) => s.patches).map((p: string) => join(LAB_DIR, p));
  const dest = mkdtempSync(join(tmpdir(), 'keepup-02-tree-'));
  prepareArchiveTree(CLONE, dest, pr.baseCommit, patches, []);
  const provider = readFileSync(join(dest, 'collector', 'utils', 'WhisperProviders', 'OpenAiWhisper.js'), 'utf8');
  assert.match(provider, /options\.WhisperOpenAiModel \|\| DEFAULT_MODEL/);
  assert.match(provider, /const DEFAULT_MODEL = "gpt-transcribe"/);
  assert.ok(existsSync(join(dest, 'collector', '__tests__', 'utils', 'WhisperProviders', 'OpenAiWhisper.test.js')));
  for (const patch of patches) assert.match(readFileSync(patch, 'utf8'), /^Date: .*1 Sep 2026 12:00:00 \+0000$/m);
  rmSync(dest, { recursive: true, force: true });
});

test('result.md on disk is a valid result written by run.ts, and not_run holds no numbers', () => {
  const result = parseResult(readFileSync(join(LAB_DIR, 'result.md'), 'utf8'));
  assert.equal(result.lab, LAB);
  if (result.status === 'not_run') {
    assert.equal(result.body, NOT_RUN_SENTENCE);
    assert.equal(result.needs, KEY_NAME);
  }
});

// Helpers that read the temp lab folder.

function parseableMeasured(): string {
  return '---\nlab: 02-whisper\nstatus: measured\nmeasured_at: 2026-10-01\n---\n| | before | after |\n| --- | --- | --- |\n| x | 1 | 2 |\n';
}

function fakeRunFromInput(root: string, request: SandboxRequest): Raw {
  const inputFile = join(root, 'lab', '.work', request.input.replace('/lab-work/', ''));
  const input = JSON.parse(readFileSync(inputFile, 'utf8')) as { fakeTranscripts: Record<string, Record<string, string>> };
  const runs = TEST_SET.recordings.flatMap((r) => [BEFORE_MODEL, AFTER_MODEL].map((model) => run(r.id, model, input.fakeTranscripts[r.audioFile][model], 1)));
  return cannedRaw({ fake: true, runs });
}
