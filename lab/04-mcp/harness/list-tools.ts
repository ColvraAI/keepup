// Part one: start a server exactly as its example does and record the tools it lists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandLine, parseServers, resolveTemplates, type ServerSpec } from '../lib/example.ts';
import type { Credentials, ToolsFailure, ToolsRecord } from '../lib/records.ts';
import type { ServerId } from '../servers.ts';
import type { CallTool } from './no-credentials.ts';

export interface McpConnection {
  client: string;
  serverInfo: { name?: string; version?: string } | null;
  listAllTools: () => Promise<{ name: string }[]>;
  /** Only the dry run's no-credentials step calls a tool directly. */
  callTool?: CallTool;
  close: () => Promise<void>;
}

export type Connector = (spec: ServerSpec, env: NodeJS.ProcessEnv) => Promise<McpConnection>;

export interface ListStep {
  repo: string;
  server: ServerId;
  example: string;
  credentials: Credentials;
  env: NodeJS.ProcessEnv;
  /** Dry run only: the fake server that replaces the example's own. */
  override?: { cmd: string[] };
}

export function specFor(step: Pick<ListStep, 'repo' | 'server' | 'example' | 'env' | 'override'>): ServerSpec {
  const servers = parseServers(readFileSync(join(step.repo, step.example), 'utf8'));
  const spec = servers[step.server];
  if (!spec) throw new Error(`${step.example} has no server called ${step.server}`);
  const resolved = resolveTemplates(spec, step.env);
  return step.override ? { name: step.server, transport: 'stdio', cmd: step.override.cmd, args: [], env: {} } : resolved;
}

/** How the record says it was started: the command, or the URL. Never headers or env, where tokens live. */
export function startedAs(spec: ServerSpec): string {
  return spec.transport === 'stdio' ? commandLine(spec) : spec.url;
}

export async function listTools(step: ListStep, connect: Connector, now: () => Date = () => new Date()): Promise<ToolsRecord | ToolsFailure> {
  const base = { kind: 'tools' as const, server: step.server, example: step.example };
  const began = Date.now();
  let connection: McpConnection | null = null;
  try {
    const spec = specFor(step);
    connection = await connect(spec, step.env);
    const tools = await connection.listAllTools();
    return {
      ...base, ok: true, measuredAt: now().toISOString(), transport: spec.transport, startedAs: startedAs(spec), credentials: step.credentials,
      client: connection.client, serverInfo: connection.serverInfo, elapsedMs: Date.now() - began, toolNames: tools.map((t) => t.name).sort(), tools,
    };
  } catch (error) {
    return { ...base, ok: false, measuredAt: now().toISOString(), error: (error as Error).message };
  } finally {
    await connection?.close().catch(() => undefined);
  }
}
