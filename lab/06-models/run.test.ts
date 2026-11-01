import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { REPO_ROOT } from '../shared/env.ts';
import { openRouterPrice } from '../shared/prices.ts';
import { manifestProblem, parseResult, readResult, renderResult, type LabResult } from '../shared/result.ts';
import { buildResult, daysBetween, KEY_NAME, LIST_FILE, NOT_RUN_SENTENCE, parseRaw, PINNED_COMMIT, PROVIDER_FILE, RELEASES, scrubSecrets, SHUT_DOWN_MODEL, TEAM_COMMIT, teamLine, type GitRead, type RawRun } from './report.ts';
import { main, type Deps, type SandboxRequest } from './run.ts';
import { branchTip, parseChecks, summarize, testFilesIn } from './repo-tests.ts';
import { prepareArchiveTree } from './tree.ts';

const LAB_DIR = import.meta.dirname;
const CLONE = join(REPO_ROOT, 'tmp', 'anything-llm');
const HAS_CLONE = existsSync(join(CLONE, '.git'));
const NO_CLONE = HAS_CLONE ? false : 'tmp/anything-llm is not here';
const HARNESS = join(LAB_DIR, 'harness.cjs');
const DEPRECATIONS = join(REPO_ROOT, 'tmp/vendor-docs/deprecations.md');
const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const pr = JSON.parse(readFileSync(join(LAB_DIR, 'pr.json'), 'utf8'));
const patchText = (i: number) => readFileSync(join(LAB_DIR, pr.stages[i].patches[0]), 'utf8');
const git = (...args: string[]) => execFileSync('git', ['-C', CLONE, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const tempDirs: string[] = [];
function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `keepup-06-${name}-`));
  tempDirs.push(dir);
  return dir;
}
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// ---- pr.json against docs/contracts.md

test('pr.json has every field the contract asks for, in its shape', () => {
  const required = ['schema', 'id', 'spec', 'upstream', 'fork', 'baseCommit', 'baseBranch', 'ciWorkflow', 'branch', 'lab', 'source', 'sourceUrl', 'where', 'founderLine', 'effect', 'effort', 'whyItFits', 'risks', 'rollback', 'proof', 'sources', 'stages'];
  for (const field of required) assert.ok(field in pr, `missing ${field}`);
  assert.equal(pr.schema, 1);
  assert.equal(pr.id, '06');
  assert.ok(existsSync(join(REPO_ROOT, pr.spec)), 'the spec file exists');
  assert.equal(pr.upstream, 'Mintplex-Labs/anything-llm');
  assert.equal(pr.fork, 'anything-llm');
  assert.match(pr.baseCommit, /^[0-9a-f]{40}$/);
  assert.equal(pr.baseBranch, `replay/${pr.baseCommit.slice(0, 8)}`);
  assert.equal(pr.ciWorkflow, null);
  assert.equal(pr.branch, 'keepup/2026-09-22-gpt-6-models');
  assert.equal(pr.lab, 'lab/06-models');
  assert.ok(pr.effect.length > 0 && pr.effect.every((w: string) => ['cheaper', 'faster', 'better answers', 'keeps working', 'new capability'].includes(w)));
  assert.ok(['Hours', 'A day', 'A project'].includes(pr.effort));
  assert.ok('vendor' in pr.proof && 'independent' in pr.proof);
  for (const url of [pr.sourceUrl, pr.proof.vendor.url, ...pr.sources]) assert.match(url, /^https:\/\/\S+$/);
});

test('the stages are the two replay dates, with the two fixed titles and existing patches', () => {
  assert.deepEqual(pr.stages.map((s: { date: string }) => s.date), ['2026-09-22', '2026-09-29']);
  assert.equal(pr.stages[0].title, 'Add GPT-6 Sol and GPT-6 Luna to the OpenAI fallback model list · released today');
  assert.equal(pr.stages[1].title, 'Add GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol to the OpenAI fallback model list', 'GPT-6 Sol and Luna shipped a week before this stage, so it can\'t say "released today"');
  for (const stage of pr.stages) assert.ok(readFileSync(join(REPO_ROOT, pr.spec), 'utf8').includes(`"${stage.title}"`), `"${stage.title}" is word for word the one in the spec`);
  assert.equal(pr.stages[0].comment, null);
  assert.ok(pr.stages[1].comment.length > 0);
  for (const stage of pr.stages) {
    assert.ok(stage.whatShipped && stage.whatThisChanges);
    assert.ok(stage.patches.length > 0);
    for (const patch of stage.patches) assert.ok(existsSync(join(LAB_DIR, patch)), `${patch} exists`);
    assert.ok(!stage.title.includes('{{'), 'the title takes no number');
  }
});

test('the App accepts pr.json, when the App is here', { skip: existsSync(join(REPO_ROOT, 'app/src/specs.ts')) ? false : 'app/src/specs.ts is not here' }, async () => {
  const { loadSpec } = await import('../../app/src/specs.ts');
  assert.equal(loadSpec(join(LAB_DIR, 'pr.json'), REPO_ROOT).id, '06');
});

test('the founder line has no number beyond the model names', () => {
  assert.ok(!/\d/.test(pr.founderLine.replace(/GPT-6(\.1)?/g, '')), pr.founderLine);
});

test('the "where" lines point at what they claim at the base commit', { skip: NO_CLONE }, () => {
  const claims: Record<string, { line: string; nearby: string }> = {
    [LIST_FILE]: { line: 'return [', nearby: 'name: "gpt-3.5-turbo"' },
    [PROVIDER_FILE]: { line: '#temperature(modelName, temperature) {', nearby: 'NO_TEMP_MODELS' },
  };
  assert.deepEqual(pr.where.map((w: { path: string }) => w.path).sort(), Object.keys(claims).sort());
  for (const { path, line } of pr.where) {
    const lines = git('show', `${pr.baseCommit}:${path}`).split('\n');
    assert.ok(lines[line - 1].includes(claims[path].line), `${path}:${line} is "${lines[line - 1]}"`);
    assert.ok(lines.slice(line - 1, line + 4).join('\n').includes(claims[path].nearby), `${path}:${line} is near ${claims[path].nearby}`);
  }
  assert.ok(git('show', `${pr.baseCommit}:${LIST_FILE}`).split('\n').slice(190, 209).join('\n').includes('async function openAiModels'));
});

test('the base commit is what the spec says and the sha is complete', { skip: NO_CLONE }, () => {
  assert.equal(git('rev-parse', 'f92433b4').trim(), pr.baseCommit);
});

test('the numbers in the risk text are the ones in the provider at the base commit', { skip: NO_CLONE }, () => {
  assert.ok(pr.risks.includes('4,096'));
  assert.ok(git('show', `${pr.baseCommit}:${PROVIDER_FILE}`).includes('MODEL_MAP.get("openai", this.model) ?? 4_096'));
});

// ---- nothing in pr.json overclaims about the team's commit

test('whyItFits is two lines about this repo at the base commit, and says when the list matters', () => {
  assert.equal(pr.whyItFits.split(/(?<=\.)\s+/).length, 2, pr.whyItFits);
  assert.match(pr.whyItFits, /only matters when its call to OpenAI's live model list fails/, pr.whyItFits);
  for (const later of [TEAM_COMMIT, PINNED_COMMIT, 'gpt-6.1-sol', ' Oct']) assert.ok(!pr.whyItFits.includes(later), `"${later}" is after 22 Sep, so it belongs in the team line`);
});

test('what whyItFits says about the list and the provider is what the base commit holds', { skip: NO_CLONE }, () => {
  assert.ok(pr.whyItFits.includes('nothing newer than gpt-4o'), pr.whyItFits);
  const file = git('show', `${pr.baseCommit}:${LIST_FILE}`);
  const fallback = file.slice(file.indexOf('async function openAiModels'), file.indexOf('const gpts = allModels'));
  assert.ok(fallback.indexOf('.catch(') < fallback.indexOf('return ['), 'the list is what the failed call returns');
  assert.deepEqual([...fallback.matchAll(/\bid: "([^"]+)"/g)].map((m) => m[1]), ['gpt-3.5-turbo', 'gpt-4o', 'gpt-4', 'gpt-4-turbo', 'gpt-4-32k', 'gpt-3.5-turbo-16k']);
  assert.ok(pr.whyItFits.includes('sends a temperature on every chat'), pr.whyItFits);
  assert.ok(git('show', `${pr.baseCommit}:${PROVIDER_FILE}`).includes('this.defaultTemp = 0.7;'));
});

test('pr.json links the team commit and never says "same models"', () => {
  assert.ok(!/same models/i.test(JSON.stringify(pr)));
  assert.ok(pr.sources.some((url: string) => url.endsWith(`/commit/${TEAM_COMMIT}`)), 'names the commit');
});

test('git backs the team commit\'s date and its old and new default', { skip: NO_CLONE }, () => {
  assert.equal(git('log', '-1', '--format=%as', TEAM_COMMIT).trim(), '2026-10-27');
  const defaultAt = (rev: string) => git('show', `${rev}:${PROVIDER_FILE}`).match(/OPEN_MODEL_PREF \|\| "([^"]+)"/)?.[1];
  assert.equal(defaultAt(`${TEAM_COMMIT}^`), SHUT_DOWN_MODEL);
  assert.equal(defaultAt(TEAM_COMMIT), 'gpt-5.6-luna');
  assert.equal(git('log', '-1', '--format=%h', PINNED_COMMIT).trim().slice(0, PINNED_COMMIT.length), PINNED_COMMIT);
});

test('the shutdown is on OpenAI\'s deprecations page, and pr.json cites that page', { skip: existsSync(DEPRECATIONS) ? false : 'tmp/vendor-docs/deprecations.md is not here' }, () => {
  const row = readFileSync(DEPRECATIONS, 'utf8').split('\n').find((l) => l.includes(`\`${SHUT_DOWN_MODEL}\``) && l.startsWith('|'));
  assert.ok(row?.startsWith('| October 23, 2026 |'), row);
  assert.ok(pr.sources.includes('https://developers.openai.com/api/docs/deprecations'));
});

test('the team really added gpt-6-luna and gpt-6.1-sol in that commit, and never gpt-6-sol', { skip: NO_CLONE }, () => {
  const line = teamLine((args) => git(...args));
  assert.ok(line.includes('27 Oct 2026'));
  assert.ok(line.includes('was a fix for the gpt-4.1-nano shutdown that also changed this list'), line);
  assert.ok(line.includes('moved the OpenAI default from gpt-4.1-nano to gpt-5.6-luna'), line);
  assert.ok(line.includes(`in the file this pull request changes (${LIST_FILE})`), line);
  assert.ok(!line.includes('same file'), 'the default does not live in the list\'s file');
  assert.ok(line.includes('gpt-6-luna first appears in that list 35 days'), line);
  assert.ok(line.includes('gpt-6.1-sol 28 days'), line);
  assert.ok(line.includes('gpt-6-sol was never added, as of 9caf2b4 (30 Oct 2026)'), line);
  assert.equal(git('log', '--format=%h', '-S"gpt-6-sol"', PINNED_COMMIT, '--', LIST_FILE).trim(), '', 'no commit up to the pinned one ever put gpt-6-sol in the list');
});

// ---- the patches

test('commit 1 has no gpt-6.1-sol, commit 2 adds it, and each carries its replay date', () => {
  assert.ok(!patchText(0).includes('gpt-6.1-sol'));
  for (const id of ['gpt-6-sol', 'gpt-6-luna']) assert.ok(patchText(0).includes(`id: "${id}"`), id);
  assert.ok(patchText(1).includes('id: "gpt-6.1-sol"'));
  assert.match(patchText(0), /^Date: Tue, 22 Sep 2026 12:00:00 \+0000$/m);
  assert.match(patchText(1), /^Date: Tue, 29 Sep 2026 12:00:00 \+0000$/m);
  for (const text of [patchText(0), patchText(1)]) assert.ok(text.includes(pr.sourceUrl), 'the commit message names the source');
});

test('the patches touch only the model list, the provider rule and their tests', () => {
  const touched = (text: string) => [...text.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]).sort();
  assert.deepEqual(touched(patchText(0)), [
    'server/__tests__/utils/AiProviders/openAi/index.test.js',
    'server/__tests__/utils/helpers/customModels.test.js',
    PROVIDER_FILE,
    LIST_FILE,
  ].sort());
  assert.deepEqual(touched(patchText(1)), [
    'server/__tests__/utils/AiProviders/openAi/index.test.js',
    'server/__tests__/utils/helpers/customModels.test.js',
    LIST_FILE,
  ].sort());
});

test('each release date is the one in the provider changelog in data/db', () => {
  const log = gunzipSync(readFileSync(join(REPO_ROOT, 'data/db/changelog-openai.txt.gz'))).toString('utf8').split('\n');
  // A "Sep 22" heading carries no year, so the month section above it has to say 2026.
  const dateBefore = (needle: string) => {
    const at = log.findIndex((l) => l.includes(needle));
    assert.ok(at > 0, needle);
    const above = log.slice(0, at).reverse();
    const day = above.find((l) => /^\s*Sep \d+\s*$/.test(l))?.trim();
    const section = above.find((l) => /^\s*[A-Z][a-z]+, \d{4}\s*$/.test(l))?.trim();
    return `${day} / ${section}`;
  };
  assert.equal(dateBefore('Released GPT-6 Sol ( gpt-6-sol ) and GPT-6 Luna ( gpt-6-luna )'), 'Sep 22 / September, 2026');
  assert.equal(dateBefore('Released GPT-6.1 Sol ( gpt-6.1-sol )'), 'Sep 29 / September, 2026');
  assert.deepEqual(RELEASES.map((r) => r.date), ['2026-09-22', '2026-09-22', '2026-09-29']);
});

test('the patches apply in order at the base commit and give each model its release date as created', { skip: NO_CLONE }, () => {
  const dest = join(tempDir('tree'), 'tree');
  const patches = pr.stages.flatMap((s: { patches: string[] }) => s.patches).map((p: string) => join(LAB_DIR, p));
  prepareArchiveTree(CLONE, dest, pr.baseCommit, patches, [LIST_FILE, PROVIDER_FILE]);
  const list = readFileSync(join(dest, LIST_FILE), 'utf8');
  for (const { model, date } of RELEASES) {
    const entry = new RegExp(`name: "${model}",\\s+id: "${model}",\\s+object: "model",\\s+created: (\\d+),\\s+owned_by: "openai",\\s+organization: "OpenAi",`);
    const found = list.match(entry);
    assert.ok(found, `${model} has the file's shape`);
    assert.equal(Number(found[1]), Date.parse(`${date}T00:00:00Z`) / 1000, `${model} created`);
  }
  assert.ok(existsSync(join(dest, 'server/__tests__/utils/helpers/customModels.test.js')));
});

// ---- result.md, with no key

function labRoot(): string {
  const root = tempDir('root');
  mkdirSync(join(root, 'lab/06-models/patches'), { recursive: true });
  mkdirSync(join(root, 'lab/.work'), { recursive: true });
  cpSync(join(LAB_DIR, 'pr.json'), join(root, 'lab/06-models/pr.json'));
  cpSync(join(LAB_DIR, 'patches'), join(root, 'lab/06-models/patches'), { recursive: true });
  return root;
}

const resultPath = (root: string) => join(root, 'lab/06-models/result.md');
const measuredBefore: LabResult = { lab: '06-models', status: 'measured', measured_at: '2026-11-01', body: '| a |\n| - |' };

function fakeRun(overrides: Partial<RawRun['runs'][number]> = {}, fake = false): RawRun {
  return {
    fake,
    startedAt: '2026-11-01T10:00:00Z',
    finishedAt: '2026-11-01T10:00:09Z',
    systemPrompt: 'system',
    userPrompt: 'user',
    runs: RELEASES.map(({ model }) => ({ model, answered: true, echoedModel: model, latencyMs: 1200, appDurationSeconds: 1.2, text: 'ready', usage: { input: 20, output: 10 }, temperatureSent: false, error: null, response: null, ...(overrides.model === model ? overrides : {}) })),
  };
}

function deps(root: string, overrides: Partial<Deps> = {}): Deps {
  return {
    root,
    env: {},
    sandbox: () => {
      throw new Error('the sandbox should not run');
    },
    prepareLabTree: () => undefined,
    removeLabTree: () => undefined,
    prepareDryTree: (_pr, dest) => mkdirSync(dest, { recursive: true }),
    teamLine: () => 'The team line.',
    priceOf: (model) => openRouterPrice(`openai/${model}`),
    today: () => '2026-11-01',
    log: () => undefined,
    ...overrides,
  };
}

/** Writes raw.json where the harness would, the way a sandbox run does. */
function sandboxWriting(root: string, raw: RawRun, calls: SandboxRequest[] = [], output = 'ok', status = 0): Deps['sandbox'] {
  return (req) => {
    calls.push(req);
    const file = req.out.replace('/lab-work', join(root, 'lab/.work'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(raw));
    return { status, output };
  };
}

test('with no key it writes an honest not_run result and exits 3, without touching the sandbox', async () => {
  const root = labRoot();
  assert.equal(await main([], deps(root)), 3);
  const result = readResult(resultPath(root));
  assert.equal(result?.status, 'not_run');
  assert.equal(result?.needs, KEY_NAME);
  assert.equal(result?.body, NOT_RUN_SENTENCE);
  assert.equal(result?.measured_at, undefined);
  assert.equal(result?.title_number, undefined);
  assert.ok(!/\d/.test(NOT_RUN_SENTENCE), 'a lab that did not run has no numbers at all');
  assert.equal((NOT_RUN_SENTENCE.match(/\./g) ?? []).length, 1, 'one sentence');
  assert.ok(!NOT_RUN_SENTENCE.includes(TEAM_COMMIT), 'the team line appears only after a real run');
});

test('with no key it leaves a stronger earlier result alone', async () => {
  const root = labRoot();
  writeFileSync(resultPath(root), renderResult(measuredBefore));
  const before = readFileSync(resultPath(root), 'utf8');
  assert.equal(await main([], deps(root)), 3);
  assert.equal(readFileSync(resultPath(root), 'utf8'), before);
});

test('--no-keys never reads .env', async () => {
  const root = labRoot();
  writeFileSync(join(root, '.env'), `${KEY_NAME}=${FAKE_KEY}\n`);
  assert.equal(await main(['--no-keys'], deps(root, { env: { [KEY_NAME]: FAKE_KEY } })), 3);
  assert.equal(readResult(resultPath(root))?.status, 'not_run');
});

test('an unknown flag is a usage error, code 2, and never a real run', async () => {
  const logged: string[] = [];
  assert.equal(await main(['--dryrun'], deps(labRoot(), { env: { [KEY_NAME]: FAKE_KEY }, log: (line) => logged.push(line) })), 2);
  assert.match(logged.join('\n'), /--dryrun/);
});

// ---- with a key, against a stand-in sandbox

test('with a key it runs in the sandbox, passes the key by name only, and writes a measured result', async () => {
  const root = labRoot();
  const calls: SandboxRequest[] = [];
  const prepared: string[] = [];
  const removed: string[] = [];
  const code = await main([], deps(root, {
    env: { [KEY_NAME]: FAKE_KEY },
    sandbox: sandboxWriting(root, fakeRun(), calls),
    prepareLabTree: (_pr, dest) => prepared.push(dest),
    removeLabTree: (dest) => removed.push(dest),
  }));
  assert.equal(code, 0);
  assert.deepEqual(prepared, [join(root, 'tmp/lab-wt-06')]);
  assert.deepEqual(removed, prepared);
  assert.equal(calls[0].worktree, prepared[0]);
  assert.equal(calls[0].env.SANDBOX_ENV, KEY_NAME);
  assert.equal(calls[0].env[KEY_NAME], FAKE_KEY);
  assert.equal(calls[0].fake, false);
  assert.ok(!JSON.stringify({ ...calls[0], env: null }).includes(FAKE_KEY), 'the key is never on a command line');
  assert.ok(existsSync(join(root, 'lab/06-models/out/responses.json')));
  const result = parseResult(readFileSync(resultPath(root), 'utf8'));
  assert.equal(result.status, 'measured');
  assert.equal(manifestProblem(resultPath(root), result), null, 'its raw output is saved before its result, so the App will count it');
  assert.equal(result.measured_at, '2026-11-01');
  assert.equal(result.title_number, undefined, 'the title takes no number');
  assert.ok(result.body.includes('| gpt-6-sol | yes | gpt-6-sol | 1200 ms | 20 / 10 |'), result.body);
  assert.ok(result.body.includes('The team line.'));
});

test('costs print the price source and date from lab/shared/prices.ts', () => {
  const result = buildResult({ raw: fakeRun(), priceOf: (model) => openRouterPrice(`openai/${model}`), teamLine: 'Team.', measuredAt: '2026-11-01' });
  assert.ok(result.body.includes('| $0.000140 |'), result.body); // 20 x $2 + 10 x $10 per million
  assert.ok(result.body.includes('| $0.000007 |'), result.body); // 20 x $0.10 + 10 x $0.50 per million
  assert.ok(result.body.includes('https://openrouter.ai/openai/gpt-6-luna'));
  assert.ok(result.body.includes('2026-10-31'));
});

test('a model that fails makes the result partial, says what is needed, and estimates nothing', async () => {
  const root = labRoot();
  const raw = fakeRun({ model: 'gpt-6-sol', answered: false, echoedModel: null, latencyMs: null, usage: null, text: null, error: 'model | not found' });
  const code = await main([], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox: sandboxWriting(root, raw) }));
  assert.equal(code, 1);
  const result = readResult(resultPath(root));
  assert.equal(result?.status, 'partial');
  assert.ok(result?.needs?.includes('gpt-6-sol'));
  assert.ok(result?.body.includes('| gpt-6-sol | no: model / not found | - | - | - | - |'), result?.body);
  assert.ok(result?.body.includes('| gpt-6-luna | yes |'));
});

const outFile = (root: string, name: string) => join(root, 'lab/06-models/out', name);
const workFile = (root: string, name: string) => join(root, 'lab/.work/06-models/run', name);

/** A run where the first model is refused and the others answer slower: 9999 ms marks it apart from fakeRun's 1200. */
function weakerRun(error = 'rate limited'): RawRun {
  const [first, ...rest] = fakeRun().runs;
  return { ...fakeRun(), runs: [{ ...first, answered: false, echoedModel: null, latencyMs: null, usage: null, text: null, error }, ...rest.map((r) => ({ ...r, latencyMs: 9999 }))] };
}

test('a later run that comes back weaker leaves out/ and result.md alone, keeps its raw output under lab/.work/, and exits 1', async () => {
  const root = labRoot();
  const key = { env: { [KEY_NAME]: FAKE_KEY } };
  assert.equal(await main([], deps(root, { ...key, sandbox: sandboxWriting(root, fakeRun(), [], 'first log') })), 0);
  const saved = { result: readFileSync(resultPath(root), 'utf8'), raw: readFileSync(outFile(root, 'responses.json'), 'utf8'), log: readFileSync(outFile(root, 'sandbox.log'), 'utf8') };
  assert.ok(saved.result.includes('| gpt-6-sol | yes | gpt-6-sol | 1200 ms |'), saved.result);

  const logged: string[] = [];
  const later = sandboxWriting(root, weakerRun(`rate limited ${FAKE_KEY}`), [], `second log ${FAKE_KEY}`);
  assert.equal(await main([], deps(root, { ...key, sandbox: later, log: (line) => logged.push(line) })), 1);

  assert.equal(readFileSync(resultPath(root), 'utf8'), saved.result);
  assert.equal(readFileSync(outFile(root, 'responses.json'), 'utf8'), saved.raw);
  assert.equal(readFileSync(outFile(root, 'sandbox.log'), 'utf8'), saved.log);
  const message = logged.join('\n');
  assert.match(message, /weaker/);
  assert.ok(message.includes('lab/.work/06-models/run/'), message);
  assert.ok(!message.includes('result.md is'), `says a result was written: ${message}`);

  const keptRaw = readFileSync(workFile(root, 'raw.json'), 'utf8');
  assert.ok(keptRaw.includes('9999'), 'the weaker run is still there to read');
  assert.ok(!keptRaw.includes(FAKE_KEY), 'and it is scrubbed');
  const keptLog = readFileSync(workFile(root, 'sandbox.log'), 'utf8');
  assert.ok(keptLog.includes('second log') && !keptLog.includes(FAKE_KEY), keptLog);
});

test('a later run at least as strong as the earlier one replaces out/ and result.md together', async () => {
  const root = labRoot();
  const key = { env: { [KEY_NAME]: FAKE_KEY } };
  const steps: { raw: RawRun; code: number; status: string; shown: string }[] = [
    { raw: weakerRun(), code: 1, status: 'partial', shown: '| gpt-6-luna | yes | gpt-6-luna | 9999 ms |' },
    { raw: { ...weakerRun(), runs: weakerRun().runs.map((r) => (r.answered ? { ...r, latencyMs: 8888 } : r)) }, code: 1, status: 'partial', shown: '| gpt-6-luna | yes | gpt-6-luna | 8888 ms |' },
    { raw: fakeRun(), code: 0, status: 'measured', shown: '| gpt-6-luna | yes | gpt-6-luna | 1200 ms |' },
  ];
  for (const { raw, code, status, shown } of steps) {
    assert.equal(await main([], deps(root, { ...key, sandbox: sandboxWriting(root, raw) })), code);
    const result = readResult(resultPath(root));
    assert.equal(result?.status, status);
    assert.ok(result?.body.includes(shown), result?.body);
    assert.deepEqual(JSON.parse(readFileSync(outFile(root, 'responses.json'), 'utf8')), raw, 'out/ holds the run the table shows');
  }
});

test('a real run whose output calls itself fake reaches neither out/ nor result.md', async () => {
  const root = labRoot();
  const sandbox = sandboxWriting(root, fakeRun({}, true));
  await assert.rejects(main([], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox })), /fake/);
  assert.ok(!existsSync(resultPath(root)));
  assert.ok(!existsSync(join(root, 'lab/06-models/out')));
});

test('a harness that crashes writes no result and no outputs, and the tree is still removed', async () => {
  const root = labRoot();
  writeFileSync(resultPath(root), renderResult(measuredBefore));
  const before = readFileSync(resultPath(root), 'utf8');
  const removed: string[] = [];
  const code = await main([], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox: () => ({ status: 1, output: `boom ${FAKE_KEY}` }), removeLabTree: (d) => removed.push(d) }));
  assert.equal(code, 1);
  assert.equal(readFileSync(resultPath(root), 'utf8'), before);
  assert.ok(!existsSync(join(root, 'lab/06-models/out')));
  assert.equal(removed.length, 1);
  assert.ok(!readFileSync(join(root, 'lab/.work/06-models/run/sandbox.log'), 'utf8').includes(FAKE_KEY));
});

test('output that fails its check reaches neither result.md nor out/', async () => {
  const root = labRoot();
  const sandbox: Deps['sandbox'] = (req) => {
    const file = req.out.replace('/lab-work', join(root, 'lab/.work'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    return { status: 0, output: 'ok' };
  };
  await assert.rejects(main([], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox })), /raw\.json/);
  assert.ok(!existsSync(resultPath(root)));
  assert.ok(!existsSync(join(root, 'lab/06-models/out')));
});

test('if git cannot back the team line, it stops before any request is sent', async () => {
  const root = labRoot();
  const calls: SandboxRequest[] = [];
  const teamLineFails = () => {
    throw new Error('no clone');
  };
  await assert.rejects(main([], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox: sandboxWriting(root, fakeRun(), calls), teamLine: teamLineFails })), /no clone/);
  assert.equal(calls.length, 0);
});

test('a fake run can never become a result', () => {
  assert.throws(() => buildResult({ raw: fakeRun({}, true), priceOf: (m) => openRouterPrice(`openai/${m}`), teamLine: 'Team.', measuredAt: '2026-11-01' }), /fake/);
});

// ---- no keys in anything written

test('the writer scrubs the exact key and anything key-shaped', () => {
  const text = `exact ${FAKE_KEY} masked sk-proj-abc****wxyz plain words sk-short`;
  const clean = scrubSecrets(text, [FAKE_KEY, '']);
  assert.ok(!clean.includes(FAKE_KEY));
  assert.ok(!clean.includes('sk-proj-abc'));
  assert.ok(clean.includes('plain words'));
});

test('raw outputs saved to out/ contain no key, even when the run leaked one', async () => {
  const root = labRoot();
  const leaky = fakeRun({ model: 'gpt-6-luna', text: `ready ${FAKE_KEY}` });
  await main([], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox: sandboxWriting(root, leaky, [], `log line with ${FAKE_KEY}`) }));
  for (const file of readdirSync(join(root, 'lab/06-models/out'))) {
    assert.ok(!readFileSync(join(root, 'lab/06-models/out', file), 'utf8').includes(FAKE_KEY), file);
  }
  assert.ok(!readFileSync(join(root, 'lab/.work/06-models/run/raw.json'), 'utf8').includes(FAKE_KEY), 'the work copy is scrubbed too');
});

// ---- parsing what the harness wrote

test('parseRaw refuses a run that is missing a model or has a broken row', () => {
  const models = RELEASES.map((r) => r.model);
  assert.equal(parseRaw(JSON.stringify(fakeRun()), models).runs.length, models.length);
  const missing = { ...fakeRun(), runs: fakeRun().runs.slice(1) };
  assert.throws(() => parseRaw(JSON.stringify(missing), models), /gpt-6-sol/);
  const broken = { ...fakeRun(), runs: fakeRun().runs.map((r) => ({ ...r, latencyMs: 'fast' })) };
  assert.throws(() => parseRaw(JSON.stringify(broken), models), /latencyMs/);
  assert.throws(() => parseRaw('{ not json', models), /raw\.json/);
});

// ---- the team line

const providerWith = (model: string) => `this.model =\n  modelPreference || process.env.OPEN_MODEL_PREF || "${model}";`;

const noCommits = '';

function stubGit(after: string, before: string, defaults = { before: 'gpt-4.1-nano', after: 'gpt-5.6-luna' }, commitsAddingIt = noCommits, commitDate = '2026-10-27T11:28:41-07:00'): GitRead {
  return (args) => {
    if (args[0] === 'log') return args.some((a) => a.startsWith('-S')) ? commitsAddingIt : `${commitDate}\n`;
    const old = args[1].includes('^');
    if (args[1].endsWith(PROVIDER_FILE)) return providerWith(old ? defaults.before : defaults.after);
    return old ? before : after;
  };
}

test('teamLine computes the days from git and says what the team did not add', () => {
  const line = teamLine(stubGit('{ id: "gpt-6-luna" } { id: "gpt-6.1-sol" }', '{ id: "gpt-4o" }'));
  assert.ok(line.includes('5edf32b9'));
  assert.ok(line.includes('27 Oct 2026'));
  assert.ok(line.includes('fix for the gpt-4.1-nano shutdown'), line);
  assert.ok(line.includes('moved the OpenAI default from gpt-4.1-nano to gpt-5.6-luna'), line);
  assert.ok(line.includes(LIST_FILE), line);
  assert.ok(line.includes('gpt-6-luna first appears in that list 35 days'), line);
  assert.ok(line.includes('gpt-6.1-sol 28 days'), line);
  assert.ok(line.includes('gpt-6-sol was never added, as of 9caf2b4'), line);
});

test('teamLine only says "never added" when no commit up to the pin added it', () => {
  const line = teamLine(stubGit('{ id: "gpt-6-luna" }', '{ id: "gpt-4o" }', undefined, 'abc1234\n'));
  assert.ok(line.includes('It did not add gpt-6-sol.'), line);
  assert.ok(!line.includes('never added'), line);
});

test('teamLine dates commits in UTC, whatever the commit\'s own offset says', () => {
  const line = teamLine(stubGit('{ id: "gpt-6-luna" }', '{ id: "gpt-4o" }', undefined, noCommits, '2026-10-27T23:30:00-07:00'));
  assert.ok(line.includes('(28 Oct 2026)'), line);
  assert.ok(line.includes('gpt-6-luna first appears in that list 36 days'), line);
});

test('teamLine reads the new default from git rather than assuming it', () => {
  const line = teamLine(stubGit('{ id: "gpt-6-luna" }', '{ id: "gpt-4o" }', { before: 'gpt-4.1-nano', after: 'some-other-model' }));
  assert.ok(line.includes('from gpt-4.1-nano to some-other-model'), line);
});

test('teamLine fails loud when the commit did not move the default off the model that shut down', () => {
  const list = ['{ id: "gpt-6-luna" }', '{ id: "gpt-4o" }'] as const;
  assert.throws(() => teamLine(stubGit(...list, { before: 'gpt-4o', after: 'gpt-5.6-luna' })), /gpt-4\.1-nano/);
  assert.throws(() => teamLine(stubGit(...list, { before: 'gpt-4.1-nano', after: 'gpt-4.1-nano' })), /gpt-4\.1-nano/);
  const noDefault: GitRead = (args) => (args[0] === 'log' ? '2026-10-27\n' : args[1].endsWith(PROVIDER_FILE) ? 'no default here' : list[args[1].includes('^') ? 1 : 0]);
  assert.throws(() => teamLine(noDefault), /default/);
});

test('teamLine fails loud when git does not back the claim', () => {
  assert.throws(() => teamLine(stubGit('{ id: "gpt-4o" }', '{ id: "gpt-4o" }')), /5edf32b9/);
});

test('daysBetween counts whole days', () => {
  assert.equal(daysBetween('2026-09-22', '2026-10-27'), 35);
  assert.equal(daysBetween('2026-09-29', '2026-10-27'), 28);
});

// ---- the repo's own tests, as docs/contracts.md asks for them

const jestReport = {
  numTotalTests: 4,
  numPassedTests: 3,
  numFailedTests: 1,
  testResults: [
    { name: '/repo/collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', assertionResults: [{ fullName: 'FFMPEGWrapper finds it', status: 'failed' }] },
    { name: '/repo/server/__tests__/utils/helpers/customModels.test.js', assertionResults: [{ fullName: 'a', status: 'passed' }, { fullName: 'b', status: 'passed' }] },
    { name: '/repo/server/other.test.js', assertionResults: [{ fullName: 'c', status: 'passed' }] },
  ],
};

test('repo-test evidence reads every count from the report and names what failed', () => {
  const checks = { jest: 1, 'server lint': 0, 'ffmpeg in image': 1 };
  const evidence = summarize(jestReport, checks, 'abc', '2026-11-01', ['server/__tests__/utils/helpers/customModels.test.js']);
  assert.ok(evidence.summary.startsWith('3 of 4 repo tests pass in the sandbox on Node 18.'), evidence.summary);
  assert.ok(evidence.summary.includes('The 1 that fails is in collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js'), evidence.summary);
  assert.ok(evidence.summary.includes('the image has no ffmpeg binary'), evidence.summary);
  assert.ok(evidence.summary.includes('Every linter and check that ran passed'), evidence.summary);
  assert.deepEqual(evidence.tests, { total: 4, passed: 3, failed: 1 });
  assert.deepEqual(evidence.failed_tests, [{ file: 'collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js', test: 'FFMPEGWrapper finds it' }]);
  assert.deepEqual(evidence.tests_this_change_adds, [{ file: 'server/__tests__/utils/helpers/customModels.test.js', total: 2, passed: 2 }]);
});

test('repo-test evidence says so when a linter fails, and blames no missing binary it did not check', () => {
  const evidence = summarize(jestReport, { jest: 1, 'server lint': 1, 'ffmpeg in image': 0 }, 'abc', '2026-11-01', []);
  assert.ok(evidence.summary.includes('server lint failed'), evidence.summary);
  assert.ok(!evidence.summary.includes('no ffmpeg'), evidence.summary);
});

test('parseChecks reads the exit code after the last equals sign', () => {
  assert.deepEqual(parseChecks('jest=1\nserver lint=0\n'), { jest: 1, 'server lint': 0 });
  assert.throws(() => parseChecks('server lint=\n'), /server lint/);
});

test('the test files a patch adds or changes are read from its diff', () => {
  assert.deepEqual(testFilesIn(patchText(0)).sort(), ['server/__tests__/utils/AiProviders/openAi/index.test.js', 'server/__tests__/utils/helpers/customModels.test.js']);
});

test('saved repo-test evidence adds up, and is for the tip of this branch while the branch is here', { skip: NO_CLONE || (existsSync(join(LAB_DIR, 'out/repo-tests.json')) ? false : 'no evidence saved') }, (t) => {
  const evidence = JSON.parse(readFileSync(join(LAB_DIR, 'out/repo-tests.json'), 'utf8'));
  assert.ok(evidence.tests.total === evidence.tests.passed + evidence.tests.failed);
  const tip = branchTip(CLONE, pr.branch);
  if (tip === null) {
    t.skip(`${pr.branch} has been removed from the clone`);
    return;
  }
  assert.equal(evidence.commit, tip);
});

test('branchTip finds a branch, and says null rather than throwing once it has been removed', () => {
  const repo = tempDir('branch');
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  run('init', '-q');
  run('commit', '-q', '--allow-empty', '-m', 'base');
  run('branch', 'keepup/gone');
  assert.equal(branchTip(repo, 'keepup/gone'), run('rev-parse', 'HEAD').trim());
  run('branch', '-q', '-D', 'keepup/gone');
  assert.equal(branchTip(repo, 'keepup/gone'), null);
});

// ---- the fake provider follows OpenAI's written rule

const require = createRequire(import.meta.url);
const { respond } = require('./fake-openai.cjs') as { respond: (body: Record<string, unknown>, models: string[]) => { status: number; json: Record<string, any> } };

test('the fake provider answers a GPT-6 request with no temperature and echoes the model', () => {
  const { status, json } = respond({ model: 'gpt-6-sol', input: 'hi' }, ['gpt-6-sol']);
  assert.equal(status, 200);
  assert.equal(json.object, 'response');
  assert.equal(json.model, 'gpt-6-sol');
});

test('the fake provider rejects temperature on GPT-6 at the default reasoning effort, as OpenAI\'s guide says', () => {
  assert.equal(respond({ model: 'gpt-6-sol', temperature: 0.7 }, ['gpt-6-sol']).status, 400);
  assert.equal(respond({ model: 'gpt-6-sol', temperature: 0.7, reasoning: { effort: 'none' } }, ['gpt-6-sol']).status, 200);
});

test('the fake provider rejects a model it was not told about', () => {
  assert.equal(respond({ model: 'gpt-nope' }, ['gpt-6-sol']).status, 404);
});

// ---- the dry run, end to end, with the harness on this machine against a stand-in class

/** A stand-in for server/utils/AiProviders/openAi: our own code, so upstream code still never runs on the host. */
function stubRepo(sendsTemperature: boolean): string {
  const repo = tempDir('stub');
  const dir = join(repo, 'server/utils/AiProviders/openAi');
  mkdirSync(dir, { recursive: true });
  const temperature = sendsTemperature ? 'temperature,' : '';
  writeFileSync(join(dir, 'index.js'), `
class OpenAiLLM {
  constructor(_embedder, model) {
    this.model = model;
    this.defaultTemp = 0.7;
    const url = process.env.OPENAI_BASE_URL + '/responses';
    const create = async (body) => {
      const reply = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPEN_AI_KEY }, body: JSON.stringify(body) });
      const json = await reply.json();
      if (!reply.ok) throw new Error(json.error.message);
      return { ...json, output_text: json.output[0].content[0].text };
    };
    this.openai = { responses: { create } };
  }
  constructPrompt({ systemPrompt, userPrompt }) {
    return [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }];
  }
  async getChatCompletion(messages, { temperature }) {
    const output = await this.openai.responses.create({ model: this.model, input: messages, store: false, ${temperature} });
    return { textResponse: output.output_text, metrics: { duration: 0.01 } };
  }
}
module.exports = { OpenAiLLM };
`);
  return repo;
}

function hostSandbox(root: string, repo: string, calls: SandboxRequest[] = []): Deps['sandbox'] {
  return (req) => {
    calls.push(req);
    const out = req.out.replace('/lab-work', join(root, 'lab/.work'));
    const args = [HARNESS, '--repo', repo, '--out', out, '--models', req.models.join(','), ...(req.fake ? ['--fake'] : [])];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...req.env } });
    return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
  };
}

function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return files;
}

test('--dry-run goes end to end, writes only under lab/.work/06-models/dry-run/, and never touches result.md or out/', async () => {
  const root = labRoot();
  writeFileSync(resultPath(root), renderResult({ lab: '06-models', status: 'not_run', needs: KEY_NAME, body: NOT_RUN_SENTENCE }));
  mkdirSync(join(root, 'lab/06-models/out'));
  writeFileSync(join(root, 'lab/06-models/out/earlier.json'), '{"earlier":true}');
  writeFileSync(join(root, '.env'), `${KEY_NAME}=${FAKE_KEY}\n`);
  const before = snapshot(root);
  const calls: SandboxRequest[] = [];
  const code = await main(['--dry-run'], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox: hostSandbox(root, stubRepo(false), calls) }));
  assert.equal(code, 0);
  const after = snapshot(root);
  for (const [path, content] of before) assert.equal(after.get(path), content, `${path} changed`);
  const created = [...after.keys()].filter((p) => !before.has(p));
  assert.ok(created.length > 0);
  for (const path of created) assert.ok(path.startsWith(join('lab', '.work', '06-models', 'dry-run')), `${path} is outside the dry-run folder`);
  assert.equal(calls[0].fake, true);
  assert.equal(calls[0].env.SANDBOX_ENV, '', 'no key goes into the sandbox');
  assert.ok(!JSON.stringify(calls[0]).includes(FAKE_KEY));
  const raw = parseRaw(after.get(join('lab', '.work', '06-models', 'dry-run', 'raw.json')) as string, RELEASES.map((r) => r.model));
  assert.equal(raw.fake, true);
  assert.deepEqual(raw.runs.map((r) => [r.model, r.answered, r.echoedModel, r.temperatureSent]), RELEASES.map((r) => [r.model, true, r.model, false]));
  const preview = after.get(join('lab', '.work', '06-models', 'dry-run', 'result.preview.md')) as string;
  assert.ok(preview.includes('Dry run against a fake provider'));
  assert.ok(preview.includes('| gpt-6-luna | yes | gpt-6-luna |'));
});

test('--dry-run fails when the provider code still sends temperature, which is the bug the patch fixes', async () => {
  const root = labRoot();
  const code = await main(['--dry-run'], deps(root, { sandbox: hostSandbox(root, stubRepo(true)) }));
  assert.equal(code, 1);
  const raw = parseRaw(readFileSync(join(root, 'lab/.work/06-models/dry-run/raw.json'), 'utf8'), RELEASES.map((r) => r.model));
  assert.ok(raw.runs.every((r) => !r.answered && r.temperatureSent && r.error?.includes('temperature')));
  assert.ok(!existsSync(resultPath(root)));
});

test('latency counts the request only, not the time spent building the provider', () => {
  const repo = stubRepo(false);
  const file = join(repo, PROVIDER_FILE);
  const slowStart = 'this.model = model;\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);';
  writeFileSync(file, readFileSync(file, 'utf8').replace('this.model = model;', slowStart));
  const out = join(tempDir('out'), 'raw.json');
  const run = spawnSync(process.execPath, [HARNESS, '--repo', repo, '--out', out, '--models', 'gpt-6-sol', '--fake'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  const [row] = JSON.parse(readFileSync(out, 'utf8')).runs;
  assert.equal(row.answered, true, row.error);
  assert.ok(row.latencyMs < 1000, `latency was ${row.latencyMs} ms`);
});

test('an answer with no usage, or half of one, is saved as null rather than 0 tokens, and the check refuses it', () => {
  for (const usage of ['undefined', '{ input_tokens: 5 }', '{ output_tokens: 5 }']) {
    const repo = stubRepo(false);
    const file = join(repo, PROVIDER_FILE);
    writeFileSync(file, readFileSync(file, 'utf8').replace('return { ...json, output_text', `return { ...json, usage: ${usage}, output_text`));
    const out = join(tempDir('out'), 'raw.json');
    const run = spawnSync(process.execPath, [HARNESS, '--repo', repo, '--out', out, '--models', 'gpt-6-sol', '--fake'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(run.status, 0, run.stderr);
    const text = readFileSync(out, 'utf8');
    const [row] = JSON.parse(text).runs;
    assert.equal(row.answered, true, row.error);
    assert.equal(row.usage, null, usage);
    assert.throws(() => parseRaw(text, ['gpt-6-sol']), /gpt-6-sol has a bad usage/, usage);
  }
});

test('the harness keeps the tokens the API really reported', () => {
  const out = join(tempDir('out'), 'raw.json');
  const run = spawnSync(process.execPath, [HARNESS, '--repo', stubRepo(false), '--out', out, '--models', 'gpt-6-sol', '--fake'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  const [row] = JSON.parse(readFileSync(out, 'utf8')).runs;
  assert.equal(row.usage.output, 1, 'fake-openai.cjs reports one output token');
  assert.ok(row.usage.input > 0);
});

test('a real run whose answer has no usage reaches neither result.md nor out/', async () => {
  const root = labRoot();
  const sandbox = sandboxWriting(root, fakeRun({ model: 'gpt-6-luna', usage: null }));
  await assert.rejects(main([], deps(root, { env: { [KEY_NAME]: FAKE_KEY }, sandbox })), /gpt-6-luna has a bad usage/);
  assert.ok(!existsSync(resultPath(root)));
  assert.ok(!existsSync(join(root, 'lab/06-models/out')));
});

test('the harness refuses a real run with no key rather than reaching for anything else', () => {
  const run = spawnSync(process.execPath, [HARNESS, '--repo', stubRepo(false), '--out', join(tempDir('out'), 'raw.json'), '--models', 'gpt-6-sol'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, new RegExp(KEY_NAME));
});

// ---- the dry-run tree

test('prepareArchiveTree applies patches outside any repo, without writing to the clone', () => {
  const clone = tempDir('clone');
  const run = (...args: string[]) => execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  run('init', '-q');
  mkdirSync(join(clone, 'a/b'), { recursive: true });
  writeFileSync(join(clone, 'a/b/file.txt'), 'one\n');
  writeFileSync(join(clone, 'other.txt'), 'other\n');
  run('add', '.');
  run('commit', '-qm', 'base');
  const base = run('rev-parse', 'HEAD').trim();
  writeFileSync(join(clone, 'a/b/file.txt'), 'one\ntwo\n');
  run('commit', '-qam', 'change');
  const patchDir = tempDir('patch');
  const patch = run('format-patch', `${base}..HEAD`, '-o', patchDir).trim();
  run('reset', '-q', '--hard', base);
  const before = run('rev-parse', 'HEAD');
  const dest = join(LAB_DIR, '..', '.work', '06-models', 'tree-test', String(process.pid));
  prepareArchiveTree(clone, dest, base, [patch], ['a']);
  assert.equal(readFileSync(join(dest, 'a/b/file.txt'), 'utf8'), 'one\ntwo\n', 'the patch really landed, inside the outer repo too');
  assert.ok(!existsSync(join(dest, 'other.txt')), 'only the named paths');
  assert.equal(run('rev-parse', 'HEAD'), before);
  assert.equal(run('status', '--short'), '');
  assert.throws(() => prepareArchiveTree(clone, `${dest}-bad`, base, [join(patchDir, 'missing.patch')], ['a']));
  rmSync(join(LAB_DIR, '..', '.work', '06-models', 'tree-test'), { recursive: true, force: true });
});
