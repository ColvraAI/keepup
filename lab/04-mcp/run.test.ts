import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { loadSpec } from '../../app/src/specs.ts';
import { REPO_ROOT } from '../shared/env.ts';
import { manifestProblem, readResult, renderResult } from '../shared/result.ts';
import { newFileFromPatch, parseServers, resolveTemplates, type HttpSpec, type StdioSpec } from './lib/example.ts';
import { recordFile, type RawRecord } from './lib/records.ts';
import { SECRET_NAMES } from './lib/scrub.ts';
import { main, type Deps, type SandboxRequest } from './run.ts';
import { AURA_IMAGE, AURA_IMAGE_DIGEST, AURA_IMAGE_NAME, AURA_TAG, BASE_COMMIT, BASE_SHORT, EXAMPLE_MODEL, INVESTIGATION_PROMPT, JUNK_SENTRY_TOKEN, LAB_NAME, NODE_VERSION, SDK_VERSION, SERVERS, TITLE_NUMBER, CONFIG_NAMES } from './servers.ts';
import { SENTRY_EVENT_MESSAGE } from './testset/send-signoz-telemetry.ts';

const LAB_DIR = import.meta.dirname;
const CLONE = join(REPO_ROOT, 'tmp', 'aura');
const NO_CLONE = existsSync(join(CLONE, '.git')) ? false : 'tmp/aura is not here';
const pr = JSON.parse(readFileSync(join(LAB_DIR, 'pr.json'), 'utf8'));
const allPatches: string[] = pr.stages.flatMap((s: { patches: string[] }) => s.patches);
const patchText = (i: number) => readFileSync(join(LAB_DIR, pr.stages[i].patches[0]), 'utf8');
const SENTRY = 'examples/complete/incident-response-sentry.toml';
const SIGNOZ = 'examples/complete/incident-response-signoz.toml';
const DYNATRACE = 'examples/complete/incident-response-dynatrace-managed.toml';
const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const FAKE_SENTRY = 'sntrys_not_a_real_token_0123456789';
const git = (...args: string[]) => execFileSync('git', ['-C', CLONE, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---- pr.json against docs/contracts.md

test('pr.json has every contract field, and the App loads it', () => {
  const required = ['schema', 'id', 'spec', 'upstream', 'fork', 'baseCommit', 'baseBranch', 'ciWorkflow', 'branch', 'lab', 'source', 'sourceUrl', 'where', 'founderLine', 'effect', 'effort', 'whyItFits', 'risks', 'rollback', 'proof', 'sources', 'stages'];
  for (const field of required) assert.ok(field in pr, `missing ${field}`);
  assert.equal(pr.schema, 1);
  assert.equal(pr.id, '04');
  assert.equal(pr.spec, 'docs/prs/04-aura-incident-mcp-servers.md');
  assert.equal(pr.upstream, 'mezmo/aura');
  assert.equal(pr.fork, 'aura');
  assert.equal(pr.baseCommit, BASE_COMMIT);
  assert.equal(pr.baseBranch, 'replay/3a49ac4');
  assert.equal(pr.ciWorkflow, 'lab/ci/aura.yml');
  assert.equal(pr.branch, 'keepup/2026-09-25-incident-mcp-servers');
  assert.equal(pr.lab, 'lab/04-mcp');
  assert.deepEqual(pr.effect, ['new capability']);
  assert.equal(pr.effort, 'Hours');
  assert.equal(pr.proof.independent, null);
  for (const url of [pr.sourceUrl, pr.proof.vendor.url, ...pr.sources]) assert.match(url, /^https:\/\/\S+$/);
  for (const url of ['https://github.com/getsentry/toolkit/releases/tag/0.42.0', 'https://github.com/SigNoz/signoz-mcp-server', 'https://github.com/dynatrace-oss/dynatrace-managed-mcp', 'https://registry.modelcontextprotocol.io']) assert.ok(pr.sources.includes(url), `${url} is in sources`);
  assert.equal(loadSpec(join(LAB_DIR, 'pr.json'), REPO_ROOT).stages.length, 2);
});

test('the founder line has no measured number and no jargon', () => {
  assert.ok(!/\d/.test(pr.founderLine), pr.founderLine);
  assert.ok(!/\bMCP\b|TOML|stdio/.test(pr.founderLine), pr.founderLine);
});

test('the two stages carry the replay dates, the exact titles and the comment rules', () => {
  assert.deepEqual(pr.stages.map((s: { date: string }) => s.date), ['2026-09-25', '2026-10-30']);
  const [first, second] = pr.stages;
  assert.equal(first.title, 'Add Sentry as an incident integration');
  assert.equal(first.titleUnmeasured ?? null, null);
  assert.equal(first.comment, null);
  assert.equal(second.title, 'Add Sentry, SigNoz and Dynatrace as incident integrations · {{lab.title_number}}');
  assert.equal(second.titleUnmeasured, 'Add Sentry, SigNoz and Dynatrace as incident integrations', 'app/src/specs.ts refuses a count here');
  assert.equal(TITLE_NUMBER, '2 of 3 vendor MCP servers tested, Dynatrace Managed listed but not tested', 'the spec: "official" fits Sentry and SigNoz, not Dynatrace Managed, and "tested" only fits what a call read');
  assert.match(readFileSync(join(REPO_ROOT, pr.spec), 'utf8'), new RegExp(`· ${TITLE_NUMBER}"`), 'the spec gives the same title');
  assert.equal(second.comment, 'Updated 30 Oct: new releases of SigNoz MCP (v0.17.0) and Dynatrace Managed MCP (v2.0.0), so this pull request now covers all three servers.');
  for (const stage of pr.stages) {
    assert.ok(stage.whatShipped && stage.whatThisChanges);
    for (const patch of stage.patches) assert.ok(existsSync(join(LAB_DIR, patch)), `${patch} exists`);
  }
  assert.match(pr.stages[0].whatShipped, /v0\.42\.0/);
  assert.match(pr.stages[1].whatShipped, /v0\.17\.0/);
  assert.match(pr.stages[1].whatShipped, /v2\.0\.0/);
});

const WHERE_CLAIMS: Record<string, string> = {
  'README.md:78': '## Integrations',
  'examples/complete/incident-response-datadog.toml:26': '[mcp.servers.datadog]',
};

test('every where line says what it claims at the base commit', { skip: NO_CLONE }, () => {
  assert.equal(pr.where.length, Object.keys(WHERE_CLAIMS).length);
  for (const { path, line } of pr.where) {
    const claim = WHERE_CLAIMS[`${path}:${line}`];
    assert.ok(claim, `no expectation for ${path}:${line}`);
    const text = git('show', `${BASE_COMMIT}:${path}`).split('\n')[line - 1];
    assert.equal(text, claim);
  }
});

test('what keepup saw holds at the base: 25 rows, and none of the three servers', { skip: NO_CLONE }, () => {
  const readme = git('show', `${BASE_COMMIT}:README.md`);
  const table = readme.slice(readme.indexOf('| Integration |')).split('\n\n')[0].split('\n').slice(2);
  assert.equal(table.length, 25);
  for (const name of ['Sentry', 'SigNoz', 'Dynatrace']) assert.ok(!table.join('\n').includes(name));
  const examples = git('ls-tree', '--name-only', BASE_COMMIT, 'examples/complete/').split('\n');
  assert.ok(examples.includes('examples/complete/incident-response-datadog.toml'));
  assert.ok(!examples.includes('examples/complete/incident-response-checkly.toml'), 'checkly is not a pattern at the base');
});

// ---- the patches

test('the patches carry the bot and their replay dates, in order', () => {
  assert.equal(allPatches.length, 2);
  assert.match(patchText(0), /^From: "keepup\[bot\]"/m);
  assert.match(patchText(0), /^Date: Fri, 25 Sep 2026 12:00:00 \+0000$/m);
  assert.match(patchText(1), /^Date: Fri, 30 Oct 2026 12:00:00 \+0000$/m);
  assert.match(patchText(0), /Replay date: 2026-09-25/);
  assert.match(patchText(1), /Replay date: 2026-10-30/);
  assert.match(patchText(0), /^Subject: \[PATCH 1\/2\] feat\(examples\): /m);
  assert.match(patchText(1), /^Subject: \[PATCH 2\/2\] feat\(examples\): /m);
});

test('the patches apply in order at the base and leave the README table sorted', { skip: NO_CLONE }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-apply-'));
  execFileSync('sh', ['-c', `git -C "${CLONE}" archive ${BASE_COMMIT} README.md | tar -x -C "${dir}"`]);
  const applyGit = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  applyGit('init', '-q');
  for (const patch of allPatches) applyGit('apply', join(LAB_DIR, patch));
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const rows = readme.slice(readme.indexOf('| Integration |')).split('\n\n')[0].split('\n').slice(2);
  assert.equal(rows.length, 28);
  const names = rows.map((row) => row.split('|')[1].trim().replace(/^\[([^\]]+)\].*$/, '$1').toLowerCase());
  assert.deepEqual(names, [...names].sort());
  assert.ok(rows.includes('| Sentry | Search issues and errors, read stack traces and events, and find the release that introduced a problem |'), 'the spec gives this row exactly');
  assert.ok(rows.some((r) => r.startsWith('| SigNoz | ')));
  assert.ok(rows.some((r) => r.startsWith('| Dynatrace Managed | ')));
  for (const example of [SENTRY, SIGNOZ, DYNATRACE]) assert.ok(existsSync(join(dir, example)));
});

test('the first patch alone only adds Sentry', () => {
  assert.throws(() => newFileFromPatch(patchText(0), SIGNOZ));
  assert.ok(newFileFromPatch(patchText(0), SENTRY).includes('mcp.sentry.dev'));
  assert.ok(newFileFromPatch(patchText(1), SIGNOZ).includes('signoz/signoz-mcp-server:v0.17.0'));
  assert.ok(newFileFromPatch(patchText(1), DYNATRACE).includes('dynatrace-managed-mcp-server@2.0.0'));
});

// ---- the examples

const example = (path: string) => newFileFromPatch(patchText(path === SENTRY ? 0 : 1), path);

test('Sentry: its hosted server, the skill that leaves out issue updates, and the token only from the environment', () => {
  const server = parseServers(example(SENTRY)).sentry as HttpSpec;
  assert.equal(server.transport, 'http_streamable');
  assert.equal(server.url, 'https://mcp.sentry.dev/mcp?skills=inspect');
  assert.equal(server.headers.Authorization, "Sentry-Bearer {{ env.SENTRY_ACCESS_TOKEN | default: '' }}");
  assert.equal((resolveTemplates(server, { SENTRY_ACCESS_TOKEN: 't' }) as HttpSpec).headers.Authorization, 'Sentry-Bearer t');
});

test('SigNoz: the pinned image over stdio, with the key handed over by name', () => {
  const server = parseServers(example(SIGNOZ)).signoz as StdioSpec;
  assert.deepEqual(server.cmd, ['docker']);
  assert.deepEqual(server.args, ['run', '-i', '--rm', '-e', 'SIGNOZ_URL', '-e', 'SIGNOZ_API_KEY', 'signoz/signoz-mcp-server:v0.17.0']);
  assert.deepEqual(server.env, { SIGNOZ_URL: "{{ env.SIGNOZ_URL | default: '' }}", SIGNOZ_API_KEY: "{{ env.SIGNOZ_API_KEY | default: '' }}" });
});

test('Dynatrace: the pinned npm package over stdio, with no token in the file', () => {
  const text = example(DYNATRACE);
  const server = parseServers(text).dynatrace_managed as StdioSpec;
  assert.deepEqual(server.cmd, ['npx']);
  assert.deepEqual(server.args, ['-y', '@dynatrace-oss/dynatrace-managed-mcp-server@2.0.0']);
  assert.deepEqual(server.env, { LOG_OUTPUT: 'stderr-all' });
  assert.ok(!/^[^#]*apiToken/m.test(text), 'the token shape only appears in the prerequisites comment');
});

test('the patches say what is true: the SigNoz claim is about bytes, and nothing unsourced stays', () => {
  const second = patchText(1);
  assert.ok(!/most of the server's tool list/.test(second), 'by count the write tools are not most of the list');
  assert.match(example(SIGNOZ), /write tools\n# carry most of the definition size sent to the model on every turn/);
  assert.ok(!/tool list\s+sent to the model small/.test(second), 'what remains is not small');
  assert.ok(!/official MCP servers/.test(second), 'Dynatrace Managed is community-supported');
  assert.ok(!/hosted-only/.test(second), 'the table has self-hosted tools such as Prometheus');
  assert.ok(!/first stop in most incidents/.test(patchText(0)), 'that claim has no source');
  assert.ok(!/read-only/.test(patchText(0)), 'execute_sentry_tool is in the inspect list, and its server marks it destructive');
  assert.match(example(SENTRY), /skills=inspect leaves out the tools that update issues/);
  assert.match(patchText(0), /^Source: https:\/\/github\.com\/getsentry\/toolkit\/releases\/tag\/0\.42\.0$/m);
});

test("the Node wording matches the package's engines range, which stops below 27", () => {
  assert.match(example(DYNATRACE), new RegExp(`Node\\.js 26 \\(${NODE_VERSION.replaceAll('.', '\\.')} or later\\), as the package's engines field requires`));
  assert.ok(pr.risks.includes(`Node.js 26 (${NODE_VERSION} or later), as its package requires`));
  for (const text of [patchText(1), pr.risks]) assert.ok(!text.includes(`Node.js ${NODE_VERSION} or later`), 'the range has an upper bound, so "or later" alone misstates it');
});

test('pr.json keeps "official" off Dynatrace Managed, and only claims write tools where there are some', () => {
  assert.equal(pr.proof.vendor.claim, "Sentry's and SigNoz's official servers and Dynatrace's own, community-supported server, all listed in the MCP Registry");
  assert.ok(!pr.proof.vendor.claim.endsWith('.'), 'the template adds a comma and the link after it');
  assert.ok(!/official/.test(pr.stages[1].whatShipped));
  assert.match(pr.stages[1].whatShipped, /new releases of the vendors' own servers/);
  assert.match(pr.risks, /Sentry's and SigNoz's servers also have write tools/);
  assert.ok(!/read-only skills/.test(pr.risks));
  assert.match(pr.risks, /PagerDuty/);
  assert.match(pr.risks, /answer without an error when they can't reach the cluster/, 'lib/fixtures/no-credentials-calls-dynatrace_managed.json');
});

test('every example follows the sibling pattern and resolves with nothing but the shipped test env', () => {
  for (const path of [SENTRY, SIGNOZ, DYNATRACE]) {
    const text = example(path);
    assert.ok(text.includes('[mcp.servers.pagerduty]'), `${path} keeps PagerDuty`);
    assert.ok(text.includes('sanitize_schemas = true'));
    assert.ok(text.includes(`CONFIG_PATH=${path} cargo run --bin aura -- webserver`));
    assert.ok(text.includes('api_key = "{{ env.OPENAI_API_KEY }}"'));
    assert.ok(text.includes(`model = "${EXAMPLE_MODEL}"`));
    for (const spec of Object.values(parseServers(text))) assert.doesNotThrow(() => resolveTemplates(spec, {}), 'no server template needs a value');
    assert.ok(!/(sk-[A-Za-z0-9]{12}|sntrys_|dt0s01\.[A-Z0-9]{8})/.test(text), `${path} has no key in it`);
  }
});

test('the AURA the lab runs is the tag upstream put on the base commit', { skip: NO_CLONE }, () => {
  assert.equal(git('rev-parse', `${AURA_TAG}^{commit}`).trim(), BASE_COMMIT);
  assert.ok(git('tag', '--points-at', BASE_COMMIT).split('\n').includes(AURA_TAG));
  assert.equal(BASE_COMMIT.slice(0, BASE_SHORT.length), BASE_SHORT);
});

test('the image is the one named for that tag, pinned by digest, so a moved tag cannot change what runs', () => {
  assert.equal(AURA_IMAGE_NAME, `mezmo/aura:${AURA_TAG.replace(/^v/, '')}`);
  assert.match(AURA_IMAGE_DIGEST, /^sha256:[0-9a-f]{64}$/);
  assert.equal(AURA_IMAGE, `${AURA_IMAGE_NAME}@${AURA_IMAGE_DIGEST}`);
});

test("repo-tests.json says what its raw log says, and that log compiled this code rather than reusing a shared binary", () => {
  const record = JSON.parse(readFileSync(join(LAB_DIR, 'out', 'repo-tests.json'), 'utf8'));
  const log = readFileSync(join(LAB_DIR, 'out', 'repo-tests.log'), 'utf8');
  assert.match(log, /^\s*Compiling aura-config /m, '/target is a shared volume, so a run that compiled nothing may have run someone else\'s test binary');
  assert.match(record.command, /cargo clean -p aura-config/);
  assert.equal(record.commit, patchText(1).match(/^From ([0-9a-f]{40}) /)?.[1], 'it is the commit the last patch came from');
  const total = [...log.matchAll(/^running (\d+) tests?$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
  assert.ok(total > 0);
  assert.deepEqual(record.tests, { total, passed: total, failed: 0, ignored: 0 });
  assert.ok(record.summary.startsWith(`${total} of ${total} aura-config tests pass`), record.summary);
  for (const line of [...record.results, record.loads_every_example]) assert.ok(log.includes(line), `the log has: ${line}`);
});

test('the patches change only the README and examples, so the base holds all of the code the pull request would run', () => {
  const touched = allPatches.flatMap((patch) => [...readFileSync(join(LAB_DIR, patch), 'utf8').matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]));
  assert.ok(touched.length > 0);
  for (const path of touched) assert.match(path, /^(README\.md|examples\/complete\/incident-response-[a-z-]+\.toml)$/);
});

test('the lab table of servers agrees with the patches', () => {
  assert.deepEqual(SERVERS.map((s) => s.example).sort(), [DYNATRACE, SENTRY, SIGNOZ].sort());
  for (const server of SERVERS) {
    const servers = parseServers(example(server.example));
    assert.ok(servers[server.id], `${server.example} has a server called ${server.id}`);
  }
});

// ---- run.ts, with every outside thing faked

interface World {
  root: string;
  deps: Deps;
  sandboxCalls: SandboxRequest[];
  bridges: { allowed: readonly (readonly string[])[]; token: string; closed: boolean }[];
  pulled: string[];
  trees: { prepared: string[]; removed: string[] };
  logs: string[];
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'keepup-lab04-'));
  const lab = join(root, 'lab', LAB_NAME);
  mkdirSync(join(lab, 'patches'), { recursive: true });
  writeFileSync(join(lab, 'pr.json'), JSON.stringify(pr));
  for (const patch of allPatches) cpSync(join(LAB_DIR, patch), join(lab, patch));
  return root;
}

function toolsRecord(server: RawRecord['server'], keyInIt = ''): RawRecord {
  return {
    kind: 'tools', ok: true, server, example: 'x', measuredAt: '2026-11-01T10:00:00.000Z', transport: 'stdio', startedAs: `start ${server}`, credentials: 'real',
    client: `sdk ${keyInIt}`, serverInfo: { name: server, version: '1' }, elapsedMs: 5, toolNames: ['a', 'b'], tools: [],
  };
}

function fullRecords(server: RawRecord['server'], credentials: 'real' | 'placeholder' = 'real'): RawRecord[] {
  const base = { server, example: 'x', measuredAt: '2026-11-01T10:00:00.000Z', aura: AURA_TAG, alias: 'a', credentials };
  return [
    { ...(toolsRecord(server) as object), credentials } as RawRecord,
    { ...base, kind: 'aura-tools', ok: true, toolsByServer: { [server]: ['a', 'b'] } },
    { ...base, kind: 'offered', ok: true, toolNames: ['a'], otherTools: [], sentBytes: 10, sizes: null },
  ];
}

const READS: Record<RawRecord['server'], string> = { sentry: 'search_issues', signoz: 'signoz_search_logs', dynatrace_managed: 'dynatrace_managed_list_problems' };

function answeredRecord(server: RawRecord['server'], extra: object = {}): RawRecord {
  return {
    kind: 'investigation', ok: true, server, example: 'x', measuredAt: '2026-11-02T10:00:00.000Z', aura: AURA_TAG, alias: 'a', credentials: 'real', prompt: INVESTIGATION_PROMPT, provider: 'openai', model: EXAMPLE_MODEL, llmSwapped: false,
    toolsByServer: { [server]: [READS[server]] }, mcpServers: [], toolCalls: [{ id: '1', name: READS[server], ok: true, ms: 3 }], timeToFirstTextMs: 1, timeToAnswerMs: 2, answer: 'because', usage: null, ...extra,
  } as RawRecord;
}

const fileFor = (record: RawRecord) => recordFile(record.kind, record.server, record.ok);
const writeRecords = (dir: string, records: readonly RawRecord[]) => {
  mkdirSync(dir, { recursive: true });
  for (const record of records) writeFileSync(join(dir, fileFor(record)), JSON.stringify(record));
};
const ALL_SERVERS = ['sentry', 'signoz', 'dynatrace_managed'] as const;
const measuredRecords = (): RawRecord[] => [...ALL_SERVERS.flatMap((s) => fullRecords(s)), answeredRecord('sentry'), answeredRecord('signoz')];
const ALL_KEYS = { SENTRY_ACCESS_TOKEN: FAKE_SENTRY, OPENAI_API_KEY: FAKE_KEY, SIGNOZ_URL: 'http://host.docker.internal:8080', SIGNOZ_API_KEY: 'signoz-key-not-real-012345' };

function makeWorld(env: Record<string, string | undefined>, writes: (request: SandboxRequest, rawDir: string) => void = () => undefined, sandboxStatus = 0): World {
  const root = tempRoot();
  const world: World = { root, sandboxCalls: [], bridges: [], pulled: [], trees: { prepared: [], removed: [] }, logs: [], deps: undefined as unknown as Deps };
  world.deps = {
    root,
    env,
    sandbox: async (request) => {
      world.sandboxCalls.push(request);
      const plan = JSON.parse(readFileSync(request.planFile, 'utf8'));
      const rawDir = plan.rawDir.replace('/lab-work', join(root, 'lab', '.work'));
      mkdirSync(rawDir, { recursive: true });
      writes(request, rawDir);
      return { status: sandboxStatus, output: 'sandbox log' };
    },
    runLocal: async () => { throw new Error('the host harness must not run in this test'); },
    prepareTree: (_base, _patches, dest) => {
      world.trees.prepared.push(dest);
      mkdirSync(join(dest, 'examples', 'complete'), { recursive: true });
      for (const path of [SENTRY, SIGNOZ, DYNATRACE]) writeFileSync(join(dest, path), example(path));
    },
    removeTree: (dest) => {
      world.trees.removed.push(dest);
      rmSync(dest, { recursive: true, force: true });
    },
    ensureAura: async (binDir, arch) => {
      const dir = join(binDir, `${AURA_TAG}-${arch}`);
      return { image: AURA_IMAGE, binarySha256: 'x', binary: join(dir, 'aura'), libDir: join(dir, 'lib'), loader: join(dir, 'lib', 'ld-linux-aarch64.so.1') };
    },
    dockerArch: () => 'arm64',
    pullImage: (image) => { world.pulled.push(image); },
    startBridge: async (options) => {
      const entry = { allowed: options.allowed, token: options.token, closed: false };
      world.bridges.push(entry);
      return { port: 54321, close: async () => { entry.closed = true; } };
    },
    log: (line) => { world.logs.push(line); },
  };
  return world;
}

const resultPath = (root: string) => join(root, 'lab', LAB_NAME, 'result.md');
const outDir = (root: string) => join(root, 'lab', LAB_NAME, 'out');

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

test('unknown flags are refused', async () => {
  const world = makeWorld({});
  await assert.rejects(main(['--nope'], world.deps), /Unknown flag/);
});

test('--no-keys --no-start writes the honest not_run result and exits 3, without reading .env', async () => {
  const world = makeWorld({ OPENAI_API_KEY: FAKE_KEY, SENTRY_ACCESS_TOKEN: FAKE_SENTRY });
  writeFileSync(join(world.root, '.env'), `SENTRY_ACCESS_TOKEN=${FAKE_SENTRY}\n`);
  const code = await main(['--no-keys', '--no-start'], world.deps);
  assert.equal(code, 3);
  assert.equal(world.sandboxCalls.length, 0);
  const result = readResult(resultPath(world.root));
  assert.equal(result?.status, 'not_run');
  assert.match(result?.needs ?? '', /SENTRY_ACCESS_TOKEN/);
  assert.ok(!readFileSync(resultPath(world.root), 'utf8').includes(FAKE_SENTRY));
});

test('a run with no keys starts only the servers that need none, and passes no key anywhere', async () => {
  const world = makeWorld({ PATH: process.env.PATH, OPENAI_API_KEY: FAKE_KEY, SENTRY_ACCESS_TOKEN: FAKE_SENTRY }, (_request, rawDir) => {
    writeFileSync(join(rawDir, recordFile('tools', 'signoz')), JSON.stringify(toolsRecord('signoz')));
    writeFileSync(join(rawDir, recordFile('tools', 'dynatrace_managed')), JSON.stringify(toolsRecord('dynatrace_managed')));
  });
  writeFileSync(join(world.root, '.env'), `SENTRY_ACCESS_TOKEN=${FAKE_SENTRY}\n`);
  const code = await main(['--no-keys'], world.deps);
  assert.equal(code, 3);
  const request = world.sandboxCalls[0];
  const plan = JSON.parse(readFileSync(request.planFile, 'utf8'));
  assert.deepEqual(plan.servers.map((s: { id: string }) => s.id).sort(), ['dynatrace_managed', 'signoz']);
  assert.ok(plan.servers.every((s: { credentials: string; investigate: boolean }) => s.credentials === 'placeholder' && !s.investigate));
  assert.equal(request.env.SENTRY_ACCESS_TOKEN, undefined);
  assert.equal(request.env.OPENAI_API_KEY, undefined);
  assert.ok(!request.env.SANDBOX_ENV.includes('SENTRY_ACCESS_TOKEN'));
  const result = readResult(resultPath(world.root));
  assert.equal(result?.status, 'partial');
  assert.equal(result?.title_number, undefined);
  assert.match(result?.needs ?? '', /^SENTRY_ACCESS_TOKEN/);
  assert.ok(!/\| Sentry \|/.test(result?.body ?? ''));
});

test('the real run uses the lab worktree, the sandbox, the real client and the bridge, then removes the worktree', async () => {
  const world = makeWorld({});
  const code = await main(['--no-keys'], world.deps);
  assert.equal(code, 3);
  const tree = join(world.root, 'tmp', 'lab-wt-04');
  assert.deepEqual(world.trees.prepared, [tree]);
  assert.deepEqual(world.trees.removed, [tree]);
  const request = world.sandboxCalls[0];
  assert.equal(request.worktree, tree);
  assert.match(request.command, new RegExp(`setup\\.sh /lab-work/04-mcp/toolchain ${NODE_VERSION} ${SDK_VERSION}`));
  assert.match(request.command, /harness\/bin:/);
  assert.match(request.command, /sandbox-main\.ts \/lab-work\/04-mcp\/run\/plan\.json/);
  assert.match(request.command, /npm_config_cache=\/tmp\/npm-cache/, 'off the bind mount, where a cold npx failed');
  const plan = JSON.parse(readFileSync(request.planFile, 'utf8'));
  assert.equal(plan.repo, '/repo');
  assert.equal(plan.client, 'sdk');
  assert.equal(plan.sdkVersion, SDK_VERSION);
  const auraDir = `/lab-work/bin/${AURA_TAG}-arm64`;
  assert.deepEqual(plan.auraCommand, [`${auraDir}/lib/ld-linux-aarch64.so.1`, '--library-path', `${auraDir}/lib`, `${auraDir}/aura`], "the image's own loader and libraries, because the binary needs a newer glibc than the sandbox has");
  assert.equal(plan.prompt, INVESTIGATION_PROMPT);
  assert.deepEqual(world.pulled, ['signoz/signoz-mcp-server:v0.17.0']);
  assert.deepEqual(world.bridges[0].allowed, [['run', '-i', '--rm', '-e', 'SIGNOZ_URL', '-e', 'SIGNOZ_API_KEY', 'signoz/signoz-mcp-server:v0.17.0']]);
  assert.equal(world.bridges[0].closed, true);
  assert.equal(request.env.BRIDGE_ADDR, 'host.docker.internal:54321');
  assert.equal(request.env.BRIDGE_TOKEN, world.bridges[0].token);
  assert.ok(world.bridges[0].token.length >= 32);
  assert.ok(!request.command.includes(world.bridges[0].token), 'no secret on a command line');
  assert.match(request.env.SANDBOX_ENV, /BRIDGE_ADDR/);
  assert.match(request.env.SANDBOX_ENV, /BRIDGE_TOKEN/);
});

test('a real run saves which image it used beside its records, and reading the records skips it', async () => {
  const world = makeWorld({}, (_request, rawDir) => writeRecords(rawDir, [...fullRecords('signoz', 'placeholder'), ...fullRecords('dynatrace_managed', 'placeholder')]));
  assert.equal(await main(['--no-keys'], world.deps), 3);
  const saved = JSON.parse(readFileSync(join(outDir(world.root), 'aura-image.json'), 'utf8'));
  assert.deepEqual(saved, { tag: AURA_TAG, tagCommit: BASE_COMMIT, image: AURA_IMAGE, binarySha256: 'x' });
  assert.equal(readResult(resultPath(world.root))?.status, 'partial');
});

test('a sandbox dry run uses the same copy of AURA as a real run, so it takes no second copy on disk', async () => {
  const world = makeWorld({});
  await main(['--dry-run', '--sandbox'], world.deps);
  const plan = JSON.parse(readFileSync(world.sandboxCalls[0].planFile, 'utf8'));
  assert.equal(plan.auraCommand[plan.auraCommand.length - 1], `/lab-work/bin/${AURA_TAG}-arm64/aura`);
});

test('with keys, the plan runs everything, and the keys go by name and never into the plan or the command', async () => {
  const secrets = { OPENAI_API_KEY: FAKE_KEY, SENTRY_ACCESS_TOKEN: FAKE_SENTRY, SIGNOZ_URL: 'http://host.docker.internal:8080', SIGNOZ_API_KEY: 'signoz-key-not-real-012345' };
  const world = makeWorld(secrets);
  await main([], world.deps);
  const request = world.sandboxCalls[0];
  const planText = readFileSync(request.planFile, 'utf8');
  for (const value of [FAKE_KEY, FAKE_SENTRY, 'signoz-key-not-real-012345']) {
    assert.ok(!planText.includes(value), 'not in the plan');
    assert.ok(!request.command.includes(value), 'not on the command line');
  }
  assert.equal(request.env.OPENAI_API_KEY, FAKE_KEY);
  assert.equal(request.env.SENTRY_ACCESS_TOKEN, FAKE_SENTRY);
  for (const name of ['OPENAI_API_KEY', 'SENTRY_ACCESS_TOKEN', 'SIGNOZ_URL', 'SIGNOZ_API_KEY']) assert.ok(request.env.SANDBOX_ENV.split(' ').includes(name), `${name} goes by name`);
  const plan = JSON.parse(planText);
  const byId = Object.fromEntries(plan.servers.map((s: { id: string }) => [s.id, s]));
  assert.equal(byId.sentry.credentials, 'real');
  assert.equal(byId.sentry.investigate, true);
  assert.equal(byId.signoz.credentials, 'real');
  assert.equal(byId.signoz.investigate, true);
  assert.equal(byId.dynatrace_managed.credentials, 'placeholder');
  assert.equal(byId.dynatrace_managed.investigate, false, 'no Dynatrace cluster to investigate');
  assert.deepEqual(plan.llm, { kind: 'as-is' });
  assert.deepEqual(plan.loadOnlyEnv, {});
});

test('with only an Anthropic key, the example is swapped to Claude, and says so', async () => {
  const world = makeWorld({ ANTHROPIC_API_KEY: 'sk-ant-not-real-0123456789', SENTRY_ACCESS_TOKEN: FAKE_SENTRY });
  await main([], world.deps);
  const plan = JSON.parse(readFileSync(world.sandboxCalls[0].planFile, 'utf8'));
  assert.deepEqual(plan.llm, { kind: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.equal(plan.provider, 'anthropic');
});

test('with no LLM key, AURA still discovers tools, on a stand-in value it never sends anywhere', async () => {
  const world = makeWorld({ SENTRY_ACCESS_TOKEN: FAKE_SENTRY });
  await main([], world.deps);
  const plan = JSON.parse(readFileSync(world.sandboxCalls[0].planFile, 'utf8'));
  assert.ok(plan.servers.every((s: { discover: boolean; investigate: boolean }) => s.discover && !s.investigate));
  assert.ok(plan.loadOnlyEnv.OPENAI_API_KEY);
});

test('raw outputs are scrubbed on the way to out/, whatever the harness wrote', async () => {
  const world = makeWorld({ SENTRY_ACCESS_TOKEN: FAKE_SENTRY, OPENAI_API_KEY: FAKE_KEY }, (_request, rawDir) => {
    writeFileSync(join(rawDir, recordFile('tools', 'sentry')), JSON.stringify(toolsRecord('sentry', FAKE_SENTRY)));
    writeFileSync(join(rawDir, 'aura-sentry.log'), `Authorization: Sentry-Bearer ${FAKE_SENTRY}\nkey=${FAKE_KEY}\n`);
    writeFileSync(join(rawDir, 'transcript-sentry.sse'), `data: ${FAKE_KEY}\n\n`);
  });
  await main([], world.deps);
  const files = listFiles(outDir(world.root));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(FAKE_SENTRY), `${file} leaks the Sentry token`);
    assert.ok(!text.includes(FAKE_KEY), `${file} leaks the OpenAI key`);
  }
  assert.ok(!readFileSync(resultPath(world.root), 'utf8').includes(FAKE_SENTRY));
});

test('all three servers seen by AURA and both investigations answered: measured, exit 0, with the title number', async () => {
  const world = makeWorld(ALL_KEYS, (_request, rawDir) => writeRecords(rawDir, measuredRecords()));
  assert.equal(await main([], world.deps), 0);
  const result = readResult(resultPath(world.root));
  assert.equal(result?.status, 'measured');
  assert.equal(result?.title_number, TITLE_NUMBER);
  assert.equal(result && manifestProblem(resultPath(world.root), result), null, 'its raw output is saved before its result, so the App will count it');
});

test('a keyless rerun after a measured run starts nothing, exits 3 and changes nothing', async () => {
  const world = makeWorld(ALL_KEYS, (_request, rawDir) => writeRecords(rawDir, measuredRecords()));
  assert.equal(await main([], world.deps), 0);
  const snapshot = () => Object.fromEntries(listFiles(join(world.root, 'lab', LAB_NAME)).map((f) => [f, readFileSync(f, 'utf8')]));
  const before = snapshot();
  const calls = world.sandboxCalls.length;
  assert.equal(await main(['--no-keys'], world.deps), 3);
  assert.equal(world.sandboxCalls.length, calls, 'nothing started');
  assert.equal(world.trees.prepared.length, 1, 'no new worktree');
  assert.deepEqual(snapshot(), before);
  assert.match(world.logs[world.logs.length - 1], /Kept the measured result/);
  assert.match(world.logs[world.logs.length - 1], /SENTRY_ACCESS_TOKEN/);
});

test('any one missing key or backend keeps the measured result the same way', async () => {
  for (const missing of ['SENTRY_ACCESS_TOKEN', 'SIGNOZ_URL', 'SIGNOZ_API_KEY', 'OPENAI_API_KEY'] as const) {
    const world = makeWorld(ALL_KEYS, (_request, rawDir) => writeRecords(rawDir, measuredRecords()));
    assert.equal(await main([], world.deps), 0);
    const calls = world.sandboxCalls.length;
    const env = Object.fromEntries(Object.entries(ALL_KEYS).filter(([name]) => name !== missing));
    assert.equal(await main([], { ...world.deps, env }), 3, `without ${missing}`);
    assert.equal(world.sandboxCalls.length, calls, `without ${missing}, nothing starts`);
  }
});

test('with every key, a measured result can be run again: Anthropic counts as the model key, and Dynatrace needs no cluster', async () => {
  const world = makeWorld(ALL_KEYS, (_request, rawDir) => writeRecords(rawDir, measuredRecords()));
  assert.equal(await main([], world.deps), 0);
  const { OPENAI_API_KEY: _dropped, ...rest } = ALL_KEYS;
  assert.equal(await main([], { ...world.deps, env: { ...rest, ANTHROPIC_API_KEY: 'sk-ant-not-real-0123456789' } }), 0);
  assert.equal(world.sandboxCalls.length, 2);
});

test('a later run with every key that comes back weaker leaves out/ and result.md alone, and exits 1', async () => {
  const world = makeWorld(ALL_KEYS, (_request, rawDir) => writeRecords(rawDir, measuredRecords()));
  assert.equal(await main([], world.deps), 0);
  const saved = readFileSync(join(outDir(world.root), recordFile('investigation', 'signoz')), 'utf8');
  const result = readFileSync(resultPath(world.root), 'utf8');
  const allFailed = answeredRecord('signoz', { toolCalls: [{ id: '1', name: READS.signoz, ok: false, ms: 3, error: 'ToolError' }] });
  const weaker: Deps = { ...world.deps, sandbox: async (request) => {
    const rawDir = JSON.parse(readFileSync(request.planFile, 'utf8')).rawDir.replace('/lab-work', join(world.root, 'lab', '.work'));
    writeRecords(rawDir, [...ALL_SERVERS.flatMap((s) => fullRecords(s)), answeredRecord('sentry'), allFailed]);
    return { status: 0, output: '' };
  } };
  assert.equal(await main([], weaker), 1);
  assert.equal(readFileSync(join(outDir(world.root), recordFile('investigation', 'signoz')), 'utf8'), saved);
  assert.equal(readFileSync(resultPath(world.root), 'utf8'), result);
  assert.ok(world.logs.some((line) => /weaker/.test(line)));
});

test('a placeholder run never replaces real records in out/, for that server, whatever the result says', async () => {
  const world = makeWorld({}, (_request, rawDir) => {
    writeRecords(rawDir, [...fullRecords('signoz', 'placeholder'), ...fullRecords('dynatrace_managed', 'placeholder')]);
    writeFileSync(join(rawDir, 'aura-signoz.log'), 'placeholder log');
    writeFileSync(join(rawDir, 'aura-dynatrace_managed.log'), 'placeholder log');
  });
  const out = outDir(world.root);
  writeRecords(out, [...fullRecords('signoz'), answeredRecord('signoz')]);
  writeFileSync(join(out, 'aura-signoz.log'), 'real log');
  assert.equal(await main(['--no-keys'], world.deps), 3);
  for (const kind of ['tools', 'aura-tools', 'offered'] as const) {
    assert.equal(JSON.parse(readFileSync(join(out, recordFile(kind, 'signoz')), 'utf8')).credentials, 'real', `${kind} stays real`);
  }
  assert.equal(readFileSync(join(out, 'aura-signoz.log'), 'utf8'), 'real log', 'and so does its log');
  assert.equal(JSON.parse(readFileSync(join(out, recordFile('tools', 'dynatrace_managed')), 'utf8')).credentials, 'placeholder', 'other servers still save');
  assert.ok(world.logs.some((line) => /Kept the real SigNoz records/.test(line)));
  assert.ok(!/placeholder URL/.test(readResult(resultPath(world.root))?.body ?? ''), 'the table never mixes the two');
});

test('a run without the token keeps the Sentry row from the run that had it', async () => {
  const first = makeWorld({ SENTRY_ACCESS_TOKEN: FAKE_SENTRY }, (_request, rawDir) => {
    writeFileSync(join(rawDir, recordFile('tools', 'sentry')), JSON.stringify(toolsRecord('sentry')));
  });
  await main([], first.deps);
  assert.match(readResult(resultPath(first.root))?.body ?? '', /\| Sentry \|/);
  const second: Deps = { ...first.deps, env: {} };
  await main([], second);
  assert.match(readResult(resultPath(first.root))?.body ?? '', /\| Sentry \|/);
});

test('a server that fails is exit 1, its row stays absent, and a later success clears the failure', async () => {
  const failure: RawRecord = { kind: 'tools', ok: false, server: 'signoz', example: 'x', measuredAt: '2026-11-01T10:00:00.000Z', error: 'image would not start' };
  const world = makeWorld({}, (_request, rawDir) => {
    writeFileSync(join(rawDir, recordFile('tools', 'signoz', false)), JSON.stringify(failure));
  });
  assert.equal(await main(['--no-keys'], world.deps), 1);
  assert.ok(!/\| SigNoz \|/.test(readResult(resultPath(world.root))?.body ?? ''));
  assert.ok(existsSync(join(outDir(world.root), recordFile('tools', 'signoz', false))));
  const again: Deps = { ...world.deps, sandbox: async (request) => {
    const rawDir = JSON.parse(readFileSync(request.planFile, 'utf8')).rawDir.replace('/lab-work', join(world.root, 'lab', '.work'));
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, recordFile('tools', 'signoz')), JSON.stringify(toolsRecord('signoz')));
    return { status: 0, output: '' };
  } };
  assert.equal(await main(['--no-keys'], again), 3);
  assert.ok(!existsSync(join(outDir(world.root), recordFile('tools', 'signoz', false))), 'the stale failure is gone');
});

test('a sandbox that dies is exit 1 and writes no claim', async () => {
  const world = makeWorld({}, () => undefined, 1);
  assert.equal(await main(['--no-keys'], world.deps), 1);
  assert.equal(readResult(resultPath(world.root))?.status ?? 'not_run', 'not_run');
  assert.deepEqual(world.trees.removed.length, 1);
  assert.equal(world.bridges[0].closed, true);
});

test('a weaker run never replaces a measured result', async () => {
  const world = makeWorld({});
  mkdirSync(dirname(resultPath(world.root)), { recursive: true });
  const measured = renderResult({ lab: LAB_NAME, status: 'measured', measured_at: '2026-11-01', title_number: TITLE_NUMBER, body: '| a |\n| - |' });
  writeFileSync(resultPath(world.root), measured);
  assert.equal(await main(['--no-keys', '--no-start'], world.deps), 3);
  assert.equal(readFileSync(resultPath(world.root), 'utf8'), measured);
});

// ---- --dry-run, for real against the fakes on this host

test('--dry-run runs the whole pipeline against fakes and writes only under lab/.work/04-mcp/dry-run/', { timeout: 120_000 }, async () => {
  const world = makeWorld({ OPENAI_API_KEY: FAKE_KEY, SENTRY_ACCESS_TOKEN: FAKE_SENTRY });
  mkdirSync(outDir(world.root), { recursive: true });
  writeFileSync(join(outDir(world.root), 'keep.json'), '{}');
  const earlier = renderResult({ lab: LAB_NAME, status: 'not_run', needs: 'x', body: 'earlier' });
  writeFileSync(resultPath(world.root), earlier);
  const before = listFiles(world.root);
  const realLocal = runLocalForTest();
  const deps: Deps = { ...world.deps, runLocal: realLocal };

  assert.equal(await main(['--dry-run'], deps), 0);

  const work = join(world.root, 'lab', '.work', LAB_NAME, 'dry-run');
  const added = listFiles(world.root).filter((f) => !before.includes(f));
  assert.ok(added.length > 0);
  for (const file of added) assert.ok(file.startsWith(`${work}/`), `${relative(world.root, file)} is outside the dry-run folder`);
  assert.equal(readFileSync(resultPath(world.root), 'utf8'), earlier, 'result.md is untouched');
  assert.deepEqual(readdirSync(outDir(world.root)), ['keep.json'], 'out/ is untouched');
  assert.equal(world.sandboxCalls.length, 0, 'the plain dry run needs no Docker');
  assert.equal(world.bridges.length, 0);

  const preview = readFileSync(join(work, 'result.preview.md'), 'utf8');
  assert.match(preview, /Dry run/);
  assert.match(preview, /fake server, dry run only/);
  assert.match(preview, /\| Sentry \|/);
  assert.match(preview, /\| SigNoz \|/);
  assert.match(preview, /\| Dynatrace Managed \|/);
  assert.match(preview, /fake_sentry_search/);
  assert.match(preview, /offered to the agent/);
  assert.match(preview, /\| Sentry \| no example at 3a49ac4 \| 2, from fake-sentry 0\.0\.0-fake \| 2 \| 2 \|/);
  assert.match(preview, new RegExp(TITLE_NUMBER), 'the fakes reach the measured path, in the preview only');
  const transcript = readFileSync(join(work, 'raw', 'transcript-sentry.sse'), 'utf8');
  assert.match(transcript, /aura\.tool_complete/);
  for (const file of added) assert.ok(!readFileSync(file, 'utf8').includes(FAKE_KEY), `${file} carries a key`);
});

test('a junk Sentry token is only for a sandbox dry run: it never reaches a real run or a plain dry run', async () => {
  const world = makeWorld({});
  await assert.rejects(main(['--junk-sentry-token'], world.deps), /only goes with --dry-run --sandbox/);
  await assert.rejects(main(['--dry-run', '--junk-sentry-token'], world.deps), /only goes with --dry-run --sandbox/);
  assert.equal(world.sandboxCalls.length, 0);
  assert.equal(await main(['--dry-run', '--sandbox', '--junk-sentry-token'], world.deps), 0);
  const request = world.sandboxCalls[0];
  const plan = JSON.parse(readFileSync(request.planFile, 'utf8'));
  const sentry = plan.servers.find((s: { id: string }) => s.id === 'sentry');
  assert.equal(sentry.credentials, 'placeholder', 'never labelled real');
  assert.equal(sentry.placeholders.SENTRY_ACCESS_TOKEN, JUNK_SENTRY_TOKEN);
  assert.equal(request.env.SENTRY_ACCESS_TOKEN, undefined);
  assert.equal(existsSync(resultPath(world.root)), false);
  assert.equal(existsSync(outDir(world.root)), false);
});

test('a sandbox dry run asks for tools that need no credentials and tools that do, and probes every tool', async () => {
  const world = makeWorld({});
  assert.equal(await main(['--dry-run', '--sandbox'], world.deps), 0);
  const plan = JSON.parse(readFileSync(world.sandboxCalls[0].planFile, 'utf8'));
  const names = plan.fakeProvider.calls.map((c: { name: string }) => c.name);
  for (const name of ['signoz_search_docs', 'signoz_list_services', 'search_sentry_tools', 'execute_sentry_tool']) assert.ok(names.includes(name), name);
  assert.ok(plan.servers.every((s: { probeCalls: boolean }) => s.probeCalls));
});

test('a real run never calls a tool on its own', async () => {
  const world = makeWorld(ALL_KEYS);
  await main([], world.deps);
  const plan = JSON.parse(readFileSync(world.sandboxCalls[0].planFile, 'utf8'));
  assert.ok(plan.servers.every((s: { probeCalls?: boolean }) => !s.probeCalls));
  assert.equal(plan.fakeProvider, undefined);
});

test('--dry-run --sandbox uses the real client and AURA with a fake provider, still only under dry-run/', async () => {
  const world = makeWorld({ OPENAI_API_KEY: FAKE_KEY, SENTRY_ACCESS_TOKEN: FAKE_SENTRY });
  const code = await main(['--dry-run', '--sandbox'], world.deps);
  assert.equal(code, 0);
  const request = world.sandboxCalls[0];
  const plan = JSON.parse(readFileSync(request.planFile, 'utf8'));
  assert.equal(plan.client, 'sdk');
  assert.ok(plan.fakeProvider, 'a fake provider instead of a real one');
  assert.deepEqual(plan.servers.map((s: { id: string }) => s.id).sort(), ['dynatrace_managed', 'signoz'], 'no placeholder token goes to Sentry');
  assert.equal(plan.rawDir, '/lab-work/04-mcp/dry-run/raw');
  assert.match(request.command, /setup\.sh \/lab-work\/04-mcp\/dry-run\/toolchain/);
  assert.ok(request.worktree.includes(join('.work', LAB_NAME, 'dry-run')));
  assert.equal(request.env.OPENAI_API_KEY, undefined, 'no real key reaches a dry run');
  assert.equal(request.env.SENTRY_ACCESS_TOKEN, undefined);
  assert.equal(existsSync(resultPath(world.root)), false);
  assert.equal(existsSync(outDir(world.root)), false);
});

function runLocalForTest(): Deps['runLocal'] {
  return async (planFile) => {
    const output = execFileSync(process.execPath, [join(LAB_DIR, 'harness', 'sandbox-main.ts'), planFile], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    return { status: 0, output };
  };
}

// ---- files the sandbox needs

test('the sandbox setup script pins what the plan says, and verifies the Node download', () => {
  const setup = readFileSync(join(LAB_DIR, 'harness', 'setup.sh'), 'utf8');
  assert.match(setup, /SHASUMS256\.txt/);
  assert.match(setup, /sha256sum -c/);
  assert.match(setup, /--ignore-scripts/);
  assert.ok(statSync(join(LAB_DIR, 'harness', 'setup.sh')).mode & 0o111);
});

test('the test set is the one prompt the spec names', () => {
  assert.equal(readFileSync(join(LAB_DIR, 'testset', 'prompt.txt'), 'utf8').trim(), INVESTIGATION_PROMPT);
  assert.equal(INVESTIGATION_PROMPT, 'why did errors spike in the last hour?');
});

const notes = () => readFileSync(join(LAB_DIR, 'testset', 'notes.md'), 'utf8');

test('the notes name every variable the lab reads, except the bridge token it makes for each run', () => {
  const section = notes().split('## Names the lab reads')[1]?.split('\n## ')[0] ?? '';
  for (const name of [...SECRET_NAMES, ...CONFIG_NAMES].filter((n) => n !== 'BRIDGE_TOKEN')) assert.ok(section.includes(`\`${name}\``), `${name} is in the notes`);
  assert.ok(!/^- .*`BRIDGE_TOKEN`/m.test(section), 'the lab makes that one for each run, so nobody sets it');
});

test('the notes send the Sentry events with the message the result reports', () => {
  assert.ok(notes().includes(`sentry-cli send-event -m "${SENTRY_EVENT_MESSAGE}"`));
});
