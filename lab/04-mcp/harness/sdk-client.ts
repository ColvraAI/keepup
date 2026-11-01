// The real client: the official MCP SDK, installed under /lab-work by setup.sh and only
// ever loaded inside the sandbox.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { ServerSpec } from '../lib/example.ts';
import type { McpConnection } from './list-tools.ts';

const REQUEST_TIMEOUT_MS = 180_000;
const CALL_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 2000;

type Sdk = {
  Client: new (info: { name: string; version: string }, options: { capabilities: object; jsonSchemaValidator: object }) => {
    connect: (transport: unknown, options: { timeout: number }) => Promise<void>;
    getServerVersion: () => McpConnection['serverInfo'];
    listTools: (params: { cursor?: string }, options: { timeout: number }) => Promise<{ tools: { name: string }[]; nextCursor?: string }>;
    callTool: (params: { name: string; arguments: Record<string, unknown> }, schema: undefined, options: { timeout: number }) => Promise<{ isError?: boolean; content?: unknown; structuredContent?: unknown }>;
    close: () => Promise<void>;
  };
  StdioClientTransport: new (options: { command: string; args: string[]; env: Record<string, string>; stderr: string; cwd?: string }) => { stderr: Readable | null };
  StreamableHTTPClientTransport: new (url: URL, options: { requestInit: { headers: Record<string, string> } }) => unknown;
};

/** AURA doesn't check a tool's answer against its output schema, so this client takes answers the way AURA does. */
const ACCEPT_ANY_OUTPUT = { getValidator: () => (input: unknown) => ({ valid: true, data: input, errorMessage: undefined }) };

function loadSdk(sdkDir: string): Sdk {
  const require = createRequire(join(sdkDir, 'package.json'));
  return {
    ...require('@modelcontextprotocol/sdk/client/index.js'),
    ...require('@modelcontextprotocol/sdk/client/stdio.js'),
    ...require('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  };
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined));
}

function transportFor(sdk: Sdk, spec: ServerSpec, env: NodeJS.ProcessEnv, cwd: string): { stderr?: Readable | null } {
  if (spec.transport === 'http_streamable') return new sdk.StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } }) as object;
  return new sdk.StdioClientTransport({ command: spec.cmd[0], args: [...spec.cmd.slice(1), ...spec.args], env: { ...definedEnv(env), ...spec.env }, stderr: 'pipe', cwd });
}

/** Keeps the end of a server's stderr, because "Connection closed" alone says nothing about why. */
export function stderrTail(stream: Readable | null | undefined, limit: number = STDERR_TAIL_CHARS): () => string {
  let text = '';
  stream?.on('data', (chunk: Buffer | string) => { text = `${text}${String(chunk)}`.slice(-limit); });
  return () => text.trim();
}

async function explained<T>(work: Promise<T>, tail: () => string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const said = tail();
    throw new Error(`${(error as Error).message}${said ? `; the server said: ${said}` : ''}`);
  }
}

async function allTools(list: Sdk['Client']['prototype']['listTools']): Promise<{ name: string }[]> {
  const pages = async (cursor?: string): Promise<{ name: string }[]> => {
    const page = await list(cursor ? { cursor } : {}, { timeout: REQUEST_TIMEOUT_MS });
    return page.nextCursor ? [...page.tools, ...(await pages(page.nextCursor))] : page.tools;
  };
  return pages();
}

export function sdkConnector(sdkDir: string, sdkVersion: string, cwd: string) {
  const sdk = loadSdk(sdkDir);
  return async (spec: ServerSpec, env: NodeJS.ProcessEnv): Promise<McpConnection> => {
    const client = new sdk.Client({ name: 'keepup-lab', version: '0' }, { capabilities: {}, jsonSchemaValidator: ACCEPT_ANY_OUTPUT });
    const transport = transportFor(sdk, spec, env, cwd);
    const tail = stderrTail(transport.stderr);
    await explained(client.connect(transport, { timeout: REQUEST_TIMEOUT_MS }), tail);
    return {
      client: `@modelcontextprotocol/sdk ${sdkVersion}`,
      serverInfo: client.getServerVersion() ?? null,
      listAllTools: () => explained(allTools(client.listTools.bind(client)), tail),
      callTool: async (name, args) => {
        const answer = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
        return { isError: answer.isError === true, text: JSON.stringify(answer.structuredContent ?? answer.content ?? null) };
      },
      close: () => client.close(),
    };
  };
}
