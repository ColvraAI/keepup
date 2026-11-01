// Secrets planted where a real failure would put them, in a server's error message and in git's
// stderr. Each test has to see them arrive and be scrubbed, or it proves nothing.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { main as setupMain } from '../src/cli/setup.ts';
import { processIo } from '../src/cli/shared.ts';
import { requireAppConfig } from '../src/config.ts';
import { GitError } from '../src/git.ts';
import { createAppClient, describeApiError } from '../src/github.ts';
import { redact, registerEnvSecrets, registerSecret } from '../src/secrets.ts';
import { startFakeGitHub } from './fake-github.ts';
import { createWorld, installSpec, ORG, repoFixture, tempDir } from './world.ts';
import { after } from 'node:test';

const TOKEN = 'ghs_canaryfixedinstallationtoken';
/** No recognisable shape: only registration, then redaction, can catch this one. */
const SHAPELESS = 'canary-shapeless-value-0123456789';

interface Run { code: number; stdout: string; stderr: string }

function cli(name: string, args: string[], root: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'app/src/cli', `${name}.ts`), ...args], { env: { PATH: process.env.PATH, HOME: tempDir('keepup-home-'), KEEPUP_ROOT: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function assertClean(run: Run, pem: string): void {
  const all = run.stdout + run.stderr;
  for (const secret of [TOKEN, SHAPELESS, 'BEGIN RSA PRIVATE KEY', pem.split('\n')[1], Buffer.from(`x-access-token:${TOKEN}`).toString('base64')]) {
    assert.ok(!all.includes(secret), `leaked ${secret.slice(0, 16)}…\n${all}`);
  }
}

test('a server error repeating the token, a key and the PEM reaches the terminal as [redacted], with exit 1', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  w.fake.fixedToken = TOKEN;
  w.fake.poison = { method: 'POST', path: /\/git\/refs$/, message: () => `boom ${TOKEN} ${SHAPELESS} ${w.fake.privateKey}` };
  const run = await cli('pr', ['06'], w.root, { ...w.env, SENTRY_ACCESS_TOKEN: SHAPELESS });
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /GitHub said 500: boom \[redacted\] \[redacted\] \[redacted\]/);
  assertClean(run, w.fake.privateKey);
});

test('git printing the token on stderr reaches the terminal as [redacted], with exit 1', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  w.fake.fixedToken = TOKEN;
  const bare = w.fake.repo(ORG, 'anything-llm')?.bare as string;
  writeFileSync(join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\necho "denied for ${TOKEN} and ${SHAPELESS}" >&2\nexit 1\n`, { mode: 0o755 });
  const run = await cli('pr', ['06'], w.root, { ...w.env, SENTRY_ACCESS_TOKEN: SHAPELESS });
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /denied for \[redacted\] and \[redacted\]/);
  assertClean(run, w.fake.privateKey);
});

test('a token with no recognisable shape is scrubbed too, because it was registered when it was minted', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  const plain = 'canary-plain-installation-token-0123';
  w.fake.fixedToken = plain;
  const bare = w.fake.repo(ORG, 'anything-llm')?.bare as string;
  writeFileSync(join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\necho "denied for ${plain}" >&2\nexit 1\n`, { mode: 0o755 });
  const run = await cli('pr', ['06'], w.root, w.env);
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /denied for \[redacted\]/);
  assert.ok(!(run.stdout + run.stderr).includes(plain));
});

test('status --live with GitHub repeating secrets still prints none of them, and exits 0', async () => {
  const w = await createWorld();
  w.fake.fixedToken = TOKEN;
  w.fake.poison = { method: 'GET', path: /\/installation\/repositories$/, message: () => `boom ${TOKEN} ${SHAPELESS}` };
  const run = await cli('status', ['--live'], w.root, { ...w.env, SENTRY_ACCESS_TOKEN: SHAPELESS });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Couldn't read GitHub \(500: boom \[redacted\] \[redacted\]\)/);
  assertClean(run, w.fake.privateKey);
});

test('the client secret and webhook secret stay out of a later server error', async () => {
  const dir = tempDir();
  const root = join(dir, 'root');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(root);
  const fix = repoFixture();
  const fake = await startFakeGitHub({ dir, org: ORG, installed: false, slug: 'keepup-ai' });
  after(() => fake.close());
  fake.addRepo('Mintplex-Labs', 'anything-llm', fix.bare);
  fake.addRepo('mezmo', 'aura', fix.bare);
  fake.poison = { method: 'POST', path: /\/forks$/, message: () => `boom ${fake.clientSecret} ${fake.webhookSecret}` };
  const out: string[] = [];
  const err: string[] = [];
  const browser = async (url: string) => {
    if (!url.endsWith('/start')) return;
    const html = await (await fetch(url)).text();
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const manifest = decode(html.match(/name="manifest" value="([^"]*)"/)?.[1] ?? '');
    const redirect = new URL((JSON.parse(manifest) as { redirect_url: string }).redirect_url);
    redirect.searchParams.set('code', fake.acceptManifest(manifest));
    redirect.searchParams.set('state', new URL(decode(html.match(/action="([^"]+)"/)?.[1] ?? '')).searchParams.get('state') ?? '');
    await fetch(redirect);
  };
  const code = await setupMain(['--org', ORG], { root, env: { KEEPUP_GITHUB_API_URL: fake.url, KEEPUP_GITHUB_WEB_URL: fake.webUrl }, io: { out: (l) => out.push(l), err: (l) => err.push(l) } }, {
    ghToken: async () => fake.options.personToken, openBrowser: browser, keyDir: join(dir, 'keys'), sleep: async () => undefined, pollMs: 1, flowTimeoutMs: 5000,
  });
  assert.equal(code, 1);
  const text = [...out, ...err].join('\n');
  assert.match(text, /GitHub said 500: boom \[redacted\] \[redacted\]/);
  assert.ok(!text.includes(fake.clientSecret) && !text.includes(fake.webhookSecret));
});

test('every layer scrubs on its own, so none of them is the only thing standing', () => {
  registerSecret('layer-canary-0123456789');
  assert.ok(!new GitError('git said layer-canary-0123456789').message.includes('layer-canary'), 'GitError');
  assert.equal(describeApiError({ status: 500, response: { data: { message: 'x layer-canary-0123456789' } } }), '500: x [redacted]');
  const printed: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { printed.push(s); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { printed.push(s); return true; }) as typeof process.stderr.write;
  try {
    processIo.out('out layer-canary-0123456789');
    processIo.err('err layer-canary-0123456789');
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  assert.deepEqual(printed, ['out [redacted]\n', 'err [redacted]\n']);
});

test('each secret shape is caught with nothing registered, and each env name that should be is registered', () => {
  const shapes = ['ghs_abcdefghij', 'gho_abcdefghij', 'ghp_abcdefghij', 'github_pat_abcdefghijkl', 're_abcdefghijkl', 'sk-abcdefghijkl', 'sk-ant-abcdefghijkl', 'eyJabcdefghij.eyJabcdefghij.abcdefghijkl', '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----', 'authorization: bearer abcdef'];
  for (const shape of shapes) assert.ok(!redact(`before ${shape} after`).includes(shape), shape);
  registerEnvSecrets({ SOME_API_KEY: 'name-ends-in-key-012', SOME_TOKEN: 'name-ends-in-token-012', A_SECRET: 'name-ends-in-secret-012', A_PASSWORD: 'name-ends-in-password-012', GITHUB_APP_PRIVATE_KEY_PATH: '/not/secret/path/at/all', DEMO_ORG: 'not-secret-org' });
  assert.equal(redact('name-ends-in-key-012 name-ends-in-token-012 name-ends-in-secret-012 name-ends-in-password-012'), '[redacted] [redacted] [redacted] [redacted]');
  assert.equal(redact('/not/secret/path/at/all not-secret-org'), '/not/secret/path/at/all not-secret-org');
});

test('Octokit\'s own warnings go through the scrubber', async () => {
  const w = await createWorld();
  const client = createAppClient(requireAppConfig(w.env, w.root), w.env);
  const printed: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => { printed.push(s); return true; }) as typeof process.stderr.write;
  try {
    client.log.warn('warned about ghs_abcdefghijklmn');
    client.log.error('error about ghs_abcdefghijklmn');
  } finally {
    process.stderr.write = real;
  }
  assert.deepEqual(printed, ['warned about [redacted]\n', 'error about [redacted]\n']);
});
