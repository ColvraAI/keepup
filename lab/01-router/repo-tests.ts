// node lab/01-router/repo-tests.ts <worktree> [--variant jev]
// Writes out/repo-tests.json, or out/repo-tests-jev.json for the variant, the evidence
// docs/contracts.md asks for, from a real run of the repo's own tests and checks in the
// sandbox. It needs no key. The commands are in the file it writes, and every count is
// read from jest's own JSON report, so none is typed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LAB_DIR = import.meta.dirname;
const ROOT = join(LAB_DIR, '..', '..');
const WORK = join(ROOT, 'lab', '.work', '01-router', 'repo-tests');
const IN_SANDBOX = '/lab-work/01-router/repo-tests';
const FFMPEG_CHECK = 'ffmpeg in image';

/** Upstream's CI at the base commit: run-tests.yaml, lint.yaml and the two check-* workflows. */
export const SANDBOX_COMMAND = [
  'yarn setup:envs >/dev/null; yarn prisma:setup >/dev/null 2>&1',
  `yarn -s jest --json --outputFile=${IN_SANDBOX}/jest.json >/dev/null 2>&1; echo "jest=$?" >${IN_SANDBOX}/checks.txt`,
  `(cd server && yarn -s lint:check >/dev/null 2>&1; echo "server lint=$?" >>${IN_SANDBOX}/checks.txt)`,
  `(cd collector && yarn -s lint:check >/dev/null 2>&1; echo "collector lint=$?" >>${IN_SANDBOX}/checks.txt)`,
  `(if [ -x frontend/node_modules/.bin/eslint ]; then cd frontend && yarn -s lint:check >/dev/null 2>&1; echo "frontend lint=$?" >>${IN_SANDBOX}/checks.txt; fi)`,
  `(cd frontend/src/locales && node verifyTranslations.mjs >/dev/null 2>&1; echo "check-translations=$?" >>${IN_SANDBOX}/checks.txt)`,
  `(cd extras/scripts && node verifyPackageVersions.mjs >/dev/null 2>&1; echo "check-package-versions=$?" >>${IN_SANDBOX}/checks.txt)`,
  `command -v ffmpeg >/dev/null; echo "${FFMPEG_CHECK}=$?" >>${IN_SANDBOX}/checks.txt`,
].join('; ');

interface JestReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[];
}

const relativeToRepo = (name: string) => name.replace(/^\/repo\//, '');

function describeFailures(failed: readonly { file: string }[], checks: Record<string, number>): string {
  if (!failed.length) return 'None fail.';
  const files = [...new Set(failed.map((f) => f.file))].join(', ');
  const lead = failed.length === 1 ? `The 1 that fails is in ${files}` : `The ${failed.length} that fail are in ${files}`;
  const noBinary = checks[FFMPEG_CHECK] !== undefined && checks[FFMPEG_CHECK] !== 0 && files.includes('ffmpeg');
  return `${lead}${noBinary ? ', and the image has no ffmpeg binary.' : '.'}`;
}

function describeChecks(checks: Record<string, number>): string {
  const names = Object.keys(checks).filter((name) => name !== 'jest' && name !== FFMPEG_CHECK);
  const bad = names.filter((name) => checks[name] !== 0);
  return bad.length ? `${bad.join(', ')} failed.` : `Every linter and check that ran passed: ${names.join(', ')}.`;
}

/** The one-line summary and the detail, from jest's report and the exit codes the checks gave. */
export function summarize(report: JestReport, checks: Record<string, number>, commit: string, ranOn: string, changedTestFiles: readonly string[]) {
  const failed = report.testResults.flatMap((file) => file.assertionResults.filter((a) => a.status === 'failed').map((a) => ({ file: relativeToRepo(file.name), test: a.fullName })));
  const added = report.testResults.filter((file) => changedTestFiles.includes(relativeToRepo(file.name))).map((file) => ({
    file: relativeToRepo(file.name),
    total: file.assertionResults.length,
    passed: file.assertionResults.filter((a) => a.status === 'passed').length,
  }));
  const summary = `${report.numPassedTests} of ${report.numTotalTests} repo tests pass in the sandbox on Node 18. ${describeFailures(failed, checks)} ${describeChecks(checks)}`;
  return {
    summary,
    commit,
    ran_on: ranOn,
    command: SANDBOX_COMMAND,
    tests: { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests },
    failed_tests: failed,
    tests_this_change_adds: added,
    checks,
  };
}

export function parseChecks(text: string): Record<string, number> {
  const pairs = text.split('\n').filter(Boolean).map((line): [string, number] => {
    const at = line.lastIndexOf('=');
    const code = line.slice(at + 1);
    if (at < 1 || code === '' || Number.isNaN(Number(code))) throw new Error(`checks.txt has a bad line: ${line}`);
    return [line.slice(0, at), Number(code)];
  });
  return Object.fromEntries(pairs);
}

export function testFilesIn(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(\S*__tests__\S*) /gm)].map((m) => m[1]);
}

function changedTestFiles(patchDir: string): string[] {
  const dir = join(LAB_DIR, patchDir);
  const all = readdirSync(dir).flatMap((name) => testFilesIn(readFileSync(join(dir, name), 'utf8')));
  return [...new Set(all)];
}

function main(worktree: string, variant: 'jev' | null): void {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const run = spawnSync(join(ROOT, 'scripts', 'sandbox.sh'), ['anything-llm', worktree, SANDBOX_COMMAND], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`the sandbox run failed (exit ${run.status})`);
  const report = JSON.parse(readFileSync(join(WORK, 'jest.json'), 'utf8')) as JestReport;
  const checks = parseChecks(readFileSync(join(WORK, 'checks.txt'), 'utf8'));
  const commit = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const evidence = summarize(report, checks, commit, new Date().toISOString().slice(0, 10), changedTestFiles(variant ? `patches-${variant}` : 'patches'));
  mkdirSync(join(LAB_DIR, 'out'), { recursive: true });
  writeFileSync(join(LAB_DIR, 'out', variant ? `repo-tests-${variant}.json` : 'repo-tests.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(evidence.summary);
  for (const failure of evidence.failed_tests) console.log(`  failed: ${failure.file}: ${failure.test}`);
  rmSync(WORK, { recursive: true, force: true });
}

if (import.meta.main) {
  const [worktree, flag, value] = process.argv.slice(2);
  if (!worktree || (flag !== undefined && (flag !== '--variant' || value !== 'jev'))) {
    console.error('Usage: node lab/01-router/repo-tests.ts <worktree> [--variant jev]');
    process.exit(2);
  }
  try {
    main(resolve(worktree), flag ? 'jev' : null);
  } catch (error) {
    console.error(`repo-tests: ${(error as Error).message}`);
    process.exit(1);
  }
}
