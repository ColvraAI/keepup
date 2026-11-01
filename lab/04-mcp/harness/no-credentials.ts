// Calls every tool a real server lists, with no good credentials behind it, to see which
// ones work anyway. A tool that does can't show a token or a backend is good, so it can't
// count toward "tested" (lib/table.ts). Only a dry run asks for this: it's the evidence
// behind each server's readsBackend list in servers.ts.
type Json = Record<string, unknown>;

const TEXT_LIMIT = 400;
const NOT_READY = /INDEX_NOT_READY/;
/** Dynatrace Managed's schema names this as a free string, then refuses every value but this one on a placeholder config. */
const BY_NAME: Json = { environment_alias: 'ALL_ENVIRONMENTS' };

export interface ToolAnswer { isError: boolean; text: string }
export interface ProbeCall { name: string; ok: boolean; text: string }
export type CallTool = (name: string, args: Json) => Promise<ToolAnswer>;
export interface ProbeOptions { retries?: number; retryDelayMs?: number }

function dummyValue(schema: Json): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const dummies: Record<string, unknown> = { integer: 1, number: 1, boolean: false, array: [], object: {} };
  return schema.type === undefined || !(String(schema.type) in dummies) ? 'demo' : dummies[String(schema.type)];
}

/** Just enough for a call to get past the schema and reach the backend. */
export function dummyArguments(schema: { required?: string[]; properties?: Record<string, Json> } | undefined): Json {
  const required = schema?.required ?? [];
  return Object.fromEntries(required.map((name) => [name, BY_NAME[name] ?? dummyValue(schema?.properties?.[name] ?? {})]));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function answerOf(call: CallTool, name: string, args: Json): Promise<ToolAnswer> {
  try {
    return await call(name, args);
  } catch (error) {
    return { isError: true, text: (error as Error).message };
  }
}

async function askUntilReady(call: CallTool, name: string, args: Json, options: Required<ProbeOptions>): Promise<ToolAnswer> {
  const answer = await answerOf(call, name, args);
  if (!(answer.isError && NOT_READY.test(answer.text)) || options.retries === 0) return answer;
  await sleep(options.retryDelayMs);
  return askUntilReady(call, name, args, { ...options, retries: options.retries - 1 });
}

export async function probeTools(tools: readonly { name: string; inputSchema?: unknown }[], call: CallTool, options: ProbeOptions = {}): Promise<ProbeCall[]> {
  const settings = { retries: options.retries ?? 24, retryDelayMs: options.retryDelayMs ?? 5000 };
  const results: ProbeCall[] = [];
  for (const tool of tools) {
    const answer = await askUntilReady(call, tool.name, dummyArguments(tool.inputSchema as Parameters<typeof dummyArguments>[0]), settings);
    results.push({ name: tool.name, ok: !answer.isError, text: answer.text.slice(0, TEXT_LIMIT) });
  }
  return results;
}
