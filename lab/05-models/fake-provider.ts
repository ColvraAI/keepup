// A stand-in for the Anthropic and OpenAI HTTP APIs, used only by --dry-run, so the
// real AURA binary can run end to end with no key and no spend. It enforces what
// Anthropic documents for these models (the rules and sources are in testset-notes.md),
// so a config the real API would refuse is refused here too. Nothing it returns
// reaches result.md.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type Json = Record<string, unknown>;

export const FAKE_ANSWER = 'Fake answer from the dry-run provider.';
export const FAKE_PLAN_ANSWER = 'Fake orchestrated answer from the dry-run provider.';
const FAKE_SUMMARY = 'Fake thinking summary.';
const CURRENT_MODELS = new Set(['claude-sonnet-5', 'claude-sonnet-5-5']);
/** Any value is refused here, which is API version 2026-10-21's rule and stricter than the 2023-06-01 that rig sends: see testset-notes.md. */
const SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k'];

export interface Rejection { status: number; type: string; message: string }
export interface RecordedRequest { path: string; hasCredential: boolean; body: Json }
export interface Turn { text?: string; tool?: { name: string; input: Json } }

export interface FakeProvider {
  port: number;
  requests: () => readonly RecordedRequest[];
  close: () => Promise<void>;
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);

function blocksOf(message: Json): Json[] {
  return asList(message.content);
}

/** Signature to the text it was issued with: a block sent back must still match it. */
function modifiedThinking(body: Json, issued: ReadonlyMap<string, string>): boolean {
  const assistants = asList(body.messages).filter((m) => m.role === 'assistant');
  const latest = assistants[assistants.length - 1];
  if (!latest) return false;
  return blocksOf(latest).some((block) => {
    if (block.type !== 'thinking') return false;
    const original = issued.get(String(block.signature));
    return original === undefined || block.thinking !== original;
  });
}

function sonnet55Rejection(body: Json): Rejection | null {
  const thinking = isObject(body.thinking) ? body.thinking.type : undefined;
  const invalid = (message: string): Rejection => ({ status: 400, type: 'invalid_request_error', message });
  if (thinking === 'disabled') return invalid('To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.');
  const choice = isObject(body.tool_choice) ? body.tool_choice.type : undefined;
  if (choice === 'any' || choice === 'tool') return invalid('tool_choice: type "tool" and "any" are not supported for this model.');
  return null;
}

/** What the documented API would refuse, or null when the request is acceptable. */
export function anthropicRejection(body: Json, issued: ReadonlyMap<string, string>): Rejection | null {
  const model = String(body.model);
  if (!CURRENT_MODELS.has(model)) return { status: 404, type: 'not_found_error', message: `model: ${model}` };
  const invalid = (message: string): Rejection => ({ status: 400, type: 'invalid_request_error', message });
  if (isObject(body.thinking) && body.thinking.type === 'enabled') {
    return invalid('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.');
  }
  const sampling = SAMPLING_PARAMS.find((p) => p in body);
  if (sampling) return invalid(`${sampling} is not supported for this model.`);
  if (model === 'claude-sonnet-5-5') {
    const rejected = sonnet55Rejection(body);
    if (rejected) return rejected;
  }
  if (modifiedThinking(body, issued)) return invalid('`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified');
  return null;
}

function lastMessageText(messages: Json[]): string {
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return blocksOf(last).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
}

function endsWithToolResult(messages: Json[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  return last.role === 'tool' || blocksOf(last).some((b) => b.type === 'tool_result');
}

function coordinatorTurn(messages: Json[]): Turn {
  if (endsWithToolResult(messages)) return { text: 'Recorded.' };
  if (!lastMessageText(messages).includes('USER QUERY:')) {
    return { tool: { name: 'respond_directly', input: { response: FAKE_PLAN_ANSWER, routing_rationale: 'The worker has finished.' } } };
  }
  const step = { type: 'task', task: 'Weigh the two options and recommend one.', worker: 'deep-analysis' };
  return { tool: { name: 'create_plan', input: { goal: 'Recommend one option.', steps: [step], routing_rationale: 'Needs reasoning.', planning_summary: 'One task for deep-analysis.' } } };
}

function toolNames(body: Json): string[] {
  return asList(body.tools).map((t) => String(isObject(t.function) ? t.function.name : t.name));
}

/** A worker with read_artifact calls it first, so every dry run walks a real tool loop. */
function workerTurn(tools: readonly string[], messages: Json[]): Turn {
  const used = messages.filter((m) => m.role === 'assistant').flatMap(blocksOf).filter((b) => b.type === 'tool_use').map((b) => String(b.name));
  if (used.includes('submit_result')) return { text: 'Submitted.' };
  if (tools.includes('read_artifact') && !used.includes('read_artifact')) return { tool: { name: 'read_artifact', input: { filename: 'notes.md' } } };
  return { tool: { name: 'submit_result', input: { summary: FAKE_ANSWER, result: FAKE_ANSWER, confidence: 'high' } } };
}

/** The next assistant turn: decided by which tools the request offers, as AURA's agents do. */
export function nextTurn(body: Json): Turn {
  const tools = toolNames(body);
  const messages = asList(body.messages);
  if (tools.includes('create_plan')) return coordinatorTurn(messages);
  if (tools.includes('submit_result')) return workerTurn(tools, messages);
  return { text: FAKE_ANSWER };
}

function sse(res: ServerResponse, lines: readonly string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(lines.join(''));
}

const event = (name: string, data: Json): string => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;

function thinkingEvents(index: number, text: string, signature: string): string[] {
  const deltas = text ? [text.slice(0, 5), text.slice(5)] : [''];
  return [
    event('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    ...deltas.map((thinking) => event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking } })),
    event('content_block_delta', { index, delta: { type: 'signature_delta', signature } }),
    event('content_block_stop', { index }),
  ];
}

function turnEvents(index: number, turn: Turn): string[] {
  if (turn.tool) {
    const start = { type: 'tool_use', id: `toolu_fake_${index}`, name: turn.tool.name, input: {} };
    return [
      event('content_block_start', { index, content_block: start }),
      event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.tool.input) } }),
      event('content_block_stop', { index }),
    ];
  }
  return [
    event('content_block_start', { index, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index, delta: { type: 'text_delta', text: turn.text ?? '' } }),
    event('content_block_stop', { index }),
  ];
}

/** Thinking first, as Sonnet 5.5 returns it: empty text under its default `display`. */
function anthropicStream(body: Json, turn: Turn, signature: string, summary: string): string[] {
  const usage = { input_tokens: 10, output_tokens: 0 };
  const message = { id: 'msg_fake', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage };
  return [
    event('message_start', { message }),
    ...thinkingEvents(0, summary, signature),
    ...turnEvents(1, turn),
    event('message_delta', { delta: { stop_reason: turn.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    event('message_stop', {}),
  ];
}

/** The signatures this server has handed out, each with the thinking text it came with. */
interface Signatures { known: ReadonlyMap<string, string>; issue: (text: string) => string }

function newSignatures(): Signatures {
  const known = new Map<string, string>();
  const issue = (text: string): string => {
    const signature = `fake-signature-${known.size + 1}`;
    known.set(signature, text);
    return signature;
  };
  return { known, issue };
}

function handleAnthropic(res: ServerResponse, body: Json, signatures: Signatures): void {
  const rejected = anthropicRejection(body, signatures.known);
  if (rejected) {
    res.writeHead(rejected.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: rejected.type, message: rejected.message }, request_id: 'req_fake' }));
    return;
  }
  const display = isObject(body.thinking) ? body.thinking.display : undefined;
  const summary = display === 'summarized' ? FAKE_SUMMARY : '';
  sse(res, anthropicStream(body, nextTurn(body), signatures.issue(summary), summary));
}

function handleOpenAi(res: ServerResponse, body: Json): void {
  const turn = nextTurn(body);
  const chunk = (delta: Json, finish: string | null): string => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: null })}\n\n`;
  const content = turn.tool
    ? chunk({ tool_calls: [{ index: 0, id: 'call_fake', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.input) } }] }, null)
    : chunk({ content: turn.text }, null);
  const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
  sse(res, [content, chunk({}, turn.tool ? 'tool_calls' : 'stop'), usage, 'data: [DONE]\n\n']);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isObject(parsed)) throw new Error('request body is not a JSON object');
  return parsed;
}

function route(req: IncomingMessage, res: ServerResponse, body: Json, signatures: Signatures): void {
  if (req.url === '/v1/messages') return handleAnthropic(res, body, signatures);
  if (req.url === '/v1/chat/completions') return handleOpenAi(res, body);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${req.url}` } }));
}

/** Listens on loopback only: Docker Desktop forwards host.docker.internal to it. */
export async function startFakeProvider(): Promise<FakeProvider> {
  const recorded: RecordedRequest[] = [];
  const signatures = newSignatures();
  const server = createServer((req, res) => {
    readJson(req)
      .then((body) => {
        const hasCredential = Boolean(req.headers['x-api-key'] || req.headers.authorization);
        recorded.push({ path: req.url ?? '', hasCredential, body });
        route(req, res, body, signatures);
      })
      .catch((e: unknown) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: (e as Error).message } }));
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => [...recorded],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
      server.closeAllConnections();
    }),
  };
}
