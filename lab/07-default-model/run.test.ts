import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { REPO_ROOT } from '../shared/env.ts';
import { parseResult, readResult, renderResult, type LabResult } from '../shared/result.ts';
import { buildResult, KEY_NAME, NEW_MODEL, NOT_RUN_SENTENCE, OLD_MODEL, parseRaw, PROVIDER_FILE, refusedForTheModel, scrubSecrets, SHUTDOWN_DATE, TEAM_COMMIT, teamLine, type Attempt, type GitRead, type RawRun } from './report.ts';
import { main, type Deps, type SandboxRequest } from './run.ts';
import { branchTip, testFilesIn } from './repo-tests.ts';

const LAB_DIR = import.meta.dirname;
const CLONE = join(REPO_ROOT, 'tmp', 'anything-llm');
const NO_CLONE = existsSync(join(CLONE, '.git')) ? false : 'tmp/anything-llm is not here';
const HARNESS = join(LAB_DIR, 'harness.cjs');
const DEPRECATIONS = join(REPO_ROOT, 'tmp/vendor-docs/deprecations.md');
const PRICING = join(REPO_ROOT, 'tmp/vendor-docs/openai-pricing.md');
const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const pr = JSON.parse(readFileSync(join(LAB_DIR, 'pr.json'), 'utf8'));
const patchPath = join(LAB_DIR, pr.stages[0].patches[0]);
const patchText = () => readFileSync(patchPath, 'utf8');
const HAS_BRANCH = () => (NO_CLONE ? null : branchTip(CLONE, pr.branch));
const git = (...args: string[]) => execFileSync('git', ['-C', CLONE, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const tempDirs: string[] = [];
function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `keepup-07-${name}-`));
  tempDirs.push(dir);
  return dir;
}
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// ---- pr.json against docs/contracts.md and the spec

test('pr.json is the spec\'s pull request', () => {
  assert.equal(pr.id, '07');
  assert.ok(existsSync(join(REPO_ROOT, pr.spec)), 'the spec file exists');
  assert.equal(pr.upstream, 'Mintplex-Labs/anything-llm');
  assert.equal(pr.baseBranch, `replay/${pr.baseCommit.slice(0, 8)}-default-model`, 'its own base, because PR 02 has replay/bbefbc7f (D44)');
  assert.equal(pr.ciWorkflow, null);
  assert.equal(pr.branch, 'keepup/2026-09-01-default-model-shutdown');
  assert.equal(pr.lab, 'lab/07-default-model');
  assert.deepEqual(pr.effect, ['keeps working']);
  assert.equal(pr.effort, 'Hours');
  assert.deepEqual(pr.stages.map((s: { date: string }) => s.date), ['2026-09-01']);
  assert.equal(pr.stages[0].title, 'Your default OpenAI model shuts down on 23 Oct · move to gpt-5.6-luna');
  assert.ok(readFileSync(join(REPO_ROOT, pr.spec), 'utf8').includes(`"${pr.stages[0].title}"`), 'word for word the one in the spec');
  assert.equal(pr.stages[0].comment, null);
});

test('the App accepts pr.json, when the App is here', { skip: existsSync(join(REPO_ROOT, 'app/src/specs.ts')) ? false : 'app/src/specs.ts is not here' }, async () => {
  const { loadSpec } = await import('../../app/src/specs.ts');
  assert.equal(loadSpec(join(LAB_DIR, 'pr.json'), REPO_ROOT).id, '07');
});

test('the base commit is what the spec says, and the last upstream commit before 1 Sep in UTC', { skip: NO_CLONE }, () => {
  assert.equal(git('rev-parse', 'bbefbc7f').trim(), pr.baseCommit);
  assert.equal(new Date(git('log', '-1', '--format=%cI', pr.baseCommit).trim()).toISOString().slice(0, 10), '2026-08-31');
  assert.equal(git('log', '--first-parent', '--format=%H', '--since=2026-08-31T22:25:51Z', '--until=2026-08-31T23:59:59Z', 'master').trim(), '');
});

test('every "where" line names gpt-4.1-nano at the base commit', { skip: NO_CLONE }, () => {
  for (const { path, line } of pr.where) {
    assert.ok(git('show', `${pr.baseCommit}:${path}`).split('\n')[line - 1].includes(OLD_MODEL), `${path}:${line}`);
  }
});

test('the patch moves every default the base names, and nothing that only mentions the model', { skip: NO_CLONE }, () => {
  const found = git('grep', '-n', OLD_MODEL, pr.baseCommit, '--').split('\n').filter(Boolean).map((l) => l.split(':').slice(1, 3).join(':'));
  const left = [
    'docker/.env.example:15', 'docker/.env.example:83', 'docker/.env.example:89',
    'frontend/src/pages/WorkspaceSettings/ChatSettings/WorkspaceLLMSelection/index.jsx:226',
    'server/.env.example:12', 'server/.env.example:89', 'server/.env.example:95',
    'server/utils/AiProviders/modelMap/legacy.js:100', 'server/utils/AiProviders/modelMap/legacy.js:101',
  ];
  const moved = found.filter((l) => !left.includes(l));
  assert.deepEqual(moved.sort(), [...pr.where.map((w: { path: string; line: number }) => `${w.path}:${w.line}`), 'server/utils/agents/aibitat/providers/openai.js:9'].sort());
  const removed = patchText().split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---') && l.includes(OLD_MODEL));
  assert.equal(removed.length, moved.length);
  const codeDiffs = patchText().split(/^diff --git /m).slice(1).filter((d) => !d.startsWith('a/server/__tests__'));
  assert.equal(codeDiffs.flatMap((d) => d.split('\n')).filter((l) => l.startsWith('+') && l.includes(OLD_MODEL)).length, 0, 'only the test file still names it');
});

test('the shutdown, its notice date and the substitute are on OpenAI\'s deprecations page', { skip: existsSync(DEPRECATIONS) ? false : 'tmp/vendor-docs is not here' }, () => {
  const page = readFileSync(DEPRECATIONS, 'utf8');
  const row = page.split('\n').find((l) => l.includes(`\`${OLD_MODEL}\``) && l.startsWith('|'));
  assert.ok(row?.startsWith('| October 23, 2026 |'), row);
  assert.ok(row?.includes(`\`${NEW_MODEL}\``), row);
  const notice = page.slice(page.lastIndexOf('### 2026-04-22', page.indexOf(row as string)), page.indexOf(row as string));
  assert.match(notice, /On April 22, 2026, we announced/);
  assert.equal(SHUTDOWN_DATE, '2026-10-23');
  assert.ok(pr.sources.includes(pr.sourceUrl));
  assert.equal(pr.proof.vendor.url, pr.sourceUrl);
  assert.match(pr.proof.vendor.claim, /22 Apr 2026.*23 Oct 2026.*gpt-5\.6-luna/);
});

test('the 22 Apr notice isn\'t what names the substitute, so the text keeps the two facts apart', () => {
  // The row's substitute in Wayback captures of the page: gpt-5-nano on 26 Apr, gpt-5.4-nano on 29 May and 3 Jul, gpt-5.6-luna on 10 Aug and 2 Sep.
  const installDay = 'https://web.archive.org/web/20260902020743/https://developers.openai.com/api/docs/deprecations';
  assert.ok(pr.sources.includes(installDay), 'the page as it stood on install day');
  const spec = readFileSync(join(REPO_ROOT, pr.spec), 'utf8');
  assert.ok(spec.includes(installDay), 'the spec cites it too');
  for (const earlier of ['gpt-5-nano', 'gpt-5.4-nano']) assert.ok(spec.includes(earlier), `the spec says the page first named ${earlier}`);
  for (const text of [pr.proof.vendor.claim, pr.stages[0].whatShipped]) {
    assert.match(text, /announced on 22 Apr 2026.*its deprecations page now names gpt-5\.6-luna/);
  }
  for (const text of [pr.proof.vendor.claim, pr.stages[0].whatShipped, spec]) {
    assert.doesNotMatch(text, /(?:notice|23 Oct 2026),? and names gpt-5\.6-luna/);
  }
});

test('gpt-5.6-luna was released on 9 Jul 2026, so it existed on 1 Sep', () => {
  const log = gunzipSync(readFileSync(join(REPO_ROOT, 'data/db/changelog-openai.txt.gz'))).toString('utf8').split('\n');
  const at = log.findIndex((l) => l.includes('Released the GPT-5.6 model family'));
  assert.ok(at > 0);
  const above = log.slice(0, at).reverse();
  assert.equal(above.find((l) => /^\s*[A-Z][a-z]{2} \d+\s*$/.test(l))?.trim(), 'Jul 9');
  assert.equal(above.find((l) => /^\s*[A-Z][a-z]+, \d{4}\s*$/.test(l))?.trim(), 'July, 2026');
  assert.ok(above.slice(0, 8).some((l) => l.includes(NEW_MODEL)), 'the entry lists the model');
});

test('the prices in the risks are the ones on the pricing page, in its standard table', { skip: existsSync(PRICING) ? false : 'tmp/vendor-docs is not here' }, () => {
  const page = readFileSync(PRICING, 'utf8');
  const standard = page.slice(page.indexOf('### Standard pricing data'));
  assert.match(standard, /\| gpt-5\.6-luna \| \$0\.20 \| \$1\.20 \|/);
  assert.match(standard, /\| gpt-4\.1-nano \| \$0\.10 \| \$0\.40 \|/);
  for (const price of ['$0.20', '$1.20', '$0.10', '$0.40']) assert.ok(pr.risks.includes(price), price);
});

test('the numbers and rules in the risks are the ones in the code at the base commit', { skip: NO_CLONE }, () => {
  const provider = git('show', `${pr.baseCommit}:${PROVIDER_FILE}`);
  assert.ok(pr.risks.includes('4,096 tokens'));
  assert.ok(provider.includes('MODEL_MAP.get("openai", modelName) ?? 4_096'));
  assert.ok(provider.includes('const NO_TEMP_MODELS = ["o", "gpt-5"];'));
  assert.ok(pr.risks.includes('temperature of 1'));
  const screen = git('show', `${pr.baseCommit}:frontend/src/components/LLMSelection/OpenAiOptions/index.jsx`);
  assert.ok(screen.includes('selected={settings?.OpenAiModelPref === model.id}'), 'the settings screen preselects the default');
  assert.ok(pr.risks.includes('stays on it and still stops working'), 'and says the people it does not help');
});

test('the rollback says the old model stops answering, and pr.json makes no claim about what the team knew', () => {
  assert.match(pr.rollback, /OPEN_MODEL_PREF/);
  assert.match(pr.rollback, /no longer answers/);
  assert.ok(!/unaware|didn't know|did not know|missed|noticed|forgot/i.test(JSON.stringify(pr)), 'no claim about the team');
  assert.ok(pr.sources.some((url: string) => url.endsWith(`/commit/${TEAM_COMMIT}`)), 'names the commit');
  assert.ok(!pr.whyItFits.includes(TEAM_COMMIT) && !pr.whyItFits.includes('27 Oct'), 'whyItFits describes the base commit');
});

// ---- the patch

test('the patch is one commit dated 1 Sep, written from the notice, with the new default in its tests', () => {
  assert.deepEqual(readdirSync(join(LAB_DIR, 'patches')), [pr.stages[0].patches[0].replace('patches/', '')]);
  assert.match(patchText(), /^Date: Tue, 1 Sep 2026 12:00:00 \+0000$/m);
  assert.match(patchText(), /^From: "keepup\[bot\]" <keepup\[bot\]@users\.noreply\.github\.com>$/m);
  assert.ok(patchText().includes(pr.sourceUrl), 'the message names the source');
  assert.deepEqual(testFilesIn(patchText()), ['server/__tests__/utils/AiProviders/openAi/defaultModel.test.js']);
});

test('the patch applies at the base commit, and the default is the new model everywhere', { skip: NO_CLONE }, async () => {
  const { prepareArchiveTree } = await import('../06-models/tree.ts');
  const dest = join(tempDir('tree'), 'tree');
  prepareArchiveTree(CLONE, dest, pr.baseCommit, [patchPath], ['server/models/systemSettings.js', 'server/utils/agents', PROVIDER_FILE, 'server/__tests__/utils/AiProviders']);
  for (const { path } of pr.where) {
    const text = readFileSync(join(dest, path), 'utf8');
    assert.ok(text.includes(NEW_MODEL) && !text.includes(OLD_MODEL), path);
  }
  assert.match(readFileSync(join(dest, PROVIDER_FILE), 'utf8'), /modelPreference \|\| process\.env\.OPEN_MODEL_PREF \|\| "gpt-5\.6-luna"/);
});

// ---- the team line

const providerWith = (model: string) => `modelPreference || process.env.OPEN_MODEL_PREF || "${model}";`;

function stubGit({ before = OLD_MODEL, after = NEW_MODEL, tags = '', date = '2026-10-27T11:28:41-07:00' } = {}): GitRead {
  return (args) => {
    if (args[0] === 'tag') return tags;
    if (args[0] === 'log') return `${args.at(-1) === TEAM_COMMIT ? date : '2026-10-30T13:49:57-07:00'}\n`;
    return providerWith(args[1].includes('^') ? before : after);
  };
}

test('teamLine reads the days from git, and says nothing about what the team knew', () => {
  const line = teamLine(stubGit());
  assert.ok(line.includes('5edf32b9 (27 Oct 2026)'), line);
  assert.ok(line.includes('from gpt-4.1-nano to gpt-5.6-luna'), line);
  assert.ok(line.includes('4 days after the model stopped working on 23 Oct 2026'), line);
  assert.ok(line.includes('No tagged release carries it, as of 9caf2b4 (30 Oct 2026).'), line);
});

test('teamLine dates the commit in UTC, and drops the tag sentence once a tag holds it', () => {
  assert.ok(teamLine(stubGit({ date: '2026-10-27T23:30:00-07:00' })).includes('5 days after'));
  assert.ok(!teamLine(stubGit({ tags: 'v1.20.0\n' })).includes('tagged'));
});

test('teamLine fails loud when git does not back it', () => {
  assert.throws(() => teamLine(stubGit({ before: 'gpt-4o' })), /5edf32b9/);
  assert.throws(() => teamLine(stubGit({ after: OLD_MODEL })), /5edf32b9/);
});

test('teamLine holds against the real clone', { skip: NO_CLONE }, () => {
  const line = teamLine((args) => git(...args));
  assert.ok(line.includes('(27 Oct 2026) moved this default from gpt-4.1-nano to gpt-5.6-luna, 4 days after the model stopped working on 23 Oct 2026.'), line);
});

// ---- result.md, with no key

function labRoot(): string {
  const root = tempDir('root');
  mkdirSync(join(root, 'lab/07-default-model/patches'), { recursive: true });
  mkdirSync(join(root, 'lab/.work'), { recursive: true });
  cpSync(join(LAB_DIR, 'pr.json'), join(root, 'lab/07-default-model/pr.json'));
  cpSync(join(LAB_DIR, 'patches'), join(root, 'lab/07-default-model/patches'), { recursive: true });
  return root;
}

const resultPath = (root: string) => join(root, 'lab/07-default-model/result.md');
const outDir = (root: string) => join(root, 'lab/07-default-model/out');
const measuredBefore: LabResult = { lab: '07-default-model', status: 'measured', measured_at: '2026-11-01', body: '| a |\n| - |' };

const OLD_ROW: Attempt = { role: 'old-default', askedFor: OLD_MODEL, sentModel: OLD_MODEL, answered: false, echoedModel: null, latencyMs: null, text: null, usage: null, error: 'The model does not exist', errorStatus: 404, errorCode: 'model_not_found', response: null };
const NEW_ROW: Attempt = { role: 'new-default', askedFor: null, sentModel: NEW_MODEL, answered: true, echoedModel: NEW_MODEL, latencyMs: 1200, text: 'ready', usage: { input: 20, output: 10 }, error: null, errorStatus: null, errorCode: null, response: null };

function fakeRun({ old = {}, next = {}, fake = false }: { old?: Partial<Attempt>; next?: Partial<Attempt>; fake?: boolean } = {}): RawRun {
  return { fake, startedAt: '2026-11-01T10:00:00Z', finishedAt: '2026-11-01T10:00:09Z', systemPrompt: 'system', userPrompt: 'user', runs: [{ ...OLD_ROW, ...old }, { ...NEW_ROW, ...next }] };
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
    today: () => '2026-11-01',
    log: () => undefined,
    ...overrides,
  };
}

function sandboxWriting(root: string, raw: RawRun | string, calls: SandboxRequest[] = [], output = 'ok', status = 0): Deps['sandbox'] {
  return (req) => {
    calls.push(req);
    const file = req.out.replace('/lab-work', join(root, 'lab/.work'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
    return { status, output };
  };
}

const withKey = { env: { [KEY_NAME]: FAKE_KEY } };

test('with no key it writes an honest not_run result and exits 3, without touching the sandbox', async () => {
  const root = labRoot();
  assert.equal(await main([], deps(root)), 3);
  const result = readResult(resultPath(root));
  assert.equal(result?.status, 'not_run');
  assert.equal(result?.needs, KEY_NAME);
  assert.equal(result?.body, NOT_RUN_SENTENCE);
  assert.equal(result?.measured_at, undefined);
  assert.ok(!/\d/.test(NOT_RUN_SENTENCE), 'a lab that did not run has no numbers at all');
  assert.equal((NOT_RUN_SENTENCE.match(/\./g) ?? []).length, 1, 'one sentence');
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
  assert.equal(await main(['--no-keys'], deps(root, withKey)), 3);
  assert.equal(readResult(resultPath(root))?.status, 'not_run');
});

test('an unknown flag is a usage error, code 2, and never a real run', async () => {
  const logged: string[] = [];
  assert.equal(await main(['--dryrun'], deps(labRoot(), { ...withKey, log: (line) => logged.push(line) })), 2);
  assert.match(logged.join('\n'), /--dryrun/);
});

// ---- with a key, against a stand-in sandbox

test('with a key it runs in the sandbox, passes the key by name only, and records the old model\'s real error and the new default\'s real answer', async () => {
  const root = labRoot();
  const calls: SandboxRequest[] = [];
  const prepared: string[] = [];
  const removed: string[] = [];
  const code = await main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, fakeRun(), calls), prepareLabTree: (_pr, dest) => prepared.push(dest), removeLabTree: (dest) => removed.push(dest) }));
  assert.equal(code, 0);
  assert.deepEqual(prepared, [join(root, 'tmp/lab-wt-07')]);
  assert.deepEqual(removed, prepared);
  assert.equal(calls[0].env.SANDBOX_ENV, KEY_NAME);
  assert.equal(calls[0].fake, false);
  assert.ok(!JSON.stringify({ ...calls[0], env: null }).includes(FAKE_KEY), 'the key is never on a command line');
  assert.ok(existsSync(join(outDir(root), 'responses.json')));
  const result = parseResult(readFileSync(resultPath(root), 'utf8'));
  assert.equal(result.status, 'measured');
  assert.equal(result.title_number, undefined, 'the title takes no number');
  assert.ok(result.body.includes('| The old default, set by name | gpt-4.1-nano | no | 404 model_not_found: The model does not exist | - | - |'), result.body);
  assert.ok(result.body.includes(`| No model set: this fork's default | gpt-5.6-luna | yes | gpt-5.6-luna: "ready" | 1200 ms | 20 / 10 |`), result.body);
  assert.ok(result.body.includes('The team line.'));
});

const partialCases: [string, Parameters<typeof fakeRun>[0], RegExp][] = [
  ['the old model still answers', { old: { answered: true, echoedModel: OLD_MODEL, latencyMs: 900, text: 'ready', usage: { input: 1, output: 1 }, error: null, errorStatus: null, errorCode: null } }, /gpt-4\.1-nano still answered/],
  ['a bad key, which says nothing about the model', { old: { error: 'Incorrect API key provided', errorStatus: 401, errorCode: 'invalid_api_key' } }, /a refusal of gpt-4\.1-nano about the model itself/],
  ['a rate limit', { old: { error: 'Rate limit reached', errorStatus: 429, errorCode: 'rate_limit_exceeded' } }, /about the model itself/],
  ['no answer from the new default', { next: { answered: false, echoedModel: null, latencyMs: null, text: null, usage: null, error: 'overloaded', errorStatus: 503 } }, /a real answer from gpt-5\.6-luna/],
];

for (const [name, run, needs] of partialCases) {
  test(`${name} makes the result partial, says what is needed, and exits 1`, async () => {
    const root = labRoot();
    assert.equal(await main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, fakeRun(run)) })), 1);
    const result = readResult(resultPath(root));
    assert.equal(result?.status, 'partial');
    assert.match(result?.needs ?? '', needs);
  });
}

test('only a refusal about the model counts as the shutdown', () => {
  assert.equal(refusedForTheModel(OLD_ROW), true);
  assert.equal(refusedForTheModel({ ...OLD_ROW, errorStatus: 400, errorCode: null, error: 'This model has been deprecated.' }), true);
  assert.equal(refusedForTheModel({ ...OLD_ROW, errorStatus: 500, errorCode: null, error: 'Server error' }), false);
  assert.equal(refusedForTheModel({ ...OLD_ROW, answered: true }), false);
});

test('a later run that comes back weaker leaves out/ and result.md alone, keeps its raw output under lab/.work/, and exits 1', async () => {
  const root = labRoot();
  assert.equal(await main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, fakeRun(), [], 'first log') })), 0);
  const saved = { result: readFileSync(resultPath(root), 'utf8'), raw: readFileSync(join(outDir(root), 'responses.json'), 'utf8') };
  const logged: string[] = [];
  const weaker = fakeRun({ next: { answered: false, echoedModel: null, latencyMs: null, text: null, usage: null, error: `boom ${FAKE_KEY}` } });
  assert.equal(await main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, weaker, [], `second log ${FAKE_KEY}`), log: (line) => logged.push(line) })), 1);
  assert.equal(readFileSync(resultPath(root), 'utf8'), saved.result);
  assert.equal(readFileSync(join(outDir(root), 'responses.json'), 'utf8'), saved.raw);
  assert.match(logged.join('\n'), /weaker/);
  for (const name of ['raw.json', 'sandbox.log']) assert.ok(!readFileSync(join(root, 'lab/.work/07-default-model/run', name), 'utf8').includes(FAKE_KEY), name);
});

test('a real run whose output calls itself fake reaches neither out/ nor result.md', async () => {
  const root = labRoot();
  await assert.rejects(main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, fakeRun({ fake: true })) })), /fake/);
  assert.ok(!existsSync(resultPath(root)));
  assert.ok(!existsSync(outDir(root)));
});

test('a harness that crashes writes no result and no outputs, and the tree is still removed', async () => {
  const root = labRoot();
  writeFileSync(resultPath(root), renderResult(measuredBefore));
  const before = readFileSync(resultPath(root), 'utf8');
  const removed: string[] = [];
  assert.equal(await main([], deps(root, { ...withKey, sandbox: () => ({ status: 1, output: `boom ${FAKE_KEY}` }), removeLabTree: (d) => removed.push(d) })), 1);
  assert.equal(readFileSync(resultPath(root), 'utf8'), before);
  assert.ok(!existsSync(outDir(root)));
  assert.equal(removed.length, 1);
  assert.ok(!readFileSync(join(root, 'lab/.work/07-default-model/run/sandbox.log'), 'utf8').includes(FAKE_KEY));
});

test('output that fails its check reaches neither result.md nor out/', async () => {
  for (const [bad, message] of [
    ['{ not json', /raw\.json/],
    [JSON.stringify(fakeRun({ next: { askedFor: NEW_MODEL } })), /does not test the default/],
    [JSON.stringify(fakeRun({ next: { sentModel: OLD_MODEL } })), /sent gpt-4\.1-nano/],
    [JSON.stringify(fakeRun({ next: { usage: null } })), /bad usage/],
    [JSON.stringify({ ...fakeRun(), runs: [OLD_ROW] }), /one old-default row/],
  ] as [string, RegExp][]) {
    const root = labRoot();
    await assert.rejects(main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, bad) })), message);
    assert.ok(!existsSync(resultPath(root)));
    assert.ok(!existsSync(outDir(root)));
  }
});

test('if git cannot back the team line, it stops before any request is sent', async () => {
  const root = labRoot();
  const calls: SandboxRequest[] = [];
  const fails = () => {
    throw new Error('no clone');
  };
  await assert.rejects(main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, fakeRun(), calls), teamLine: fails })), /no clone/);
  assert.equal(calls.length, 0);
});

test('a fake run can never become a result', () => {
  assert.throws(() => buildResult({ raw: fakeRun({ fake: true }), teamLine: 'Team.', measuredAt: '2026-11-01' }), /fake/);
});

// ---- no keys in anything written

test('the writer scrubs the exact key and anything key-shaped', () => {
  const clean = scrubSecrets(`exact ${FAKE_KEY} masked sk-proj-abc****wxyz plain words sk-short`, [FAKE_KEY, '']);
  assert.ok(!clean.includes(FAKE_KEY));
  assert.ok(!clean.includes('sk-proj-abc'));
  assert.ok(clean.includes('plain words'));
});

test('raw outputs saved to out/ contain no key, even when the run leaked one', async () => {
  const root = labRoot();
  await main([], deps(root, { ...withKey, sandbox: sandboxWriting(root, fakeRun({ old: { error: `does not exist ${FAKE_KEY}` } }), [], `log ${FAKE_KEY}`) }));
  for (const file of readdirSync(outDir(root))) assert.ok(!readFileSync(join(outDir(root), file), 'utf8').includes(FAKE_KEY), file);
});

// ---- the fake provider

const require = createRequire(import.meta.url);
const { respond } = require('./fake-openai.cjs') as { respond: (body: Record<string, unknown>, answering: string) => { status: number; json: Record<string, any> } };

test('the fake provider answers only the new default, and refuses the old model in its own words', () => {
  const ok = respond({ model: NEW_MODEL, input: 'hi' }, NEW_MODEL);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.model, NEW_MODEL);
  const gone = respond({ model: OLD_MODEL }, NEW_MODEL);
  assert.equal(gone.status, 404);
  assert.match(gone.json.error.message, /^Fake provider/);
});

// ---- the dry run, end to end, with the harness on this machine against a stand-in class

/** A stand-in for server/utils/AiProviders/openAi: our own code, so upstream code still never runs on the host. */
function stubRepo(defaultModel: string): string {
  const repo = tempDir('stub');
  const dir = join(repo, 'server/utils/AiProviders/openAi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), `
class OpenAiLLM {
  constructor(_embedder, model) {
    this.model = model || process.env.OPEN_MODEL_PREF || ${JSON.stringify(defaultModel)};
    this.defaultTemp = 0.7;
    const url = process.env.OPENAI_BASE_URL + '/responses';
    const create = async (body) => {
      const reply = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await reply.json();
      if (!reply.ok) throw Object.assign(new Error(json.error.message), { status: reply.status, code: json.error.code });
      return { ...json, output_text: json.output[0].content[0].text };
    };
    this.openai = { responses: { create } };
  }
  constructPrompt({ systemPrompt, userPrompt }) {
    return [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }];
  }
  async getChatCompletion(messages) {
    const output = await this.openai.responses.create({ model: this.model, input: messages, store: false }).catch((e) => { throw new Error(e.message); });
    return { textResponse: output.output_text, metrics: { duration: 0.01 } };
  }
}
module.exports = { OpenAiLLM };
`);
  return repo;
}

function hostSandbox(root: string, repo: string, calls: SandboxRequest[] = [], extraEnv: Record<string, string> = {}): Deps['sandbox'] {
  return (req) => {
    calls.push(req);
    const out = req.out.replace('/lab-work', join(root, 'lab/.work'));
    const args = [HARNESS, '--repo', repo, '--out', out, '--old-model', OLD_MODEL, '--new-model', NEW_MODEL, ...(req.fake ? ['--fake'] : [])];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...req.env, ...extraEnv } });
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

test('--dry-run goes end to end, writes only under lab/.work/07-default-model/dry-run/, and never touches result.md or out/', async () => {
  const root = labRoot();
  writeFileSync(resultPath(root), renderResult({ lab: '07-default-model', status: 'not_run', needs: KEY_NAME, body: NOT_RUN_SENTENCE }));
  mkdirSync(outDir(root));
  writeFileSync(join(outDir(root), 'earlier.json'), '{"earlier":true}');
  writeFileSync(join(root, '.env'), `${KEY_NAME}=${FAKE_KEY}\n`);
  const before = snapshot(root);
  const calls: SandboxRequest[] = [];
  assert.equal(await main(['--dry-run'], deps(root, { ...withKey, sandbox: hostSandbox(root, stubRepo(NEW_MODEL), calls) })), 0);
  const seen = snapshot(root);
  for (const [path, content] of before) assert.equal(seen.get(path), content, `${path} changed`);
  const created = [...seen.keys()].filter((p) => !before.has(p));
  assert.ok(created.length > 0);
  for (const path of created) assert.ok(path.startsWith(join('lab', '.work', '07-default-model', 'dry-run')), `${path} is outside the dry-run folder`);
  assert.equal(calls[0].fake, true);
  assert.equal(calls[0].env.SANDBOX_ENV, '', 'no key goes into the sandbox');
  assert.ok(!JSON.stringify(calls[0]).includes(FAKE_KEY));
  const raw = parseRaw(seen.get(join('lab', '.work', '07-default-model', 'dry-run', 'raw.json')) as string);
  assert.equal(raw.fake, true);
  assert.deepEqual(raw.runs.map((r) => [r.role, r.askedFor, r.sentModel, r.answered]), [['old-default', OLD_MODEL, OLD_MODEL, false], ['new-default', null, NEW_MODEL, true]]);
  assert.equal(raw.runs[0].errorStatus, 404, 'the error the SDK raised is kept, though the provider only passes its message on');
  assert.equal(raw.runs[0].errorCode, 'model_not_found');
  const preview = seen.get(join('lab', '.work', '07-default-model', 'dry-run', 'result.preview.md')) as string;
  assert.ok(preview.includes('Dry run against a fake provider'));
  assert.ok(preview.includes('| gpt-5.6-luna | yes |'), preview);
});

test('--dry-run fails on a tree whose default is still the old model, which is the bug the patch fixes', async () => {
  const root = labRoot();
  assert.equal(await main(['--dry-run'], deps(root, { sandbox: hostSandbox(root, stubRepo(OLD_MODEL)) })), 1);
  const raw = parseRaw(readFileSync(join(root, 'lab/.work/07-default-model/dry-run/raw.json'), 'utf8'));
  assert.equal(raw.runs[1].sentModel, OLD_MODEL);
  assert.equal(raw.runs[1].answered, false);
  assert.ok(!existsSync(resultPath(root)));
});

test('the harness clears OPEN_MODEL_PREF, so a setting in its environment cannot stand in for the default', async () => {
  const root = labRoot();
  assert.equal(await main(['--dry-run'], deps(root, { sandbox: hostSandbox(root, stubRepo(NEW_MODEL), [], { OPEN_MODEL_PREF: 'someone-elses-model' }) })), 0);
  const raw = parseRaw(readFileSync(join(root, 'lab/.work/07-default-model/dry-run/raw.json'), 'utf8'));
  assert.equal(raw.runs[1].sentModel, NEW_MODEL);
});

test('the harness refuses a real run with no key rather than reaching for anything else', () => {
  const run = spawnSync(process.execPath, [HARNESS, '--repo', stubRepo(NEW_MODEL), '--out', join(tempDir('out'), 'raw.json'), '--old-model', OLD_MODEL, '--new-model', NEW_MODEL], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, new RegExp(KEY_NAME));
});

// ---- the repo's own tests, as docs/contracts.md asks for them

test('saved repo-test evidence adds up, is for this patch, and says the new tests fail at the base', { skip: existsSync(join(LAB_DIR, 'out/repo-tests.json')) ? false : 'no evidence saved' }, () => {
  const evidence = JSON.parse(readFileSync(join(LAB_DIR, 'out/repo-tests.json'), 'utf8'));
  assert.equal(evidence.tests.total, evidence.tests.passed + evidence.tests.failed);
  const tip = HAS_BRANCH();
  if (tip) assert.equal(evidence.commit, tip, 'the evidence is for the tip of this branch');
  assert.equal(evidence.tests_this_change_adds.length, 1);
  assert.equal(evidence.tests_this_change_adds[0].total, evidence.tests_this_change_adds[0].passed);
  assert.ok(evidence.failed_tests.every((f: { file: string }) => !f.file.includes('defaultModel')));
  const atBase = JSON.parse(readFileSync(join(LAB_DIR, 'out/new-tests-at-base.json'), 'utf8'));
  assert.ok(atBase.numFailedTests > 0, 'the new tests fail at the base commit');
  assert.ok(atBase.failed_names.some((name: string) => name.includes('uses the substitute')));
  assert.ok(atBase.passed_names.every((name: string) => /keeps|reports OPEN_MODEL_PREF/.test(name)), 'only the tests of an explicit setting pass there');
});
