// node lab/05-models/repo-tests.ts
// Writes out/repo-tests.json, the evidence docs/contracts.md asks for, from a real run of the
// repo's own config tests in the sandbox, once per stage. It needs no key. The command is the
// one the fork's CI runs (lab/ci/aura.yml), and every count is read from cargo's own output.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LAB_DIR = import.meta.dirname;
const ROOT = join(LAB_DIR, '..', '..');
const CLONE = join(ROOT, 'tmp', 'aura');
const WORKTREE = join(ROOT, 'tmp', 'lab-wt-05-tests');
const WORK = join(ROOT, 'lab', '.work', '05-models', 'repo-tests');
const IN_SANDBOX = '/lab-work/05-models/repo-tests';
const IN_SANDBOX_LAB = '/lab/05-models';
const TEST_COMMAND = 'cargo test -p aura-config --locked';
const SHIPPED_TEST = 'test_all_shipped_configs_parse';
const PATCH_FAILED_EXIT = 9;

export interface PlanStage { date: string; patches: string[] }

export interface CargoRun {
  passed: number;
  failed: number;
  ignored: number;
  shippedConfigs: string | null;
  failedTests: string[];
  resultLines: string[];
}

export interface StageRun { date: string; exit: number; run: CargoRun }

/** One command, so the whole run holds the sandbox's queue once: each stage's patches go on, then the tests run. */
export function sandboxCommand(stages: readonly PlanStage[]): string {
  return stages.map((stage, i) => [
    ...stage.patches.map((p) => `patch -p1 -s < ${IN_SANDBOX_LAB}/${p} || exit ${PATCH_FAILED_EXIT}`),
    `${TEST_COMMAND} > ${IN_SANDBOX}/stage-${i}.txt 2>&1; echo $? > ${IN_SANDBOX}/stage-${i}.exit`,
  ].join('; ')).join('; ');
}

export function parseCargoTests(text: string): CargoRun {
  const results = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;.*$/gm)];
  if (!results.length) throw new Error('cargo printed no test result, so the tests never ran');
  const sum = (group: number) => results.reduce((total, m) => total + Number(m[group]), 0);
  return {
    passed: sum(1),
    failed: sum(2),
    ignored: sum(3),
    shippedConfigs: text.match(new RegExp(`^test \\S*${SHIPPED_TEST} \\.\\.\\. (\\w+)$`, 'm'))?.[1] ?? null,
    failedTests: [...text.matchAll(/^test (.+) \.\.\. FAILED$/gm)].map((m) => m[1]),
    resultLines: results.map((m) => m[0]),
  };
}

const stagePassed = (stage: StageRun) => stage.exit === 0 && stage.run.failed === 0 && stage.run.shippedConfigs === 'ok';

function summaryLine(stages: readonly StageRun[]): string {
  const tip = stages[stages.length - 1].run;
  const total = tip.passed + tip.failed;
  const failing = stages.filter((s) => !stagePassed(s));
  if (failing.length) return `aura-config tests fail at the stage dated ${failing.map((s) => s.date).join(' and the stage dated ')}: at the tip, ${tip.passed} of ${total} pass.`;
  return `${tip.passed} of ${total} aura-config tests pass in the sandbox at the tip, and at each of the ${stages.length} stages, ${tip.ignored} ignored. They include ${SHIPPED_TEST}, which parses the shipped configs, both changed examples among them. This is the command the fork's CI runs; the rest of the workspace's tests didn't run, since only example TOML files change.`;
}

export function summarize(stages: readonly StageRun[], commit: string, ranOn: string) {
  const tip = stages[stages.length - 1].run;
  return {
    summary: summaryLine(stages),
    commit,
    ran_on: ranOn,
    command: TEST_COMMAND,
    tests: { total: tip.passed + tip.failed, passed: tip.passed, failed: tip.failed, ignored: tip.ignored },
    failed_tests: [...new Set(stages.flatMap((s) => s.run.failedTests))],
    stages: stages.map((s) => ({ date: s.date, exit: s.exit, [SHIPPED_TEST]: s.run.shippedConfigs, passed: s.run.passed, failed: s.run.failed, result_lines: s.run.resultLines })),
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function removeWorktree(): void {
  if (git(CLONE, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${WORKTREE}`)) git(CLONE, 'worktree', 'remove', '--force', WORKTREE);
  rmSync(WORKTREE, { recursive: true, force: true });
  git(CLONE, 'worktree', 'prune');
}

function runInSandbox(stages: readonly PlanStage[]): void {
  const run = spawnSync(join(ROOT, 'scripts', 'sandbox.sh'), ['aura', WORKTREE, sandboxCommand(stages)], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`the sandbox run failed (exit ${run.status})`);
}

/** The evidence names a commit, so the tree the tests ran on has to be that commit's. */
function checkTreeIsTip(branch: string): string {
  git(WORKTREE, 'add', '-A');
  const tested = git(WORKTREE, 'write-tree');
  const tip = git(CLONE, 'rev-parse', `${branch}^{tree}`);
  if (tested !== tip) throw new Error(`the tree the tests ran on (${tested}) isn't ${branch}'s (${tip}): regenerate the patches`);
  return git(CLONE, 'rev-parse', branch);
}

function readStages(stages: readonly PlanStage[]): StageRun[] {
  return stages.map((stage, i) => ({
    date: stage.date,
    exit: Number(readFileSync(join(WORK, `stage-${i}.exit`), 'utf8').trim()),
    run: parseCargoTests(readFileSync(join(WORK, `stage-${i}.txt`), 'utf8')),
  }));
}

function main(): void {
  const pr = JSON.parse(readFileSync(join(LAB_DIR, 'pr.json'), 'utf8')) as { baseCommit: string; branch: string; stages: PlanStage[] };
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  removeWorktree();
  git(CLONE, 'worktree', 'add', '--force', '--detach', WORKTREE, pr.baseCommit);
  try {
    runInSandbox(pr.stages);
    const commit = checkTreeIsTip(pr.branch);
    const evidence = summarize(readStages(pr.stages), commit, new Date().toISOString().slice(0, 10));
    mkdirSync(join(LAB_DIR, 'out'), { recursive: true });
    writeFileSync(join(LAB_DIR, 'out', 'repo-tests.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${evidence.summary}\n`);
  } finally {
    removeWorktree();
  }
  rmSync(WORK, { recursive: true, force: true });
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`repo-tests: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
