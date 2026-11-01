import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { expandHome, NeedsSetupError } from '../src/config.ts';
import { readObjects } from '../src/objects.ts';
import { runSetup, SetupRefused, updateEnvFile, type SetupDeps, type SetupOptions } from '../src/setup.ts';
import { pressActionsButton, registerByDefaultBranchPush } from './fake-actions.ts';
import { startFakeGitHub, type FakeGitHub, type FakeOptions } from './fake-github.ts';
import { installSpec, ORG, repoFixture, tempDir, UPSTREAM } from './world.ts';

/** The name in app/manifest.json, which the fake takes the slug from. */
const APP = 'keepup-ai';

const WORKFLOWS = [
  { id: 1, name: 'tests', path: '.github/workflows/run-tests.yaml', state: 'active' },
  { id: 2, name: 'lint', path: '.github/workflows/lint.yaml', state: 'active' },
  { id: 3, name: 'docker', path: '.github/workflows/docker.yaml', state: 'active' },
  { id: 4, name: 'cla', path: '.github/workflows/cla.yaml', state: 'active' },
];

interface Scene {
  root: string;
  keyDir: string;
  fake: FakeGitHub;
  lines: string[];
  opened: string[];
  deps: SetupDeps;
  options: SetupOptions;
  env: Record<string, string>;
}

function parseForm(html: string): { action: string; manifest: string } {
  const action = html.match(/action="([^"]+)"/)?.[1] ?? '';
  const raw = html.match(/name="manifest" value="([^"]*)"/)?.[1] ?? '';
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { action: decode(action), manifest: decode(raw) };
}

/** Stands in for the person at the browser: submits the form to the fake github.com and follows its redirect. */
function fakeBrowser(fake: FakeGitHub, opened: string[], script: { state?: string; install?: boolean } = {}) {
  return async (url: string): Promise<void> => {
    opened.push(url);
    if (url.endsWith('/start')) {
      const html = await (await fetch(url)).text();
      const { action, manifest } = parseForm(html);
      const target = new URL(action);
      const parsed = JSON.parse(manifest) as { redirect_url: string };
      const code = fake.acceptManifest(manifest);
      const redirect = new URL(parsed.redirect_url);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', script.state ?? target.searchParams.get('state') ?? '');
      await fetch(redirect);
      return;
    }
    if (url.includes('/installations/new') && script.install !== false) fake.installedOnOrg = true;
  };
}

async function scene(fakeOptions: Partial<FakeOptions> = {}, script: Parameters<typeof fakeBrowser>[2] = {}, optionOverrides: Partial<SetupOptions> = {}): Promise<Scene> {
  const dir = tempDir();
  const root = join(dir, 'root');
  mkdirSync(root);
  const keyDir = join(dir, 'home', '.config', 'keepup');
  const fix = repoFixture();
  const fake = await startFakeGitHub({ dir, org: ORG, installed: false, slug: APP, ...fakeOptions });
  after(() => fake.close());
  fake.addRepo('Mintplex-Labs', 'anything-llm', fix.bare, { workflows: WORKFLOWS });
  fake.addRepo('mezmo', 'aura', fix.bare, { workflows: [WORKFLOWS[3]] });
  const lines: string[] = [];
  const opened: string[] = [];
  const env = { KEEPUP_GITHUB_API_URL: fake.url, KEEPUP_GITHUB_WEB_URL: fake.webUrl };
  const deps: SetupDeps = {
    root, env, keyDir,
    ghToken: async () => fake.options.personToken,
    openBrowser: fakeBrowser(fake, opened, script),
    log: (l) => lines.push(l),
    sleep: async () => undefined,
    pollMs: 1,
    forkTimeoutMs: 5000,
    flowTimeoutMs: 5000,
  };
  return { root, keyDir, fake, lines, opened, deps, env, options: { org: ORG, ...optionOverrides } };
}

test('the whole setup: org checks, manifest flow, forks, Actions, install, and what it writes', async () => {
  const s = await scene();
  const result = await runSetup(s.options, s.deps);
  assert.equal(s.fake.registeredApps, 1);
  assert.deepEqual(s.fake.unhandled, []);
  const keyPath = join(s.keyDir, `${APP}.private-key.pem`);
  assert.equal(readFileSync(keyPath, 'utf8'), s.fake.privateKey);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  const env = readFileSync(join(s.root, '.env'), 'utf8');
  assert.match(env, /^DEMO_ORG=keepup-demo$/m);
  assert.match(env, /^GITHUB_APP_ID=4242$/m);
  assert.match(env, new RegExp(`^GITHUB_APP_SLUG=${APP}$`, 'm'));
  assert.ok(env.includes(`GITHUB_APP_PRIVATE_KEY_PATH=${keyPath}`));
  assert.match(env, /^GITHUB_APP_INSTALLATION_ID=777$/m);
  const fork = s.fake.repo(ORG, 'anything-llm');
  assert.equal(fork?.fork, true);
  assert.equal(fork?.parent, UPSTREAM);
  assert.equal(fork?.hasIssues, true);
  assert.deepEqual(fork?.workflows, [], 'a fresh fork lists no workflows');
  assert.deepEqual(s.fake.requests.filter((r) => /\/actions\/workflows\/\d+\//.test(r.path)), [], 'so there is nothing to switch, and the base branch has to do that job');
  const objects = readObjects(s.root);
  assert.equal(objects.org, ORG);
  assert.deepEqual(objects.app, { slug: APP, url: `https://github.com/apps/${APP}`, bot: `${APP}[bot]` });
  assert.deepEqual(objects.forks, { 'anything-llm': `https://github.com/${ORG}/anything-llm`, aura: `https://github.com/${ORG}/aura` });
  assert.deepEqual(result.problems, []);
  assert.equal(result.manual.length, 2, 'nothing proves either gate is open yet, so both get the final step');
  assert.match(result.manual[0], new RegExp(`https://github.com/${ORG}/anything-llm/actions`));
  assert.match(result.manual[1], new RegExp(`https://github.com/${ORG}/aura/actions`));
  assert.ok(!result.manual.join(' ').includes('the API has no call'), 'that is not known either way');
});

test('the forks setup records are what the API returned', async () => {
  const s = await scene();
  s.fake.apiMarker = 'from-the-api';
  await runSetup(s.options, s.deps);
  const { forks } = readObjects(s.root);
  assert.equal(forks['anything-llm'], `https://github.com/${ORG}/anything-llm#from-the-api`);
  assert.equal(forks.aura, `https://github.com/${ORG}/aura#from-the-api`);
});

test('the manifest asks for exactly the permissions in use, no webhook, and anyone can open its install page', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const m = s.fake.lastManifest as Record<string, unknown>;
  assert.deepEqual(m.default_permissions, { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write', workflows: 'write', actions: 'read', checks: 'read', statuses: 'read' });
  assert.equal(m.public, true, 'a private App shows a founder a page with no Install button');
  assert.equal((m.hook_attributes as { active: boolean }).active, false);
  assert.equal(m.name, APP);
  assert.match(String(m.redirect_url), /^http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(m.setup_url, undefined, 'its port is dead once setup exits, and every later install would land on it');
});

test('--app-name changes the name, and the taken-name hint is printed', async () => {
  const s = await scene({}, {}, { appName: 'keepup-demo-app' });
  await runSetup(s.options, s.deps);
  assert.equal((s.fake.lastManifest as { name: string }).name, 'keepup-demo-app');
  assert.match(readFileSync(join(s.root, '.env'), 'utf8'), /GITHUB_APP_SLUG=keepup-demo-app/);
  assert.ok(existsSync(join(s.keyDir, 'keepup-demo-app.private-key.pem')));
  assert.ok(s.lines.some((l) => /--app-name/.test(l)));
});

test('a state mismatch stops the flow before any code is exchanged', async () => {
  const s = await scene({}, { state: 'not-the-state' });
  await assert.rejects(runSetup(s.options, s.deps), /state/i);
  assert.equal(s.fake.requests.filter((r) => r.path.includes('/app-manifests/')).length, 0);
  assert.equal(s.fake.registeredApps, 0);
  assert.ok(!existsSync(join(s.keyDir, `${APP}.private-key.pem`)));
});

test('no redirect within the bound gives up with a clear message', async () => {
  const s = await scene();
  await assert.rejects(runSetup(s.options, { ...s.deps, openBrowser: async () => undefined, flowTimeoutMs: 20 }), /didn't come back/);
});

test('secrets from the conversion are never printed or stored in .env', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const everything = s.lines.join('\n') + readFileSync(join(s.root, '.env'), 'utf8');
  for (const secret of [s.fake.clientSecret, s.fake.webhookSecret, 'BEGIN RSA PRIVATE KEY', s.fake.options.personToken]) {
    assert.ok(!everything.includes(secret), `${secret} leaked`);
  }
});

test('rerunning skips what is done', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const count = s.fake.writeRequests().length;
  const opened = s.opened.length;
  await runSetup(s.options, s.deps);
  assert.equal(s.fake.registeredApps, 1);
  const newWrites = s.fake.writeRequests().slice(count).filter((r) => !r.path.endsWith('/access_tokens'));
  // Sent on purpose each time: a gated fork reports enabled: true, so nothing can say it isn't needed.
  assert.deepEqual(newWrites.map((r) => `${r.method} ${r.path}`), [`PUT /repos/${ORG}/anything-llm/actions/permissions`, `PUT /repos/${ORG}/aura/actions/permissions`]);
  assert.equal(s.opened.length, opened, 'no browser');
});

test('.env lines survive, empty keys are filled in place, and set keys are kept unless asked', async () => {
  const dir = tempDir();
  const path = join(dir, '.env');
  writeFileSync(path, '# a comment\nOPENAI_API_KEY=keep-me\nGITHUB_APP_ID=\nDEMO_ORG=old\n');
  const first = updateEnvFile(path, { GITHUB_APP_ID: '1', DEMO_ORG: 'new', OTHER: 'x' });
  assert.deepEqual(first, { written: ['GITHUB_APP_ID', 'OTHER'], kept: ['DEMO_ORG'] });
  assert.equal(readFileSync(path, 'utf8'), '# a comment\nOPENAI_API_KEY=keep-me\nGITHUB_APP_ID=1\nDEMO_ORG=old\nOTHER=x\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  updateEnvFile(path, { DEMO_ORG: 'new' }, { overwrite: true });
  assert.match(readFileSync(path, 'utf8'), /^DEMO_ORG=new$/m);
});

test('a different DEMO_ORG already in .env is refused', async () => {
  const s = await scene();
  writeFileSync(join(s.root, '.env'), 'DEMO_ORG=another-org\n');
  await assert.rejects(runSetup(s.options, s.deps), /already says another-org/);
  assert.equal(s.fake.requests.length, 0);
});

test('not logged in to gh says how, and waits', async () => {
  const s = await scene();
  await assert.rejects(runSetup(s.options, { ...s.deps, ghToken: async () => null }), (e: unknown) => {
    assert.ok(e instanceof NeedsSetupError);
    assert.match(e.message, /gh auth login/);
    return true;
  });
});

test('an org that does not exist gets the creation URL', async () => {
  const s = await scene({ orgExists: false });
  await assert.rejects(runSetup(s.options, s.deps), /https:\/\/github\.com\/account\/organizations\/new/);
});

test('a person who is not an admin is told, with the org named', async () => {
  const s = await scene({ personRole: 'member' });
  await assert.rejects(runSetup(s.options, s.deps), /admin.*keepup-demo/s);
  assert.equal(s.fake.writeRequests().length, 0);
});

test('orgs in KEEPUP_NOT_DEMO_ORGS and upstream owners are refused, even with --force', async () => {
  for (const org of ['Acme-Corp', 'acme-corp', 'Other-Org', 'mezmo', 'Mintplex-Labs']) {
    const s = await scene({}, {}, { org, force: true });
    const deps = { ...s.deps, env: { ...s.deps.env, KEEPUP_NOT_DEMO_ORGS: 'acme-corp, other-org' } };
    await assert.rejects(runSetup(s.options, deps), SetupRefused);
    assert.equal(s.fake.requests.length, 0, org);
  }
});

test('an org with unrelated repos is refused unless --force', async () => {
  const s = await scene({ orgRepos: ['payroll', 'keepup-notes'] });
  await assert.rejects(runSetup(s.options, s.deps), /payroll/);
  assert.equal(s.fake.writeRequests().length, 0);
  const forced = await scene({ orgRepos: ['payroll'] }, {}, { force: true });
  await runSetup(forced.options, forced.deps);
  assert.equal(forced.fake.registeredApps, 1);
});

test('forks wait until ready, and a slow one still gets configured', async () => {
  const s = await scene();
  const up = s.fake.repo('mezmo', 'aura');
  if (up) up.notReadyPolls = 3;
  await runSetup(s.options, s.deps);
  assert.equal(s.fake.repo(ORG, 'aura')?.hasIssues, true);
});

test('a fork that never gets ready gives up within its bound', async () => {
  const s = await scene();
  const up = s.fake.repo('mezmo', 'aura');
  if (up) up.notReadyPolls = 1_000_000;
  let clock = 0;
  await assert.rejects(runSetup(s.options, { ...s.deps, forkTimeoutMs: 10, sleep: async () => { clock += 1; }, nowMs: () => clock }), /mezmo\/aura.*isn't ready/s);
});

test('an existing repo in the org that is not a fork of the upstream is refused', async () => {
  const s = await scene();
  s.fake.addRepo(ORG, 'aura', repoFixture().bare);
  await assert.rejects(runSetup(s.options, s.deps), /keepup-demo\/aura already exists and isn't a fork of mezmo\/aura/);
});

test('every base commit is checked on the fork, and a missing one is said loudly', async () => {
  const s = await scene();
  const fix = repoFixture();
  installSpec(s.root, fix);
  installSpec(s.root, fix, { labDir: 'lab/02-x', overrides: { id: '02', baseCommit: 'b'.repeat(40), spec: 'docs/prs/02.md' } });
  const result = await runSetup(s.options, s.deps);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /b{40}/);
  assert.ok(s.lines.some((l) => /DOES NOT RESOLVE/.test(l)), s.lines.join('\n'));
});

test('setup prints the Actions page as a final step, until a run proves the gate is open', async () => {
  const s = await scene();
  const first = await runSetup(s.options, s.deps);
  assert.ok(first.manual.some((m) => m.includes(`https://github.com/${ORG}/anything-llm/actions`)), first.manual.join('\n'));
  assert.ok(s.lines.some((l) => l.includes(`https://github.com/${ORG}/anything-llm/actions`)));
  const fork = s.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  await registerByDefaultBranchPush(fork);
  assert.ok(fork.workflows.every((w) => w.state === 'active'), 'a default-branch push reads as active with the gate still closed');
  const stillClosed = await runSetup(s.options, s.deps);
  assert.ok(stillClosed.manual.some((m) => m.includes('anything-llm/actions')), '`active` proves nothing');
  fork.runs = [{ id: 1, name: 't', path: '.github/workflows/run-tests.yaml', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), html_url: 'https://github.com/x', run_number: 1, created_at: '2026-11-01T00:00:00Z' }];
  const proven = await runSetup(s.options, s.deps);
  assert.ok(!proven.manual.some((m) => m.includes('anything-llm/actions')), 'a run does prove it');
});

test('setup asks the API to enable Actions every time, on the fork that reports it is on already', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const puts = s.fake.requests.filter((r) => r.method === 'PUT' && r.path === `/repos/${ORG}/aura/actions/permissions`);
  assert.deepEqual(puts.map((r) => r.body), [{ enabled: true, allowed_actions: 'all' }]);
  assert.equal(s.fake.repo(ORG, 'aura')?.gateOpen, false, 'the fake assumes it does not open the gate, since nobody has confirmed that it does');
});

test('a workflow that registered later gets switched off, and the allowlist stays on', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const fork = s.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  await pressActionsButton(fork);
  await runSetup(s.options, s.deps);
  assert.deepEqual(fork.workflows.map((w) => [w.path.split('/').pop(), w.state]).sort(), [
    ['cla.yml', 'disabled_manually'], ['docker.yaml', 'disabled_manually'], ['lint.yaml', 'active'], ['metrics.yml', 'disabled_manually'], ['run-tests.yaml', 'active'],
  ]);
});

test('deleted and dynamic workflows are left alone', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const fork = s.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.workflows = [{ id: 5, name: 'gone', path: '.github/workflows/gone.yaml', state: 'deleted' }, { id: 6, name: 'dep', path: 'dynamic/dependabot/dependabot-updates', state: 'active' }];
  await runSetup(s.options, s.deps);
  assert.deepEqual(s.fake.requests.filter((r) => /\/actions\/workflows\/[56]\//.test(r.path)), []);
});

test('a workflow GitHub refuses to switch does not stop setup: it is a best-effort pass', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const fork = s.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.workflows = [{ id: 7, name: 'x', path: '.github/workflows/x.yml', state: 'active' }];
  s.fake.denyWorkflowSwitch = true;
  const result = await runSetup(s.options, s.deps);
  assert.deepEqual(result.problems, []);
  assert.equal(fork.workflows[0].state, 'active');
});

test('a key path written with ~ counts as registered', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  assert.equal(s.fake.registeredApps, 1);
  const home = tempDir('keepup-home-');
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(expandHome('~/x'), join(home, 'x'));
    assert.equal(expandHome('/a/b'), '/a/b');
    const env = readFileSync(join(s.root, '.env'), 'utf8');
    const keyPath = env.match(/^GITHUB_APP_PRIVATE_KEY_PATH=(.*)$/m)?.[1] ?? '';
    copyFileSync(keyPath, join(home, 'moved.pem'));
    writeFileSync(join(s.root, '.env'), env.replace(keyPath, '~/moved.pem'));
    await runSetup(s.options, s.deps);
    assert.equal(s.fake.registeredApps, 1, 'found through ~, so nothing new was registered');
  } finally {
    process.env.HOME = realHome;
  }
});

test('forks with Actions off get it on', async () => {
  const s = await scene();
  await runSetup(s.options, { ...s.deps, log: () => undefined });
  const fork = s.fake.repo(ORG, 'anything-llm');
  if (fork) fork.actionsEnabled = false;
  await runSetup(s.options, s.deps);
  assert.equal(fork?.actionsEnabled, true);
});

test('the installation is found by polling, since the App has no redirect to wait for', async () => {
  const s = await scene({}, { install: false });
  const browser = s.deps.openBrowser;
  const deps = { ...s.deps, openBrowser: async (url: string) => {
    await browser(url);
    if (url.includes('/installations/new')) s.fake.installedOnOrg = true;
  } };
  await runSetup(s.options, deps);
  assert.match(readFileSync(join(s.root, '.env'), 'utf8'), /^GITHUB_APP_INSTALLATION_ID=777$/m);
});

test('an installation that misses a fork is reported', async () => {
  const s = await scene();
  const original = s.fake.repos.get(`${ORG}/aura`.toLowerCase());
  assert.equal(original, undefined);
  s.fake.hideFromInstallation = 'aura';
  const result = await runSetup(s.options, s.deps);
  assert.ok(result.problems.some((p) => /doesn't cover.*aura/.test(p)), result.problems.join('\n'));
});

test('the only upstream write in all of setup is the fork call, into the demo org', async () => {
  const s = await scene();
  await runSetup(s.options, s.deps);
  const upstream = s.fake.requests.filter((r) => /^\/repos\/(mintplex-labs|mezmo)\//i.test(r.path));
  assert.deepEqual(upstream.map((r) => [r.method, r.path, (r.body as { organization: string; default_branch_only: boolean })]), [
    ['POST', '/repos/Mintplex-Labs/anything-llm/forks', { organization: ORG, default_branch_only: false }],
    ['POST', '/repos/mezmo/aura/forks', { organization: ORG, default_branch_only: false }],
  ]);
});

test('the browser never sees a secret: the start page holds only the manifest and state', async () => {
  const s = await scene();
  let page = '';
  const browser = s.deps.openBrowser;
  const deps = { ...s.deps, openBrowser: async (url: string) => {
    if (url.endsWith('/start')) page = await (await fetch(url)).text();
    await browser(url);
  } };
  await runSetup(s.options, deps);
  assert.ok(page.includes('document.forms[0].submit()'));
  assert.ok(!page.includes(s.fake.options.personToken));
  assert.match(page, /settings\/apps\/new\?state=[0-9a-f]{32}/);
});
