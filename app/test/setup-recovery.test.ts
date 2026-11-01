// Setup when things aren't fresh: a lost key, a new installation, a moved org, a slow fork, a browser that won't open.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { requireAppConfig } from '../src/config.ts';
import { createAppJwtClient, createPersonClient } from '../src/github.ts';
import { GuardError } from '../src/guard.ts';
import { readObjects, updateObjects } from '../src/objects.ts';
import { runSetup, SetupRefused, type SetupDeps, type SetupOptions } from '../src/setup.ts';
import { startLocalServer } from '../src/setup-server.ts';
import { computeStatus } from '../src/status.ts';
import { startFakeGitHub, type FakeGitHub } from './fake-github.ts';
import { installSpec, ORG, recordFor, repoFixture, tempDir, UPSTREAM } from './world.ts';

const APP = 'keepup-ai';

interface Scene { root: string; keyDir: string; fake: FakeGitHub; lines: string[]; opened: string[]; deps: SetupDeps; options: SetupOptions; env: Record<string, string> }

function browserFor(fake: FakeGitHub, opened: string[]) {
  return async (url: string): Promise<void> => {
    opened.push(url);
    if (url.endsWith('/start')) {
      const html = await (await fetch(url)).text();
      const raw = html.match(/name="manifest" value="([^"]*)"/)?.[1] ?? '';
      const action = html.match(/action="([^"]+)"/)?.[1] ?? '';
      const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const manifest = decode(raw);
      const redirect = new URL((JSON.parse(manifest) as { redirect_url: string }).redirect_url);
      redirect.searchParams.set('code', fake.acceptManifest(manifest));
      redirect.searchParams.set('state', new URL(decode(action)).searchParams.get('state') ?? '');
      await fetch(redirect);
    }
    if (url.includes('/installations/new')) fake.installedOnOrg = true;
  };
}

async function scene(options: Partial<SetupOptions> = {}, org = ORG): Promise<Scene> {
  const dir = tempDir();
  const root = join(dir, 'root');
  mkdirSync(root);
  const fix = repoFixture();
  const fake = await startFakeGitHub({ dir, org, installed: false, slug: APP });
  after(() => fake.close());
  fake.addRepo('Mintplex-Labs', 'anything-llm', fix.bare);
  fake.addRepo('mezmo', 'aura', fix.bare);
  const lines: string[] = [];
  const opened: string[] = [];
  const keyDir = join(dir, 'home', '.config', 'keepup');
  const env = { KEEPUP_GITHUB_API_URL: fake.url, KEEPUP_GITHUB_WEB_URL: fake.webUrl };
  const deps: SetupDeps = {
    root, env, keyDir,
    ghToken: async () => fake.options.personToken,
    openBrowser: browserFor(fake, opened),
    log: (l) => lines.push(l),
    sleep: async () => undefined,
    pollMs: 1, forkTimeoutMs: 5000, flowTimeoutMs: 5000,
  };
  return { root, keyDir, fake, lines, opened, deps, env, options: { org, ...options } };
}

const envFile = (s: Scene) => readFileSync(join(s.root, '.env'), 'utf8');

test('both browser steps print their address first, and say which login to use', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const text = s.lines.join('\n');
  assert.equal(s.opened.length, 2);
  for (const url of s.opened) assert.ok(text.includes(url), `${url} isn't in the log`);
  assert.match(text, /signed in to GitHub as a-founder/);
  assert.ok(s.lines.findIndex((l) => l.includes(s.opened[0])) >= 0);
});

test('a browser that will not open is a warning: setup waits, and the person can use the printed address', async () => {
  const s = await scene();
  const works = s.deps.openBrowser;
  let tries = 0;
  const failing = async (url: string) => {
    tries += 1;
    setTimeout(() => void works(url), 5);
    throw new Error('Command failed: open');
  };
  const result = await runSetup(s.options, { ...s.deps, openBrowser: failing });
  assert.equal(tries, 2, 'both steps got past it');
  assert.deepEqual(result.problems, []);
  assert.ok(s.lines.some((l) => /Couldn't open a browser from here/.test(l)));
  assert.equal(s.fake.registeredApps, 1);
});

test('a key that went missing never registers a second App, and says where to get a new key', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const keyPath = envFile(s).match(/^GITHUB_APP_PRIVATE_KEY_PATH=(.*)$/m)?.[1] ?? '';
  const { rmSync } = await import('node:fs');
  rmSync(keyPath);
  const before = envFile(s);
  await assert.rejects(runSetup(s.options, s.deps), (e: Error) => {
    assert.match(e.message, new RegExp(`generate a new key at https://github.com/organizations/${ORG}/settings/apps/${APP}`));
    assert.match(e.message, /--new-app/);
    return true;
  });
  assert.equal(s.fake.registeredApps, 1);
  assert.equal(envFile(s), before, '.env is left alone');
  assert.deepEqual(readdirSync(s.keyDir), [], 'no second key file');
});

test('--new-app replaces the id, slug, key path and installation together', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  writeFileSync(join(s.root, '.env'), `${envFile(s).replace(/GITHUB_APP_ID=.*/, 'GITHUB_APP_ID=111').replace(/GITHUB_APP_SLUG=.*/, 'GITHUB_APP_SLUG=old-slug').replace(/GITHUB_APP_INSTALLATION_ID=.*/, 'GITHUB_APP_INSTALLATION_ID=222')}OPENAI_API_KEY=keep-me\n`);
  await runSetup({ ...s.options, newApp: true }, s.deps);
  const env = envFile(s);
  assert.equal(s.fake.registeredApps, 2);
  assert.match(env, /^GITHUB_APP_ID=4242$/m);
  assert.match(env, new RegExp(`^GITHUB_APP_SLUG=${APP}$`, 'm'));
  assert.match(env, /^GITHUB_APP_INSTALLATION_ID=777$/m, 'the old installation is gone with the old App');
  assert.match(env, /^OPENAI_API_KEY=keep-me$/m);
  assert.ok(s.lines.some((l) => /Leave --new-app off/.test(l)));
});

test('an installation that was replaced is found again, without hand-editing .env', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  writeFileSync(join(s.root, '.env'), envFile(s).replace(/GITHUB_APP_INSTALLATION_ID=.*/, 'GITHUB_APP_INSTALLATION_ID=31337'));
  const before = s.opened.length;
  const result = await runSetup(s.options, s.deps);
  assert.deepEqual(result.problems, []);
  assert.match(envFile(s), /^GITHUB_APP_INSTALLATION_ID=777$/m);
  assert.equal(s.opened.length, before, 'found by asking GitHub, with no browser');
  assert.ok(s.lines.some((l) => /Installation 31337 in \.env isn't on GitHub any more/.test(l)));
});

test('an uninstalled App goes back to the install page and then saves the new id', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  s.fake.installedOnOrg = false;
  await runSetup(s.options, s.deps);
  assert.ok(s.opened.at(-1)?.endsWith(`/apps/${APP}/installations/new`), s.opened.join('\n'));
  assert.match(envFile(s), /^GITHUB_APP_INSTALLATION_ID=777$/m);
});

test('a stored installation is only believed when GitHub says it is this App, on this org', async () => {
  for (const arrange of [(f: FakeGitHub) => { f.foreignInstallationId = 555; }, (f: FakeGitHub) => { f.otherAppInstallationId = 555; }]) {
    const s = await scene();
    await runSetup(s.options, s.deps);
    arrange(s.fake);
    writeFileSync(join(s.root, '.env'), envFile(s).replace(/GITHUB_APP_INSTALLATION_ID=.*/, 'GITHUB_APP_INSTALLATION_ID=555'));
    await runSetup(s.options, s.deps);
    assert.match(envFile(s), /^GITHUB_APP_INSTALLATION_ID=777$/m);
  }
});

test('a deleted App says so and names the way back, instead of a bare 404', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  s.fake.appDeleted = true;
  await assert.rejects(runSetup(s.options, s.deps), /GitHub doesn't recognise the App in \.env.*--new-app/s);
});

test('a rerun waits for a fork that is still being copied, instead of calling its commits missing', async () => {
  const s = await scene();
  installSpec(s.root, repoFixture());
  await runSetup(s.options, s.deps);
  const fork = s.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.notReadyPolls = 3;
  let slept = 0;
  const result = await runSetup(s.options, { ...s.deps, sleep: async () => { slept += 1; } });
  assert.ok(slept >= 3, 'it waited');
  assert.deepEqual(result.problems, []);
  assert.ok(!s.lines.some((l) => /DOES NOT RESOLVE/.test(l)));
});

test('a fork still copying when the base commits are checked gets a plain answer, and setup goes on', async () => {
  const s = await scene();
  installSpec(s.root, repoFixture());
  await runSetup(s.options, s.deps);
  const fork = s.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.singleCommitReadsAsCopying = true;
  const result = await runSetup(s.options, s.deps);
  assert.ok(result.problems.some((p) => /still being copied/.test(p)), result.problems.join('\n'));
  assert.ok(!result.problems.some((p) => /DOES NOT RESOLVE/.test(p)));
  assert.ok(!s.lines.some((l) => /DOES NOT RESOLVE/.test(l)));
});

test('a repo not found at first is waited for too', async () => {
  const s = await scene();
  const up = s.fake.repo('mezmo', 'aura');
  if (up) up.notFoundPolls = 3;
  const result = await runSetup(s.options, s.deps);
  assert.deepEqual(result.problems, []);
  assert.equal(s.fake.repo(ORG, 'aura')?.hasIssues, true);
});

test('a fork of something else is refused, even with the right name', async () => {
  const s = await scene();
  s.fake.addRepo(ORG, 'aura', repoFixture().bare, { fork: true, parent: UPSTREAM });
  await assert.rejects(runSetup(s.options, s.deps), /keepup-demo\/aura already exists and isn't a fork of mezmo\/aura/);
});

test('asking for another org names the real way to switch, and the App\'s org decides', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const stored = envFile(s);
  writeFileSync(join(s.root, '.env'), stored.replace(`DEMO_ORG=${ORG}`, 'DEMO_ORG=the-old-org'));
  await assert.rejects(runSetup(s.options, s.deps), (e: Error) => {
    assert.ok(e instanceof SetupRefused);
    assert.match(e.message, /already says the-old-org/);
    assert.match(e.message, /--new-app/);
    assert.ok(!/--overwrite-env/.test(e.message), 'that flag alone would leave the old App');
    return true;
  });
  s.fake.appOwner = 'the-old-org';
  await assert.rejects(runSetup({ ...s.options, overwriteEnv: true }, s.deps), /The App in \.env belongs to the-old-org, not keepup-demo.*--new-app/s);
  assert.equal(s.fake.repo(ORG, 'anything-llm')?.pulls.length, 0);
  s.fake.appOwner = ORG;
  const result = await runSetup({ ...s.options, overwriteEnv: true }, s.deps);
  assert.deepEqual(result.problems, []);
  assert.match(envFile(s), new RegExp(`^DEMO_ORG=${ORG}$`, 'm'), 'it does belong here, so .env was just wrong');
});

test('moving to a new org with --new-app forgets the old org\'s records', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  installSpec(s.root, repoFixture());
  updateObjects(s.root, (o) => ({ ...o, org: 'the-old-org', prs: { '06': recordFor(s.root, '06') }, issues: { 'aura/2026-10-26': { number: 1, url: 'https://github.com/the-old-org/aura/issues/1' } }, forks: { aura: 'https://github.com/the-old-org/aura' } }));
  writeFileSync(join(s.root, '.env'), envFile(s).replace(`DEMO_ORG=${ORG}`, 'DEMO_ORG=the-old-org'));
  await runSetup({ ...s.options, newApp: true }, s.deps);
  const objects = readObjects(s.root);
  assert.equal(objects.org, ORG);
  assert.deepEqual(objects.prs, {});
  assert.deepEqual(objects.issues, {});
  assert.ok(!Object.values(objects.forks).some((u) => u.includes('the-old-org')));
  assert.match(envFile(s), new RegExp(`^DEMO_ORG=${ORG}$`, 'm'));
});

test('the local server listens on this machine only', async () => {
  const server = await startLocalServer();
  after(() => server.close());
  assert.equal(server.boundAddress, '127.0.0.1');
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(server.state, /^[0-9a-f]{32}$/);
});

test('with no key directory given, the key lands under the home directory, outside the repo, mode 0600', async () => {
  const s = await scene();
  const home = tempDir('keepup-home-');
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(homedir(), home);
    const { keyDir: _unused, ...deps } = s.deps;
    await runSetup(s.options, deps);
    const key = join(home, '.config', 'keepup', `${APP}.private-key.pem`);
    assert.ok(existsSync(key));
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.ok(!key.startsWith(s.root));
  } finally {
    process.env.HOME = realHome;
  }
});

test('the person\'s client passes the guard: its token can\'t touch upstream or anything else', async () => {
  const s = await scene();
  const client = createPersonClient(s.fake.options.personToken, { ...s.env, DEMO_ORG: ORG });
  const count = s.fake.requests.length;
  await assert.rejects(client.request('POST /repos/{owner}/{repo}/issues', { owner: 'mezmo', repo: 'aura', title: 'x' }), GuardError);
  await assert.rejects(client.request('PATCH /repos/{owner}/{repo}', { owner: 'Mintplex-Labs', repo: 'anything-llm', has_issues: true }), GuardError);
  await assert.rejects(client.request('POST /repos/{owner}/{repo}/forks', { owner: 'mezmo', repo: 'aura', organization: 'not-the-demo-org' }), GuardError);
  await assert.rejects(client.request('POST /user/repos', { name: 'x' }), GuardError);
  assert.equal(s.fake.requests.length, count, 'nothing left the process');
});

test('the App\'s JWT client passes the guard too', async () => {
  const s = await scene();
  const keyPath = join(tempDir(), 'k.pem');
  writeFileSync(keyPath, s.fake.privateKey);
  const client = createAppJwtClient('4242', keyPath, { ...s.env, DEMO_ORG: ORG });
  const count = s.fake.requests.length;
  await assert.rejects(client.request('POST /repos/{owner}/{repo}/issues', { owner: 'mezmo', repo: 'aura', title: 'x' }), GuardError);
  await assert.rejects(client.request('GET /repos/{owner}/{repo}', { owner: 'someone', repo: 'else' }), GuardError);
  assert.equal(s.fake.requests.length, count, 'nothing left the process');
});

test('status after a real setup reads the slug and files it needs, end to end', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const env = { ...s.env, ...Object.fromEntries(envFile(s).trim().split('\n').map((l) => l.split('='))) } as Record<string, string>;
  assert.equal(requireAppConfig(env, s.root).slug, APP);
  const status = await computeStatus({ root: s.root, env, live: true });
  assert.equal(status.setup.ok, true);
  assert.equal(status.live, true);
  assert.equal(status.actions?.length, 2);
});
