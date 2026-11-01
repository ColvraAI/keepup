// What go looks at before it starts, what it says about a failed lab, and what status says next.
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPlan, runGo, type GoDeps, type GoStep } from '../src/go.ts';
import { runCommand } from '../src/go-runner.ts';
import { startNotes } from '../src/go-plan.ts';
import { failedLabLines } from '../src/go-checks.ts';
import { updateObjects } from '../src/objects.ts';
import { registerSecret } from '../src/secrets.ts';
import { computeStatus, formatStatus } from '../src/status.ts';
import { installSpec, MEASURED_RESULT, NOT_RUN_RESULT, ORG, recordFor, repoFixture, specJson, tempDir, writeText } from './world.ts';

function env(extra: Record<string, string> = {}): Record<string, string> {
  const key = join(tempDir(), 'k.pem');
  writeText(key, 'x');
  return { DEMO_ORG: ORG, GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'keepup-ai', GITHUB_APP_PRIVATE_KEY_PATH: key, GITHUB_APP_INSTALLATION_ID: '2', ...extra };
}

function install(root: string, id: string, date: string, result: string | null, fork = 'anything-llm'): void {
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(root, fix, { labDir: `lab/${id}-x`, result, overrides: { id, spec: `docs/prs/${id}.md`, fork, upstream: fork === 'aura' ? 'mezmo/aura' : 'Mintplex-Labs/anything-llm', branch: `keepup/${date}-${id}`, stages: [{ ...stages[0], date, title: 'Add it · {{lab.title_number}}', titleUnmeasured: 'Add it' }] } });
  writeText(join(root, `lab/${id}-x/run.ts`), '');
}

const line = (s: GoStep) => `npm run ${s.script}${s.args.length ? ` -- ${s.args.join(' ')}` : ''}`;

function deps(root: string, values: Record<string, string>, extra: Partial<GoDeps> = {}, code: (s: GoStep) => number = () => 0) {
  const calls: GoStep[] = [];
  const lines: string[] = [];
  const d: GoDeps = { root, env: values, log: (l) => lines.push(l), runner: async (s) => { calls.push(s); return code(s); }, ...extra };
  return { d, lines, names: () => calls.map(line) };
}

test('Docker down: go says so first, holds the labs, and carries on with the rest', async () => {
  const root = tempDir();
  install(root, '06', '2026-09-22', NOT_RUN_RESULT);
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  const { d, lines, names } = deps(root, env({ OPENAI_API_KEY: 'x' }), { dockerProblem: async () => "Docker isn't answering, start it." });
  assert.equal(await runGo({}, d), 3);
  assert.match(lines[0], /Docker isn't answering/);
  assert.ok(!names().some((n) => n.startsWith('npm run lab')), names().join('\n'));
  assert.ok(lines.some((l) => /hold\s+npm run lab -- 06: Docker isn't answering/.test(l)), lines.join('\n'));
  assert.ok(names().includes('npm run pr -- 02 --all'));
  assert.ok(!lines.some((l) => /needs OPENAI_API_KEY/.test(l)), `the key is set, so it isn't the cause:\n${lines.join('\n')}`);
});

test('Docker is only asked about when a lab would run', async () => {
  const root = tempDir();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  let asked = 0;
  await runGo({}, deps(root, env(), { dockerProblem: async () => { asked += 1; return null; } }).d);
  assert.equal(asked, 0);
});

test('the start note leaves out a pull request whose lab runs in this go with what it needs', () => {
  const root = tempDir();
  install(root, '02', '2026-09-01', NOT_RUN_RESULT);
  const values = env({ OPENAI_API_KEY: 'x' });
  const plan = buildPlan(root, values, {});
  assert.deepEqual(startNotes(plan, values).filter((n) => n.startsWith("Can't open")), []);
  assert.equal(startNotes(plan, values, true).filter((n) => n.startsWith("Can't open")).length, 1, 'with Docker down it really can not');
  assert.match(startNotes(buildPlan(root, env(), {}), env())[0], /Can't open yet: PR 02: .*needs OPENAI_API_KEY/);
});

test('status says a named key is set now, rather than asking for it again', async () => {
  const root = tempDir();
  install(root, '02', '2026-09-01', NOT_RUN_RESULT);
  assert.match(formatStatus(await computeStatus({ root, env: env({ OPENAI_API_KEY: 'x' }) })), /needs OPENAI_API_KEY \(set now, so the next npm run go runs it\)/);
  assert.doesNotMatch(formatStatus(await computeStatus({ root, env: env() })), /set now/);
});

test('a lab that fails shows the end of the log it wrote in this run, with secrets gone', async () => {
  const root = tempDir();
  install(root, '06', '2026-09-22', NOT_RUN_RESULT);
  const canary = 'canary-in-a-sandbox-log-314159';
  registerSecret(canary);
  const log = join(root, 'lab/.work/06-x/run/sandbox.log');
  const { d, lines } = deps(root, env(), {}, (s) => {
    if (s.script !== 'lab') return 0;
    writeText(log, `first\nCannot connect to the Docker daemon ${canary}\n`);
    return 1;
  });
  await runGo({}, d);
  const said = lines.join('\n');
  assert.match(said, /The end of lab\/\.work\/06-x\/run\/sandbox\.log/);
  assert.match(said, /Cannot connect to the Docker daemon \[redacted\]/);
  assert.ok(!said.includes(canary));
  assert.deepEqual(failedLabLines(root, '06', Date.now() + 60_000), [], 'an older log says nothing about this run');
});

test('a fork the installation does not cover is held, with where to add it, and its brief still writes its files', async () => {
  const root = tempDir();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  install(root, '05', '2026-09-02', MEASURED_RESULT, 'aura');
  const { d, lines, names } = deps(root, env(), { coveredForks: async () => ['aura'] });
  assert.equal(await runGo({}, d), 3);
  assert.ok(!names().includes('npm run pr -- 02 --all'));
  assert.ok(names().includes('npm run pr -- 05 --all'));
  assert.ok(names().includes('npm run brief -- anything-llm 2026-10-26 --dry-run'), names().join('\n'));
  assert.ok(names().includes('npm run brief -- aura 2026-10-26'));
  assert.match(lines[0], /can't reach keepup-demo\/anything-llm.*settings\/installations\/2/);
});

test('go asks about the installation only once setup is done, and not knowing holds nothing', async () => {
  const root = tempDir();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  let asked = 0;
  await runGo({}, deps(root, {}, { coveredForks: async () => { asked += 1; return []; } }).d);
  assert.equal(asked, 0);
  const unknown = deps(root, env(), { coveredForks: async () => null });
  await runGo({}, unknown.d);
  assert.ok(unknown.names().includes('npm run pr -- 02 --all'));
});

test('a patch regenerated under the same subject stops go saying all stages applied, and untick status', async () => {
  const root = tempDir();
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '06': recordFor(root, '06') } }));
  const values = env();
  const step = () => buildPlan(root, values, {}).find((s) => s.phase === 'prs' && s.args[0] === '06');
  assert.equal(step()?.skip, 'all stages applied');
  const patch = join(root, 'lab/06-x/patches/0001.patch');
  const { readFileSync } = await import('node:fs');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('gpt-6-sol', 'gpt-6-sol-changed'));
  assert.equal(step()?.skip, null, 'running the step is what refuses loudly');
  const check = (await computeStatus({ root, env: values })).extras.find((c) => c.label === 'PR 06');
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? '', /a patch on disk isn't what went to the fork/);
});

for (const state of ['failure', 'neutral']) {
  test(`CI ${state} names the run and the one command that fires another, not go`, async () => {
    const root = tempDir();
    install(root, '02', '2026-09-01', MEASURED_RESULT);
    updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02', { ci: { state, url: 'https://github.com/x/actions/runs/9' } }) } }));
    const status = await computeStatus({ root, env: env() });
    assert.match(status.next.command, /CI run of PR 02: https:\/\/github\.com\/x\/actions\/runs\/9.*npm run pr -- 02 --rerun-ci/);
    assert.match(status.next.why, /only rereads a finished run/);
    assert.match(formatStatus(status), new RegExp(`CI ${state} \\(https://github\\.com/x/actions/runs/9\\)`));
  });
}

test('a stopped step counts as stopped only once all it started has finished cleaning up', async () => {
  const dir = tempDir();
  const marker = join(dir, 'cleaned');
  // The first process ends at once, and what it started takes a moment to clean up, as sandbox.sh does around docker kill.
  const script = `(trap 'sleep 0.3; echo done > "${marker}"; exit 0' TERM; while :; do sleep 0.02; done) & trap 'exit 0' TERM; wait`;
  const { existsSync } = await import('node:fs');
  const run = runCommand('bash', ['-c', script], { cwd: dir, limitMs: 200, log: () => undefined, label: 'x', killAfterMs: 5000 });
  assert.equal(await run, 1);
  assert.ok(existsSync(marker), 'its cleanup finished first');
});

test('something that ignores the stop is killed when its time is up', async () => {
  const started = Date.now();
  const code = await runCommand('bash', ['-c', "trap '' TERM; while :; do sleep 0.02; done"], { cwd: tempDir(), limitMs: 50, log: () => undefined, label: 'x', killAfterMs: 200 });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 5000);
});
