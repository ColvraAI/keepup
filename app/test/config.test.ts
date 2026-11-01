import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isLoopback, loadConfigEnv, NeedsSetupError, readPrivateKey, requireAppConfig, resolveUrls } from '../src/config.ts';
import { objectsPath, readObjects, updateObjects, withFork, withIssue, withPr, type GithubObjects, type PrRecord } from '../src/objects.ts';
import { openInBrowser, readGhToken } from '../src/setup.ts';
import { summarise } from '../src/ci.ts';
import { tempDir, writeText } from './world.ts';

function env(root: string): Record<string, string> {
  const key = join(tempDir(), 'k.pem');
  writeText(key, '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n');
  return { DEMO_ORG: 'keepup-demo', GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'keepup', GITHUB_APP_PRIVATE_KEY_PATH: key, GITHUB_APP_INSTALLATION_ID: '2', ROOT: root };
}

test('requireAppConfig names everything missing, and the command that fills it', () => {
  assert.throws(() => requireAppConfig({}, tempDir()), (e: unknown) => {
    assert.ok(e instanceof NeedsSetupError);
    assert.deepEqual(e.missing, ['DEMO_ORG', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID']);
    assert.match(e.message, /Run: npm run setup -- --org <name>/);
    return true;
  });
  const root = tempDir();
  const { DEMO_ORG: _dropped, ...partial } = env(root);
  assert.throws(() => requireAppConfig(partial, root), /Missing DEMO_ORG in \.env/);
});

test('requireAppConfig returns the config when it is whole', () => {
  const root = tempDir();
  const values = env(root);
  assert.deepEqual(requireAppConfig(values, root), { appId: '1', slug: 'keepup', keyPath: values.GITHUB_APP_PRIVATE_KEY_PATH, installationId: 2, org: 'keepup-demo' });
});

test('the private key must stay outside the repo, and must exist', () => {
  const root = tempDir();
  const inside = join(root, 'keys', 'k.pem');
  writeText(inside, 'x');
  assert.throws(() => requireAppConfig({ ...env(root), GITHUB_APP_PRIVATE_KEY_PATH: inside }, root), /inside the repo/);
  assert.throws(() => requireAppConfig({ ...env(root), GITHUB_APP_PRIVATE_KEY_PATH: '/no/such/file' }, root), (e: unknown) => {
    assert.ok(e instanceof NeedsSetupError);
    assert.ok(!e.message.includes('/no/such/file'), 'the message names the variable');
    assert.match(e.message, /generate a new key at https:\/\/github\.com\/organizations\/keepup-demo\/settings\/apps\/keepup/);
    assert.match(e.message, /--new-app/);
    return true;
  });
  assert.throws(() => requireAppConfig({ ...env(root), GITHUB_APP_INSTALLATION_ID: 'abc' }, root), /whole number/);
});

test('readPrivateKey never repeats the file in its errors', () => {
  const dir = tempDir();
  const bad = join(dir, 'bad.pem');
  writeFileSync(bad, 'canary-not-a-key');
  assert.throws(() => readPrivateKey(bad), (e: unknown) => !(e as Error).message.includes('canary-not-a-key'));
  assert.throws(() => readPrivateKey(join(dir, 'missing.pem')), /ENOENT/);
});

test('real env vars win over .env, and .env is read from the given root only', () => {
  const root = tempDir();
  writeText(join(root, '.env'), 'DEMO_ORG=from-file\nGITHUB_APP_ID=7\n');
  const merged = loadConfigEnv(root, { DEMO_ORG: 'from-env' });
  assert.equal(merged.DEMO_ORG, 'from-env');
  assert.equal(merged.GITHUB_APP_ID, '7');
});

test('URL overrides must be loopback', () => {
  assert.deepEqual(resolveUrls({}), { api: 'https://api.github.com', web: 'https://github.com', git: 'https://github.com/' });
  assert.equal(resolveUrls({ KEEPUP_GITHUB_API_URL: 'http://127.0.0.1:9' }).api, 'http://127.0.0.1:9');
  for (const name of ['KEEPUP_GITHUB_API_URL', 'KEEPUP_GITHUB_WEB_URL', 'KEEPUP_GIT_BASE_URL']) {
    assert.throws(() => resolveUrls({ [name]: 'https://example.test' }), /may only point at this machine/);
    assert.throws(() => resolveUrls({ [name]: 'not a url' }), /isn't a URL/);
  }
  assert.equal(isLoopback('https://api.github.com'), false);
});

const record = { number: 1, url: 'u', title: 't', state: 'open', base: 'b', head: 'h', author: 'a', stagesApplied: [], ci: { state: 'none', url: null }, checkedAt: 'x' } as PrRecord;

test('object updates return new values and leave their input alone', () => {
  const start: GithubObjects = { schema: 1, forks: {}, prs: {}, issues: {} };
  const frozen = Object.freeze({ ...start, forks: Object.freeze({}), prs: Object.freeze({}), issues: Object.freeze({}) }) as GithubObjects;
  const a = withPr(frozen, '01', record);
  const b = withFork(a, 'aura', 'https://x');
  const c = withIssue(b, 'aura', '2026-10-26', { number: 2, url: 'y' });
  assert.deepEqual(frozen, start);
  assert.deepEqual(a.forks, {});
  assert.deepEqual(c.issues, { 'aura/2026-10-26': { number: 2, url: 'y' } });
});

test('the objects file: empty when missing, atomic to write, clear when broken, keeps what it does not know', () => {
  const root = tempDir();
  assert.deepEqual(readObjects(root), { schema: 1, forks: {}, prs: {}, issues: {} });
  updateObjects(root, (o) => withPr(o, '01', record));
  assert.deepEqual(readdirSync(join(root, 'data')), ['github-objects.json'], 'no temp file left behind');
  const saved = JSON.parse(readFileSync(objectsPath(root), 'utf8')) as GithubObjects;
  assert.equal(saved.prs['01'].number, 1);
  writeFileSync(objectsPath(root), JSON.stringify({ ...saved, future: { kept: true } }));
  updateObjects(root, (o) => withFork(o, 'aura', 'https://x'));
  assert.deepEqual((JSON.parse(readFileSync(objectsPath(root), 'utf8')) as { future: unknown }).future, { kept: true });
  writeFileSync(objectsPath(root), '{ broken');
  assert.throws(() => readObjects(root), /github-objects\.json isn't valid JSON/);
});

function withFakeBin(name: string, script: string, use: () => Promise<void>): Promise<void> {
  const bin = tempDir();
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return use().finally(() => { process.env.PATH = path; });
}

test('the gh token is read from a stand-in gh, trimmed, and an empty or failing one means not logged in', async () => {
  await withFakeBin('gh', 'test "$1 $2" = "auth token" && echo gho_canary_from_gh', async () => {
    assert.equal(await readGhToken(), 'gho_canary_from_gh');
  });
  await withFakeBin('gh', 'exit 1', async () => {
    assert.equal(await readGhToken(), null);
  });
});

test('the browser opener hands over the URL, unchanged', async () => {
  const out = join(tempDir(), 'opened');
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await withFakeBin(opener, `printf '%s' "$1" > ${out}`, async () => {
    await openInBrowser('http://127.0.0.1:1/start?x=1&y=2');
  });
  assert.equal(readFileSync(out, 'utf8'), 'http://127.0.0.1:1/start?x=1&y=2');
});

test('summarise: what each mix of checks counts as', () => {
  const none = { state: 'pending', total_count: 0, statuses: [] };
  const run = (status: string, conclusion: string | null) => ({ status, conclusion, html_url: 'h', details_url: 'd' });
  assert.equal(summarise([], none).state, 'none');
  assert.equal(summarise([run('queued', null)], none).state, 'pending');
  assert.equal(summarise([run('completed', 'success'), run('in_progress', null)], none).state, 'pending');
  assert.equal(summarise([run('completed', 'success'), run('completed', 'failure')], none).state, 'failure');
  assert.equal(summarise([run('completed', 'cancelled')], none).state, 'failure');
  assert.equal(summarise([run('completed', 'action_required')], none).state, 'failure');
  assert.equal(summarise([run('completed', 'neutral')], none).state, 'neutral');
  assert.equal(summarise([run('completed', 'success'), run('completed', 'neutral')], none).state, 'success');
  assert.equal(summarise([], { state: 'success', total_count: 1, statuses: [{ state: 'success', target_url: 't' }] }).state, 'success');
  assert.equal(summarise([], { state: 'failure', total_count: 1, statuses: [{ state: 'error', target_url: 't' }] }).state, 'failure');
  assert.deepEqual(summarise([{ status: 'completed', conclusion: 'success', html_url: null, details_url: 'd' }], none), { state: 'success', url: 'd' });
});
