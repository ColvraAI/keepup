// The real entry points, in real processes, with a temp root. Secrets planted where a
// failure would really put them are in secrets-e2e.test.ts; these check the plain paths.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { inspect } from 'node:util';
import { readObjects } from '../src/objects.ts';
import { createPrDeps, openOrUpdate } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import { redact, registerSecret, safeMessage } from '../src/secrets.ts';
import { createWorld, installDb, installSpec, installTimeline, ORG, NOT_RUN_RESULT, tempDir, type World } from './world.ts';

interface Run { code: number; stdout: string; stderr: string }

function cli(name: string, args: string[], root: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'app/src/cli', `${name}.ts`), ...args], {
      env: { PATH: process.env.PATH, HOME: tempDir('keepup-home-'), KEEPUP_ROOT: root, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const CANARY = {
  OPENAI_API_KEY: 'sk-canary-openai-0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-canary-0123456789',
  SENTRY_ACCESS_TOKEN: 'canary-sentry-token-0123',
  TYPESAFE_API_KEY: 'canary-typesafe-key-0123',
};

function assertNoSecrets(run: Run, extra: string[] = []): void {
  const all = run.stdout + run.stderr;
  for (const secret of [...Object.values(CANARY), ...extra]) assert.ok(!all.includes(secret), `leaked ${secret}\n${all}`);
  assert.ok(!all.includes('PRIVATE KEY'), all);
  assert.ok(!/ghs_[a-z0-9_]{6,}/i.test(all), all);
}

test('usage errors exit 2 and print the usage', async () => {
  const root = tempDir();
  const cases: [string, string[], RegExp][] = [
    ['pr', [], /Usage: npm run pr/],
    ['pr', ['06', '--nope'], /Unknown option: --nope/],
    ['pr', ['06', '--update'], /--update needs a value/],
    ['pr', ['06', '--update', '22 Sep'], /YYYY-MM-DD/],
    ['pr', ['06', '--update', '2026-09-22', '--all'], /different things/],
    ['brief', [], /Usage: npm run brief/],
    ['brief', ['anything-llm', '2026-10-27'], /not a Monday/],
    ['brief', ['aura', '2026-10-26', '--email'], /Unknown option: --email/],
    ['setup', [], /Usage: npm run setup/],
    ['status', ['extra'], /Usage: npm run status/],
    ['go', ['extra'], /Usage: npm run go/],
  ];
  for (const [name, args, pattern] of cases) {
    const run = await cli(name, args, root);
    assert.equal(run.code, 2, `${name} ${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, pattern);
  }
});

test('status with no .env prints the list and the next command, and exits 0', async () => {
  const run = await cli('status', [], tempDir());
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /✗ 1\. The demo site/);
  assert.match(run.stdout, /Next: npm run setup -- --org <name>/);
});

test('go --dry-run with no .env lists the plan and exits 0 without calling anything', async () => {
  const w = await createWorld();
  const run = await cli('go', ['--dry-run'], tempDir(), { KEEPUP_GITHUB_API_URL: w.fake.url });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /npm run brief -- aura 2026-10-26/);
  assert.equal(w.fake.requests.length, 0);
});

test('pr waiting on setup or on a lab exits 3', async () => {
  const root = tempDir();
  const w = await createWorld();
  installSpec(root, w.fix);
  const noSetup = await cli('pr', ['06'], root);
  assert.equal(noSetup.code, 3, noSetup.stderr);
  assert.match(noSetup.stderr, /npm run setup/);
  installSpec(w.root, w.fix, { result: NOT_RUN_RESULT });
  const notMeasured = await cli('pr', ['06'], w.root, w.env);
  assert.equal(notMeasured.code, 3, notMeasured.stderr);
  assert.match(notMeasured.stderr, /needs OPENAI_API_KEY/);
  assert.equal(w.fake.requests.length, 0);
});

test('an unknown id and a broken spec exit 1 with a clear message', async () => {
  const w = await createWorld();
  const run = await cli('pr', ['99'], w.root, w.env);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /No pull request spec for 99/);
});

test('setup with an org in KEEPUP_NOT_DEMO_ORGS is refused and exits 1, before gh is even asked', async () => {
  const run = await cli('setup', ['--org', 'Acme-Corp'], tempDir(), { KEEPUP_NOT_DEMO_ORGS: 'acme-corp' });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /KEEPUP_NOT_DEMO_ORGS/);
});

test('brief with missing keys writes the files, explains and exits 3', async () => {
  const root = tempDir();
  installTimeline(root, [{ repo: 'mezmo/aura', events: [] }]);
  installDb(root, 'npm', [{ released: '2026-10-27' }]);
  const run = await cli('brief', ['aura', '2026-10-26'], root);
  assert.equal(run.code, 3, run.stderr);
  assert.deepEqual(readdirSync(join(root, 'data/weekly')).sort(), ['aura-2026-10-26.html', 'aura-2026-10-26.md']);
  assert.match(run.stderr, /npm run setup/);
});

test('secrets never appear in stdout or stderr, on the happy path', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  const env = { ...w.env, ...CANARY };
  const run = await cli('pr', ['06', '--all'], w.root, env);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /PR 06: #1 https:\/\/github\.com\/keepup-demo\/anything-llm\/pull\/1/);
  assertNoSecrets(run, [...w.fake.installationTokens]);
  const objects = readFileSync(join(w.root, 'data/github-objects.json'), 'utf8');
  for (const secret of Object.values(CANARY)) assert.ok(!objects.includes(secret));
  assert.ok(!objects.includes('ghs_'));
});

test('secrets never appear when things go wrong', async () => {
  const w: World = await createWorld();
  installSpec(w.root, w.fix);
  const failures: [string, string[], Record<string, string>, number][] = [
    ['pr', ['06'], { ...w.env, ...CANARY, GITHUB_APP_ID: '999999' }, 1],
    ['pr', ['06'], { ...w.env, ...CANARY, KEEPUP_GIT_BASE_URL: 'http://127.0.0.1:9/' }, 1],
    ['pr', ['06'], { ...w.env, ...CANARY, KEEPUP_GITHUB_API_URL: 'http://127.0.0.1:9' }, 1],
    ['brief', ['anything-llm', '2026-10-26'], { ...w.env, ...CANARY }, 1],
    ['status', ['--live'], { ...w.env, ...CANARY, GITHUB_APP_ID: '999999' }, 0],
  ];
  for (const [name, args, env, code] of failures) {
    const run = await cli(name, args, w.root, env);
    assert.equal(run.code, code, `${name} ${args.join(' ')}: ${run.stdout}${run.stderr}`);
    assertNoSecrets(run, [...w.fake.installationTokens]);
  }
});

test('a real-looking token inside a server or git error is scrubbed', () => {
  registerSecret('value-only-known-at-runtime');
  assert.equal(redact('oops value-only-known-at-runtime!'), 'oops [redacted]!');
  assert.equal(redact('token ghs_abcdefghijklmnop was refused'), 'token [redacted] was refused');
  assert.equal(redact('Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hz'), '[redacted]');
  assert.equal(safeMessage(new Error('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')), '[redacted]');
});

test('an override URL may only point at this machine', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  const run = await cli('pr', ['06'], w.root, { ...w.env, KEEPUP_GITHUB_API_URL: 'https://evil.example.test' });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /may only point at this machine/);
});

test('the gh token is read in one place only', () => {
  const dir = join(REPO_ROOT, 'app/src');
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)), ...readdirSync(join(dir, 'cli')).map((f) => join(dir, 'cli', f))];
  const readers = files.filter((f) => /\['auth', 'token'\]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(readers.map((f) => f.slice(dir.length + 1)), ['setup.ts']);
  const personClients = files.filter((f) => /createPersonClient\(/.test(readFileSync(f, 'utf8')) && !f.endsWith('github.ts'));
  assert.deepEqual(personClients.map((f) => f.slice(dir.length + 1)), ['setup.ts']);
});

test('no source file holds a force push or a hardcoded key', () => {
  const dir = join(REPO_ROOT, 'app/src');
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)), ...readdirSync(join(dir, 'cli')).map((f) => join(dir, 'cli', f))];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n').filter((l) => /\['push'/.test(l))) {
      assert.ok(!/--force|'-f'|force-with-lease|`\+|'\+/.test(line), `${file} looks like a force push: ${line}`);
    }
    assert.ok(!/ghs_[A-Za-z0-9]{10}|sk-[A-Za-z0-9]{10}|re_[A-Za-z0-9]{10}/.test(text), `${file} holds a key`);
  }
});

test('thrown errors carry no token or key, even when inspected whole', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  const wrongApp = createPrDeps(w.root, { ...w.env, GITHUB_APP_ID: '999999' });
  const thrown = await openOrUpdate(findSpec('06', w.root), {}, wrongApp).catch((e: unknown) => e);
  assert.ok(thrown instanceof Error);
  const seen = `${inspect(thrown, { depth: 8 })}\n${thrown.stack}\n${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))}`;
  assert.ok(!seen.includes('PRIVATE KEY'), seen);
  assert.ok(!/ghs_[a-z0-9]/.test(seen), seen);
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(seen), 'no JWT');
  const badGit = createPrDeps(w.root, { ...w.env, KEEPUP_GIT_BASE_URL: 'http://127.0.0.1:9/' });
  const gitThrown = await openOrUpdate(findSpec('06', w.root), {}, badGit).catch((e: unknown) => e);
  const gitSeen = inspect(gitThrown, { depth: 8 });
  assert.ok(gitThrown instanceof Error);
  assert.ok(!/ghs_[a-z0-9]/.test(gitSeen), gitSeen);
  assert.ok(!gitSeen.includes('x-access-token'), gitSeen);
  for (const token of w.fake.installationTokens) assert.ok(!gitSeen.includes(Buffer.from(`x-access-token:${token}`).toString('base64')));
});

test('the whole morning, end to end: go opens the pull request, waits for CI, writes the brief, prints status', async () => {
  const w = await createWorld();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.checks = [{ name: 'tests', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/runs/1', details_url: 'https://github.com/x/runs/1' }];
  fork.runs = [{ id: 1, name: 'tests', path: '.github/workflows/run-tests.yaml', event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/runs/1', run_number: 1, created_at: '2026-11-01T09:00:00Z' }];
  w.fake.addRepo(ORG, 'aura', w.fix.bare, { fork: true, parent: 'mezmo/aura' });
  installSpec(w.root, w.fix);
  installTimeline(w.root, [
    { repo: 'Mintplex-Labs/anything-llm', events: [{ date: '2026-10-27', thing: 'A thing', kind: 'model', source_url: 'https://example.test', keepup: { action: 'pr_updated', pr: '06', summary: 'Add it' } }] },
    { repo: 'mezmo/aura', events: [] },
  ]);
  installDb(w.root, 'npm', [{ released: '2026-10-27' }]);
  const run = await cli('go', [], w.root, w.env);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const objects = readObjects(w.root);
  assert.deepEqual(objects.prs['06'].stagesApplied, ['2026-09-22', '2026-09-29']);
  assert.equal(objects.prs['06'].ci.state, 'success');
  assert.ok(objects.issues['anything-llm/2026-10-26']);
  assert.ok(objects.issues['aura/2026-10-26']);
  const body = fork.threads[0].body;
  assert.match(body, /\[Pull request #1: Add GPT-6 Sol, GPT-6 Luna and GPT-6\.1 Sol · answers on 3 of 3 new models\]/);
  assert.match(run.stdout, /Done when/);
  const pushes = w.fake.pushes().length;
  const again = await cli('go', [], w.root, w.env);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(w.fake.pushes().length, pushes, 'resumed: nothing new');
  assert.match(again.stdout, /skip  npm run pr -- 06 --all: all stages applied/);
});
