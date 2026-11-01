import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPlan, formatPlan, runGo, type GoDeps, type GoStep } from '../src/go.ts';
import { updateObjects } from '../src/objects.ts';
import { createWorld, installSpec, MEASURED_RESULT, NOT_RUN_RESULT, ORG, recordFor, repoFixture, specJson, tempDir, writeMeasured, writeText } from './world.ts';

const configured = (): Record<string, string> => ({
  DEMO_ORG: ORG, GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'keepup', GITHUB_APP_PRIVATE_KEY_PATH: join(tempDir(), 'k.pem'), GITHUB_APP_INSTALLATION_ID: '2',
});

function configuredEnv(): Record<string, string> {
  const env = configured();
  writeText(env.GITHUB_APP_PRIVATE_KEY_PATH, 'x');
  return env;
}

function line(step: GoStep): string {
  return `npm run ${step.script}${step.args.length ? ` -- ${step.args.join(' ')}` : ''}`;
}

function runnable(steps: GoStep[]): string[] {
  return steps.filter((s) => !s.skip).map(line);
}

function deps(root: string, env: Record<string, string | undefined>, code: (step: GoStep) => number | Promise<number> = () => 0): { calls: string[]; lines: string[]; deps: GoDeps } {
  const calls: string[] = [];
  const lines: string[] = [];
  return {
    calls, lines,
    deps: { root, env, log: (l) => lines.push(l), runner: async (step) => {
      calls.push(line(step));
      return code(step);
    } },
  };
}

function installLab(root: string, id: string, date: string, result: string | null, extra: Record<string, unknown> = {}): void {
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(root, fix, { labDir: `lab/${id}-x`, result, overrides: { id, spec: `docs/prs/${id}.md`, stages: [{ ...stages[0], date }], ...extra } });
  writeText(join(root, `lab/${id}-x/run.ts`), '');
}

test('go --dry-run with no .env lists the plan and calls nothing', async () => {
  const w = await createWorld();
  const root = tempDir();
  const lines: string[] = [];
  const { deps: d, calls } = deps(root, {});
  const code = await runGo({ dryRun: true }, { ...d, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
  assert.equal(w.fake.requests.length, 0);
  const text = lines.join('\n');
  assert.match(text, /npm run setup -- --org <name>/);
  assert.match(text, /npm run brief -- anything-llm 2026-10-26 --dry-run/);
  assert.match(text, /npm run brief -- aura 2026-10-26 --dry-run/);
  assert.match(text, /Nothing was run/);
});

test('the plan puts pull requests oldest first, so numbering follows the replay', () => {
  const root = tempDir();
  installLab(root, '01', '2026-10-06', MEASURED_RESULT);
  installLab(root, '06', '2026-09-22', MEASURED_RESULT);
  installLab(root, '02', '2026-09-01', MEASURED_RESULT);
  const prs = runnable(buildPlan(root, configuredEnv(), {}).filter((s) => s.phase === 'prs'));
  assert.deepEqual(prs, ['npm run pr -- 02 --all', 'npm run pr -- 06 --all', 'npm run pr -- 01 --all']);
});

test('a lab that is not measured holds back its pull request; a measured one is not re-run', () => {
  const root = tempDir();
  installLab(root, '01', '2026-10-06', NOT_RUN_RESULT);
  installLab(root, '06', '2026-09-22', MEASURED_RESULT);
  const plan = buildPlan(root, configuredEnv(), {});
  assert.deepEqual(runnable(plan.filter((s) => s.phase === 'labs')), ['npm run lab -- 01']);
  assert.equal(plan.find((s) => s.script === 'lab' && s.args[0] === '06')?.skip, 'already measured');
  assert.match(plan.find((s) => s.script === 'pr' && s.args[0] === '01')?.skip ?? '', /isn't measured/);
});

test('--allow-unmeasured passes through, only for titles with no number', () => {
  const root = tempDir();
  installLab(root, '01', '2026-10-06', NOT_RUN_RESULT);
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(root, fix, { labDir: 'lab/02-x', result: NOT_RUN_RESULT, overrides: { id: '02', spec: 'docs/prs/02.md', stages: [{ ...stages[0], title: 'Keeps working' }] } });
  const plan = buildPlan(root, configuredEnv(), { allowUnmeasured: true });
  const prs = plan.filter((s) => s.phase === 'prs');
  assert.deepEqual(runnable(prs), ['npm run pr -- 02 --all --allow-unmeasured']);
  assert.match(prs.find((s) => s.args[0] === '01')?.skip ?? '', /needs a number/);
});

test('--allow-unmeasured also opens a numbered title that has a titleUnmeasured', () => {
  const root = tempDir();
  const fix = repoFixture();
  const stages = specJson(fix.baseCommit).stages as Record<string, unknown>[];
  installSpec(root, fix, { labDir: 'lab/02-x', result: NOT_RUN_RESULT, overrides: { id: '02', spec: 'docs/prs/02.md', stages: [{ ...stages[0], titleUnmeasured: 'Add it' }] } });
  assert.deepEqual(runnable(buildPlan(root, configuredEnv(), { allowUnmeasured: true }).filter((s) => s.phase === 'prs')), ['npm run pr -- 02 --all --allow-unmeasured']);
  assert.deepEqual(runnable(buildPlan(root, configuredEnv(), {}).filter((s) => s.phase === 'prs')), []);
});

test('work already recorded is skipped: stages and CI', () => {
  const root = tempDir();
  installLab(root, '06', '2026-09-22', MEASURED_RESULT);
  updateObjects(root, (o) => ({ ...o, org: ORG, prs: { '06': recordFor(root, '06') } }));
  const plan = buildPlan(root, configuredEnv(), {});
  assert.equal(plan.find((s) => s.script === 'pr' && s.phase === 'prs')?.skip, 'all stages applied');
  assert.equal(plan.find((s) => s.phase === 'ci')?.skip, 'CI already green');
  const briefs = runnable(plan.filter((s) => s.phase === 'briefs'));
  assert.deepEqual(briefs, ['npm run brief -- anything-llm 2026-10-26', 'npm run brief -- aura 2026-10-26']);
});

test('a lab exiting 3 is reported, not fatal, and everything after it still runs', async () => {
  const root = tempDir();
  installLab(root, '01', '2026-10-06', NOT_RUN_RESULT);
  installLab(root, '06', '2026-09-22', MEASURED_RESULT);
  const { deps: d, calls, lines } = deps(root, configuredEnv(), (step) => (step.script === 'lab' ? 3 : 0));
  const code = await runGo({}, d);
  assert.equal(code, 3, 'waiting on a key');
  assert.ok(calls.includes('npm run lab -- 01'));
  assert.ok(calls.includes('npm run pr -- 06 --all'));
  assert.ok(calls.includes('npm run brief -- aura 2026-10-26'));
  assert.equal(calls.at(-1), 'npm run status');
  assert.ok(lines.some((l) => /npm run lab -- 01.*waiting on a key/.test(l)), lines.join('\n'));
});

test('a failed step is reported, the run carries on, and go exits 1 at the end', async () => {
  const root = tempDir();
  installLab(root, '06', '2026-09-22', MEASURED_RESULT);
  installLab(root, '02', '2026-09-01', MEASURED_RESULT);
  const { deps: d, calls, lines } = deps(root, configuredEnv(), (step) => (step.script === 'pr' && step.args[0] === '02' ? 1 : 0));
  const code = await runGo({}, d);
  assert.equal(code, 1);
  assert.ok(calls.includes('npm run pr -- 06 --all'));
  assert.ok(lines.some((l) => /failed/.test(l)));
});

test('with no setup, labs still run, pull requests wait, and briefs are dry runs', async () => {
  const root = tempDir();
  installLab(root, '06', '2026-09-22', NOT_RUN_RESULT);
  const { deps: d, calls, lines } = deps(root, {});
  const code = await runGo({}, d);
  assert.equal(code, 3);
  assert.deepEqual(calls, ['npm run lab -- 06', 'npm run brief -- anything-llm 2026-10-26 --dry-run', 'npm run brief -- aura 2026-10-26 --dry-run', 'npm run status']);
  assert.ok(lines.some((l) => /npm run setup -- --org <name>/.test(l)));
});

test('a lab finishing during the run unlocks its pull request in the same run', async () => {
  const root = tempDir();
  installLab(root, '06', '2026-09-22', NOT_RUN_RESULT);
  const { deps: d, calls } = deps(root, configuredEnv(), (step) => {
    if (step.script === 'lab') writeMeasured(root, 'lab/06-x');
    if (step.script === 'pr' && step.args.includes('--all')) {
      updateObjects(root, (o) => ({ ...o, prs: { '06': { number: 1, url: 'u', title: 't', state: 'open', base: 'b', head: 'h', author: 'keepup[bot]', stagesApplied: ['2026-09-22'], ci: { state: 'none', url: null }, checkedAt: 'x' } } }));
    }
    return 0;
  });
  await runGo({}, d);
  assert.ok(calls.includes('npm run pr -- 06 --all'));
  assert.ok(calls.includes('npm run pr -- 06 --wait-ci'));
});

test('replay and data run when their scripts exist, and say when they do not', () => {
  const root = tempDir();
  const plan = buildPlan(root, configuredEnv(), {});
  assert.match(plan.find((s) => s.script === 'replay')?.skip ?? '', /scripts\/replay-summary\.ts isn't there/);
  writeText(join(root, 'scripts/replay-summary.ts'), '');
  writeText(join(root, 'scripts/build-site-data.ts'), '');
  const later = buildPlan(root, configuredEnv(), {});
  assert.equal(later.find((s) => s.script === 'replay')?.skip, null);
  assert.equal(later.find((s) => s.script === 'data')?.skip, null);
});

test('the printed plan shows runs and skips', () => {
  const root = tempDir();
  installLab(root, '06', '2026-09-22', MEASURED_RESULT);
  const text = formatPlan(buildPlan(root, configuredEnv(), {})).join('\n');
  assert.match(text, /npm run pr -- 06 --all/);
  assert.match(text, /skip.*npm run lab -- 06.*already measured/);
});
