// node lab/02-whisper/repo-tests.ts <worktree>
// Writes out/repo-tests.json, the evidence docs/contracts.md asks for, from a real run of the
// repo's own tests and linters in the sandbox: the commands are in the file it writes, and it
// reads jest's own JSON report, so every count is read and none is typed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LAB_DIR = import.meta.dirname;
const ROOT = join(LAB_DIR, '..', '..');
const WORK = join(ROOT, 'lab', '.work', '02-whisper', 'repo-tests');
const IN_SANDBOX = '/lab-work/02-whisper/repo-tests';

export const SANDBOX_COMMAND = [
  'yarn setup:envs >/dev/null; yarn prisma:setup >/dev/null 2>&1',
  `yarn -s jest --json --outputFile=${IN_SANDBOX}/jest.json >/dev/null 2>&1; echo "jest=$?" >${IN_SANDBOX}/checks.txt`,
  `(cd server && yarn -s lint:check >/dev/null 2>&1; echo "server lint=$?" >>${IN_SANDBOX}/checks.txt)`,
  `(cd collector && yarn -s lint:check >/dev/null 2>&1; echo "collector lint=$?" >>${IN_SANDBOX}/checks.txt)`,
  `(cd frontend && yarn -s lint:check >/dev/null 2>&1; echo "frontend lint=$?" >>${IN_SANDBOX}/checks.txt)`,
  `(cd frontend/src/locales && node verifyTranslations.mjs >/dev/null 2>&1; echo "check-translations=$?" >>${IN_SANDBOX}/checks.txt)`,
  `(cd extras/scripts && node verifyPackageVersions.mjs >/dev/null 2>&1; echo "check-package-versions=$?" >>${IN_SANDBOX}/checks.txt)`,
].join('; ');

interface JestAssertion {
  fullName: string;
  status: string;
  failureMessages?: string[];
}

interface JestReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: { name: string; assertionResults: JestAssertion[] }[];
}

interface Failure {
  file: string;
  test: string;
  message?: string;
}

/** The sandbox image has no ffmpeg binary, so these three can't pass there. GitHub Actions skips them. */
const NEEDS_FFMPEG = 'collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js';

/**
 * These wait a fixed 25 ms (index.test.js:35) for fs.promises writes, so a busy machine can beat them. Each is
 * listed because a saved run shows it failing, at the line given. They're upstream's own tests, and the patch
 * doesn't touch the code they load. The saved runs sit beside this script, not in out/, because
 * lab/shared/result.ts counts what's in out/ as the lab's own run.
 */
const TIMING_FILE = 'server/__tests__/utils/helpers/modelPricing/index.test.js';
const TIMING_EVIDENCE = 'pricing-under-load.txt';
const FULL_RUN_EVIDENCE = 'pricing-full-run.json';
const TIMING_WAIT = 'a fixed 25 ms for file writes, which a busy machine can miss';
const TIMING_TESTS = [
  { test: 'ModelPricing cache mechanics fetches the remote pricing data and writes the disk cache', line: 64, inFullRun: true },
  { test: 'ModelPricing cache mechanics serves pricing from the disk cache without refetching when fresh', line: 90, inFullRun: true },
  { test: 'ModelPricing cache mechanics walks the full retrieval lifecycle: cold fetch, warm cache, revalidation, upstream change', line: 193, inFullRun: false },
  { test: 'ModelPricing cache mechanics recovers from a corrupted disk cache file by refetching', line: 275, inFullRun: false },
];

/** Why a failure happens, where a run has shown it. */
const EXPLAINED = [
  { where: 'ffmpeg/index.test.js', because: 'the sandbox image has no ffmpeg binary', covers: (f: Failure) => f.file === NEEDS_FFMPEG },
  { where: 'modelPricing/index.test.js', because: `it waits ${TIMING_WAIT}`, covers: (f: Failure) => f.file === TIMING_FILE && TIMING_TESTS.some((t) => t.test === f.test) },
];

/**
 * A test that passed in this run can still have failed in another, and a clean rerun mustn't erase that.
 * The site prints only the summary, so a run where these passed says so there, not just in the file.
 */
export const INTERMITTENT = TIMING_TESTS.map(({ test, line, inFullRun }) => ({
  file: TIMING_FILE,
  test,
  line,
  note: `ModelPricing timing tests passed here but fail on some runs, because they wait ${TIMING_WAIT}.`,
  seen: `${inFullRun ? `It failed in a full run of this commit, saved as ${FULL_RUN_EVIDENCE}, and passed in others. ` : ''}${TIMING_EVIDENCE} shows it failing at line ${line} under CPU load.`,
}));

type Intermittent = (typeof INTERMITTENT)[number];

/** Every failure gets its reason, or its name if it has none, so a count never stands alone. */
function whyFailed(failed: readonly Failure[]): string {
  if (!failed.length) return '';
  const groups = EXPLAINED.map((e) => ({ ...e, count: failed.filter(e.covers).length })).filter((g) => g.count > 0);
  const others = failed.filter((f) => !EXPLAINED.some((e) => e.covers(f)));
  const unexplained = `unexplained (${others.map((f) => f.test).join('; ')})`;
  if (!groups.length) return `, ${unexplained}`;
  if (groups.length === 1 && !others.length) return `, all in ${groups[0].where} because ${groups[0].because}`;
  const parts = groups.map((g) => `${g.count} in ${g.where} because ${g.because}`);
  return `: ${[...parts, ...(others.length ? [`${others.length} ${unexplained}`] : [])].join(', ')}`;
}

function failsOnOtherRuns(passedHere: readonly Intermittent[]): string {
  return [...new Set(passedHere.map((t) => t.note))].map((note) => ` ${note}`).join('');
}

export function summaryLine(tests: { total: number; passed: number; failed: number }, failed: readonly Failure[], checks: Record<string, number>, passedHere: readonly Intermittent[] = []): string {
  const badChecks = Object.entries(checks).filter(([name, code]) => name !== 'jest' && code !== 0).map(([name]) => name);
  const others = badChecks.length ? `${badChecks.join(', ')} failed` : 'every linter and check passed';
  return `${tests.passed} of ${tests.total} repo tests pass in the sandbox on Node 18, ${tests.failed} fail${whyFailed(failed)}, and ${others}.${failsOnOtherRuns(passedHere)}`;
}

/** What jest itself said went wrong: its first line, without the colour codes. */
function firstLine(messages: readonly string[] = []): string {
  return (messages[0] ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].trim();
}

const inRepo = (file: JestReport['testResults'][number]): string => file.name.replace(/^\/repo\//, '');

function failuresIn(file: JestReport['testResults'][number]): Failure[] {
  return file.assertionResults.filter((a) => a.status === 'failed').map((a) => {
    const message = firstLine(a.failureMessages);
    return { file: inRepo(file), test: a.fullName, ...(message ? { message } : {}) };
  });
}

/**
 * Only tests this run really passed: one it skipped or never reached says nothing either way. If any of them
 * failed here, that failure's own reason already says it.
 */
function intermittentPassedIn(report: JestReport, failed: readonly Failure[]): Intermittent[] {
  if (INTERMITTENT.some((t) => failed.some((f) => f.file === t.file && f.test === t.test))) return [];
  return INTERMITTENT.filter((t) => report.testResults.some((file) => inRepo(file) === t.file && file.assertionResults.some((a) => a.fullName === t.test && a.status === 'passed')));
}

/** The one-line summary and the detail, from jest's report and the exit codes the linters gave. */
export function summarize(report: JestReport, checks: Record<string, number>, commit: string, ranOn: string) {
  const failed = report.testResults.flatMap(failuresIn);
  const tests = { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests };
  return { summary: summaryLine(tests, failed, checks, intermittentPassedIn(report, failed)), commit, ran_on: ranOn, command: SANDBOX_COMMAND, tests, failed_tests: failed, checks, intermittent: INTERMITTENT };
}

export function parseChecks(text: string): Record<string, number> {
  const pairs = text.split('\n').filter(Boolean).map((line): [string, number] => {
    const at = line.lastIndexOf('=');
    return [line.slice(0, at), Number(line.slice(at + 1))];
  });
  return Object.fromEntries(pairs);
}

function main(worktree: string): void {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const run = spawnSync(join(ROOT, 'scripts', 'sandbox.sh'), ['anything-llm', worktree, SANDBOX_COMMAND], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`the sandbox run failed (exit ${run.status})`);
  const report = JSON.parse(readFileSync(join(WORK, 'jest.json'), 'utf8')) as JestReport;
  const commit = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const evidence = summarize(report, parseChecks(readFileSync(join(WORK, 'checks.txt'), 'utf8')), commit, new Date().toISOString().slice(0, 10));
  mkdirSync(join(LAB_DIR, 'out'), { recursive: true });
  writeFileSync(join(LAB_DIR, 'out', 'repo-tests.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(evidence.summary);
  for (const failure of evidence.failed_tests) console.log(`  failed: ${failure.file}: ${failure.test}`);
  rmSync(WORK, { recursive: true, force: true });
}

if (import.meta.main) {
  const [worktree] = process.argv.slice(2);
  if (!worktree) {
    console.error('Usage: node lab/02-whisper/repo-tests.ts <worktree>');
    process.exit(2);
  }
  try {
    main(resolve(worktree));
  } catch (error) {
    console.error(`repo-tests: ${(error as Error).message}`);
    process.exit(1);
  }
}
