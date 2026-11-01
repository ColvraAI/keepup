import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { InvestigationFailure, InvestigationRecord, OfferedFailure, OfferedRecord, ToolsRecord } from '../lib/records.ts';
import { recordFile } from '../lib/records.ts';
import { runPlan, serverEnv, type Plan, type PlanServer } from './sandbox-main.ts';

const LAB = join(import.meta.dirname, '..');
const EXAMPLE = 'examples/complete/incident-response-signoz.toml';
const CONFIG = `[mcp.servers.signoz]
transport = "stdio"
cmd = ["docker"]

[agent]
name = "x"
alias = "incident-response/signoz"

[agent.llm]
provider = "openai"
api_key = "{{ env.OPENAI_API_KEY }}"
model = "gpt-5.2"
`;

const server = (extra: Partial<PlanServer> = {}): PlanServer => ({ id: 'signoz', example: EXAMPLE, credentials: 'fake', placeholders: {}, override: { cmd: [process.execPath, join(LAB, 'fake', 'fake-mcp-server.ts'), 'signoz'] }, listTools: true, discover: true, investigate: true, ...extra });

function planFor(extra: Partial<Plan> = {}): Plan {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-plan-'));
  const repo = join(dir, 'repo');
  mkdirSync(dirname(join(repo, EXAMPLE)), { recursive: true });
  writeFileSync(join(repo, EXAMPLE), CONFIG);
  return { repo, rawDir: join(dir, 'raw'), cwd: join(dir, 'cwd'), client: 'mini', auraCommand: [process.execPath, join(LAB, 'fake', 'fake-aura.ts')], auraTag: 'v0', prompt: 'why?', llm: { kind: 'as-is' }, provider: 'openai', model: 'gpt-5.2', loadOnlyEnv: {}, servers: [server()], ...extra };
}

const read = <T>(plan: Plan, name: string): T => JSON.parse(readFileSync(join(plan.rawDir, name), 'utf8')) as T;

test('a plan writes one record per step, plus the transcript and the server log', async () => {
  const plan = planFor();
  await runPlan(plan);
  const names = readdirSync(plan.rawDir).sort();
  assert.deepEqual(names, ['aura-signoz.log', 'aura-tools-signoz.json', 'investigation-signoz.json', 'offered-signoz.json', 'tools-signoz.json', 'transcript-signoz.sse']);
  assert.deepEqual(read<ToolsRecord>(plan, recordFile('tools', 'signoz')).toolNames, ['fake_signoz_details', 'fake_signoz_search']);
  const investigation = read<InvestigationRecord>(plan, recordFile('investigation', 'signoz'));
  assert.equal(investigation.ok, true);
  assert.equal(investigation.prompt, 'why?');
  assert.equal(investigation.llmSwapped, false);
  assert.match(investigation.answer, /Fake answer/);
  assert.equal(investigation.toolCalls[0].name, 'fake_signoz_search');
  assert.ok(investigation.timeToAnswerMs >= 0);
});

test('the offered step records what AURA sent a stand-in provider, with sizes from the listing, and calls no tool', async () => {
  const plan = planFor({ servers: [server({ investigate: false })] });
  await runPlan(plan);
  const offered = read<OfferedRecord>(plan, recordFile('offered', 'signoz'));
  assert.equal(offered.ok, true);
  assert.equal(offered.credentials, 'fake');
  assert.deepEqual(offered.toolNames, ['fake_signoz_details', 'fake_signoz_search']);
  assert.ok(offered.sentBytes > 0);
  assert.equal(offered.sizes?.listed.count, 2);
  assert.equal(offered.sizes?.offered.count, 2);
  assert.deepEqual(readdirSync(plan.cwd), [], 'its config copy leaves nothing behind');
});

test('every investigation record says what credentials it ran on', async () => {
  const plan = planFor();
  await runPlan(plan);
  assert.equal(read<InvestigationRecord>(plan, recordFile('investigation', 'signoz')).credentials, 'fake');
  const broken = planFor({ auraCommand: ['/nonexistent/aura'] });
  await runPlan(broken);
  assert.equal(read<InvestigationFailure>(broken, recordFile('investigation', 'signoz', false)).credentials, 'fake');
});

test('steps the plan leaves off do not run', async () => {
  const plan = planFor({ servers: [server({ investigate: false })] });
  await runPlan(plan);
  assert.ok(!readdirSync(plan.rawDir).includes(recordFile('investigation', 'signoz')));
  assert.ok(readdirSync(plan.rawDir).includes(recordFile('aura-tools', 'signoz')));
});

test('an AURA that will not start leaves failure records and the rest of the plan still runs', async () => {
  const plan = planFor({ auraCommand: ['/nonexistent/aura'] });
  await runPlan(plan);
  assert.equal(read<ToolsRecord>(plan, recordFile('tools', 'signoz')).ok, true);
  assert.equal(read<InvestigationFailure>(plan, recordFile('investigation', 'signoz', false)).ok, false);
  assert.match(read<InvestigationFailure>(plan, recordFile('aura-tools', 'signoz', false)).error, /ENOENT/);
  assert.match(read<OfferedFailure>(plan, recordFile('offered', 'signoz', false)).error, /ENOENT/);
});

test('a stream with no answer is a failure record, with what was seen kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-silent-'));
  const silent = join(dir, 'silent-aura.cjs');
  writeFileSync(silent, `
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{}');
  if (req.url.startsWith('/aura/info')) return res.end(JSON.stringify({ agents: [{ id: 'incident-response/signoz', mcp_servers: {} }] }));
  req.resume();
  req.on('end', () => res.end('data: ' + JSON.stringify({ error: { message: 'model not found' } }) + '\\n\\ndata: [DONE]\\n\\n'));
}).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  const plan = planFor({ auraCommand: [process.execPath, silent] });
  await runPlan(plan);
  const failure = read<InvestigationFailure>(plan, recordFile('investigation', 'signoz', false));
  assert.match(failure.error, /model not found/);
  assert.ok(failure.stream);
});

test('an example is only copied when its llm block must change, and the copy says so', async () => {
  const plan = planFor({ llm: { kind: 'anthropic', model: 'claude-sonnet-5-5' }, provider: 'anthropic', model: 'claude-sonnet-5-5' });
  await runPlan(plan);
  assert.match(readFileSync(join(plan.cwd, 'config-signoz.toml'), 'utf8'), /provider = "anthropic"/);
  assert.equal(read<InvestigationRecord>(plan, recordFile('investigation', 'signoz')).llmSwapped, true);
  const asIs = planFor();
  await runPlan(asIs);
  assert.deepEqual(readdirSync(asIs.cwd), [], 'the real example runs untouched');
});

test('a plan can call every tool on purpose, which only a dry run asks for', async () => {
  const off = planFor();
  await runPlan(off);
  assert.ok(!readdirSync(off.rawDir).includes('no-credentials-calls-signoz.json'), 'a normal step list calls nothing on its own');
  const on = planFor({ servers: [server({ investigate: false, probeCalls: true })] });
  await runPlan(on);
  const saved = read<{ server: string; calls: { name: string; ok: boolean }[] }>(on, 'no-credentials-calls-signoz.json');
  assert.equal(saved.server, 'signoz');
  assert.deepEqual(saved.calls.map((c) => [c.name, c.ok]), [['fake_signoz_search', true], ['fake_signoz_details', true]]);
});

test('a probe that cannot start its server is written down, and the rest of the plan still runs', async () => {
  const off = { listTools: false, discover: false, investigate: false };
  const plan = planFor({ servers: [server({ ...off, id: 'dynatrace_managed', probeCalls: true }), server({ ...off, listTools: true })] });
  await runPlan(plan);
  assert.match(read<{ error: string }>(plan, 'no-credentials-calls-dynatrace_managed.json').error, /no server called dynatrace_managed/);
  assert.equal(read<ToolsRecord>(plan, recordFile('tools', 'signoz')).ok, true);
});

test('placeholders only fill what the environment leaves unset', () => {
  assert.deepEqual(serverEnv({ placeholders: { A: 'placeholder', B: 'placeholder' } }, { B: 'real', C: 'other' }), { A: 'placeholder', B: 'real', C: 'other' });
});
