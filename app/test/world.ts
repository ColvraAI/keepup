// A throwaway repo root plus a fake GitHub, wired the way the real thing is.
import { after } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRepoFixture, type RepoFixture } from './fake-repos.ts';
import { startFakeGitHub, type FakeGitHub, type FakeOptions } from './fake-github.ts';
import { outDirFor, parseResult, writeResult } from '../../lab/shared/result.ts';
import { bodyDigest, type PrRecord } from '../src/objects.ts';
import { stagePatchIds } from '../src/patch-ids.ts';
import { findSpec } from '../src/specs.ts';
import { labOf, renderBody, renderTitle } from '../src/template.ts';


// No test may reach the real internet. Octokit goes through global fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') throw new Error(`A test tried to reach ${url.hostname}.`);
  return realFetch(input, init);
};

export const ORG = 'keepup-demo';
export const UPSTREAM = 'Mintplex-Labs/anything-llm';

let fixture: RepoFixture | null = null;
export function repoFixture(): RepoFixture {
  fixture ??= createRepoFixture();
  return fixture;
}

export function tempDir(prefix = 'keepup-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

export interface SpecOverrides { [key: string]: unknown }

export function specJson(baseCommit: string, overrides: SpecOverrides = {}): Record<string, unknown> {
  return {
    schema: 1,
    id: '06',
    spec: 'docs/prs/06-anythingllm-gpt6-models.md',
    upstream: UPSTREAM,
    fork: 'anything-llm',
    baseCommit,
    baseBranch: `replay/${baseCommit.slice(0, 8)}`,
    ciWorkflow: null,
    branch: 'keepup/2026-09-22-gpt-6-models',
    lab: 'lab/06-models',
    source: 'OpenAI API changelog',
    sourceUrl: 'https://developers.openai.com/api/docs/changelog',
    where: [{ path: 'server/utils/helpers/customModels.js', line: 2 }],
    founderLine: 'New OpenAI models your users can pick from the fallback list.',
    effect: ['new capability'],
    effort: 'Hours',
    whyItFits: 'The fallback list is what users pick from when the models API is unreachable.',
    risks: 'A model id could be wrong. The test checks the ids and that there are no duplicates.',
    rollback: 'Revert this pull request.',
    proof: { vendor: { claim: 'GPT-6 Sol and Luna are generally available', url: 'https://developers.openai.com/api/docs/changelog' }, independent: null },
    sources: ['https://developers.openai.com/api/docs/changelog', 'https://github.com/Mintplex-Labs/anything-llm/commit/5edf32b9'],
    stages: [
      {
        date: '2026-09-22',
        patches: ['patches/0001.patch', 'patches/0002.patch'],
        title: 'Add GPT-6 Sol and GPT-6 Luna · {{lab.title_number}}',
        whatShipped: 'GPT-6 Sol and GPT-6 Luna shipped on 22 Sep.',
        whatThisChanges: 'customModels.js gains two entries. Nothing is switched on by default.',
        comment: null,
      },
      {
        date: '2026-09-29',
        patches: ['patches/0003.patch'],
        title: 'Add GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol · {{lab.title_number}}',
        whatShipped: 'GPT-6.1 Sol shipped on 29 Sep.',
        whatThisChanges: 'customModels.js gains one more entry.',
        comment: 'Updated 29 Sep: GPT-6.1 Sol shipped.',
      },
    ],
    ...overrides,
  };
}

export const MEASURED_RESULT = `---
lab: 06-models
status: measured
measured_at: 2026-11-01
title_number: answers on 3 of 3 new models
---
| | before | after |
| --- | --- | --- |
| models answering | 0 | 3 |
`;

/** A measured result, as that lab's run would write it. */
export const measuredFor = (labName: string, text: string = MEASURED_RESULT): string => text.replace(/^lab: .*$/m, `lab: ${labName}`);

function writeResultText(root: string, labDir: string, text: string): void {
  if (parseResult(text).status === 'measured') writeMeasured(root, labDir, text);
  else writeText(join(root, labDir, 'result.md'), text);
}

export const NOT_RUN_RESULT = `---
lab: 06-models
status: not_run
needs: OPENAI_API_KEY
---
Sends one real request to each new model. Needs OPENAI_API_KEY.
`;

/** A measured result the way a lab's run leaves it: its raw output under out/, then the result through writeResult. */
export function writeMeasured(root: string, labDir: string, text: string = MEASURED_RESULT, file = 'result.md', labName: string = basename(labDir)): void {
  const path = join(root, labDir, file);
  writeText(join(outDirFor(path), 'raw.json'), '{}\n');
  writeResult(path, parseResult(measuredFor(labName, text)));
}

/** Writes a spec, its patches, its result and the docs file into a temp root. */
export function installSpec(root: string, fix: RepoFixture, opts: { overrides?: SpecOverrides; result?: string | null; file?: string; labDir?: string } = {}): Record<string, unknown> {
  const labDir = opts.labDir ?? 'lab/06-models';
  const json = specJson(fix.baseCommit, { lab: labDir, ...opts.overrides });
  writeJson(join(root, labDir, opts.file ?? 'pr.json'), json);
  fix.patches.forEach((p, i) => {
    const target = join(root, labDir, 'patches', `000${i + 1}.patch`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(p, target);
  });
  writeText(join(root, labDir, 'out', 'raw.json'), '{}\n');
  if (opts.result !== null) writeResultText(root, labDir, opts.result ?? MEASURED_RESULT);
  writeText(join(root, String(json.spec)), '# the spec\n');
  return json;
}

export function installTimeline(root: string, repos: unknown[], window: unknown = {}): void {
  writeJson(join(root, 'data/timeline.json'), { version: 1, window, repos });
}

export function installDb(root: string, name: string, records: unknown[]): void {
  const path = join(root, 'data/db', `${name}.jsonl.gz`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(records.map((r) => JSON.stringify(r)).join('\n')));
}

export interface World {
  root: string;
  dir: string;
  fake: FakeGitHub;
  env: Record<string, string>;
  fix: RepoFixture;
}

/** A fork that already exists, an App already installed, and a clean root. */
export async function createWorld(options: Partial<FakeOptions> = {}): Promise<World> {
  const dir = tempDir();
  const root = join(dir, 'root');
  mkdirSync(root);
  const fix = repoFixture();
  const fake = await startFakeGitHub({ dir, org: ORG, ...options });
  after(() => fake.close());
  fake.addRepo('Mintplex-Labs', 'anything-llm', fix.bare);
  fake.addRepo(ORG, 'anything-llm', fix.bare, { fork: true, parent: UPSTREAM });
  const keyPath = join(dir, 'outside-repo.private-key.pem');
  writeText(keyPath, fake.privateKey);
  return {
    root,
    dir,
    fake,
    fix,
    env: {
      DEMO_ORG: ORG,
      GITHUB_APP_ID: String(fake.options.appId),
      GITHUB_APP_SLUG: fake.options.slug,
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      GITHUB_APP_INSTALLATION_ID: String(fake.options.installationId),
      KEEPUP_GITHUB_API_URL: fake.url,
      KEEPUP_GIT_BASE_URL: fake.gitUrl,
    },
  };
}

/** A record whose words are exactly what this spec and lab render, the way a real run leaves one. */
export function recordFor(root: string, id: string, overrides: Partial<PrRecord> = {}): PrRecord {
  const spec = findSpec(id, root);
  const lab = labOf(spec, root);
  const dates = overrides.stagesApplied ?? spec.stages.map((s) => s.date);
  const applied = spec.stages.filter((s) => dates.includes(s.date));
  return {
    number: 1, url: `https://github.com/${ORG}/${spec.fork}/pull/1`, state: 'open', base: spec.baseBranch, head: spec.branch, author: 'keepup-ai[bot]',
    stagesApplied: dates, ci: { state: 'success', url: 'https://github.com/x' }, checkedAt: '2026-11-01T09:00:00Z',
    title: renderTitle(applied[applied.length - 1], lab, { allowUnmeasured: true }),
    bodyDigest: bodyDigest(renderBody(spec, { org: ORG, applied, lab, allowUnmeasured: true })),
    patchIds: stagePatchIds(spec, dates),
    ...overrides,
  };
}

/** Everything in the fake's log that names an upstream owner, except the one allowed fork call. */
export function upstreamRequests(fake: FakeGitHub): string[] {
  return fake.requests
    .filter((r) => /^\/repos\/(mintplex-labs|mezmo)\//i.test(r.path))
    .map((r) => `${r.method} ${r.path}`);
}
