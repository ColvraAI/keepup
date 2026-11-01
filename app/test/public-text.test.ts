// Everything that leaves for a public repo gets one last look: nothing secret, nothing on someone else's timeline.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reportError } from '../src/cli/shared.ts';
import { runBrief } from '../src/brief.ts';
import { assertPublicText } from '../src/guard.ts';
import { createPrDeps, openOrUpdate } from '../src/pr.ts';
import { assertPublicSafe, PublicTextError, registerSecret } from '../src/secrets.ts';
import { findSpec } from '../src/specs.ts';
import { world } from './pr-world.ts';
import { installDb, installTimeline, MEASURED_RESULT, ORG } from './world.ts';

const SHAPED = 'sk-canary-in-lab-table-0123456789';
const REGISTERED = 'canary-only-known-at-runtime-77';

const hides = (e: unknown, value: string) => e instanceof Error && !e.message.includes(value);

test('assertPublicSafe names what it refused and never the value', () => {
  assert.doesNotThrow(() => assertPublicSafe('nothing here', 'A title'));
  assert.throws(() => assertPublicSafe(`x ${SHAPED}`, 'A title'), (e: unknown) => e instanceof PublicTextError && /A title holds a secret/.test(e.message) && hides(e, SHAPED));
  registerSecret(REGISTERED);
  assert.throws(() => assertPublicSafe(`x ${REGISTERED}`, 'A body'), (e: unknown) => e instanceof PublicTextError && hides(e, REGISTERED));
});

test('a refusal exits 1, and says nothing of the value', () => {
  const lines: string[] = [];
  const code = reportError(new PublicTextError('A body holds a secret'), { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join(), /A body holds a secret/);
});

for (const [name, value] of [['a shaped value', SHAPED], ['a registered value', REGISTERED]] as const) {
  test(`${name} in the lab's table stops the pull request before any write`, async () => {
    registerSecret(REGISTERED);
    const w = await world({}, MEASURED_RESULT.replace('| models answering | 0 | 3 |', `| models answering | 0 | ${value} |`));
    await assert.rejects(w.run(), (e: unknown) => e instanceof PublicTextError && hides(e, value));
    assert.deepEqual(w.fake.writeRequests(), [], 'no branch, no commit, no pull request');
    assert.equal(w.fake.pushes().length, 0);
    assert.ok(!JSON.stringify(w.fake.requests).includes(value));
  });
}

test('a title from the lab with a secret in it is refused too', async () => {
  const w = await world({}, MEASURED_RESULT.replace('answers on 3 of 3 new models', SHAPED));
  await assert.rejects(w.run(), /The title of PR 06 holds a secret/);
  assert.deepEqual(w.fake.writeRequests(), []);
  assert.equal(w.fake.pushes().length, 0);
});

test('a stage comment known to be secret only at runtime is not posted', async () => {
  const w = await world({});
  await w.run();
  const spec = join(w.root, 'lab/06-models/pr.json');
  const json = JSON.parse(readFileSync(spec, 'utf8')) as { stages: { comment: string | null }[] };
  const canary = 'canary-in-a-comment-at-runtime-55';
  json.stages[1].comment = `Updated: ${canary}`;
  writeFileSync(spec, JSON.stringify(json));
  registerSecret(canary);
  const pushes = w.fake.pushes().length;
  await assert.rejects(w.run({ all: true }), (e: unknown) => e instanceof PublicTextError && hides(e, canary));
  assert.ok(!JSON.stringify(w.fake.requests).includes(canary));
  assert.equal(w.fake.pushes().length, pushes, 'its commit is not pushed either');
});

test('a patch whose secret is only known at runtime is not pushed', async () => {
  const w = await world({});
  const canary = 'canary-in-a-patch-at-runtime-66';
  const patch = join(w.root, 'lab/06-models/patches/0001.patch');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('\n---\n', `\n${canary}\n---\n`));
  const spec = findSpec('06', w.root);
  registerSecret(canary);
  const deps = createPrDeps(w.root, w.env, { sleep: async () => undefined });
  await assert.rejects(openOrUpdate(spec, {}, deps), (e: unknown) => e instanceof PublicTextError && /The patch 0001\.patch/.test(e.message) && hides(e, canary));
  assert.equal(w.fake.pushes().length, 0);
  assert.deepEqual(w.fake.writeRequests(), []);
});

test('a lab result that links to someone else\'s pull request does not reach the body', async () => {
  const w = await world({}, MEASURED_RESULT.replace('| models answering | 0 | 3 |', '| see https://github.com/mezmo/aura/pull/1 | 0 | 3 |'));
  await assert.rejects(w.run(), /The body of PR 06 references https:\/\/github\.com\/mezmo\/aura\/pull\/1/);
  assert.deepEqual(w.fake.writeRequests(), []);
});

test('links to the demo org itself are fine, in any case', () => {
  assert.doesNotThrow(() => assertPublicText(`[#3](https://github.com/${ORG}/aura/pull/3)`, 'A brief', ORG));
  assert.doesNotThrow(() => assertPublicText(`[#3](https://github.com/${ORG.toUpperCase()}/aura/pull/3)`, 'A brief', ORG));
  assert.throws(() => assertPublicText('https://github.com/other-org/aura/pull/3', 'A brief', ORG), /references/);
});

function briefWorldEvent(summary: string, source: string) {
  return { date: '2026-10-28', thing: 'A thing', kind: 'model', source_url: source, keepup: { action: 'held_back', summary } };
}

const BRIEF_CASES: [string, ReturnType<typeof briefWorldEvent>, RegExp | null][] = [
  ['holding a secret is refused before any write', briefWorldEvent(SHAPED, 'https://example.test/x'), /The anything-llm brief holds a secret/],
  ['linking to someone else\'s pull request is refused before any write', briefWorldEvent('see https://github.com/mezmo/aura/pull/836', 'https://example.test/x'), /The anything-llm brief references https:\/\/github\.com\/mezmo\/aura\/pull\/836/],
  ['with neither goes out', briefWorldEvent('held', 'https://example.test/x'), null],
];

for (const [name, event, pattern] of BRIEF_CASES) {
  test(`the brief ${name}`, async () => {
    const w = await world({});
    installTimeline(w.root, [{ repo: 'Mintplex-Labs/anything-llm', events: [event] }, { repo: 'mezmo/aura', events: [] }]);
    installDb(w.root, 'npm', []);
    const deps = { root: w.root, env: w.env, now: () => new Date('2026-11-01T09:00:00Z'), log: () => undefined };
    if (pattern) await assert.rejects(runBrief({ repo: 'anything-llm', week: '2026-10-26' }, deps), pattern);
    else await runBrief({ repo: 'anything-llm', week: '2026-10-26' }, deps);
    assert.equal(w.fake.repo(ORG, 'anything-llm')?.threads.length, pattern ? 0 : 1);
    if (event.keepup.summary === SHAPED) assert.ok(!existsSync(join(w.root, 'data/weekly/anything-llm-2026-10-26.md')), 'no file for the site to publish either');
  });
}

test('a dry run refuses a secret too, and writes nothing', async () => {
  const w = await world({});
  installTimeline(w.root, [{ repo: 'Mintplex-Labs/anything-llm', events: [briefWorldEvent(SHAPED, 'https://example.test/x')] }, { repo: 'mezmo/aura', events: [] }]);
  installDb(w.root, 'npm', []);
  const deps = { root: w.root, env: w.env, now: () => new Date('2026-11-01T09:00:00Z'), log: () => undefined };
  await assert.rejects(runBrief({ repo: 'anything-llm', week: '2026-10-26', dryRun: true }, deps), /The anything-llm brief holds a secret/);
  assert.ok(!existsSync(join(w.root, 'data/weekly/anything-llm-2026-10-26.md')));
  assert.ok(!existsSync(join(w.root, 'data/weekly/anything-llm-2026-10-26.html')));
});

test('a secret on a later stage is refused on the default route, where preflight only reads the first stage', async () => {
  const w = await world({});
  await w.run({ all: true });
  const spec = join(w.root, 'lab/06-models/pr.json');
  const json = JSON.parse(readFileSync(spec, 'utf8')) as { stages: { whatShipped: string }[] };
  const canary = 'canary-in-a-later-stage-at-runtime-88';
  json.stages[1].whatShipped = `GPT-6.1 Sol shipped: ${canary}`;
  writeFileSync(spec, JSON.stringify(json));
  registerSecret(canary);
  const patches = () => w.fake.requests.filter((r) => r.method === 'PATCH').length;
  const before = patches();
  await assert.rejects(w.run(), (e: unknown) => e instanceof PublicTextError && /The body of PR 06 holds a secret/.test(e.message) && hides(e, canary));
  assert.equal(patches(), before, 'nothing was sent');
  assert.ok(!JSON.stringify(w.fake.requests).includes(canary));
});

test('the last look knows every shape the mask knows', () => {
  for (const text of ['AIzaSyA0123456789abcdefghijklmnopqrstu', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-0123456789-abcdefghij', 'hf_abcdefghijklmnopqrstuv', 'gsk_abcdefghijklmnopqrstuv', 'sk_live_abcdefghijklmnopqr', 'pcsk_abcdefghijklmnopqrstuv', 'postgres://user:pass@db.example.com/x', 'co = cohere.Client("0123456789abcdef0123456789abcdef01234567")']) {
    assert.throws(() => assertPublicSafe(text, 'The patch'), (e: unknown) => e instanceof PublicTextError && !e.message.includes(text), text);
  }
});
