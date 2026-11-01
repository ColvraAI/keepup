import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { loadSpec } from '../../app/src/specs.ts';
import { REPO_ROOT } from '../shared/env.ts';
import { readResult, renderResult } from '../shared/result.ts';
import { assetForArch, ensureBinary, parseChecksums, releaseUrl, sha256Of } from '../shared/aura-binary.ts';
import { LAB_RELEASE_TAG, MINIMAL_PATH, REASONING_PATH, selectCases, withBaseUrls, withSummarizedDisplay, type LabCase } from './cases.ts';
import { anthropicRejection, FAKE_ANSWER, FAKE_PLAN_ANSWER, nextTurn, startFakeProvider } from './fake-provider.ts';
import { anthropicRequests, decide, emptyThinkingProblems, oneLine, probeProblems, readOutcome, RELEASE_VS_BASE, renderBody, requestProblems, scrub, scrubTree, type CaseOutcome } from './report.ts';
import { parseCargoTests, sandboxCommand, summarize, type StageRun } from './repo-tests.ts';
import { FAKE_KEYS, runLab, type LabDeps, type SandboxCall } from './run.ts';

// ---------------------------------------------------------------- the release binary

const fakeRelease = (bytes: Uint8Array, recordedSum = sha256Of(bytes)) => {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<Uint8Array> => {
    calls.push(url);
    if (url.endsWith('/checksums.txt')) return new TextEncoder().encode(`aaaa  aura-linux-amd64\n${recordedSum}  aura-linux-arm64\n`);
    return bytes;
  };
  return { calls, fetcher };
};

test('assetForArch names the linux binary for the sandbox architecture, and refuses to guess', () => {
  assert.equal(assetForArch('arm64'), 'aura-linux-arm64');
  assert.equal(assetForArch('aarch64'), 'aura-linux-arm64');
  assert.equal(assetForArch('x86_64'), 'aura-linux-amd64');
  assert.throws(() => assetForArch('riscv64'));
});

test('parseChecksums reads sha256sum output', () => {
  assert.deepEqual(parseChecksums('abc  aura-linux-arm64\n\ndef  checksums-other\n'), { 'aura-linux-arm64': 'abc', 'checksums-other': 'def' });
});

test('ensureBinary verifies the download, makes it executable and reuses a good copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab05-bin-'));
  const { calls, fetcher } = fakeRelease(new TextEncoder().encode('binary'));
  const info = await ensureBinary(dir, 'arm64', fetcher);
  assert.equal(info.tag, 'v0.2.20');
  assert.equal(info.url, `${releaseUrl('v0.2.20')}/aura-linux-arm64`);
  assert.equal(readFileSync(info.file, 'utf8'), 'binary');
  assert.ok(statSync(info.file).mode & 0o100);
  await ensureBinary(dir, 'arm64', fetcher);
  assert.equal(calls.filter((c) => c.endsWith('aura-linux-arm64')).length, 1);
});

test('ensureBinary refuses a download whose checksum does not match and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab05-bin-'));
  const { fetcher } = fakeRelease(new TextEncoder().encode('tampered'), 'f'.repeat(64));
  await assert.rejects(ensureBinary(dir, 'arm64', fetcher), /checksum/);
  assert.deepEqual(readdirSync(dir), []);
});

// ---------------------------------------------------------------- the fake provider

const adaptive = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' }, output_config: { effort: 'high' } };

test('the fake refuses what the docs say the real API refuses', () => {
  const none = new Map<string, string>();
  assert.equal(anthropicRejection({ ...adaptive, model: 'claude-sonnet-4-20250514' }, none)?.status, 404);
  assert.match(anthropicRejection({ ...adaptive, thinking: { type: 'enabled', budget_tokens: 8000 } }, none)?.message ?? '', /thinking\.type\.enabled/);
  assert.match(anthropicRejection({ ...adaptive, thinking: { type: 'disabled' } }, none)?.message ?? '', /between_tools/);
  assert.equal(anthropicRejection({ ...adaptive, temperature: 1 }, none)?.status, 400);
  assert.match(anthropicRejection({ ...adaptive, tool_choice: { type: 'any' } }, none)?.message ?? '', /not supported/);
  assert.equal(anthropicRejection({ ...adaptive, tool_choice: { type: 'auto' } }, none), null);
  assert.equal(anthropicRejection(adaptive, none), null);
});

test('the fake refuses a thinking block that comes back changed, and accepts one that does not', () => {
  const issued = new Map([['sig', 'Summary.']]);
  const withThinking = (thinking: string) => ({
    ...adaptive,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'thinking', thinking, signature: 'sig' }, { type: 'tool_use', id: 't', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }],
  });
  assert.equal(anthropicRejection(withThinking('Summary.'), issued), null);
  assert.match(anthropicRejection(withThinking('Summary.Summary.'), issued)?.message ?? '', /cannot be modified/);
});

test('the fake does not enforce sending an empty thinking block back: what the real API does there is what the real run is for', () => {
  const dropped = { ...adaptive, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }] };
  assert.equal(anthropicRejection(dropped, new Map()), null);
  const notes = readFileSync(join(import.meta.dirname, 'testset-notes.md'), 'utf8');
  assert.match(notes, /not enforced by the fake/i);
  assert.match(notes, /including empty ones/);
});

test('the fake plays each agent by the tools it is offered', () => {
  const tools = (...names: string[]) => names.map((name) => ({ name }));
  assert.equal(nextTurn({ messages: [] }).text, FAKE_ANSWER);
  const planning = { tools: tools('create_plan'), messages: [{ role: 'user', content: [{ type: 'text', text: 'USER QUERY: x' }] }] };
  assert.equal(nextTurn(planning).tool?.name, 'create_plan');
  const continuation = { tools: tools('create_plan'), messages: [{ role: 'user', content: 'Outcome: 1 of 1 tasks succeeded.' }] };
  assert.equal(nextTurn(continuation).tool?.name, 'respond_directly');
  assert.equal(nextTurn(continuation).tool?.input.response, FAKE_PLAN_ANSWER);
  const task = { role: 'user', content: 'task' };
  assert.equal(nextTurn({ tools: tools('submit_result'), messages: [task] }).tool?.name, 'submit_result');
  const offered = tools('read_artifact', 'submit_result');
  assert.equal(nextTurn({ tools: offered, messages: [task] }).tool?.name, 'read_artifact');
  const afterRead = [task, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read_artifact', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'none' }] }];
  assert.equal(nextTurn({ tools: offered, messages: afterRead }).tool?.name, 'submit_result');
  const afterSubmit = [...afterRead, { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'submit_result', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'ok' }] }];
  assert.equal(nextTurn({ tools: offered, messages: afterSubmit }).text, 'Submitted.');
});

test('the fake streams thinking before the answer, and answers 404 for the retired model', async () => {
  const fake = await startFakeProvider();
  try {
    const send = (body: unknown) => fetch(`http://127.0.0.1:${fake.port}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'k' }, body: JSON.stringify(body) });
    const ok = await send({ ...adaptive, stream: true });
    assert.equal(ok.status, 200);
    const stream = await ok.text();
    assert.ok(stream.indexOf('"signature_delta"') < stream.indexOf('"text_delta"'));
    assert.ok(stream.includes(FAKE_ANSWER));
    const gone = await send({ ...adaptive, model: 'claude-sonnet-4-20250514' });
    assert.equal(gone.status, 404);
    assert.match(await gone.text(), /not_found_error/);
    assert.equal(fake.requests().length, 2);
    assert.equal(fake.requests()[0].hasCredential, true);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- the cases

const WORKER_BLOCK = `[orchestration.worker.deep-analysis.llm]
provider = "anthropic"
api_key = "{{ env.ANTHROPIC_API_KEY }}"
model = "claude-sonnet-5-5"
max_tokens = 16_000

[orchestration.worker.deep-analysis.llm.additional_params.thinking]
type = "adaptive"

[orchestration.worker.deep-analysis.llm.additional_params.output_config]
effort = "high"
`;

const REASONING_TOML = `[agent]
name = "Analysis Coordinator"

[agent.llm]
provider = "openai"
api_key = "{{ env.OPENAI_API_KEY }}"
model = "gpt-5.2"
reasoning_effort = "high"

[orchestration]
enabled = true

${WORKER_BLOCK}
[orchestration.worker.fast]
description = "x"

[orchestration.worker.fast.llm]
provider = "openai"
api_key = "{{ env.OPENAI_API_KEY }}"
model = "gpt-5.2"
reasoning_effort = "minimal"
`;

test('withBaseUrls points each provider block at the fake', () => {
  const out = withBaseUrls(REASONING_TOML, 'http://fake:1');
  assert.equal(out.match(/base_url = "http:\/\/fake:1\/v1"/g)?.length, 2);
  assert.equal(out.match(/base_url = "http:\/\/fake:1"\n/g)?.length, 1);
});

test('withSummarizedDisplay asks for thinking text on the Claude block only', () => {
  const out = withSummarizedDisplay(REASONING_TOML);
  assert.ok(out.includes('type = "adaptive"\ndisplay = "summarized"\n'));
  assert.equal(out.match(/display = /g)?.length, 1);
  assert.throws(() => withSummarizedDisplay('[agent]\nname = "x"\n'));
});

test('selectCases runs the shipped files only, and the dry run adds its probes', () => {
  const ids = (cases: readonly LabCase[]) => cases.map((c) => c.id);
  assert.deepEqual(ids(selectCases({ dryRun: false })), ['before-minimal', 'after-minimal', 'after-reasoning-shipped']);
  assert.deepEqual(ids(selectCases({ dryRun: true })), ['before-minimal', 'after-minimal', 'after-reasoning-shipped', 'probe-display-summarized', 'probe-empty-thinking']);
  assert.equal(selectCases({ dryRun: false })[0].expect, 'error');
});

test('the minimal cases name only the Anthropic key, and the shipped reasoning file names both', () => {
  const keysOf = Object.fromEntries(selectCases({ dryRun: false }).map((c) => [c.id, c.keys]));
  assert.deepEqual(keysOf['before-minimal'], ['ANTHROPIC_API_KEY']);
  assert.deepEqual(keysOf['after-minimal'], ['ANTHROPIC_API_KEY']);
  assert.deepEqual(keysOf['after-reasoning-shipped'], ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
});

// ---------------------------------------------------------------- reading the outcomes

const [beforeCase, minimalCase, reasoningCase] = selectCases({ dryRun: false });
const chat = (content: string, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage });
const PROVIDER_ERROR = 'The upstream model provider (anthropic/claude-sonnet-4-20250514) returned an error: CompletionError: ProviderError: SSE Error: Invalid status code 404 Not Found with message: {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-20250514"}}';
const WORKER_TRACE = `2026-11-01T00:00:00Z TRACE orchestration.worker{orchestration.task_id=0 orchestration.worker="deep-analysis"}: rig::completions: Anthropic completion request: {
  "max_tokens": 16000,
  "model": "claude-sonnet-5-5",
  "output_config": {
    "effort": "high"
  },
  "thinking": {
    "type": "adaptive"
  }
}
`;
const followUpTrace = (assistant: unknown[]): string => `2026-11-01T00:00:00Z TRACE orchestration.worker{orchestration.worker="deep-analysis"}: rig::completions: Anthropic completion request: ${JSON.stringify({ model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }, { role: 'assistant', content: assistant }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }] }, null, 2)}\n`;
const TOOL_USE = { type: 'tool_use', id: 't', name: 'read_artifact', input: {} };
const DROPPED_FOLLOW_UP = followUpTrace([TOOL_USE]);
const KEPT_FOLLOW_UP = followUpTrace([{ type: 'thinking', thinking: '', signature: 'sig' }, TOOL_USE]);
const succeededLog = (done = 1) => `${WORKER_TRACE}2026-11-01T00:00:01Z TRACE planning: x query="Outcome: ${done} of 1 tasks succeeded."\n`;

test('scrub removes the key values and anything shaped like a key', () => {
  const text = scrub('a secret-value b sk-ant-api03-abc_DEF-123 c sk-proj-abcdefghijklmnopqrstuvwxyz d', ['secret-value']);
  assert.ok(!text.includes('secret-value'));
  assert.ok(!text.includes('sk-ant-api03'));
  assert.ok(!text.includes('sk-proj'));
  assert.equal(scrub('nothing here', ['']), 'nothing here');
});

test('scrubTree writes a scrubbed copy of every raw file', () => {
  const from = mkdtempSync(join(tmpdir(), 'lab05-raw-'));
  const to = mkdtempSync(join(tmpdir(), 'lab05-out-'));
  mkdirSync(join(from, 'case'));
  writeFileSync(join(from, 'case', 'server.log'), 'header x-api-key: real-key-value\n');
  writeFileSync(join(from, 'version.txt'), 'aura 0.2.20\n');
  scrubTree(from, join(to, 'out'), ['real-key-value']);
  assert.equal(readFileSync(join(to, 'out', 'case', 'server.log'), 'utf8').includes('real-key-value'), false);
  assert.equal(readFileSync(join(to, 'out', 'version.txt'), 'utf8'), 'aura 0.2.20\n');
});

test('anthropicRequests reads what AURA really sent out of its own trace log', () => {
  const [request] = anthropicRequests(WORKER_TRACE);
  assert.equal(request.worker, true);
  assert.equal(request.body.model, 'claude-sonnet-5-5');
  assert.deepEqual(request.body.thinking, { type: 'adaptive' });
  assert.equal(anthropicRequests('no trace here').length, 0);
});

test('readOutcome treats the error AURA wraps in a 200 as an error, keeping the real words', () => {
  const outcome = readOutcome(beforeCase, { httpStatus: '200', response: chat(PROVIDER_ERROR), log: '' });
  assert.equal(outcome.kind, 'error');
  assert.ok(outcome.detail.includes('404 Not Found'));
  assert.ok(outcome.detail.includes('not_found_error'));
});

test('readOutcome reads an answer and its usage', () => {
  const outcome = readOutcome(minimalCase, { httpStatus: '200', response: chat('Paris'), log: '' });
  assert.equal(outcome.kind, 'answer');
  assert.equal(outcome.detail, 'Paris');
  assert.deepEqual(outcome.usage, { input: 10, output: 5 });
});

test('readOutcome takes zero tokens as no usage reported: it is not a measurement', () => {
  const outcome = readOutcome(minimalCase, { httpStatus: '200', response: chat('Paris', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), log: '' });
  assert.equal(outcome.kind, 'answer');
  assert.equal(outcome.usage, null);
});

test('readOutcome reports a server that never answered, and an HTTP failure, and an empty answer', () => {
  assert.equal(readOutcome(minimalCase, { startupFailed: true, log: 'ERROR Failed to load configuration: bad toml\n' }).kind, 'no_response');
  assert.match(readOutcome(minimalCase, { startupFailed: true, log: 'ERROR Failed to load configuration: bad toml\n' }).detail, /bad toml/);
  assert.equal(readOutcome(minimalCase, { httpStatus: '500', response: '{"error":{"message":"boom"}}', log: '' }).kind, 'error');
  assert.equal(readOutcome(minimalCase, { httpStatus: '200', response: chat(''), log: '' }).kind, 'error');
  assert.equal(readOutcome(minimalCase, { httpStatus: '200', response: 'not json', log: '' }).kind, 'error');
});

test('an orchestrated run counts only when the Claude worker itself succeeded', () => {
  const ok = readOutcome(reasoningCase, { httpStatus: '200', response: chat('Partition by date.'), log: succeededLog() });
  assert.equal(ok.kind, 'answer');
  assert.deepEqual(ok.workerRequest?.thinking, { type: 'adaptive' });
  const failedLog = `${WORKER_TRACE}2026-11-01T00:00:01Z ERROR orchestration.worker{orchestration.worker="deep-analysis"}: aura::logging: error="400 Bad Request: thinking.type.enabled"\nOutcome: 0 of 1 tasks succeeded.\n`;
  const failed = readOutcome(reasoningCase, { httpStatus: '200', response: chat('The worker could not finish.'), log: failedLog });
  assert.equal(failed.kind, 'error');
  assert.match(failed.detail, /thinking\.type\.enabled/);
  const direct = readOutcome(reasoningCase, { httpStatus: '200', response: chat('I can answer that myself.'), log: 'no worker here\n' });
  assert.equal(direct.kind, 'error');
  assert.match(direct.detail, /never reached/);
});

const outcomeOf = (labCase: LabCase, kind: CaseOutcome['kind'], detail: string, extra: Partial<CaseOutcome> = {}): CaseOutcome => ({ id: labCase.id, label: labCase.label, model: labCase.model, kind, detail, usage: null, ...extra });

test('requestProblems catches a worker block that still sends what Sonnet 5.5 refuses', () => {
  const sent = (workerRequest: Record<string, unknown>): CaseOutcome => ({ id: reasoningCase.id, label: reasoningCase.label, model: reasoningCase.model, kind: 'answer', detail: 'x', usage: null, workerRequest });
  assert.deepEqual(requestProblems([sent({ model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })]), []);
  const old = requestProblems([sent({ model: 'claude-sonnet-5-5', temperature: 1, thinking: { type: 'enabled', budget_tokens: 8000 } })]);
  assert.equal(old.length, 3);
  assert.ok(old.some((problem) => problem.includes('temperature')));
  assert.deepEqual(requestProblems([outcomeOf(minimalCase, 'answer', 'Paris')]), []);
});

test('the display probe holds only while the changed thinking block is what fails', () => {
  const probe = selectCases({ dryRun: true }).find((c) => c.id === 'probe-display-summarized') as LabCase;
  assert.equal(probe.expect, 'error');
  const failedOn = (detail: string): CaseOutcome => ({ id: probe.id, label: probe.label, model: probe.model, kind: 'error', detail, usage: null });
  assert.deepEqual(probeProblems([failedOn('400: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified')]), []);
  assert.equal(probeProblems([failedOn('some other failure')]).length, 1);
  assert.deepEqual(probeProblems([]), []);
});

test('oneLine makes any text safe for one table cell', () => {
  assert.equal(oneLine('a\n\nb | c'), 'a b \\| c');
  const long = oneLine('x'.repeat(1000));
  assert.ok(long.length <= 401);
  assert.ok(long.endsWith('…'));
});

test('decide is measured only when the before run errors and every after run answers', () => {
  const cases = [beforeCase, minimalCase, reasoningCase];
  const good = [outcomeOf(beforeCase, 'error', PROVIDER_ERROR), outcomeOf(minimalCase, 'answer', 'Paris'), outcomeOf(reasoningCase, 'answer', 'Partition')];
  assert.deepEqual(decide(cases, good), { status: 'measured' });
  const beforeAnswered = [outcomeOf(beforeCase, 'answer', 'Hello'), good[1], good[2]];
  const partial = decide(cases, beforeAnswered);
  assert.equal(partial.status, 'partial');
  assert.match(partial.needs ?? '', /before-minimal/);
  assert.equal(decide(cases, [good[0]]).status, 'partial');
});

test('decide is partial and needs the key when a case could not run, and says so as well when another case missed', () => {
  const ran = [beforeCase, minimalCase];
  const good = [outcomeOf(beforeCase, 'error', PROVIDER_ERROR), outcomeOf(minimalCase, 'answer', 'Paris')];
  assert.deepEqual(decide(ran, good, ['OPENAI_API_KEY']), { status: 'partial', needs: 'OPENAI_API_KEY' });
  assert.deepEqual(decide(ran, good), { status: 'measured' }, 'every case that was meant to run did');
  const missed = decide(ran, [good[0], outcomeOf(minimalCase, 'error', 'overloaded')], ['OPENAI_API_KEY']);
  assert.equal(missed.status, 'partial');
  assert.match(missed.needs ?? '', /^OPENAI_API_KEY, and a rerun, because after-minimal did not/);
});

test('decide takes the before run as proof only when the error says the model was not found', () => {
  const cases = [beforeCase, minimalCase, reasoningCase];
  const afterRows = [outcomeOf(minimalCase, 'answer', 'Paris'), outcomeOf(reasoningCase, 'answer', 'Partition')];
  const verdict = (raw: Parameters<typeof readOutcome>[1]) => decide(cases, [readOutcome(beforeCase, raw), ...afterRows]);
  assert.equal(verdict({ httpStatus: '200', response: chat(PROVIDER_ERROR), log: '' }).status, 'measured');
  const overloaded = 'The upstream model provider (anthropic/claude-sonnet-4-20250514) returned an error: CompletionError: ProviderError: SSE Error: Invalid status code 529 with message: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  const refused = verdict({ httpStatus: '200', response: chat(overloaded), log: '' });
  assert.equal(refused.status, 'partial');
  assert.match(refused.needs ?? '', /before-minimal/);
  assert.equal(verdict({ httpStatus: '500', response: '{"error":{"message":"connection refused"}}', log: '' }).status, 'partial');
  const limited = PROVIDER_ERROR.replace('404 Not Found', '429 Too Many Requests').replace('not_found_error', 'rate_limit_error');
  assert.equal(verdict({ httpStatus: '200', response: chat(limited), log: '' }).status, 'partial');
  const onlyTheNumber = 'The upstream model provider (anthropic/x) returned an error: Invalid status code 404 Not Found';
  assert.equal(verdict({ httpStatus: '200', response: chat(onlyTheNumber), log: '' }).status, 'partial');
  const numberInsideAnId = `${overloaded} not_found_error req_404`;
  assert.equal(verdict({ httpStatus: '200', response: chat(numberInsideAnId), log: '' }).status, 'partial');
});

test('an orchestrated outcome records whether AURA sent the thinking block back on each follow-up', () => {
  const read = (log: string) => readOutcome(reasoningCase, { httpStatus: '200', response: chat('Partition by date.'), log: `${log}Outcome: 1 of 1 tasks succeeded.\n` });
  assert.deepEqual(read(WORKER_TRACE + DROPPED_FOLLOW_UP).toolLoop, { followUps: 1, withThinking: 0 });
  assert.deepEqual(read(WORKER_TRACE + KEPT_FOLLOW_UP).toolLoop, { followUps: 1, withThinking: 1 });
  assert.deepEqual(read(WORKER_TRACE).toolLoop, { followUps: 0, withThinking: 0 });
  assert.equal(readOutcome(minimalCase, { httpStatus: '200', response: chat('Paris'), log: '' }).toolLoop, undefined);
});

test('the empty-block claim in the pull request holds only while the dry run shows the block dropped', () => {
  const probe = selectCases({ dryRun: true }).find((c) => c.id === 'probe-empty-thinking') as LabCase;
  const ran = (followUps: number, withThinking: number): CaseOutcome => outcomeOf(probe, 'answer', 'x', { toolLoop: { followUps, withThinking } });
  assert.deepEqual(emptyThinkingProblems([ran(1, 0)]), []);
  assert.match(emptyThinkingProblems([ran(1, 1)]).join(), /comes out of the pull request/);
  assert.match(emptyThinkingProblems([ran(0, 0)]).join(), /no follow-up/);
  assert.match(emptyThinkingProblems([]).join(), /did not run/);
  const display = selectCases({ dryRun: true }).find((c) => c.id === 'probe-display-summarized') as LabCase;
  assert.deepEqual(emptyThinkingProblems([ran(1, 0), outcomeOf(display, 'error', 'x', { toolLoop: { followUps: 1, withThinking: 1 } })]), [], 'that probe asks for thinking text, so its block is not empty');
});

test('renderBody records what the real run sent back, or that no tool loop ran', () => {
  const binary = { tag: LAB_RELEASE_TAG, asset: 'aura-linux-arm64', sha256: 'abc', url: 'https://x', file: '/x' };
  const price = { model: 'm', inputPerMTok: 2, outputPerMTok: 10, source: 'OpenRouter', fetched: '2026-10-31' };
  const render = (toolLoop: { followUps: number; withThinking: number }) => renderBody([reasoningCase], [outcomeOf(reasoningCase, 'answer', 'x', { workerRequest: { model: 'claude-sonnet-5-5' }, toolLoop })], binary, price);
  assert.match(render({ followUps: 2, withThinking: 0 }), /0 of the worker's 2 follow-up requests after a tool call/);
  assert.match(render({ followUps: 0, withThinking: 0 }), /made no follow-up request after a tool call/);
});

test('renderBody prints the before and after table, the binary and what really ran', () => {
  const outcomes = [
    outcomeOf(beforeCase, 'error', PROVIDER_ERROR),
    outcomeOf(minimalCase, 'answer', 'Paris', { usage: { input: 20, output: 8 } }),
    outcomeOf(reasoningCase, 'answer', 'Partition by date.', { usage: { input: 900, output: 300 }, workerRequest: { model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } } }),
  ];
  const binary = { tag: LAB_RELEASE_TAG, asset: 'aura-linux-arm64', sha256: 'abc123', url: 'https://x', file: '/x' };
  const body = renderBody([beforeCase, minimalCase, reasoningCase], outcomes, binary, { model: 'anthropic/claude-sonnet-5.5', inputPerMTok: 2, outputPerMTok: 10, source: 'OpenRouter (https://openrouter.ai/x)', fetched: '2026-10-31' });
  assert.match(body, /^\| \| before \| after \|/);
  assert.ok(body.includes('`examples/minimal/anthropic.toml`'));
  assert.ok(body.includes('claude-sonnet-4-20250514: error'));
  assert.ok(body.includes('404 Not Found'));
  assert.ok(body.includes('claude-sonnet-5-5: answered "Paris"'));
  assert.ok(body.includes(LAB_RELEASE_TAG));
  assert.ok(body.includes('abc123'));
  assert.ok(body.includes(RELEASE_VS_BASE), 'the table says how the binary relates to the base commit');
  assert.ok(body.includes('"effort":"high"'));
  assert.ok(body.includes('no temperature'));
  assert.ok(body.includes('OpenRouter'));
  assert.ok(body.includes('2026-10-31'));
  renderResult({ lab: '05-models', status: 'measured', measured_at: '2026-11-01', body });
});

test('a case that could not run is absent from the table, and a line says what it needs', () => {
  const binary = { tag: LAB_RELEASE_TAG, asset: 'aura-linux-arm64', sha256: 'abc', url: 'https://x', file: '/x' };
  const price = { model: 'm', inputPerMTok: 2, outputPerMTok: 10, source: 'OpenRouter', fetched: '2026-10-31' };
  const outcomes = [outcomeOf(beforeCase, 'error', PROVIDER_ERROR), outcomeOf(minimalCase, 'answer', 'Paris', { usage: { input: 20, output: 8 } })];
  const body = renderBody([beforeCase, minimalCase], outcomes, binary, price, [{ label: reasoningCase.label, missingKeys: ['OPENAI_API_KEY'] }]);
  const rows = body.split('\n').filter((line) => line.startsWith('| `'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].includes(REASONING_PATH), false);
  assert.ok(body.includes(`Not run: ${reasoningCase.label}. It also needs OPENAI_API_KEY, so it has no row here.`));
  assert.equal(/reasoning run/.test(body), false, 'nothing is said about a run that did not happen');
});

test('the cost line never prices the mixed run, and never reads missing usage as zero cost', () => {
  const binary = { tag: LAB_RELEASE_TAG, asset: 'aura-linux-arm64', sha256: 'abc', url: 'https://x', file: '/x' };
  const price = { model: 'm', inputPerMTok: 2, outputPerMTok: 10, source: 'OpenRouter', fetched: '2026-10-31' };
  const cases = [minimalCase, reasoningCase];
  const render = (minimal: CaseOutcome['usage'], reasoning: CaseOutcome['usage']) => renderBody(cases, [outcomeOf(minimalCase, 'answer', 'Paris', { usage: minimal }), outcomeOf(reasoningCase, 'answer', 'x', { usage: reasoning })], binary, price);
  const reported = render({ input: 20, output: 8 }, { input: 40, output: 20 });
  assert.match(reported, /from 20 input and 8 output tokens/);
  assert.match(reported, /isn't priced/);
  assert.match(reported, /40 input, 20 output/);
  const silent = render(null, null);
  assert.equal(silent.includes('$0.000000'), false);
  assert.match(silent, /no token usage for the minimal example/);
  assert.match(silent, /no token usage for the reasoning run/);
});

// ---------------------------------------------------------------- the harness

const HARNESS = join(import.meta.dirname, 'harness', 'run-cases.sh');

test('the harness is valid bash, surfaces the real provider error and never handles a key itself', () => {
  execFileSync('bash', ['-n', HARNESS]);
  const script = readFileSync(HARNESS, 'utf8');
  assert.ok(script.includes('AURA_DEBUG_PROVIDER_ERRORS=true'));
  assert.ok(script.includes('webserver'));
  assert.equal(script.includes('API_KEY'), false);
  assert.ok(script.includes('read -r id config request aura'), 'each case names its own binary');
  assert.ok(script.includes('"$out/version.txt"'), 'each case records the version that served it');
});

// ---------------------------------------------------------------- run.ts, end to end

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
}

/** A throwaway keepup-demo: a tiny clone with the two examples, its patches, and pr.json. */
function fixtureRoot(): { root: string; baseCommit: string } {
  const root = mkdtempSync(join(tmpdir(), 'lab05-root-'));
  const clone = join(root, 'tmp', 'aura');
  mkdirSync(join(clone, 'examples', 'minimal'), { recursive: true });
  mkdirSync(join(clone, 'examples', 'complete'), { recursive: true });
  git(clone, 'init', '-q');
  writeFileSync(join(clone, MINIMAL_PATH), '[agent.llm]\nprovider = "anthropic"\nmodel = "claude-sonnet-4-20250514"\n');
  writeFileSync(join(clone, REASONING_PATH), REASONING_TOML.replace(/claude-sonnet-5-5/g, 'claude-sonnet-4-5-20250929'));
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'base');
  const baseCommit = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, MINIMAL_PATH), '[agent.llm]\nprovider = "anthropic"\nmodel = "claude-sonnet-5-5"\n');
  writeFileSync(join(clone, REASONING_PATH), REASONING_TOML);
  git(clone, 'commit', '-q', '-am', 'move');
  const labDir = join(root, 'lab', '05-models');
  mkdirSync(join(labDir, 'patches'), { recursive: true });
  git(clone, 'format-patch', '-q', `${baseCommit}..HEAD`, '--no-signature', '-o', join(labDir, 'patches'));
  git(clone, 'reset', '-q', '--hard', baseCommit);
  const patches = readdirSync(join(labDir, 'patches')).map((p) => `patches/${p}`);
  writeFileSync(join(labDir, 'pr.json'), JSON.stringify({ baseCommit, stages: [{ patches }] }));
  return { root, baseCommit };
}

function logFor(id: string, secret: string): string {
  if (id === 'probe-empty-thinking') return succeededLog().replace(WORKER_TRACE, WORKER_TRACE + DROPPED_FOLLOW_UP);
  if (id.startsWith('probe')) return `${WORKER_TRACE}ERROR ${'orchestration.worker="deep-analysis"'}: aura::logging: error="blocks in the latest assistant message cannot be modified"\nOutcome: 0 of 1 tasks succeeded.\n`;
  return id.includes('reasoning') ? `${DROPPED_FOLLOW_UP}${succeededLog()}x-api-key ${secret}\n` : `${secret}\n`;
}

/** Plays the sandbox: writes what the harness would, from what the host prepared. */
function fakeSandbox(root: string, calls: SandboxCall[], secret = ''): LabDeps['sandbox'] {
  return async (call) => {
    calls.push(call);
    const mode = call.command.includes('/dry-run') ? 'dry-run' : 'run';
    const work = join(root, 'lab', '.work', '05-models', mode);
    for (const line of readFileSync(join(work, 'cases.tsv'), 'utf8').trim().split('\n')) {
      const [id, , , binary] = line.split('\t');
      const out = join(work, 'raw', id);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'version.txt'), `aura ${/-v?(\d+\.\d+\.\d+)-/.exec(`-${binary.split('/').pop()}`)?.[1]}\n`);
      const retired = id === 'before-minimal';
      writeFileSync(join(out, 'http_status.txt'), '200');
      writeFileSync(join(out, 'response.json'), chat(retired ? PROVIDER_ERROR : `Answer ${secret}`));
      writeFileSync(join(out, 'server.log'), logFor(id, secret));
    }
    return 0;
  };
}

const BOTH_KEYS = { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' };

function deps(root: string, calls: SandboxCall[], overrides: Partial<LabDeps> = {}): LabDeps {
  const bytes = new TextEncoder().encode('binary');
  return {
    env: () => { throw new Error('the environment must not be read here'); },
    arch: async () => 'arm64',
    fetcher: fakeRelease(bytes).fetcher,
    sandbox: fakeSandbox(root, calls),
    now: () => new Date('2026-11-01T09:00:00Z'),
    log: () => {},
    ...overrides,
  };
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

test('with no key it writes not_run through the same path and exits 3', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  const code = await runLab({ root, dryRun: false }, deps(root, calls, { env: () => ({}) }));
  assert.equal(code, 3);
  assert.equal(calls.length, 0);
  const result = readResult(join(root, 'lab', '05-models', 'result.md'));
  assert.equal(result?.status, 'not_run');
  assert.equal(result?.needs, 'ANTHROPIC_API_KEY and OPENAI_API_KEY');
  assert.equal(/\d/.test(result?.body ?? ''), false, 'not_run has no numbers at all');
  assert.equal(result?.body.includes('\n'), false, 'not_run is one sentence');
});

test('with only the Anthropic key the two minimal cases run, the reasoning case is absent, and the result is partial and needs the OpenAI key', async () => {
  const { root } = fixtureRoot();
  const secret = 'real-looking-anthropic-key';
  const calls: SandboxCall[] = [];
  const code = await runLab({ root, dryRun: false }, deps(root, calls, { env: () => ({ ANTHROPIC_API_KEY: secret }), sandbox: fakeSandbox(root, calls, secret) }));
  assert.equal(code, 3, 'it is waiting on a key, and nothing failed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.SANDBOX_ENV, 'ANTHROPIC_API_KEY');
  assert.equal('OPENAI_API_KEY' in calls[0].env, false);
  assert.equal(calls[0].command.includes(secret), false);
  const work = join(root, 'lab', '.work', '05-models', 'run');
  const ran = readFileSync(join(work, 'cases.tsv'), 'utf8').trim().split('\n').map((line) => line.split('\t')[0]);
  assert.deepEqual(ran, ['before-minimal', 'after-minimal']);
  const labDir = join(root, 'lab', '05-models');
  const result = readResult(join(labDir, 'result.md'));
  assert.equal(result?.status, 'partial');
  assert.equal(result?.needs, 'OPENAI_API_KEY');
  assert.equal(result?.measured_at, '2026-11-01');
  assert.equal(result?.title_number, undefined);
  assert.equal(result?.body.includes(secret), false);
  assert.ok(result?.body.includes('claude-sonnet-4-20250514: error'));
  assert.ok(result?.body.includes('claude-sonnet-5-5: answered'));
  assert.ok(result?.body.includes(`Not run: \`${REASONING_PATH}\``));
  assert.ok(existsSync(join(labDir, 'out', 'after-minimal', 'response.json')));
  assert.equal(existsSync(join(labDir, 'out', 'after-reasoning-shipped')), false);
  for (const f of allFiles(join(labDir, 'out'))) assert.equal(readFileSync(f, 'utf8').includes(secret), false, f);
});

test('with only the Anthropic key a case that misses still fails the run, and needs says both things', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  const missed: LabDeps['sandbox'] = async (call) => {
    await fakeSandbox(root, calls)(call);
    writeFileSync(join(root, 'lab', '.work', '05-models', 'run', 'raw', 'after-minimal', 'response.json'), chat(PROVIDER_ERROR));
    return 0;
  };
  assert.equal(await runLab({ root, dryRun: false }, deps(root, calls, { env: () => ({ ANTHROPIC_API_KEY: 'a' }), sandbox: missed })), 1);
  const result = readResult(join(root, 'lab', '05-models', 'result.md'));
  assert.equal(result?.status, 'partial');
  assert.match(result?.needs ?? '', /^OPENAI_API_KEY, and a rerun, because after-minimal did not/);
});

test('without the Anthropic key nothing can run: not_run, nothing spent, and needs names what is missing', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  assert.equal(await runLab({ root, dryRun: false }, deps(root, calls, { env: () => ({ OPENAI_API_KEY: 'o' }) })), 3);
  assert.equal(calls.length, 0);
  const result = readResult(join(root, 'lab', '05-models', 'result.md'));
  assert.equal(result?.status, 'not_run');
  assert.equal(result?.needs, 'ANTHROPIC_API_KEY');
  assert.equal(existsSync(join(root, 'lab', '05-models', 'out')), false);
});

test('a real run clears the last run from out/ but keeps the repo-test evidence, which has its own lifecycle', async () => {
  const { root } = fixtureRoot();
  const out = join(root, 'lab', '05-models', 'out');
  mkdirSync(join(out, 'stale-case'), { recursive: true });
  writeFileSync(join(out, 'stale-case', 'response.json'), '{}');
  writeFileSync(join(out, 'repo-tests.json'), '{"summary":"kept"}\n');
  const calls: SandboxCall[] = [];
  assert.equal(await runLab({ root, dryRun: false }, deps(root, calls, { env: () => ({ ANTHROPIC_API_KEY: 'a' }), sandbox: fakeSandbox(root, calls) })), 3);
  assert.equal(readFileSync(join(out, 'repo-tests.json'), 'utf8'), '{"summary":"kept"}\n');
  assert.equal(existsSync(join(out, 'stale-case')), false);
  assert.ok(existsSync(join(out, 'before-minimal', 'response.json')));
});

test('a missing key leaves a stronger earlier result alone', async () => {
  const { root } = fixtureRoot();
  const path = join(root, 'lab', '05-models', 'result.md');
  const earlier = renderResult({ lab: '05-models', status: 'measured', measured_at: '2026-11-01', body: '| a |' });
  writeFileSync(path, earlier);
  assert.equal(await runLab({ root, dryRun: false }, deps(root, [], { env: () => ({}) })), 3);
  assert.equal(readFileSync(path, 'utf8'), earlier);
  const calls: SandboxCall[] = [];
  assert.equal(await runLab({ root, dryRun: false }, deps(root, calls, { env: () => ({ ANTHROPIC_API_KEY: 'a' }), sandbox: fakeSandbox(root, calls) })), 3);
  assert.equal(readFileSync(path, 'utf8'), earlier);
  assert.equal(calls.length, 0, 'one key can\'t beat a measured result, so nothing is spent trying');
});

test('--dry-run writes only under lab/.work, never reads a key and never touches result.md or out/', async () => {
  const { root } = fixtureRoot();
  const labDir = join(root, 'lab', '05-models');
  mkdirSync(join(labDir, 'out'));
  writeFileSync(join(labDir, 'out', 'keep.txt'), 'earlier raw output');
  const earlier = renderResult({ lab: '05-models', status: 'measured', measured_at: '2026-11-01', body: '| a |' });
  writeFileSync(join(labDir, 'result.md'), earlier);
  const before = new Set(allFiles(root).filter((f) => !f.includes(`${join('tmp', 'aura')}`)));
  const calls: SandboxCall[] = [];
  const code = await runLab({ root, dryRun: true }, deps(root, calls));
  assert.equal(code, 0);
  assert.equal(readFileSync(join(labDir, 'result.md'), 'utf8'), earlier);
  assert.deepEqual(readdirSync(join(labDir, 'out')), ['keep.txt']);
  const created = allFiles(root).filter((f) => !f.includes(`${join('tmp', 'aura')}`) && !before.has(f)).map((f) => relative(root, f));
  const outside = created.filter((f) => !f.startsWith(join('lab', '.work', '05-models', 'dry-run')) && !f.startsWith(join('lab', '.work', 'bin')));
  assert.deepEqual(outside, []);
  assert.ok(created.some((f) => f.endsWith('result-preview.md')));
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, FAKE_KEYS.ANTHROPIC_API_KEY);
  assert.equal(calls[0].env.OPENAI_API_KEY, FAKE_KEYS.OPENAI_API_KEY);
});

test('--dry-run points every provider at the fake and removes its worktree afterwards', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  await runLab({ root, dryRun: true }, deps(root, calls));
  const configs = join(root, 'lab', '.work', '05-models', 'dry-run', 'configs');
  for (const name of readdirSync(configs)) {
    const toml = readFileSync(join(configs, name), 'utf8');
    assert.ok(toml.includes('base_url = "http://host.docker.internal:'), name);
    assert.equal(toml.includes('api.anthropic.com'), false);
  }
  assert.ok(!git(join(root, 'tmp', 'aura'), 'worktree', 'list').includes('dry-run'));
});

test('--dry-run asks for summarized thinking only on the probe', async () => {
  const { root } = fixtureRoot();
  await runLab({ root, dryRun: true }, deps(root, []));
  const configs = join(root, 'lab', '.work', '05-models', 'dry-run', 'configs');
  assert.ok(readFileSync(join(configs, 'probe-display-summarized.toml'), 'utf8').includes('display = "summarized"'));
  assert.equal(readFileSync(join(configs, 'after-reasoning-shipped.toml'), 'utf8').includes('display'), false);
});

test('every case, real or dry, runs on the lab release, and no other release is fetched', async () => {
  for (const [dryRun, env] of [[true, () => { throw new Error('the environment must not be read here'); }], [false, () => BOTH_KEYS]] as const) {
    const { root } = fixtureRoot();
    const release = fakeRelease(new TextEncoder().encode('binary'));
    assert.equal(await runLab({ root, dryRun }, deps(root, [], { fetcher: release.fetcher, env, sandbox: fakeSandbox(root, []) })), 0);
    assert.deepEqual([...new Set(release.calls.map((u) => u.split('/').at(-2)))], [LAB_RELEASE_TAG]);
    const rows = readFileSync(join(root, 'lab', '.work', '05-models', dryRun ? 'dry-run' : 'run', 'cases.tsv'), 'utf8').trim().split('\n');
    for (const row of rows) assert.equal(row.split('\t')[3], `/lab-work/bin/${LAB_RELEASE_TAG}-aura-linux-arm64`, row);
  }
});

test('--dry-run fails once a real tool loop stops dropping the empty block, so the sentence comes out', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  const logged: string[] = [];
  const fixed: LabDeps['sandbox'] = async (call) => {
    await fakeSandbox(root, calls)(call);
    writeFileSync(join(root, 'lab', '.work', '05-models', 'dry-run', 'raw', 'probe-empty-thinking', 'server.log'), `${WORKER_TRACE}${KEPT_FOLLOW_UP}Outcome: 1 of 1 tasks succeeded.\n`);
    return 0;
  };
  assert.equal(await runLab({ root, dryRun: true }, deps(root, calls, { sandbox: fixed, log: (l) => logged.push(l) })), 1);
  assert.ok(logged.some((l) => l.includes('comes out of the pull request')));
});

test('--dry-run fails when an expected result does not show up', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  const broken: LabDeps['sandbox'] = async (call) => {
    await fakeSandbox(root, calls)(call);
    writeFileSync(join(root, 'lab', '.work', '05-models', 'dry-run', 'raw', 'before-minimal', 'response.json'), chat('It answered anyway.'));
    return 0;
  };
  assert.equal(await runLab({ root, dryRun: true }, deps(root, calls, { sandbox: broken })), 1);
});

test('with both keys it runs the patched configs, passes keys by name and saves only scrubbed output', async () => {
  const { root, baseCommit } = fixtureRoot();
  const secret = 'real-looking-key-value';
  const calls: SandboxCall[] = [];
  const code = await runLab({ root, dryRun: false }, deps(root, calls, { env: () => ({ ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: secret }), sandbox: fakeSandbox(root, calls, secret) }));
  assert.equal(code, 0);
  const call = calls[0];
  assert.equal(call.env.SANDBOX_ENV, 'ANTHROPIC_API_KEY OPENAI_API_KEY');
  assert.equal(call.command.includes(secret), false);
  assert.ok(call.command.includes('/lab/05-models/harness/run-cases.sh'));
  assert.equal(call.worktree, join(root, 'tmp', 'lab-wt-05'));
  const work = join(root, 'lab', '.work', '05-models', 'run');
  assert.ok(readFileSync(join(work, 'configs', 'before-minimal.toml'), 'utf8').includes('claude-sonnet-4-20250514'));
  assert.ok(readFileSync(join(work, 'configs', 'after-minimal.toml'), 'utf8').includes('claude-sonnet-5-5'));
  assert.equal(readFileSync(join(work, 'configs', 'after-minimal.toml'), 'utf8').includes('base_url'), false);
  assert.ok(git(join(root, 'tmp', 'aura'), 'rev-parse', 'HEAD') === baseCommit);
  const labDir = join(root, 'lab', '05-models');
  const saved = allFiles(join(labDir, 'out'));
  assert.ok(saved.length > 0);
  for (const f of saved) assert.equal(readFileSync(f, 'utf8').includes(secret), false, f);
  const result = readResult(join(labDir, 'result.md'));
  assert.equal(result?.status, 'measured');
  assert.equal(result?.measured_at, '2026-11-01');
  assert.equal(result?.title_number, undefined);
  assert.equal(result?.body.includes(secret), false);
});

test('a run that misses keeps a stronger result and its out/', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  const env = () => ({ ANTHROPIC_API_KEY: 'a-key', OPENAI_API_KEY: 'o-key' });
  assert.equal(await runLab({ root, dryRun: false }, deps(root, calls, { env, sandbox: fakeSandbox(root, calls, 'a-key') })), 0);
  assert.equal(calls[0].env.SANDBOX_ENV, 'ANTHROPIC_API_KEY OPENAI_API_KEY');
  const labDir = join(root, 'lab', '05-models');
  const measured = readFileSync(join(labDir, 'result.md'), 'utf8');
  assert.ok(existsSync(join(labDir, 'out', 'after-reasoning-shipped', 'response.json')));
  const rawBefore = readFileSync(join(labDir, 'out', 'after-minimal', 'response.json'), 'utf8');
  const worse: LabDeps['sandbox'] = async (call) => {
    await fakeSandbox(root, calls, 'a-key')(call);
    writeFileSync(join(root, 'lab', '.work', '05-models', 'run', 'raw', 'after-minimal', 'response.json'), chat(PROVIDER_ERROR));
    return 0;
  };
  assert.equal(await runLab({ root, dryRun: false }, deps(root, calls, { env, sandbox: worse })), 1);
  assert.equal(readFileSync(join(labDir, 'result.md'), 'utf8'), measured);
  assert.equal(readFileSync(join(labDir, 'out', 'after-minimal', 'response.json'), 'utf8'), rawBefore);
});

test('a binary that reports another version stops the lab', async () => {
  const { root } = fixtureRoot();
  const calls: SandboxCall[] = [];
  const otherVersion: LabDeps['sandbox'] = async (call) => {
    await fakeSandbox(root, calls)(call);
    writeFileSync(join(root, 'lab', '.work', '05-models', 'run', 'raw', 'after-minimal', 'version.txt'), 'aura 0.2.20\n');
    return 0;
  };
  const code = await runLab({ root, dryRun: false }, deps(root, calls, { env: () => BOTH_KEYS, sandbox: otherVersion }));
  assert.equal(code, 1);
  assert.equal(existsSync(join(root, 'lab', '05-models', 'result.md')), false);
});

test('a sandbox that fails stops the lab without writing a result', async () => {
  const { root } = fixtureRoot();
  const failing: LabDeps['sandbox'] = async () => 125;
  const code = await runLab({ root, dryRun: false }, deps(root, [], { env: () => BOTH_KEYS, sandbox: failing }));
  assert.equal(code, 1);
  assert.equal(existsSync(join(root, 'lab', '05-models', 'result.md')), false);
});

// ---------------------------------------------------------------- the repo's own tests

const SHIPPED_OK = 'test config_test::tests::test_all_shipped_configs_parse ... ok';
const cargoOutput = (shippedLine: string, unit: string) => `   Compiling aura-config v0.2.12 (/repo/crates/aura-config)
running 3 tests
${shippedLine}
test config_test::tests::other ... ok
test config_test::tests::slow ... ignored

test result: ${unit}; 1 ignored; 0 measured; 0 filtered out; finished in 0.10s

   Doc-tests aura_config

running 1 test
test crates/aura-config/src/lib.rs - doc (line 1) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;
const CARGO_OK = cargoOutput(SHIPPED_OK, 'ok. 2 passed; 0 failed');
const CARGO_FAILED = cargoOutput('test config_test::tests::test_all_shipped_configs_parse ... FAILED', 'FAILED. 1 passed; 1 failed');

test('parseCargoTests adds up every test binary, and reads the shipped-config test by name', () => {
  const ok = parseCargoTests(CARGO_OK);
  assert.deepEqual([ok.passed, ok.failed, ok.ignored], [3, 0, 1]);
  assert.equal(ok.shippedConfigs, 'ok');
  assert.deepEqual(ok.failedTests, []);
  assert.equal(ok.resultLines.length, 2);
  const failed = parseCargoTests(CARGO_FAILED);
  assert.deepEqual([failed.passed, failed.failed], [2, 1]);
  assert.equal(failed.shippedConfigs, 'FAILED');
  assert.deepEqual(failed.failedTests, ['config_test::tests::test_all_shipped_configs_parse']);
  assert.throws(() => parseCargoTests('error: could not compile `aura-config`\n'), /no test result/);
});

const STAGE_DATES = ['2026-09-01', '2026-09-28', '2026-09-30'];
const stagesFrom = (outputs: readonly string[], exits: readonly number[] = outputs.map(() => 0)): StageRun[] => outputs.map((output, i) => ({ date: STAGE_DATES[i], exit: exits[i], run: parseCargoTests(output) }));

test('the repo-tests summary claims a pass only when every stage passed, the shipped-config test among them', () => {
  const good = summarize(stagesFrom([CARGO_OK, CARGO_OK, CARGO_OK]), 'abc', '2026-11-01');
  assert.match(good.summary, /^3 of 3 aura-config tests pass in the sandbox at the tip, and at each of the 3 stages/);
  assert.match(good.summary, /test_all_shipped_configs_parse/);
  assert.match(good.summary, /1 ignored/);
  assert.match(good.summary, /the rest of the workspace's tests didn't run/);
  assert.deepEqual(good.tests, { total: 3, passed: 3, failed: 0, ignored: 1 });
  assert.equal(good.commit, 'abc');
  assert.equal(good.ran_on, '2026-11-01');
  const bad = summarize(stagesFrom([CARGO_OK, CARGO_FAILED, CARGO_OK]), 'abc', '2026-11-01');
  assert.equal(/at each of the/.test(bad.summary), false);
  assert.match(bad.summary, /fail at the stage dated 2026-09-28/);
  const exitOnly = summarize(stagesFrom([CARGO_OK, CARGO_OK, CARGO_OK], [0, 0, 101]), 'abc', '2026-11-01');
  assert.match(exitOnly.summary, /fail at the stage dated 2026-09-30/);
});

test('the repo-tests command applies each stage\'s patches in order, then runs the command the fork\'s CI runs', () => {
  const command = sandboxCommand([{ date: STAGE_DATES[0], patches: ['patches/a.patch'] }, { date: STAGE_DATES[1], patches: ['patches/b.patch'] }]);
  assert.ok(command.indexOf('/lab/05-models/patches/a.patch') < command.indexOf('stage-0.txt'));
  assert.ok(command.indexOf('stage-0.txt') < command.indexOf('/lab/05-models/patches/b.patch'));
  const workflow = readFileSync(join(REPO_ROOT, 'lab', 'ci', 'aura.yml'), 'utf8');
  for (const run of command.matchAll(/cargo test [^>]*?(?= >)/g)) assert.ok(workflow.includes(run[0]), run[0]);
  assert.equal(command.includes('cargo test -p aura-config --locked'), true);
  assert.equal(/API_KEY/.test(command), false);
});

// ---------------------------------------------------------------- pr.json, against the real repo

const prFile = join(import.meta.dirname, 'pr.json');
const clone = join(REPO_ROOT, 'tmp', 'aura');
const FINAL_TITLE = 'Example on a retired Claude model fails today, another retires 30 Nov · move to claude-sonnet-5-5';
const STAGE_TITLES = [
  'Example on a retired Claude model fails today · move to claude-sonnet-5',
  'Example on a retired Claude model fails today · move to claude-sonnet-5-5',
  FINAL_TITLE,
];

test('pr.json passes the App loader and carries every field in the contract', () => {
  const spec = loadSpec(prFile, REPO_ROOT);
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  assert.equal(raw.id, '05');
  assert.equal(raw.baseCommit, '5a5efba014081aa59ebc31d6d745b680d1dec1ba');
  assert.equal(raw.baseBranch, 'replay/5a5efba');
  assert.equal(raw.branch, 'keepup/2026-09-01-retired-claude-models');
  assert.equal(raw.ciWorkflow, 'lab/ci/aura.yml');
  assert.ok(raw.founderLine.length > 0);
  assert.equal(/\d/.test(raw.founderLine), false);
  assert.deepEqual(raw.effect, ['keeps working']);
  assert.equal(raw.effort, 'Hours');
  assert.deepEqual(spec.stages.map((s) => s.date), ['2026-09-01', '2026-09-28', '2026-09-30']);
  assert.equal(spec.stages[0].title.includes('claude-sonnet-5-5'), false, 'Sonnet 5.5 did not exist on 1 Sep');
  assert.deepEqual(spec.stages.map((s) => s.title), STAGE_TITLES);
  assert.ok(readFileSync(join(REPO_ROOT, raw.spec), 'utf8').includes(`"${FINAL_TITLE}"`), 'the last stage carries the title in the spec');
  assert.equal(spec.stages[0].title.includes('30 Nov') || spec.stages[1].title.includes('30 Nov'), false, 'the 30 Nov date was not announced until 30 Sep');
  for (const stage of spec.stages) {
    assert.equal(stage.title.includes('{{'), false, 'this title takes no number');
    for (const file of stage.patchFiles) assert.ok(existsSync(file), file);
  }
});

test('pr.json only cites sources it names, and its text never claims a measurement', () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  assert.ok(raw.sources.includes(raw.sourceUrl));
  const everyText = [raw.founderLine, raw.whyItFits, raw.risks, raw.rollback, ...raw.stages.flatMap((s: { whatShipped: string; whatThisChanges: string }) => [s.whatShipped, s.whatThisChanges])].join(' ');
  assert.equal(/\bmeasured\b/i.test(everyText), false);
  assert.equal(everyText.includes('TODO'), false);
});

const gitAvailable = existsSync(clone);

test('Stage 3 doesn\'t say temperature is what returns the 400, which Anthropic\'s page doesn\'t say of the 1.0 this file sends', () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const last = raw.stages[raw.stages.length - 1];
  assert.equal(/400 error for a thinking budget and for temperature/.test(last.whatThisChanges), false);
  assert.match(last.whatThisChanges, /400 error for a thinking budget/);
  assert.match(last.whatThisChanges, /temperature is removed as the migration guide says/);
  assert.equal(/context_window|1M/.test(JSON.stringify(raw)), false, 'patch 3 no longer changes it');
  const patch = readFileSync(join(import.meta.dirname, last.patches[0]), 'utf8');
  assert.equal(/temperature, top_p or top_k returns/.test(patch), false);
  assert.equal(/for sampling parameters/.test(patch.replace(/\n/g, ' ')), false);
  assert.equal(/for a manual thinking budget and for/.test(patch.replace(/\n/g, ' ')), false);
  assert.equal(/^[-+]context_window/m.test(patch), false, 'the spec doesn\'t ask for it');
});

test('Risks names every older Claude id left outside crates/ at the base commit, and says what it leaves out', { skip: !gitAvailable }, () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const hits = execFileSync('git', ['-C', clone, 'grep', '-n', 'claude-', raw.baseCommit, '--', '.', ':!crates', ':!Cargo.lock'], { encoding: 'utf8' }).trim().split('\n').map((row) => {
    const [, path, line] = row.split(':');
    return { path, line };
  });
  const moved = raw.where.map((w: { path: string; line: number }) => `${w.path}:${w.line}`);
  const left = hits.filter((h) => !moved.includes(`${h.path}:${h.line}`));
  assert.ok(left.length >= 8, `found ${left.length}`);
  for (const { path, line } of left) {
    const at = raw.risks.indexOf(`${path}:`);
    assert.ok(at >= 0, `Risks doesn't name ${path}`);
    assert.match(raw.risks.slice(at, at + path.length + 24), new RegExp(`\\b${line}\\b`), `Risks doesn't name ${path}:${line}`);
  }
  assert.match(raw.risks, /every id outside crates\//);
  assert.match(raw.risks, /crates\/aura-cli\/src\/init\/provider\.rs:85/);
  assert.match(raw.risks, /examples\/minimal\/openrouter\.toml:22 is live.*no longer lists.*follow-up/);
});
const FORK_RIG_REV = '5b0238a1d74e1d7c68034384b69e17f62890d517';
const RIG_STREAMING = `https://github.com/mezmo/rig/blob/${FORK_RIG_REV}/rig/rig-core/src/providers/anthropic/streaming.rs#L393-L394`;

test('pr.json says the worker loses its reasoning on a tool turn, where a reader will see it', () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const last = raw.stages[raw.stages.length - 1];
  for (const text of [raw.risks, last.whatThisChanges]) {
    assert.match(text, /rig/);
    assert.match(text, /discards?|drops?/);
    assert.match(text, /empty thinking block/);
    assert.match(text, /reasoning/);
    assert.match(text, /signature/);
  }
  assert.match(raw.risks, /including empty ones/);
  assert.equal(/accepts/.test(last.comment), false, 'the comment must not promise more than the docs do');
  assert.ok(raw.sources.includes(RIG_STREAMING));
});

test('the release the lab runs is the base commit: everything between them is CI, docs or tests', { skip: !gitAvailable }, () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const inClone = (...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' });
  const handlers = 'crates/aura-web-server/src/streaming/handlers.rs';
  const notBuilt = /^(\.github\/|docs\/|scripts\/|Jenkinsfile$|release\.config\.js$|package\.json$|[A-Z]+\.md$|crates\/aura-test-utils\/|crates\/[^/]+\/tests\/)/;
  const changed = inClone('diff', '--name-only', LAB_RELEASE_TAG, raw.baseCommit).trim().split('\n');
  assert.deepEqual(changed.filter((f) => !notBuilt.test(f)), [handlers]);
  const testModule = inClone('show', `${LAB_RELEASE_TAG}:${handlers}`).split('\n').indexOf('#[cfg(test)]') + 1;
  assert.ok(testModule > 0);
  const hunks = [...inClone('diff', '-U0', LAB_RELEASE_TAG, raw.baseCommit, '--', handlers).matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)];
  assert.ok(hunks.length > 0);
  for (const [, start, removed] of hunks) {
    assert.equal(removed ?? '1', '0', 'the base only adds to this file');
    assert.ok(Number(start) > testModule, 'and only inside its test module');
  }
  const released = inClone('log', '-1', '--format=%cs', LAB_RELEASE_TAG).trim();
  assert.ok(released <= raw.stages[0].date, `${LAB_RELEASE_TAG} was released on ${released}, after the first stage`);
  assert.ok(readFileSync(join(import.meta.dirname, 'testset-notes.md'), 'utf8').includes(LAB_RELEASE_TAG));
});

test('pr.json cites only the release the lab ran on, and that release predates the last stage', { skip: !gitAvailable }, () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const last = raw.stages[raw.stages.length - 1];
  const text = JSON.stringify(raw);
  assert.deepEqual([...new Set(text.match(/v\d+\.\d+\.\d+/g))], [LAB_RELEASE_TAG]);
  assert.ok(last.whatThisChanges.includes(`${LAB_RELEASE_TAG} release binary`));
  assert.ok(raw.sources.includes(`https://github.com/mezmo/aura/releases/tag/${LAB_RELEASE_TAG}`));
  const released = execFileSync('git', ['-C', clone, 'log', '-1', '--format=%cs', LAB_RELEASE_TAG], { encoding: 'utf8' }).trim();
  assert.ok(released <= last.date, `${LAB_RELEASE_TAG} was released on ${released}, after the stage dated ${last.date}`);
  const pins = (ref: string) => execFileSync('git', ['-C', clone, 'show', `${ref}:Cargo.toml`], { encoding: 'utf8' }).includes(`rev = "${FORK_RIG_REV}"`);
  assert.ok(pins(raw.baseCommit), 'the rig link is the rev the base pins');
  assert.ok(pins(LAB_RELEASE_TAG), 'the lab release pins the same rig as the base');
});

test('every where line points at the model it claims, at the base commit', { skip: !gitAvailable }, () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const claims: Record<string, string> = { [MINIMAL_PATH]: 'model = "claude-sonnet-4-20250514"', [REASONING_PATH]: 'model = "claude-sonnet-4-5-20250929"' };
  assert.equal(raw.where.length, 2);
  for (const where of raw.where as { path: string; line: number }[]) {
    const lines = execFileSync('git', ['-C', clone, 'show', `${raw.baseCommit}:${where.path}`], { encoding: 'utf8' }).split('\n');
    assert.equal(lines[where.line - 1], claims[where.path], `${where.path}:${where.line}`);
  }
});

test('the patches apply in order at the base commit and each leaves the configs true', { skip: !gitAvailable }, () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const index = join(mkdtempSync(join(tmpdir(), 'lab05-index-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const inClone = (...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', env });
  inClone('read-tree', raw.baseCommit);
  const expected = [
    { minimal: 'claude-sonnet-5', reasoning: 'claude-sonnet-4-5-20250929' },
    { minimal: 'claude-sonnet-5-5', reasoning: 'claude-sonnet-4-5-20250929' },
    { minimal: 'claude-sonnet-5-5', reasoning: 'claude-sonnet-5-5' },
  ];
  raw.stages.forEach((stage: { patches: string[] }, i: number) => {
    for (const patch of stage.patches) inClone('apply', '--cached', join(import.meta.dirname, patch));
    assert.ok(inClone('show', `:${MINIMAL_PATH}`).includes(`model = "${expected[i].minimal}"\n`));
    assert.ok(inClone('show', `:${REASONING_PATH}`).includes(`model = "${expected[i].reasoning}"\n`));
  });
  const final = inClone('show', `:${REASONING_PATH}`);
  assert.equal(final.includes('budget_tokens = '), false);
  assert.equal(/^temperature/m.test(final), false);
  assert.ok(final.includes('[orchestration.worker.deep-analysis.llm.additional_params.thinking]\ntype = "adaptive"\n'));
  assert.ok(final.includes('[orchestration.worker.deep-analysis.llm.additional_params.output_config]\neffort = "high"\n'));
  assert.ok(final.includes('\ncontext_window = 200_000\n'), 'as at the base commit: the spec does not change it');
});

test('the patches are the branch: applied at the base commit they give its exact tree', { skip: !gitAvailable }, () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const index = join(mkdtempSync(join(tmpdir(), 'lab05-index-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const inClone = (...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', env }).trim();
  inClone('read-tree', raw.baseCommit);
  for (const stage of raw.stages as { patches: string[] }[]) for (const patch of stage.patches) inClone('apply', '--cached', join(import.meta.dirname, patch));
  assert.equal(inClone('write-tree'), inClone('rev-parse', `${raw.branch}^{tree}`));
  const dates = inClone('log', '--format=%an|%aI|%cI', `${raw.baseCommit}..${raw.branch}`).split('\n').reverse();
  assert.deepEqual(dates, (raw.stages as { date: string }[]).map((s) => `keepup[bot]|${s.date}T12:00:00+00:00|${s.date}T12:00:00+00:00`));
});

const EVIDENCE_FILE = join(import.meta.dirname, 'out', 'repo-tests.json');

test('saved repo-test evidence is for the tip of this branch, and covers every stage', { skip: !gitAvailable || (existsSync(EVIDENCE_FILE) ? false : 'no evidence saved') }, () => {
  const raw = JSON.parse(readFileSync(prFile, 'utf8'));
  const evidence = JSON.parse(readFileSync(EVIDENCE_FILE, 'utf8'));
  assert.equal(evidence.commit, execFileSync('git', ['-C', clone, 'rev-parse', raw.branch], { encoding: 'utf8' }).trim());
  assert.equal(evidence.tests.total, evidence.tests.passed + evidence.tests.failed);
  assert.deepEqual(evidence.stages.map((s: { date: string }) => s.date), raw.stages.map((s: { date: string }) => s.date));
  assert.equal(typeof evidence.summary, 'string');
});
