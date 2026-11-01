// The raw outputs the harness writes and lab/04-mcp/out/ keeps. Every number in result.md
// is read from one of these.
import type { DefinitionSizes } from './sizes.ts';
import type { McpServerStatus, StreamSummary, ToolCall, Usage } from './sse.ts';
import type { ServerId } from '../servers.ts';

/** 'real' means the values came from the environment. Only a working call that read the backend proves them good: hosted Sentry lists its tools for any token, and some of its tools work on one too. */
export type Credentials = 'placeholder' | 'real' | 'fake';

interface Base { server: ServerId; example: string; measuredAt: string }

export interface ToolsFailure extends Base { kind: 'tools'; ok: false; error: string }
export interface ToolsRecord extends Base {
  kind: 'tools';
  ok: true;
  transport: string;
  startedAs: string;
  credentials: Credentials;
  client: string;
  serverInfo: { name?: string; version?: string } | null;
  elapsedMs: number;
  toolNames: string[];
  tools: unknown[];
}

export interface AuraToolsFailure extends Base { kind: 'aura-tools'; ok: false; error: string }
export interface AuraToolsRecord extends Base {
  kind: 'aura-tools';
  ok: true;
  aura: string;
  alias: string;
  credentials: Credentials;
  toolsByServer: Record<string, string[]>;
}

/** What AURA really sent a model: the tools in its first request, seen by a stand-in provider that calls none of them. */
export interface OfferedFailure extends Base { kind: 'offered'; ok: false; error: string }
export interface OfferedRecord extends Base {
  kind: 'offered';
  ok: true;
  aura: string;
  alias: string;
  credentials: Credentials;
  /** This server's tools that AURA offered. */
  toolNames: string[];
  /** Everything else in the same request. */
  otherTools: string[];
  /** The length of that request's whole tools array, as AURA sent it. */
  sentBytes: number;
  /** Null when this run has no listing of the server to measure. */
  sizes: DefinitionSizes | null;
}

export interface InvestigationFailure extends Base { kind: 'investigation'; ok: false; credentials?: Credentials; error: string; stream?: StreamSummary }
export interface InvestigationRecord extends Base {
  kind: 'investigation';
  ok: true;
  aura: string;
  alias: string;
  credentials: Credentials;
  prompt: string;
  provider: string;
  model: string;
  llmSwapped: boolean;
  toolsByServer: Record<string, string[]>;
  mcpServers: McpServerStatus[];
  toolCalls: ToolCall[];
  timeToFirstTextMs: number | null;
  timeToAnswerMs: number;
  answer: string;
  usage: Usage | null;
}

export type RawRecord = ToolsRecord | ToolsFailure | AuraToolsRecord | AuraToolsFailure | OfferedRecord | OfferedFailure | InvestigationRecord | InvestigationFailure;

const FILE_PREFIX: Record<RawRecord['kind'], string> = { tools: 'tools', 'aura-tools': 'aura-tools', offered: 'offered', investigation: 'investigation' };

export function recordFile(kind: RawRecord['kind'], server: ServerId, ok = true): string {
  return `${FILE_PREFIX[kind]}-${server}${ok ? '' : '.failed'}.json`;
}
