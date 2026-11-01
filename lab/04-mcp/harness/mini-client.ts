// The dry run's stand-in for the official SDK, which only ever exists inside the sandbox.
// It speaks just enough stdio JSON-RPC to list a fake server's tools.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ServerSpec } from '../lib/example.ts';
import type { McpConnection } from './list-tools.ts';

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

export async function connectMini(spec: ServerSpec, env: NodeJS.ProcessEnv): Promise<McpConnection> {
  if (spec.transport !== 'stdio') throw new Error('the dry-run client only speaks stdio');
  const child = spawn(spec.cmd[0], [...spec.cmd.slice(1), ...spec.args], { env: { ...env, ...spec.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map<number, (message: Json) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Json;
    waiting.get(message.id as number)?.(message);
  });
  let nextId = 1;
  const request = (method: string, params: Json): Promise<Json> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve(message.result as Json);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'keepup-lab-dry-run', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    client: 'dry-run stand-in client',
    serverInfo: (init.serverInfo as McpConnection['serverInfo']) ?? null,
    listAllTools: async () => (await request('tools/list', {})).tools as { name: string }[],
    callTool: async (name, args) => {
      const answer = await request('tools/call', { name, arguments: args });
      return { isError: answer.isError === true, text: JSON.stringify(answer.content ?? null) };
    },
    close: async () => { child.kill(); },
  };
}
