// go's decisions: what it does when words are stale, a spec is broken, the Actions gate is shut, or time runs out.
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPlan, formatPlan, runGo, type GoDeps, type GoStep } from '../src/go.ts';
import { runCommand, STEP_LIMITS_MS } from '../src/go-runner.ts';
import { updateObjects } from '../src/objects.ts';
import { setupSummary } from '../src/setup.ts';
import { computeStatus } from '../src/status.ts';
import { installSpec, MEASURED_RESULT, NOT_RUN_RESULT, ORG, recordFor, repoFixture, specJson, tempDir, writeJson, writeMeasured, writeText } from './world.ts';

function env(): Record<string, string> {
  const key = join(tempDir(), 'k.pem');
  writeText(key, 'x');
  return { DEMO_ORG: ORG, GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'keepup-ai', GITHUB_APP_PRIVATE_KEY_PATH: key, GITHUB_APP_INSTALLATION_ID: '2' };
}

const line = (s: GoStep) => `npm run ${s.script}${s.args.length ? ` -- ${s.args.join(' ')}` : ''}`;

function deps(root: string, values: Record<string, string | undefined>, code: (step: GoStep) => number = () => 0, extra: Partial<GoDeps> = {}) {
  const calls: GoStep[] = [];
  const lines: string[] = [];
  const d: GoDeps = { root, env: values, log: (l) => lines.push(l), runner: async (s) => { calls.push(s); return code(s); }, ...extra };
  return { d, calls, lines, names: () => calls.map(line) };
}

function install(root: string, id: string, date: string, result: string | null, fork = 'anything-llm', extra: Record<string, unknown> = {}): void {
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(root, fix, {
    labDir: `lab/${id}-x`, result,
    overrides: { id, spec: `docs/prs/${id}.md`, fork, upstream: fork === 'aura' ? 'mezmo/aura' : 'Mintplex-Labs/anything-llm', branch: `keepup/${date}-${id}`, stages: [{ ...stages[0], date, title: 'Add it · {{lab.title_number}}', titleUnmeasured: 'Add it' }], ...extra },
  });
  writeText(join(root, `lab/${id}-x/run.ts`), '');
}

const planFor = (root: string, values: Record<string, string>, id: string, flags = {}) => buildPlan(root, values, flags).find((s) => s.phase === 'prs' && s.args[0] === id);

test('a pull request opened unmeasured is not skipped once its lab has a number', () => {
  const root = tempDir();
  const values = env();
  install(root, '06', '2026-09-22', NOT_RUN_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '06': recordFor(root, '06') } }));
  assert.equal(planFor(root, values, '06')?.skip, 'all stages applied', 'until the lab runs, there is nothing new to say');
  writeMeasured(root, 'lab/06-x');
  assert.equal(planFor(root, values, '06')?.skip, null, 'the title and body now owe it their number');
});

test('stale words reopen the step, and current ones keep it skipped, by title and by body', () => {
  const root = tempDir();
  const values = env();
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  const set = (over: object) => updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '06': recordFor(root, '06', over) } }));
  set({});
  assert.equal(planFor(root, values, '06')?.skip, 'all stages applied');
  set({ title: 'an older title' });
  assert.equal(planFor(root, values, '06')?.skip, null);
  set({ bodyDigest: 'an older body' });
  assert.equal(planFor(root, values, '06')?.skip, null);
  set({ bodyDigest: undefined });
  assert.equal(planFor(root, values, '06')?.skip, null, 'a record that predates the digest gets refreshed');
  set({ title: 'an older title', state: 'merged' });
  assert.equal(planFor(root, values, '06')?.skip, 'all stages applied', 'a merged one is only read, so running it would change nothing');
});

test('status does not tick a pull request whose words lag the lab, and go then fixes it', async () => {
  const root = tempDir();
  const values = env();
  install(root, '01', '2026-10-06', NOT_RUN_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '01': recordFor(root, '01', { stagesApplied: ['2026-10-06'], ci: { state: 'success', url: 'x' } }) } }));
  writeMeasured(root, 'lab/01-x');
  const status = await computeStatus({ root, env: values });
  const check = status.items.find((i) => i.n === 2)?.checks.find((c) => c.label === 'PR 01');
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? '', /run npm run pr -- 01 --all/);
});

test('a merged pull request with no number in its title says so, since it can\'t be edited from here', async () => {
  const root = tempDir();
  const values = env();
  install(root, '01', '2026-10-06', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '01': recordFor(root, '01', { title: 'Add it', state: 'merged' }) } }));
  const check = (await computeStatus({ root, env: values })).items.find((i) => i.n === 2)?.checks.find((c) => c.label === 'PR 01');
  assert.match(check?.detail ?? '', /doesn't carry the lab's number/);
});

test('a broken spec is a failure, in the plan and the summary, with an exit code to match', async () => {
  const root = tempDir();
  const values = env();
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  install(root, '02', '2026-09-01', MEASURED_RESULT, 'anything-llm', { baseCommit: 'nope' });
  const text = formatPlan(buildPlan(root, values, {})).join('\n');
  assert.match(text, /BROKEN lab\/02-x\/pr\.json: this pull request can't open until the spec is fixed/);
  assert.match(text, /baseCommit/);
  const { d, lines, names } = deps(root, values);
  assert.equal(await runGo({}, d), 1);
  assert.ok(lines.some((l) => /^Failed: the spec lab\/02-x\/pr\.json/.test(l)), lines.join('\n'));
  assert.ok(!lines.includes('Every step ran or was already done.'));
  assert.ok(names().includes('npm run pr -- 06 --all'), 'the good one still runs');
  const dry = deps(root, values);
  assert.equal(await runGo({ dryRun: true }, dry.d), 0, 'a dry run only reports');
  assert.match(dry.lines.join('\n'), /BROKEN/);
});

test('the first pull request on a fork checks Actions, and a closed gate stops that fork only', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  install(root, '05', '2026-09-02', MEASURED_RESULT, 'aura');
  const { d, lines, names } = deps(root, values, (s) => (s.args.includes('--check-actions') && s.args[0] === '02' ? 3 : 0));
  assert.equal(await runGo({}, d), 3);
  const called = names();
  assert.ok(called.includes('npm run pr -- 02 --all'));
  assert.ok(called.includes('npm run pr -- 02 --check-actions'));
  assert.ok(!called.includes('npm run pr -- 06 --all'), 'held');
  assert.ok(called.includes('npm run pr -- 05 --all'), 'the other fork carries on');
  assert.ok(called.includes('npm run pr -- 05 --check-actions'));
  assert.ok(lines.some((l) => /hold\s+npm run pr -- 06 --all: Actions isn't running on anything-llm/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes(`https://github.com/${ORG}/anything-llm/actions`) && /I understand my workflows/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /npm run pr -- 02.*waiting on a key/.test(l)), 'not the wrong cause');
  assert.ok(called.includes('npm run brief -- anything-llm 2026-10-26'), 'and nothing else is held back');
});

test('after the button: a pull request with no checks gets one new event, and CI is then waited for', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02', { ci: { state: 'none', url: null } }) } }));
  let checks = 0;
  const { d, names } = deps(root, values, (s) => {
    if (s.args.includes('--check-actions')) {
      checks += 1;
      return checks === 1 ? 3 : 0;
    }
    return 0;
  });
  await runGo({}, d);
  assert.deepEqual(names().filter((c) => c.includes('-- 02')), ['npm run pr -- 02 --check-actions', 'npm run pr -- 02 --rerun-ci', 'npm run pr -- 02 --check-actions', 'npm run pr -- 02 --wait-ci']);
});

test('if the event brings nothing either, the gate is still shut, and the fork stops without waiting out CI', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02', { ci: { state: 'none', url: null } }), '06': recordFor(root, '06', { ci: { state: 'none', url: null } }) } }));
  const { d, names, lines } = deps(root, values, (s) => (s.args.includes('--check-actions') ? 3 : 0));
  assert.equal(await runGo({}, d), 3);
  assert.ok(!names().some((c) => c.includes('--wait-ci')), 'no twenty-minute waits');
  assert.deepEqual(names().filter((c) => c.includes('--rerun-ci')), ['npm run pr -- 02 --rerun-ci'], 'one try per fork');
  assert.ok(lines.some((l) => /I understand my workflows/.test(l)));
});

test('the CI phase has one deadline, shared out, and CI comes after the brief, the replay and the data', async () => {
  const root = tempDir();
  const values = env();
  writeText(join(root, 'scripts/replay-summary.ts'), '');
  writeText(join(root, 'scripts/build-site-data.ts'), '');
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02', { ci: { state: 'pending', url: 'x' } }), '06': recordFor(root, '06', { ci: { state: 'pending', url: 'x' } }) } }));
  let clock = 0;
  const { d, calls, lines, names } = deps(root, values, (s) => {
    if (s.args.includes('--wait-ci')) clock += 60_000;
    return s.args.includes('--wait-ci') ? 3 : 0;
  }, { nowMs: () => clock, ciPhaseMs: 60_000 });
  assert.equal(await runGo({}, d), 3);
  const order = names();
  assert.ok(order.indexOf('npm run brief -- aura 2026-10-26') < order.indexOf('npm run pr -- 02 --wait-ci'));
  assert.ok(order.indexOf('npm run data') < order.indexOf('npm run pr -- 02 --wait-ci'));
  const waits = calls.filter((s) => s.args.includes('--wait-ci'));
  assert.equal(waits.length, 1, 'the second one has no time left');
  assert.equal(waits[0].env?.KEEPUP_CI_WAIT_MS, '60000');
  assert.ok(lines.some((l) => /hold\s+npm run pr -- 06 --wait-ci: the CI phase's shared time ran out/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /npm run pr -- 02 --wait-ci has no green result yet/.test(l)));
  assert.ok(!lines.some((l) => /--wait-ci.*waiting on a key/.test(l)));
});

test('when CI changes the record, the site data is rebuilt so the site can show it', async () => {
  const root = tempDir();
  const values = env();
  writeText(join(root, 'scripts/build-site-data.ts'), '');
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02', { ci: { state: 'pending', url: 'x' } }) } }));
  const { d, names } = deps(root, values, (s) => {
    if (s.args.includes('--wait-ci')) updateObjects(root, (o) => ({ ...o, prs: { '02': { ...o.prs['02'], ci: { state: 'success', url: 'y' } } } }));
    return 0;
  });
  await runGo({}, d);
  assert.equal(names().filter((c) => c === 'npm run data').length, 2);
  const quiet = deps(root, values);
  await runGo({}, quiet.d);
  assert.equal(quiet.names().filter((c) => c === 'npm run data').length, 1, 'green already, nothing new');
});

test('a step that hangs is stopped at its limit and reported, with a line while it runs', async () => {
  const lines: string[] = [];
  const started = Date.now();
  const code = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tempDir(), limitMs: 80, heartbeatMs: 20, log: (l) => lines.push(l), label: 'a hung step' });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 5000, 'stopped, not waited for');
  assert.ok(lines.some((l) => /still running: a hung step/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /a hung step hit its limit/.test(l)), lines.join('\n'));
  assert.ok(STEP_LIMITS_MS.lab > 40 * 60_000, 'longer than sandbox.sh can wait on a stale lock');
});

test('a step that ends on its own passes its exit code through', async () => {
  const run = (code: number) => runCommand(process.execPath, ['-e', `process.exit(${code})`], { cwd: tempDir(), limitMs: 10_000, log: () => undefined, label: 'x' });
  assert.equal(await run(0), 0);
  assert.equal(await run(3), 3);
});

interface NextCase { name: string; arrange: (root: string) => void; values?: Record<string, string>; command: RegExp; why?: RegExp }

function doneExcept(root: string): void {
  const fix = repoFixture();
  const stage = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  const stagesOf: Record<string, string[]> = { '01': ['2026-10-06', '2026-10-22'], '04': ['2026-09-25', '2026-10-30'] };
  for (const id of ['01', '02', '03', '04', '05']) {
    const stages = (stagesOf[id] ?? ['2026-09-22']).map((date, i) => ({ ...stage[0], date, title: 'Keeps working', comment: i === 0 ? null : 'Updated.' }));
    installSpec(root, fix, { labDir: `lab/${id}-x`, overrides: { id, spec: `docs/prs/${id}.md`, stages } });
  }
  updateObjects(root, (o) => ({
    ...o, org: ORG,
    prs: Object.fromEntries(['01', '02', '03', '04', '05'].map((id) => [id, recordFor(root, id)])),
    issues: { 'anything-llm/2026-10-26': { number: 9, url: 'x' }, 'aura/2026-10-26': { number: 3, url: 'y' } },
  }));
  writeJson(join(root, 'data/timeline.json'), { repos: [{ events: [1, 2, 3].map((n) => ({ team: { date: 'd', commit: `c${n}`, days_after: n } })) }] });
  writeJson(join(root, 'data/replay-summary.json'), {});
  writeText(join(root, 'site/package.json'), '{}');
  writeText(join(root, 'site/public/data/x.json'), '{}');
  writeJson(join(root, 'data/site.json'), { url: 'https://example.test' });
  writeJson(join(root, 'data/run-through.json'), {});
}

test('the next command walks the whole way to the end, one honest answer at a time', async () => {
  const cases: NextCase[] = [
    { name: 'broken spec', arrange: (r) => { install(r, '02', '2026-09-01', MEASURED_RESULT, 'anything-llm', { baseCommit: 'nope' }); }, command: /fix the spec/, why: /baseCommit/ },
    { name: 'no setup', arrange: () => undefined, values: {}, command: /npm run setup -- --org <name>/ },
    { name: 'a key is missing', arrange: (r) => { install(r, '01', '2026-10-06', NOT_RUN_RESULT); }, command: /add OPENAI_API_KEY to \.env, then run npm run go/, why: /npm run go -- --allow-unmeasured/ },
    { name: 'a key is there, so go', arrange: (r) => { install(r, '01', '2026-10-06', NOT_RUN_RESULT); }, values: { OPENAI_API_KEY: 'x' }, command: /^npm run go$/ },
    { name: 'pull requests to open', arrange: (r) => { install(r, '06', '2026-09-22', MEASURED_RESULT); }, command: /^npm run go$/ },
    { name: 'only the deploy is left, no token', arrange: (r) => { doneExcept(r); rmData(r, 'data/site.json'); }, command: /add VERCEL_TOKEN to \.env, then run npm run deploy/ },
    { name: 'only the deploy is left', arrange: (r) => { doneExcept(r); rmData(r, 'data/site.json'); }, values: { VERCEL_TOKEN: 'x' }, command: /^npm run deploy$/ },
    { name: 'no site data', arrange: (r) => { doneExcept(r); rmData(r, 'site/public/data/x.json'); }, command: /^npm run data$/ },
    { name: 'no site at all', arrange: (r) => { doneExcept(r); rmData(r, 'site/package.json'); }, command: /build site/ },
    { name: 'only the video is left', arrange: (r) => { doneExcept(r); rmData(r, 'data/run-through.json'); }, command: /record the run-through/ },
    { name: 'all done', arrange: (r) => { doneExcept(r); }, command: /^nothing$/ },
  ];
  for (const c of cases) {
    const root = tempDir();
    const values = env();
    c.arrange(root);
    const status = await computeStatus({ root, env: c.values && Object.keys(c.values).length === 0 ? {} : { ...values, ...c.values } });
    assert.match(status.next.command, c.command, `${c.name}: ${status.next.command}`);
    if (c.why) assert.match(status.next.why, c.why, c.name);
  }
});

test('a lost key is told as a lost key by status, not as "run setup"', async () => {
  const root = tempDir();
  const values = { ...env(), GITHUB_APP_PRIVATE_KEY_PATH: join(tempDir(), 'gone.pem') };
  mkdirSync(join(root, 'lab'), { recursive: true });
  const status = await computeStatus({ root, env: values });
  assert.equal(status.setup.ok, false);
  assert.match(status.next.command, /settings\/apps\/keepup-ai/);
  assert.match(status.next.why, /generate a new key/);
});

test('records from another org are treated as absent, by go and by status', async () => {
  const root = tempDir();
  const values = env();
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: 'an-old-org', prs: { '06': recordFor(root, '06') } }));
  assert.equal(planFor(root, values, '06')?.skip, null, 'not "all stages applied": that was on another org');
  assert.equal(buildPlan(root, values, {}).find((s) => s.phase === 'ci')?.skip, 'no pull request yet');
  const status = await computeStatus({ root, env: values });
  assert.equal(status.extras.find((c) => c.label === 'PR 06')?.detail, 'not opened yet');
});

function rmData(root: string, path: string): void {
  rmSync(join(root, path));
}

const BROKEN_RESULT = '---\nlab: 02-x\nstatus: measured\n---\n| a | b |\n';

test('one unreadable result costs that pull request only: the others run, and go says which', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  install(root, '06', '2026-09-22', MEASURED_RESULT);
  writeText(join(root, 'lab/02-x/result.md'), BROKEN_RESULT);
  assert.match(formatPlan(buildPlan(root, values, {})).join('\n'), /BROKEN 02: this pull request waits, because lab\/02-x\/result\.md can't be read/);
  const { d, lines, names } = deps(root, values);
  assert.equal(await runGo({}, d), 1);
  assert.ok(names().includes('npm run lab -- 02'), 'running the lab is what can fix it');
  assert.ok(names().includes('npm run pr -- 06 --all'));
  assert.ok(!names().includes('npm run pr -- 02 --all'));
  assert.ok(lines.some((l) => /^Failed: the lab result of PR 02/.test(l)), lines.join('\n'));
});

test('a lab run that rewrites the unreadable result clears the failure in the same run', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  writeText(join(root, 'lab/02-x/result.md'), BROKEN_RESULT);
  const { d, names } = deps(root, values, (s) => {
    if (s.script === 'lab') writeMeasured(root, 'lab/02-x');
    return 0;
  });
  assert.equal(await runGo({}, d), 0);
  assert.ok(names().includes('npm run pr -- 02 --all'));
});

test('status keeps reporting past an unreadable result, a half-written site.json and an empty record', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '02': recordFor(root, '02') } }));
  writeText(join(root, 'lab/02-x/result.md'), BROKEN_RESULT);
  writeText(join(root, 'data/site.json'), '{ "url": "https://half');
  writeText(join(root, 'data/timeline.json'), '{ "repos": [');
  const status = await computeStatus({ root, env: values });
  const check = status.items.find((i) => i.n === 2)?.checks.find((c) => c.label === 'PR 02');
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? '', /lab isn't measured/);
  const site = status.items.find((i) => i.n === 1)?.checks.find((c) => c.label.startsWith('deployed'));
  assert.equal(site?.ok, false);
  assert.match(site?.detail ?? '', /site\.json isn't valid JSON/);
  assert.match(status.labs.find((l) => l.dir === '02-x')?.status ?? '', /unreadable/);
});

test('prs: null in the record reads as nothing recorded, for go and for status', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  writeJson(join(root, 'data/github-objects.json'), { schema: 1, org: ORG, forks: null, prs: null, issues: null });
  assert.equal((await computeStatus({ root, env: values })).extras.length, 2);
  assert.equal(buildPlan(root, values, {}).find((s) => s.phase === 'prs')?.skip, null);
});

test('a record file that isn\'t JSON: status says to fix it and carries on, and go refuses rather than guess', async () => {
  const root = tempDir();
  const values = env();
  install(root, '02', '2026-09-01', MEASURED_RESULT);
  writeText(join(root, 'data/github-objects.json'), '{ "prs": ');
  const status = await computeStatus({ root, env: values });
  assert.equal(status.next.command, 'fix data/github-objects.json');
  assert.match(status.next.why, /isn't valid JSON/);
  assert.throws(() => buildPlan(root, values, {}), /isn't valid JSON/);
});

test('setup ends by saying what to do next', () => {
  assert.equal(setupSummary({ manual: ['press the button'], problems: [] }, tempDir()).at(-1), 'Next: npm run go');
  assert.match(setupSummary({ manual: [], problems: ['base commit'] }, tempDir()).at(-1) ?? '', /fix the problems above/);
});
