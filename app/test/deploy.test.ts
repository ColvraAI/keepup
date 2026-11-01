import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/deploy.ts';
import { NeedsSetupError } from '../src/config.ts';
import { realRunVercel, realStatusOf, runDeploy, VERCEL_CLI, type DeployDeps } from '../src/deploy.ts';
import { tempDir } from './world.ts';

const TOKEN = 'canary-vercel-token-0123';

function deps(over: Partial<DeployDeps> = {}): { d: DeployDeps; calls: { args: string[]; token: string; cwd: string }[]; root: string } {
  const root = tempDir();
  mkdirSync(join(root, 'site/out'), { recursive: true });
  const calls: { args: string[]; token: string; cwd: string }[] = [];
  return {
    root, calls,
    d: {
      root, env: { VERCEL_TOKEN: TOKEN }, log: () => undefined,
      runVercel: async (args, token, cwd) => { calls.push({ args, token, cwd }); return 'https://keepup-abc.vercel.app\n'; },
      statusOf: async () => 200,
      ...over,
    },
  };
}

const siteJson = (root: string) => join(root, 'data/site.json');

test('it deploys the built site, keeps the token out of the arguments, and records the address that answered', async () => {
  const { d, calls, root } = deps();
  const { url } = await runDeploy(d);
  assert.equal(url, 'https://keepup-abc.vercel.app');
  assert.deepEqual(calls, [{ args: ['deploy', 'site/out', '--prod', '--yes'], token: TOKEN, cwd: root }]);
  assert.deepEqual(JSON.parse(readFileSync(siteJson(root), 'utf8')), { url });
  assert.match(VERCEL_CLI, /^vercel@\d+\.\d+\.\d+$/, 'an exact version');
});

test('an address that does not answer is not written down', async () => {
  const { d, root } = deps({ statusOf: async () => 401 });
  await assert.rejects(runDeploy(d), /answers 401, so data\/site\.json wasn't written/);
  assert.ok(!existsSync(siteJson(root)));
});

test('no address in the output is an error, not a guess', async () => {
  const { d, root } = deps({ runVercel: async () => 'something else\n' });
  await assert.rejects(runDeploy(d), /printed no deployment address/);
  assert.ok(!existsSync(siteJson(root)));
});

test('a missing token or a missing build waits, saying what to do, and calls nothing', async () => {
  const noToken = deps();
  await assert.rejects(runDeploy({ ...noToken.d, env: {} }), (e: unknown) => e instanceof NeedsSetupError && /VERCEL_TOKEN.*vercel\.com\/account\/tokens/.test(e.message));
  assert.deepEqual(noToken.calls, []);
  const noBuild = deps();
  const empty = tempDir();
  await assert.rejects(runDeploy({ ...noBuild.d, root: empty }), (e: unknown) => e instanceof NeedsSetupError && /npm --prefix site run build/.test(e.message));
  assert.deepEqual(noBuild.calls, []);
});

test('the command exits 3 waiting, 2 on bad usage and 0 once done, and the token stays out of what it prints', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const { d, root } = deps();
  assert.equal(await main([], { root: tempDir(), env: {}, io }), 3);
  assert.equal(await main(['extra'], { root, env: {}, io }), 2);
  assert.equal(await main([], { root, env: { VERCEL_TOKEN: TOKEN }, io }, { runVercel: d.runVercel, statusOf: d.statusOf }), 0);
  assert.ok(![...out, ...err].join('\n').includes(TOKEN));
});

/** An npx first on PATH that records exactly what the real function hands it. */
function standInNpx(script: string): { dir: string; argv: string; env: string; restore: () => void } {
  const dir = tempDir('keepup-npx-');
  const argv = join(dir, 'argv');
  const env = join(dir, 'env');
  writeFileSync(join(dir, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\nenv > '${env}'\n${script}\n`);
  chmodSync(join(dir, 'npx'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  return { dir, argv, env, restore: () => { process.env.PATH = path; } };
}

test('the real runner passes the token in the environment only, and nothing else of ours', async () => {
  const npx = standInNpx("echo 'https://keepup-abc.vercel.app'");
  process.env.OPENAI_API_KEY = 'canary-openai-in-parent-env-0123';
  try {
    const out = await realRunVercel(['deploy', 'site/out', '--prod', '--yes'], TOKEN, tempDir());
    assert.equal(out.trim(), 'https://keepup-abc.vercel.app');
    assert.deepEqual(readFileSync(npx.argv, 'utf8').trim().split('\n'), ['--yes', VERCEL_CLI, 'deploy', 'site/out', '--prod', '--yes']);
    const env = readFileSync(npx.env, 'utf8');
    assert.match(env, new RegExp(`^VERCEL_TOKEN=${TOKEN}$`, 'm'));
    assert.ok(!readFileSync(npx.argv, 'utf8').includes(TOKEN));
    assert.ok(!env.includes('canary-openai-in-parent-env-0123'), 'the CLI gets no other key');
  } finally {
    delete process.env.OPENAI_API_KEY;
    npx.restore();
  }
});

test('a CLI that fails says so, with no token in the message', async () => {
  const npx = standInNpx('exit 7');
  try {
    await assert.rejects(realRunVercel(['deploy'], TOKEN, tempDir()), (e: unknown) => e instanceof Error && /failed with exit 7/.test(e.message) && !e.message.includes(TOKEN));
  } finally {
    npx.restore();
  }
});

test('a CLI that can\'t be found says so', async () => {
  const path = process.env.PATH;
  process.env.PATH = tempDir();
  try {
    await assert.rejects(realRunVercel(['deploy'], TOKEN, tempDir()), /Couldn't run the Vercel CLI/);
  } finally {
    process.env.PATH = path;
  }
});

test('the status check reads what the address really answers', async () => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  assert.equal(await realStatusOf(`http://127.0.0.1:${port}/`), 401);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
