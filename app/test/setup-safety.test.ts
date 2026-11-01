// The moments setup can't take back: the one time GitHub hands over a key, a refused Actions switch, and a fork older than its base commit.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createPrDeps, openOrUpdate } from '../src/pr.ts';
import { findSpec } from '../src/specs.ts';
import { runSetup, type SetupDeps, type SetupOptions } from '../src/setup.ts';
import { quick } from './aura-world.ts';
import { startFakeGitHub, type FakeGitHub } from './fake-github.ts';
import { git } from './fake-repos.ts';
import { createWorld, installSpec, ORG, repoFixture, tempDir, UPSTREAM } from './world.ts';

const SLUG = 'keepup-ai';

function browser(fake: FakeGitHub, opened: string[]) {
  return async (url: string): Promise<void> => {
    opened.push(url);
    if (url.endsWith('/start')) {
      const html = await (await fetch(url)).text();
      const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const action = new URL(decode(html.match(/action="([^"]+)"/)?.[1] ?? ''));
      const manifest = decode(html.match(/name="manifest" value="([^"]*)"/)?.[1] ?? '');
      const redirect = new URL((JSON.parse(manifest) as { redirect_url: string }).redirect_url);
      redirect.searchParams.set('code', fake.acceptManifest(manifest));
      redirect.searchParams.set('state', action.searchParams.get('state') ?? '');
      await fetch(redirect);
    } else if (url.includes('/installations/new')) fake.installedOnOrg = true;
  };
}

async function scene(extra: Partial<SetupDeps> = {}) {
  const dir = tempDir();
  const root = join(dir, 'root');
  mkdirSync(root);
  const fix = repoFixture();
  const fake = await startFakeGitHub({ dir, org: ORG, installed: false, slug: SLUG });
  after(() => fake.close());
  fake.addRepo('Mintplex-Labs', 'anything-llm', fix.bare);
  fake.addRepo('mezmo', 'aura', fix.bare);
  const lines: string[] = [];
  const opened: string[] = [];
  const deps: SetupDeps = {
    root, env: { KEEPUP_GITHUB_API_URL: fake.url, KEEPUP_GITHUB_WEB_URL: fake.webUrl },
    keyDir: join(dir, 'home', '.config', 'keepup'), keyFallbackDirs: [join(dir, 'fallback')],
    ghToken: async () => fake.options.personToken, openBrowser: browser(fake, opened), log: (l) => lines.push(l),
    sleep: async () => undefined, pollMs: 1, forkTimeoutMs: 5000, flowTimeoutMs: 5000, ...extra,
  };
  const options: SetupOptions = { org: ORG };
  return { dir, root, fix, fake, lines, opened, deps, options };
}

test('a key folder that can\'t be written stops setup before the browser opens and before any App exists', async () => {
  const s = await scene();
  writeFileSync(join(s.dir, 'home'), 'a file where a folder should be');
  await assert.rejects(runSetup(s.options, s.deps), /can't write the App's private key.*Nothing was registered/s);
  assert.equal(s.fake.registeredApps, 0);
  assert.ok(!s.opened.some((u) => u.endsWith('/start')));
});

test('if saving still fails at the moment GitHub hands it over, the key lands in a fallback file and setup carries on', async () => {
  const s = await scene();
  const keyDir = s.deps.keyDir as string;
  mkdirSync(join(keyDir, `${SLUG}.private-key.pem`), { recursive: true });
  mkdirSync(join(keyDir, `${SLUG}-${s.fake.options.appId}.private-key.pem`), { recursive: true });
  await runSetup(s.options, s.deps);
  const [file] = readdirSync(join(s.dir, 'fallback'));
  const path = join(s.dir, 'fallback', file);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), s.fake.privateKey);
  assert.match(readFileSync(join(s.root, '.env'), 'utf8'), new RegExp(`GITHUB_APP_PRIVATE_KEY_PATH=${path}`));
  assert.ok(s.lines.some((l) => l.includes(path) && /settings\/apps\/keepup-ai/.test(l)), s.lines.join('\n'));
  assert.ok(!s.lines.join('\n').includes('BEGIN'), 'never the key');
});

test('with nowhere to put the key, it says how to recover, and .env knows the App exists', async () => {
  const s = await scene({ keyFallbackDirs: [] });
  const keyDir = s.deps.keyDir as string;
  mkdirSync(join(keyDir, `${SLUG}.private-key.pem`), { recursive: true });
  mkdirSync(join(keyDir, `${SLUG}-${s.fake.options.appId}.private-key.pem`), { recursive: true });
  await assert.rejects(runSetup(s.options, s.deps), /couldn't be saved.*Generate a new key at .*settings\/apps\/keepup-ai.*delete the App/s);
  assert.match(readFileSync(join(s.root, '.env'), 'utf8'), /GITHUB_APP_ID=/);
  await assert.rejects(runSetup(s.options, s.deps), /generate a new key/i, 'the next run knows, and registers nothing');
  assert.equal(s.fake.registeredApps, 1);
});

test('the taken-name hint puts deleting an earlier App first', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const hint = s.lines.find((l) => /name is taken/.test(l)) ?? '';
  assert.ok(hint.indexOf('delete it') >= 0 && hint.indexOf('delete it') < hint.indexOf('--app-name'), hint);
});

test('Actions refused is a problem that stays on screen, with where to look, and setup does not say go', async () => {
  const s = await scene();
  s.fake.denyActionsPermissions = true;
  const result = await runSetup(s.options, s.deps);
  const problem = result.problems.find((p) => /wouldn't turn Actions on/.test(p));
  assert.match(problem ?? '', new RegExp(`https://github.com/organizations/${ORG}/settings/actions`));
  assert.ok(s.lines.some((l) => /^Problem: .*wouldn't turn Actions on/.test(l)));
  assert.ok(s.lines.some((l) => /fix the problems above/.test(l)));
  assert.ok(!s.lines.includes('Next: npm run go'));
  assert.ok(!result.manual.some((m) => /Setup has asked the API/.test(m)), 'it did not get its answer');
});

function staleFork(fake: FakeGitHub, fix: { bare: string; baseCommit: string }, name: string, parent: string): void {
  const repo = fake.addRepo(ORG, name, fix.bare, { fork: true, parent });
  git(repo.bare, 'update-ref', '-d', 'refs/heads/patches');
  git(repo.bare, 'update-ref', 'refs/heads/main', `${fix.baseCommit}~1`);
}

test('a fork older than the base commit is caught, though GitHub answers for the commit across the network', async () => {
  const s = await scene();
  staleFork(s.fake, s.fix, 'anything-llm', UPSTREAM);
  installSpec(s.root, s.fix);
  const result = await runSetup(s.options, s.deps);
  const problem = result.problems.find((p) => /DOES NOT RESOLVE/.test(p));
  assert.match(problem ?? '', /its main is behind it/);
  assert.match(problem ?? '', /Sync fork/);
  assert.ok(s.fake.requests.some((r) => r.path.endsWith(`/commits/${s.fix.baseCommit}`)), 'the old read still happens, and it can not tell');
});

test('a pull request on such a fork stops before it writes anything', async () => {
  const w = await createWorld();
  installSpec(w.root, w.fix);
  const repo = w.fake.repo(ORG, 'anything-llm');
  if (!repo) throw new Error('fixture');
  git(repo.bare, 'update-ref', '-d', 'refs/heads/patches');
  git(repo.bare, 'update-ref', 'refs/heads/main', `${w.fix.baseCommit}~1`);
  await assert.rejects(openOrUpdate(findSpec('06', w.root), {}, createPrDeps(w.root, w.env, quick())), /isn't in keepup-demo\/anything-llm's history: its main is behind it/);
  assert.deepEqual(w.fake.writeRequests().filter((r) => !r.path.endsWith('/access_tokens')), []);
  assert.ok(existsSync(repo.bare));
});
