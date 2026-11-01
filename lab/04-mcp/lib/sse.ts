// Reads what AURA's streaming API sends with AURA_CUSTOM_EVENTS on: OpenAI-style chunks
// plus named aura.* events. The field names come from crates/aura-events/src/lib.rs.

export interface Frame { event: string | null; data: string }
export interface ToolCall {
  id: string;
  name: string;
  ok: boolean | null;
  ms: number | null;
  error?: string;
  /** The tool a wrapper was asked to run. What the wrapper did depends on this, not on its own name. */
  wraps?: string;
}
export interface McpServerStatus { server_name: string; transport: string; status: string; tools_count: number; reason?: string }
export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

export interface StreamSummary {
  answer: string;
  toolCalls: ToolCall[];
  mcpServers: McpServerStatus[];
  usage: Usage | null;
  model: string | null;
  done: boolean;
  errors: string[];
}

type Json = Record<string, unknown>;

/** AURA reports success on these, though the tool never ran: it's what a closed connection to a server gives. */
const UNDELIVERED = /^Toolset error:/;

/** Sentry's server runs most of its tools through this one, by name. */
const WRAPPER_TOOLS = ['execute_sentry_tool'];

function parseBlock(block: string): Frame | null {
  const lines = block.split(/\r?\n/);
  const event = lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim() ?? null;
  const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice('data:'.length).trim()).join('\n');
  return data ? { event, data } : null;
}

/** Whole frames only: anything after the last blank line never finished arriving. */
export function parseFrames(text: string): Frame[] {
  const blocks = text.split(/\r?\n\r?\n/).slice(0, -1);
  return blocks.map(parseBlock).filter((f): f is Frame => f !== null);
}

function readJson(data: string): Json | null {
  try {
    return JSON.parse(data) as Json;
  } catch {
    return null;
  }
}

function deltaOf(chunk: Json): string {
  const choices = Array.isArray(chunk.choices) ? (chunk.choices as Json[]) : [];
  return choices.map((c) => (c.delta as Json | undefined)?.content).filter((t): t is string => typeof t === 'string').join('');
}

function errorOf(chunk: Json): string | null {
  const error = chunk.error;
  if (!error) return null;
  if (typeof error === 'string') return error;
  return String((error as Json).message ?? JSON.stringify(error));
}

function wrappedTool(frame: Json): Pick<ToolCall, 'wraps'> {
  const name = (frame.arguments as Json | undefined)?.name;
  return WRAPPER_TOOLS.includes(String(frame.tool_name)) && typeof name === 'string' ? { wraps: name.trim() } : {};
}

function outcome(frame: Json): Pick<ToolCall, 'ok' | 'error'> {
  if (typeof frame.result === 'string' && UNDELIVERED.test(frame.result)) return { ok: false, error: frame.result };
  return { ok: frame.success === true, ...(typeof frame.error === 'string' ? { error: frame.error } : {}) };
}

function withTool(calls: readonly ToolCall[], frame: Json, finished: boolean): ToolCall[] {
  const id = String(frame.tool_id);
  const existing = calls.find((c) => c.id === id);
  const base: ToolCall = { ...(existing ?? { id, name: String(frame.tool_name), ok: null, ms: null }), ...wrappedTool(frame) };
  const next: ToolCall = finished ? { ...base, ms: Number(frame.duration_ms), ...outcome(frame) } : base;
  return existing ? calls.map((c) => (c.id === id ? next : c)) : [...calls, next];
}

function applyNamed(summary: StreamSummary, event: string, data: Json): StreamSummary {
  switch (event) {
    case 'aura.session_info':
      return { ...summary, model: typeof data.model === 'string' ? data.model : summary.model };
    case 'aura.mcp_status':
      return { ...summary, mcpServers: (data.servers as McpServerStatus[]) ?? [] };
    case 'aura.tool_requested':
    case 'aura.tool_start':
      return { ...summary, toolCalls: withTool(summary.toolCalls, data, false) };
    case 'aura.tool_complete':
      return { ...summary, toolCalls: withTool(summary.toolCalls, data, true) };
    case 'aura.usage':
      return { ...summary, usage: { prompt_tokens: Number(data.prompt_tokens), completion_tokens: Number(data.completion_tokens), total_tokens: Number(data.total_tokens) } };
    default:
      return summary;
  }
}

function applyFrame(summary: StreamSummary, frame: Frame): StreamSummary {
  if (frame.data === '[DONE]') return { ...summary, done: true };
  const data = readJson(frame.data);
  if (!data) return { ...summary, errors: [...summary.errors, `unreadable frame: ${frame.data.slice(0, 120)}`] };
  if (frame.event) return applyNamed(summary, frame.event, data);
  const error = errorOf(data);
  if (error) return { ...summary, errors: [...summary.errors, error] };
  return { ...summary, answer: summary.answer + deltaOf(data) };
}

export function summarize(frames: readonly Frame[]): StreamSummary {
  const empty: StreamSummary = { answer: '', toolCalls: [], mcpServers: [], usage: null, model: null, done: false, errors: [] };
  return frames.reduce(applyFrame, empty);
}

/** Tool names per server from GET /aura/info?detail=tools:summary. A server that never connected has no tools key. */
export function toolNamesByServer(info: unknown, agentId: string): Record<string, string[]> {
  const agents = ((info as Json).agents ?? []) as Json[];
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`/aura/info has no agent ${agentId}`);
  const servers = Object.entries((agent.mcp_servers ?? {}) as Record<string, Json>);
  const withTools = servers.filter(([, server]) => Array.isArray(server.tools));
  return Object.fromEntries(withTools.map(([name, server]) => [name, (server.tools as { name: string }[]).map((t) => t.name).sort()]));
}
