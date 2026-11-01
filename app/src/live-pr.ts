// "Open pull request": turn a change keepup just made into a spec in docs/contracts.md's shape, and open it through the same
// code as every other pull request, as the App, on a fork in DEMO_ORG. With no App, it says the next command and writes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ChangeResult } from '../../src/change.ts';
import type { Finding } from '../../src/run-shape.ts';
import { requireAppConfig, type Env } from './config.ts';
import { createAppClient, isStatus } from './github.ts';
import { assertDemoRepo, assertPublicText } from './guard.ts';
import { createPrDeps, openOrUpdate } from './pr.ts';
import { assertPublicSafe, safeMessage } from './secrets.ts';
import { forkForClick, readGhToken } from './setup.ts';
import { foreignReferences, unsourcedNumbers } from './spec-text.ts';
import { EFFECT_WORDS, holdsCount, loadSpec, type PrSpec } from './specs.ts';

export const SETUP_COMMAND = 'npm run setup -- --org <your-org> --force';

export type OpenPrResult =
  | { state: 'needs_app'; command: string; detail: string }
  | { state: 'opened'; url: string; number: number; fork: string; ci: string }
  | { state: 'refused'; reason: string };

export interface OpenPrInput {
  root: string;
  base: string;
  changeId: string;
  env: Env;
  personToken?: () => Promise<string | null>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export function appIsConfigured(env: Env, root: string): boolean {
  try {
    requireAppConfig(env, root);
    return true;
  } catch {
    return false;
  }
}

function readChange(base: string, id: string): { change: ChangeResult; finding: Finding; patch: string } | null {
  const dir = join(base, id);
  const [changeFile, findingFile, patchFile] = ['change.json', 'finding.json', 'change.patch'].map((name) => join(dir, name));
  if (!existsSync(changeFile) || !existsSync(findingFile) || !existsSync(patchFile)) return null;
  return { change: JSON.parse(readFileSync(changeFile, 'utf8')) as ChangeResult, finding: JSON.parse(readFileSync(findingFile, 'utf8')) as Finding, patch: readFileSync(patchFile, 'utf8') };
}

/** Titles take no count: a contract rule, because a number in a title reads as a result. */
function titleFor(change: ChangeResult): string {
  const fallback = `Update ${change.files[0]?.split('/').pop() ?? 'a model default'} for a change upstream`;
  return [change.pr_title, change.title].find((title): title is string => Boolean(title) && !holdsCount(title as string)) ?? fallback;
}

const isPublicUrl = (url: string) => /^https?:\/\/\S+$/.test(url) && foreignReferences(url).length === 0;
const EFFORTS: Record<string, string> = { Hours: 'Hours', 'A day': 'A day', 'A day or more': 'A day', 'A project': 'A project' };

/** Numbers in the finding's own words already passed its checks against these sources. Model words with a number stay out. */
function specJson(change: ChangeResult, finding: Finding, lab: string, org: string, date: string): Record<string, unknown> {
  const [, name = ''] = change.repo.split('/');
  const sources = finding.sources.filter(isPublicUrl);
  const url = sources[0] ?? `https://github.com/${org}/${name}`;
  const title = titleFor(change);
  const summary = unsourcedNumbers(change.summary, []).length === 0 ? `${change.summary} ` : '';
  const where = finding.where.filter((place) => change.files.includes(place.file)).map((place) => ({ path: place.file, line: place.line }));
  return {
    schema: 1, id: `live-${change.id.slice(-6)}`, spec: `${lab}/change.md`, upstream: change.repo, fork: name, baseCommit: change.commit, baseBranch: `replay/${change.commit.slice(0, 8)}`,
    ciWorkflow: null, branch: change.branch, lab, source: 'keepup', sourceUrl: url, where, founderLine: title,
    effect: finding.effect.filter((word) => EFFECT_WORDS.includes(word)), effort: EFFORTS[finding.effort] ?? 'A day', whyItFits: finding.why,
    risks: change.kind === 'behind-a-setting' ? 'It stays off until someone turns the setting on. Check it in CI, and try it on real use.' : 'It changes what the product sends. Check it in CI, and try it on real use.',
    rollback: 'Revert this one commit.', proof: { vendor: { claim: finding.proof, url }, independent: null }, sources: sources.length ? sources : [url],
    sourcedNumbers: unsourcedNumbers(finding.why, []).map((text) => ({ text, source: url })), live: true,
    stages: [{ date, patches: ['patches/0001-change.patch'], title, whatShipped: `Source: ${url}`, whatThisChanges: `${summary}keepup wrote this change, and a person merges. Files: ${change.files.join(', ')}.`, comment: null }],
  };
}

function writeSpec(root: string, id: string, json: (lab: string) => Record<string, unknown>, patch: string, summary: string): { file: string } {
  const dir = join(root, 'data', 'live-prs', id);
  const lab = relative(root, dir);
  mkdirSync(join(dir, 'patches'), { recursive: true });
  writeFileSync(join(dir, 'patches', '0001-change.patch'), patch);
  writeFileSync(join(dir, 'change.md'), `${summary}\n`);
  const file = join(dir, 'pr.json');
  writeFileSync(file, `${JSON.stringify(json(lab), null, 2)}\n`);
  return { file };
}

/** The fork, made once for this explicit click if it isn't there. The guard allows that call for this one repo, into DEMO_ORG only. */
async function ensureLiveFork(input: OpenPrInput, org: string, repo: string): Promise<void> {
  const [owner = '', name = ''] = repo.split('/');
  const app = createAppClient(requireAppConfig(input.env, input.root), input.env);
  try {
    await app.request('GET /repos/{owner}/{repo}', { owner: org, repo: name });
    return;
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
  }
  const token = await (input.personToken ?? readGhToken)();
  if (!token) throw new Error(`${org} has no fork of ${repo} yet, and making one takes your own GitHub sign-in. Run: gh auth login, then press this again.`);
  await forkForClick({ token, env: input.env, org, root: input.root, owner, name, sleep: input.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))) });
}

function checkPublic(spec: PrSpec, patch: string, org: string): void {
  assertPublicSafe(patch, 'The patch');
  assertPublicText(`${spec.stages[0].title}\n${spec.whyItFits}\n${spec.stages[0].whatThisChanges}`, 'The pull request', org);
}

export async function openLivePr(input: OpenPrInput): Promise<OpenPrResult> {
  const { root, env, changeId } = input;
  if (!appIsConfigured(env, root)) return { state: 'needs_app', command: SETUP_COMMAND, detail: 'The GitHub App isn’t set up in .env, so nothing was written and nothing was sent.' };
  const read = readChange(input.base, changeId);
  if (!read) return { state: 'refused', reason: 'That change has no patch to open: it was refused, it’s written steps, or it has been cleaned up.' };
  const { change, finding, patch } = read;
  if (change.publish_block) return { state: 'refused', reason: change.publish_block };
  if (patch.includes('[masked]')) return { state: 'refused', reason: 'That patch holds masked text, so it isn’t what would be pushed.' };
  try {
    const org = env.DEMO_ORG as string;
    const [, name = ''] = change.repo.split('/');
    assertDemoRepo(org, name, env);
    const date = (input.now?.() ?? new Date()).toISOString().slice(0, 10);
    const spec = loadSpec(writeSpec(root, changeId, (lab) => specJson(change, finding, lab, org, date), patch, change.summary).file, root, { upstream: change.repo });
    checkPublic(spec, patch, org);
    await ensureLiveFork(input, org, change.repo);
    const outcome = await openOrUpdate(spec, { allowUnmeasured: true }, createPrDeps(root, env, input.sleep ? { sleep: input.sleep } : {}));
    return { state: 'opened', url: outcome.url, number: outcome.number, fork: `${org}/${name}`, ci: outcome.ci.state };
  } catch (error) {
    return { state: 'refused', reason: safeMessage(error) };
  }
}
