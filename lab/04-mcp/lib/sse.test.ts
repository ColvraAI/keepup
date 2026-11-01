import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFrames, summarize, toolNamesByServer } from './sse.ts';

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gpt-5.2', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const named = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const STREAM = [
  ': a heartbeat comment\n\n',
  named('aura.session_info', { model: 'gpt-5.2' }),
  named('aura.mcp_status', { servers: [
    { server_name: 'pagerduty', transport: 'http_streamable', status: 'failed', tools_count: 0, reason: '401' },
    { server_name: 'signoz', transport: 'stdio', status: 'connected', tools_count: 40 },
  ] }),
  chunk({ role: 'assistant', content: '' }),
  named('aura.tool_requested', { tool_id: 't1', tool_name: 'signoz_list_services', arguments: { a: 1 } }),
  named('aura.tool_start', { tool_id: 't1', tool_name: 'signoz_list_services' }),
  named('aura.tool_complete', { tool_id: 't1', tool_name: 'signoz_list_services', duration_ms: 12, success: true, result: 'r' }),
  named('aura.tool_requested', { tool_id: 't2', tool_name: 'signoz_search_logs', arguments: {} }),
  named('aura.tool_complete', { tool_id: 't2', tool_name: 'signoz_search_logs', duration_ms: 7, success: false, error: 'upstream 401' }),
  chunk({ content: 'Errors spiked ' }),
  chunk({ content: 'after the deploy.' }),
  named('aura.usage', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
  chunk({}, 'stop'),
  'data: [DONE]\n\n',
].join('');

test('parseFrames splits named events, plain data and comments', () => {
  const frames = parseFrames(STREAM);
  assert.equal(frames[0].event, 'aura.session_info');
  assert.equal(frames[frames.length - 1].data, '[DONE]');
  assert.equal(frames.filter((f) => f.event === null).length, 5);
});

test('parseFrames handles CRLF and a frame cut off at the end', () => {
  const frames = parseFrames('event: a\r\ndata: {"x":1}\r\n\r\ndata: {"partial"');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'a');
});

test('summarize reads the answer, the tool calls in order, the servers and the usage', () => {
  const s = summarize(parseFrames(STREAM));
  assert.equal(s.answer, 'Errors spiked after the deploy.');
  assert.deepEqual(s.toolCalls, [
    { id: 't1', name: 'signoz_list_services', ok: true, ms: 12 },
    { id: 't2', name: 'signoz_search_logs', ok: false, ms: 7, error: 'upstream 401' },
  ]);
  assert.deepEqual(s.mcpServers.map((m) => [m.server_name, m.status, m.tools_count]), [['pagerduty', 'failed', 0], ['signoz', 'connected', 40]]);
  assert.deepEqual(s.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.equal(s.model, 'gpt-5.2');
  assert.equal(s.done, true);
  assert.deepEqual(s.errors, []);
});

test('a tool that was requested and never finished stays in the list as unfinished', () => {
  const s = summarize(parseFrames(named('aura.tool_requested', { tool_id: 't', tool_name: 'x', arguments: {} })));
  assert.deepEqual(s.toolCalls, [{ id: 't', name: 'x', ok: null, ms: null }]);
});

test("a wrapper tool's call says which tool it was asked to run", () => {
  const wrapped = (name: unknown) => summarize(parseFrames([
    named('aura.tool_requested', { tool_id: 't', tool_name: 'execute_sentry_tool', arguments: { name, arguments: {} } }),
    named('aura.tool_start', { tool_id: 't', tool_name: 'execute_sentry_tool' }),
    named('aura.tool_complete', { tool_id: 't', tool_name: 'execute_sentry_tool', duration_ms: 3, success: true }),
  ].join(''))).toolCalls[0];
  assert.deepEqual(wrapped(' search_issues '), { id: 't', name: 'execute_sentry_tool', ok: true, ms: 3, wraps: 'search_issues' });
  assert.equal(wrapped(7).wraps, undefined, 'a name that is not text wraps nothing');
  const plain = summarize(parseFrames(named('aura.tool_requested', { tool_id: 't', tool_name: 'other', arguments: { name: 'search_issues' } }))).toolCalls[0];
  assert.equal(plain.wraps, undefined, 'only a wrapper tool wraps');
});

test('a call AURA could not deliver is a failed call, though AURA reports success', () => {
  const frames = [
    named('aura.tool_requested', { tool_id: 't', tool_name: 'signoz_list_services', arguments: {} }),
    named('aura.tool_complete', { tool_id: 't', tool_name: 'signoz_list_services', duration_ms: 1, success: true, result: 'Toolset error: ToolCallError: ToolCallError: ToolCallError: Failed to send tool call request' }),
  ].join('');
  const [call] = summarize(parseFrames(frames)).toolCalls;
  assert.equal(call.ok, false);
  assert.match(call.error ?? '', /Failed to send tool call request/);
});

test('real stream: a server whose connection had gone reads as failed calls, not working ones', () => {
  const stream = summarize(parseFrames(readFileSync(join(import.meta.dirname, 'fixtures', 'signoz-connection-gone.sse'), 'utf8')));
  assert.deepEqual(stream.toolCalls.map((c) => [c.name, c.ok]), [['signoz_search_docs', false], ['signoz_list_services', false]]);
});

test('an error frame and a stream with no [DONE] are both visible', () => {
  const s = summarize(parseFrames(`data: ${JSON.stringify({ error: { message: 'model not found' } })}\n\n`));
  assert.deepEqual(s.errors, ['model not found']);
  assert.equal(s.done, false);
  assert.equal(s.answer, '');
});

test('a line of data that is not JSON is an error in the summary, not a crash', () => {
  const s = summarize(parseFrames('data: {oops\n\n'));
  assert.equal(s.errors.length, 1);
});

test('toolNamesByServer reads /aura/info, and a server with no tools is absent, not empty', () => {
  const info = { agents: [{ id: 'incident-response/signoz', model: 'gpt-5.2', mcp_servers: {
    pagerduty: { transport: 'http_streamable', url: 'https://x' },
    signoz: { transport: 'stdio', command: 'docker', tools: [{ name: 'b' }, { name: 'a' }] },
  } }] };
  assert.deepEqual(toolNamesByServer(info, 'incident-response/signoz'), { signoz: ['a', 'b'] });
  assert.throws(() => toolNamesByServer(info, 'nope'), /no agent/);
});

test('the reader understands a stream the real AURA binary produced, against the fake provider', () => {
  const stream = summarize(parseFrames(readFileSync(join(import.meta.dirname, 'fixtures', 'real-aura-stream.sse'), 'utf8')));
  assert.equal(stream.done, true);
  assert.deepEqual(stream.errors, []);
  assert.equal(stream.model, 'openai/gpt-5.2');
  assert.equal(stream.answer.trim(), 'Fake answer from the dry-run provider.');
  assert.deepEqual(stream.mcpServers.map((m) => [m.server_name, m.status, m.tools_count]), [['pagerduty', 'failed', 0], ['signoz', 'connected', 46]]);
  assert.equal(stream.toolCalls.length, 1);
  assert.equal(stream.toolCalls[0].name, 'signoz_list_services');
  assert.equal(stream.toolCalls[0].ok, false);
  assert.match(stream.toolCalls[0].error ?? '', /UPSTREAM_ERROR/);
  assert.deepEqual(stream.usage, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
});
