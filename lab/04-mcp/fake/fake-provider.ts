// A stand-in for OpenAI's Chat Completions API, used only by --dry-run so the real AURA
// binary can run an investigation with no key and no spend, and by the offered step of a
// real run, which only needs to see what AURA sends. The first turn asks for one of the
// tools AURA offered, unless it's answer-only; the next turn answers. Given a script, it
// asks for each scripted call AURA offers in turn, then answers. It records what AURA sent,
// bodies only, so a key in a header is never kept.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_ANSWER = 'Fake answer from the dry-run provider.';

type Json = Record<string, unknown>;

export interface ScriptedCall { name: string; arguments?: Json; delayMs?: number }
export interface FakeProvider { port: number; requests: () => readonly Json[]; close: () => Promise<void> }

function offeredTools(body: Json): string[] {
  const tools = Array.isArray(body.tools) ? (body.tools as { function?: { name?: string } }[]) : [];
  return tools.map((t) => t.function?.name).filter((n): n is string => typeof n === 'string');
}

const messagesOf = (body: Json): Json[] => (Array.isArray(body.messages) ? (body.messages as Json[]) : []);
const lastRole = (body: Json): unknown => messagesOf(body)[messagesOf(body).length - 1]?.role;

/** The scripted call this turn asks for, once per tool result so far. */
function scriptedCall(body: Json, calls: readonly ScriptedCall[]): ScriptedCall | undefined {
  const offered = offeredTools(body);
  const asked = messagesOf(body).filter((m) => m.role === 'tool').length;
  return calls.filter((c) => offered.includes(c.name))[asked];
}

function chunk(delta: Json, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function usageChunk(): string {
  return `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
}

function toolCallFrames(tool: string, args: Json = {}, turn = 0): string[] {
  const call = { index: 0, id: `call_fake_${turn}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } };
  return [chunk({ role: 'assistant', tool_calls: [call] }), chunk({}, 'tool_calls'), usageChunk(), 'data: [DONE]\n\n'];
}

function answerFrames(): string[] {
  return [chunk({ role: 'assistant', content: FAKE_ANSWER }), chunk({}, 'stop'), usageChunk(), 'data: [DONE]\n\n'];
}

export function nextFrames(body: Json, preferredTools: readonly string[], calls: readonly ScriptedCall[] = []): string[] {
  const offered = offeredTools(body);
  if (calls.some((c) => offered.includes(c.name))) {
    const next = scriptedCall(body, calls);
    return next ? toolCallFrames(next.name, next.arguments, messagesOf(body).filter((m) => m.role === 'tool').length) : answerFrames();
  }
  const tool = preferredTools.find((t) => offered.includes(t)) ?? offered[0];
  return lastRole(body) === 'tool' || !tool ? answerFrames() : toolCallFrames(tool);
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(part as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Json;
}

async function serve(req: IncomingMessage, res: ServerResponse, record: (body: Json) => void, frames: (body: Json) => string[], delayFor: (body: Json) => number): Promise<void> {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end(JSON.stringify({ error: { message: `no route for ${req.url}` } }));
    return;
  }
  const body = await readBody(req);
  record(body);
  await new Promise((resolve) => setTimeout(resolve, delayFor(body)));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frames(body).join(''));
}

export function startFakeProvider(preferredTools: readonly string[] = [], options: { answerOnly?: boolean; calls?: readonly ScriptedCall[] } = {}): Promise<FakeProvider> {
  const seen: Json[] = [];
  const calls = options.calls ?? [];
  const frames = (body: Json) => (options.answerOnly ? answerFrames() : nextFrames(body, preferredTools, calls));
  const delayFor = (body: Json) => (options.answerOnly ? 0 : scriptedCall(body, calls)?.delayMs ?? 0);
  const server = createServer((req, res) => {
    serve(req, res, (body) => seen.push(body), frames, delayFor).catch((error: Error) => res.writeHead(500).end(error.message));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as AddressInfo).port,
      requests: () => seen,
      close: () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    }));
  });
}
