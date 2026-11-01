// The morning's shape: a lab that takes hours waits at the end, Ctrl-C means stop, and a closed Actions gate
// stays closed across runs of go until a run proves otherwise.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { EXIT_INTERRUPTED, EXIT_STOPPED_AT_LIMIT, runGo, type GoDeps, type GoStep } from '../src/go.ts';
import { createNpmRunner, limitFor, runCommand } from '../src/go-runner.ts';
import { readObjects, updateObjects } from '../src/objects.ts';
import { computeStatus } from '../src/status.ts';
import { installSpec, MEASURED_RESULT, NOT_RUN_RESULT, ORG, recordFor, repoFixture, specJson, tempDir, writeMeasured, writeText } from './world.ts';

function env(): Record<string, string> {
  const key = join(tempDir(), 'k.pem');
  writeText(key, 'x');
  return { DEMO_ORG: ORG, GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'keepup-ai', GITHUB_APP_PRIVATE_KEY_PATH: key, GITHUB_APP_INSTALLATION_ID: '2' };
}

const line = (s: GoStep) => `npm run ${s.script}${s.args.length ? ` -- ${s.args.join(' ')}` : ''}`;

function install(root: string, id: string, date: string, result: string | null, fork = 'anything-llm'): void {
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(root, fix, {
    labDir: `lab/${id}-x`, result,
    overrides: { id, spec: `docs/prs/${id}.md`, fork, upstream: fork === 'aura' ? 'mezmo/aura' : 'Mintplex-Labs/anything-llm', branch: `keepup/${date}-${id}`, stages: [{ ...stages[0], date, title: 'Add it · {{lab.title_number}}', titleUnmeasured: 'Add it' }] },
  });
  writeText(join(root, `lab/${id}-x/run.ts`), '');
}

function deps(root: string, values: Record<string, string | undefined>, code: (step: GoStep) => number = () => 0) {
  const calls: GoStep[] = [];
  const lines: string[] = [];
  const d: GoDeps = { root, env: values, log: (l) => lines.push(l), runner: async (s) => { calls.push(s); return code(s); } };
  return { d, calls, lines, names: () => calls.map(line) };
}

test('the long lab runs after everything else, so nothing waits hours for it', async () => {
  const root = tempDir();
  install(root, '03', '2026-10-04', NOT_RUN_RESULT);
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  install(root, '01', '2026-10-06', NOT_RUN_RESULT);
  const { d, names } = deps(root, env());
  await runGo({}, d);
  const order = names();
  assert.ok(order.indexOf('npm run lab -- 01') < order.indexOf('npm run pr -- 06 --all'), 'a lab with a key still comes first');
  assert.ok(order.indexOf('npm run pr -- 06 --all') < order.indexOf('npm run lab -- 03'));
  assert.ok(order.indexOf('npm run brief -- aura 2026-10-26') < order.indexOf('npm run lab -- 03'));
  assert.equal(order.at(-1), 'npm run status');
  assert.ok(order.at(-2) === 'npm run lab -- 03', order.join('\n'));
});

test('--allow-unmeasured opens the long lab\'s pull request first, and its numbers go on when the lab ends', async () => {
  const root = tempDir();
  install(root, '03', '2026-10-04', NOT_RUN_RESULT);
  const { d, names } = deps(root, env(), (s) => {
    if (s.script === 'pr' && s.args.includes('--all')) updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '03': recordFor(root, '03', { ci: { state: 'success', url: 'x' } }) } }));
    if (s.script === 'lab') writeMeasured(root, 'lab/03-x', MEASURED_RESULT);
    return 0;
  });
  await runGo({ allowUnmeasured: true }, d);
  const order = names();
  assert.ok(order.indexOf('npm run pr -- 03 --all --allow-unmeasured') < order.indexOf('npm run lab -- 03'));
  assert.ok(order.indexOf('npm run pr -- 03 --all') > order.indexOf('npm run lab -- 03'), `a second pass after the lab: ${order.join(' | ')}`);
});

test('a long lab finishing opens its pull request in the same run', async () => {
  const root = tempDir();
  install(root, '03', '2026-10-04', NOT_RUN_RESULT);
  const { d, names } = deps(root, env(), (s) => {
    if (s.script === 'lab') writeMeasured(root, 'lab/03-x', MEASURED_RESULT);
    return 0;
  });
  await runGo({}, d);
  assert.ok(names().includes('npm run pr -- 03 --all'), names().join(' | '));
  assert.equal(names().at(-1), 'npm run status');
});

test('--skip-labs runs no lab at all', async () => {
  const root = tempDir();
  install(root, '03', '2026-10-04', NOT_RUN_RESULT);
  install(root, '06', '2026-09-22', NOT_RUN_RESULT);
  const { d, names, lines } = deps(root, env());
  await runGo({ skipLabs: true, allowUnmeasured: true }, d);
  assert.deepEqual(names().filter((n) => n.includes('run lab')), []);
  assert.ok(lines.some((l) => /skip\s+npm run lab -- 03: --skip-labs/.test(l)), lines.join('\n'));
  assert.ok(names().includes('npm run pr -- 06 --all --allow-unmeasured'));
});

test('go says at the start what can\'t open and why, and how long the long lab is', async () => {
  const root = tempDir();
  install(root, '03', '2026-10-04', NOT_RUN_RESULT);
  install(root, '01', '2026-10-06', NOT_RUN_RESULT);
  const { d, lines } = deps(root, env());
  await runGo({}, d);
  const firstRun = lines.findIndex((l) => l.startsWith('run '));
  const head = lines.slice(0, firstRun).join('\n');
  assert.match(head, /Can't open yet: PR 01: its lab isn't measured: needs OPENAI_API_KEY/);
  assert.match(head, /npm run lab -- 03 runs last.*about 4 hours.*--skip-labs/s);
});

test('a long lab stopped at its limit is resumable with its work counted, not a failure', async () => {
  const root = tempDir();
  install(root, '03', '2026-10-04', NOT_RUN_RESULT);
  writeText(join(root, 'lab/.work/03-x/full/model/segment-1.jsonl'), '{}');
  writeText(join(root, 'lab/.work/03-x/full/model/segment-2.jsonl'), '{}');
  const { d, lines } = deps(root, env(), (s) => (s.script === 'lab' ? EXIT_STOPPED_AT_LIMIT : 0));
  assert.equal(await runGo({}, d), 3, 'waiting, not failed');
  const said = lines.join('\n');
  assert.match(said, /npm run lab -- 03 stopped at its limit, with 2 files of work saved.*resumes/s);
  assert.doesNotMatch(said, /failed \(exit/);
  assert.doesNotMatch(said, /^Failed:/m);
});

test('the long lab gets its own limit, and only it reports the limit as resumable', () => {
  const long: GoStep = { phase: 'longLabs', script: 'lab', args: ['03'], skip: null, long: true };
  const short: GoStep = { phase: 'labs', script: 'lab', args: ['01'], skip: null };
  assert.ok(limitFor(long).limitMs > 5 * 60 * 60_000, 'its own dry run plans over four hours');
  assert.equal(limitFor(long).limitExit, EXIT_STOPPED_AT_LIMIT);
  assert.equal(limitFor(short).limitExit, undefined);
  assert.ok(limitFor(short).limitMs < limitFor(long).limitMs);
  assert.equal(typeof createNpmRunner(() => undefined, tempDir()), 'function');
});

test('a limit reports the exit it was asked to, and defaults to a failure', async () => {
  const hang = ['-e', 'setInterval(() => {}, 1000)'];
  const opts = { cwd: tempDir(), limitMs: 50, log: () => undefined, label: 'x' };
  assert.equal(await runCommand(process.execPath, hang, opts), 1);
  assert.equal(await runCommand(process.execPath, hang, { ...opts, limitExit: EXIT_STOPPED_AT_LIMIT }), EXIT_STOPPED_AT_LIMIT);
});

const DRIVER = join(import.meta.dirname, 'go-signal-driver.ts');

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 400 && !existsSync(path); i += 1) await delay(50);
  assert.ok(existsSync(path), `${path} never appeared`);
}

async function stopWith(signal: NodeJS.Signals) {
  const dir = tempDir();
  const child = spawn(process.execPath, [DRIVER, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
  child.stderr.on('data', (c: Buffer) => { out += c.toString('utf8'); });
  const closed = new Promise<number | null>((resolve) => child.on('exit', resolve));
  await waitForFile(join(dir, 'step-1.pid'));
  child.kill(signal);
  const code = await closed;
  // A step that outlived go still holds these pipes, and the assertions below should say so rather than hang here.
  child.stdout.destroy();
  child.stderr.destroy();
  return { code, out, dir };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`${signal} stops go: the step dies, the next one never starts, and go says what ran and what did not`, { timeout: 30_000 }, async (t) => {
    const { code, out, dir } = await stopWith(signal);
    t.after(() => {
      try {
        process.kill(-Number(readFileSync(join(dir, 'step-1.pid'), 'utf8')), 'SIGKILL');
      } catch {
        // Already gone, which is what the test wants.
      }
    });
    assert.equal(code, EXIT_INTERRUPTED, out);
    assert.ok(!existsSync(join(dir, 'step-2.pid')), `the next step started:\n${out}`);
    const pid = Number(readFileSync(join(dir, 'step-1.pid'), 'utf8'));
    for (let i = 0; i < 60 && alive(pid); i += 1) await delay(50);
    assert.equal(alive(pid), false, 'nothing outlives go');
    assert.match(out, /Stopped by you during npm run lab -- 01/);
    assert.match(out, /Not run: .*npm run brief -- anything-llm 2026-10-26/s);
    assert.doesNotMatch(out, /Carrying on/);
  });
}

function silentRoot(ids: [string, string][]): string {
  const root = tempDir();
  for (const [id, date] of ids) install(root, id, date, MEASURED_RESULT);
  return root;
}

/** A GitHub in miniature: a pull request's checks stay silent until the gate is open and a new event comes. */
function gate(root: string, open: () => boolean) {
  const fired = new Set<string>();
  return (s: GoStep): number => {
    const id = s.args[0];
    if (s.args.includes('--all')) updateObjects(root, (o) => ({ ...o, org: ORG, prs: { ...o.prs, [id]: recordFor(root, id, { ci: { state: 'none', url: null } }) } }));
    if (s.args.includes('--rerun-ci') && open()) fired.add(id);
    if (s.args.includes('--check-actions')) return fired.has(id) ? 0 : 3;
    if (s.args.includes('--wait-ci')) {
      if (!fired.has(id)) return 3;
      updateObjects(root, (o) => ({ ...o, prs: { ...o.prs, [id]: { ...o.prs[id], ci: { state: 'success', url: 'y' } } } }));
    }
    return 0;
  };
}

test('the hold lasts across runs: go opens nothing new on a fork whose open pull request is silent', async () => {
  const ids: [string, string][] = [['02', '2026-09-01'], ['06', '2026-09-22'], ['03', '2026-10-04']];
  const root = silentRoot(ids);
  const values = env();
  const runner = gate(root, () => false);
  for (let run = 0; run < 3; run += 1) await runGo({}, deps(root, values, runner).d);
  assert.deepEqual(Object.keys(readObjects(root).prs), ['02'], 'one pull request, however many times go runs');
});

test('after the button, the one silent pull request gets one close and reopen, then the rest open with CI', async () => {
  const ids: [string, string][] = [['02', '2026-09-01'], ['06', '2026-09-22'], ['03', '2026-10-04']];
  const root = silentRoot(ids);
  const values = env();
  let pressed = false;
  const fired = new Set<string>();
  const inner = gate(root, () => pressed);
  const runner = (s: GoStep): number => {
    if (pressed && s.args.includes('--all')) fired.add(s.args[0]);
    if (s.args.includes('--check-actions') && fired.has(s.args[0])) return 0;
    if (s.args.includes('--wait-ci') && fired.has(s.args[0])) {
      updateObjects(root, (o) => ({ ...o, prs: { ...o.prs, [s.args[0]]: { ...o.prs[s.args[0]], ci: { state: 'success', url: 'y' } } } }));
      return 0;
    }
    return inner(s);
  };
  await runGo({}, deps(root, values, runner).d);
  pressed = true;
  const after = deps(root, values, runner);
  await runGo({}, after.d);
  assert.deepEqual(after.names().filter((n) => n.includes('--rerun-ci')), ['npm run pr -- 02 --rerun-ci'], 'one pair on a public timeline');
  assert.deepEqual(Object.keys(readObjects(root).prs).sort(), ['02', '03', '06']);
  assert.ok(after.names().indexOf('npm run pr -- 02 --rerun-ci') < after.names().indexOf('npm run pr -- 06 --all'));
});

test('status names the button as the next step while a fork\'s open pull request is silent', async () => {
  const root = silentRoot([['02', '2026-09-01']]);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02', { ci: { state: 'none', url: null } }) } }));
  const { next } = await computeStatus({ root, env: env() });
  assert.match(next.command, /fix Actions on anything-llm/);
  assert.match(next.command, /https:\/\/github\.com\/keepup-demo\/anything-llm\/actions/);
  assert.match(next.command, /then run npm run go/);
  assert.match(next.why, /I understand my workflows/);
});

test('a silent pull request on a fork that has shown a run is go\'s to fix, not the button', async () => {
  const root = silentRoot([['02', '2026-09-01'], ['06', '2026-09-22']]);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02', { ci: { state: 'none', url: null } }), '06': recordFor(root, '06', { ci: { state: 'success', url: 'y' } }) } }));
  assert.equal((await computeStatus({ root, env: env() })).next.command, 'npm run go');
});
