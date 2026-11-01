import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeChange } from '../../src/change.ts';
import type { Llm } from '../../src/llm.ts';
import type { Finding } from '../../src/run-shape.ts';
import { appIsConfigured, openLivePr, SETUP_COMMAND } from '../src/live-pr.ts';
import { git } from './fake-repos.ts';
import { createWorld, ORG, UPSTREAM, upstreamRequests, type World } from './world.ts';

const FILE = 'server/utils/helpers/customModels.js';

const llm = (search: string, replace: string): Llm => ({
  maxUsd: 0.5,
  ask: async <T>() => ({ kind: 'swap', title: 'Move the default model', summary: 'Moves the default.', edits: [{ file: FILE, search, replace, why: '' }], steps: [] }) as T,
  usage: () => ({ model: 'm', input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, usd: 0, price_source: 'x', calls: 1, replayed_calls: 0, replayed_usd: 0 }),
});

const finding = (why = 'The default is going away.'): Finding => ({
  rank: 1, title: 'Your default model is going away', effect: ['keeps working'], proof: 'vendor claim', effort: 'Hours', where: [{ file: FILE, line: 1, text: '' }], why,
  options: [], sources: ['https://platform.example.com/changelog'], lever: null, pr: null,
});

async function changeIn(w: World, repo: string, why?: string): Promise<{ base: string; id: string }> {
  const line = git(w.fix.bare, 'show', `${w.fix.baseCommit}:${FILE}`).split('\n').find((text) => text.trim()) as string;
  const base = join(w.dir, 'live');
  mkdirSync(base, { recursive: true });
  const result = await makeChange({ path: w.fix.bare, run: { repo, commit: w.fix.baseCommit, findings: [finding(why)] }, rank: 1, llm: llm(line, `// keepup\n${line}`), base, now: new Date('2026-11-01T09:00:00Z') });
  assert.equal(result.refused, undefined);
  return { base, id: result.id };
}

test('opens on the fork through the same code as the App, and says keepup wrote it and a person merges', async () => {
  const w = await createWorld();
  const { base, id } = await changeIn(w, UPSTREAM);
  const opened = await openLivePr({ root: w.root, base, changeId: id, env: w.env, sleep: async () => undefined, personToken: async () => { throw new Error('no fork was needed'); } });
  assert.equal(opened.state, 'opened', JSON.stringify(opened));
  const pull = w.fake.repo(ORG, 'anything-llm')?.pulls[0];
  assert.equal(pull?.user, 'keepup[bot]');
  assert.match(pull?.body ?? '', /keepup wrote this change/);
  assert.match(pull?.body ?? '', /A person merges/);
  assert.match(pull?.body ?? '', /did not run the repo's tests/);
  assert.ok(!/simulated|replay on a fork/.test(pull?.body ?? ''));
  assert.deepEqual(upstreamRequests(w.fake), []);
  assert.ok(existsSync(join(w.root, 'data', 'live-prs', id, 'pr.json')));
});

test('with no App it says the exact command and writes nothing', async () => {
  const w = await createWorld();
  const { base, id } = await changeIn(w, UPSTREAM);
  const env = { ...w.env, GITHUB_APP_ID: undefined };
  assert.equal(appIsConfigured(env, w.root), false);
  const result = await openLivePr({ root: w.root, base, changeId: id, env });
  assert.equal(result.state, 'needs_app');
  assert.equal(result.state === 'needs_app' ? result.command : '', SETUP_COMMAND);
  assert.equal(SETUP_COMMAND, 'npm run setup -- --org <your-org> --force');
  assert.equal(existsSync(join(w.root, 'data', 'live-prs')), false);
  assert.deepEqual(w.fake.writeRequests(), []);
});

test('a repo with no fork gets one in the demo org on this click, and the only call naming it is that fork', async () => {
  const w = await createWorld();
  w.fake.addRepo('acme', 'tool', w.fix.bare);
  const { base, id } = await changeIn(w, 'acme/tool');
  const opened = await openLivePr({ root: w.root, base, changeId: id, env: w.env, sleep: async () => undefined, personToken: async () => w.fake.options.personToken ?? null });
  assert.equal(opened.state, 'opened', JSON.stringify(opened));
  const toAcme = w.fake.requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/repos/acme/'));
  assert.deepEqual(toAcme.map((request) => [request.method, request.path, (request.body as { organization?: string }).organization]), [['POST', '/repos/acme/tool/forks', ORG]]);
  assert.equal(w.fake.repo('acme', 'tool')?.pulls.length, 0);
  assert.equal(w.fake.repo(ORG, 'tool')?.pulls.length, 1);
});

test('text that references someone else’s issue is refused before anything is sent', async () => {
  const w = await createWorld();
  const { base, id } = await changeIn(w, UPSTREAM, `As seen in ${UPSTREAM}#12, it breaks.`);
  const result = await openLivePr({ root: w.root, base, changeId: id, env: w.env, sleep: async () => undefined });
  assert.equal(result.state, 'refused');
  assert.match(result.state === 'refused' ? result.reason : '', /references/);
  assert.deepEqual(w.fake.writeRequests().filter((request) => !request.path.endsWith('/access_tokens')), []);
});

test('the existing guard still refuses a fork it has not been told about', async () => {
  const { assertForkRequest } = await import('../src/guard.ts');
  assert.throws(() => assertForkRequest('acme', 'tool', ORG, { DEMO_ORG: ORG }), /not one of the demo/);
  assert.throws(() => assertForkRequest('acme', 'tool', 'elsewhere', { DEMO_ORG: ORG, KEEPUP_FORK_ONCE: 'acme/tool' }), /anywhere but/);
  assert.throws(() => assertForkRequest('acme', 'other', ORG, { DEMO_ORG: ORG, KEEPUP_FORK_ONCE: 'acme/tool' }), /not one of the demo/);
});

test('a change with no patch has nothing to open', async () => {
  const w = await createWorld();
  const result = await openLivePr({ root: w.root, base: join(w.dir, 'nowhere'), changeId: 'change-0000000-1-000000', env: w.env });
  assert.equal(result.state, 'refused');
  assert.ok(!existsSync(join(w.root, 'data', 'live-prs')));
});

test('a change whose diff holds something shaped like a key is refused before anything is written or sent', async () => {
  const w = await createWorld();
  const base = join(w.dir, 'changes');
  const id = 'change-0000000-1-111111';
  mkdirSync(join(base, id), { recursive: true });
  writeFileSync(join(base, id, 'change.json'), JSON.stringify({ id, repo: 'a/b', publish_block: 'A line in this diff holds a key.' }));
  writeFileSync(join(base, id, 'finding.json'), '{}');
  writeFileSync(join(base, id, 'change.patch'), ' KEY = "[masked]"\n');
  const result = await openLivePr({ root: w.root, base, changeId: id, env: w.env });
  assert.deepEqual(result, { state: 'refused', reason: 'A line in this diff holds a key.' });
  assert.ok(!existsSync(join(w.root, 'data', 'live-prs')));
});
