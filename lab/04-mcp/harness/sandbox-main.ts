// Runs one lab plan, step by step, writing a raw record per step. Inside the sandbox it
// uses the official SDK and the real AURA; a host dry run points the same code at fakes.
// A step that fails leaves a failure record and the rest still run.
//   node sandbox-main.ts <plan.json>
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, type ScriptedCall } from '../fake/fake-provider.ts';
import { agentAlias, withLlm, type LlmChoice } from '../lib/example.ts';
import { recordFile, type AuraToolsFailure, type AuraToolsRecord, type Credentials, type InvestigationFailure, type InvestigationRecord, type OfferedFailure, type OfferedRecord, type RawRecord, type ToolsRecord } from '../lib/records.ts';
import { definitionSizes } from '../lib/sizes.ts';
import { parseFrames, summarize } from '../lib/sse.ts';
import type { ServerId } from '../servers.ts';
import { ask, discover, withAura, type Answer } from './aura-run.ts';
import { listTools, specFor, type Connector } from './list-tools.ts';
import { connectMini } from './mini-client.ts';
import { probeTools } from './no-credentials.ts';
import { sdkConnector } from './sdk-client.ts';

/** The stand-in provider ignores this; a real key has no reason to go near it. */
const STAND_IN_KEY = 'not-a-key-the-stand-in-provider-ignores-it';

export interface PlanServer {
  id: ServerId;
  example: string;
  credentials: Credentials;
  placeholders: Record<string, string>;
  override?: { cmd: string[] };
  listTools: boolean;
  discover: boolean;
  investigate: boolean;
  /** Dry run only: call every tool the server lists, with no good credentials behind it. */
  probeCalls?: boolean;
}

export interface Plan {
  repo: string;
  rawDir: string;
  cwd: string;
  client: 'sdk' | 'mini';
  sdkDir?: string;
  sdkVersion?: string;
  auraCommand: string[];
  auraTag: string;
  prompt: string;
  llm: LlmChoice;
  provider: string;
  model: string;
  /** Only so AURA can load the example when no LLM is going to be called. */
  loadOnlyEnv: Record<string, string>;
  fakeProvider?: { preferredTools: string[]; calls?: ScriptedCall[] };
  servers: PlanServer[];
}

function saveRecord(plan: Plan, record: RawRecord): void {
  writeFileSync(join(plan.rawDir, recordFile(record.kind, record.server, record.ok)), `${JSON.stringify(record, null, 2)}\n`);
}

/** Real values win; a placeholder only fills what isn't set. */
export function serverEnv(server: Pick<PlanServer, 'placeholders'>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...server.placeholders, ...base };
}

function configFor(plan: Plan, server: PlanServer, llm: LlmChoice): string {
  const example = join(plan.repo, server.example);
  if (llm.kind === 'as-is') return example;
  const copy = join(plan.cwd, `config-${server.id}.toml`);
  writeFileSync(copy, withLlm(readFileSync(example, 'utf8'), llm));
  return copy;
}

function auraToolsRecord(plan: Plan, server: PlanServer, alias: string, toolsByServer: Record<string, string[]>): AuraToolsRecord {
  return { kind: 'aura-tools', ok: true, server: server.id, example: server.example, measuredAt: new Date().toISOString(), aura: plan.auraTag, alias, credentials: server.credentials, toolsByServer };
}

function investigationRecord(plan: Plan, server: PlanServer, alias: string, toolsByServer: Record<string, string[]>, answer: Answer): InvestigationRecord | InvestigationFailure {
  const stream = summarize(parseFrames(answer.raw));
  const base = { kind: 'investigation' as const, server: server.id, example: server.example, measuredAt: new Date().toISOString(), credentials: server.credentials };
  if (answer.status !== 200 || !stream.done || !stream.answer.trim()) {
    return { ...base, ok: false, error: `HTTP ${answer.status}; ${stream.errors.join('; ') || 'no answer in the stream'}`, stream };
  }
  return {
    ...base, ok: true, aura: plan.auraTag, alias, prompt: plan.prompt, provider: plan.provider, model: stream.model ?? plan.model, llmSwapped: plan.llm.kind === 'anthropic',
    toolsByServer, mcpServers: stream.mcpServers, toolCalls: stream.toolCalls, timeToFirstTextMs: answer.firstTextMs, timeToAnswerMs: answer.totalMs, answer: stream.answer, usage: stream.usage,
  };
}

async function auraSteps(plan: Plan, server: PlanServer, llm: LlmChoice, env: NodeJS.ProcessEnv): Promise<RawRecord[]> {
  const config = configFor(plan, server, llm);
  const alias = agentAlias(readFileSync(config, 'utf8'));
  const options = { command: plan.auraCommand, configPath: config, env, cwd: plan.cwd, logFile: join(plan.rawDir, `aura-${server.id}.log`) };
  return withAura(options, async (baseUrl) => {
    const toolsByServer = await discover(baseUrl, alias);
    const found = auraToolsRecord(plan, server, alias, toolsByServer);
    if (!server.investigate) return [found];
    const answer = await ask(baseUrl, alias, plan.prompt);
    writeFileSync(join(plan.rawDir, `transcript-${server.id}.sse`), answer.raw);
    return [found, investigationRecord(plan, server, alias, toolsByServer, answer)];
  });
}

function auraFailures(server: PlanServer, error: Error): (AuraToolsFailure | InvestigationFailure)[] {
  const base = { server: server.id, example: server.example, measuredAt: new Date().toISOString(), ok: false as const, error: error.message };
  const discovery: AuraToolsFailure = { ...base, kind: 'aura-tools' };
  const investigation: InvestigationFailure = { ...base, kind: 'investigation', credentials: server.credentials };
  return server.investigate ? [discovery, investigation] : [discovery];
}

function listedTools(plan: Plan, server: PlanServer): { name: string }[] | null {
  const file = join(plan.rawDir, recordFile('tools', server.id));
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ToolsRecord).tools as { name: string }[] : null;
}

function offeredRecord(plan: Plan, server: PlanServer, alias: string, discovered: Record<string, string[]>, request: Record<string, unknown>): OfferedRecord {
  const tools = (request.tools ?? []) as { function?: { name?: string } }[];
  const names = tools.map((tool) => tool.function?.name).filter((name): name is string => typeof name === 'string');
  const own = discovered[server.id] ?? [];
  const toolNames = names.filter((name) => own.includes(name)).sort();
  const listing = listedTools(plan, server);
  return {
    kind: 'offered', ok: true, server: server.id, example: server.example, measuredAt: new Date().toISOString(), aura: plan.auraTag, alias, credentials: server.credentials,
    toolNames, otherTools: names.filter((name) => !own.includes(name)).sort(), sentBytes: Buffer.byteLength(JSON.stringify(tools)), sizes: listing ? definitionSizes(listing, toolNames) : null,
  };
}

/** Runs the example as written against a stand-in provider, so no key and no model is involved and no tool gets called. */
async function offeredStep(plan: Plan, server: PlanServer, env: NodeJS.ProcessEnv): Promise<OfferedRecord | OfferedFailure> {
  const provider = await startFakeProvider([], { answerOnly: true });
  const dir = mkdtempSync(join(tmpdir(), 'lab04-offered-'));
  try {
    const example = readFileSync(join(plan.repo, server.example), 'utf8');
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, withLlm(example, { kind: 'openai-base-url', baseUrl: `http://127.0.0.1:${provider.port}/v1` }));
    const alias = agentAlias(example);
    const options = { command: plan.auraCommand, configPath, env: { ...env, OPENAI_API_KEY: STAND_IN_KEY }, cwd: plan.cwd, logFile: join(plan.rawDir, `aura-${server.id}.log`) };
    const discovered = await withAura(options, async (baseUrl) => {
      await ask(baseUrl, alias, plan.prompt);
      return discover(baseUrl, alias);
    });
    const [request] = provider.requests();
    if (!request) throw new Error('AURA sent the stand-in provider no request');
    return offeredRecord(plan, server, alias, discovered, request);
  } catch (error) {
    return { kind: 'offered', ok: false, server: server.id, example: server.example, measuredAt: new Date().toISOString(), error: (error as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await provider.close();
  }
}

async function probeCalls(plan: Plan, server: PlanServer, connect: Connector, env: NodeJS.ProcessEnv): Promise<object> {
  const spec = specFor({ repo: plan.repo, server: server.id, example: server.example, env, override: server.override });
  const connection = await connect(spec, env);
  try {
    if (!connection.callTool) throw new Error('this client cannot call a tool');
    const calls = await probeTools(await connection.listAllTools(), connection.callTool);
    return { startedAs: spec.transport === 'stdio' ? spec.cmd[0] : spec.url, serverInfo: connection.serverInfo, calls };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Like every step, one that fails leaves a record and the rest of the plan still runs. */
async function probeStep(plan: Plan, server: PlanServer, connect: Connector, env: NodeJS.ProcessEnv): Promise<void> {
  const found = await probeCalls(plan, server, connect, env).catch((error: Error) => ({ error: error.message }));
  writeFileSync(join(plan.rawDir, `no-credentials-calls-${server.id}.json`), `${JSON.stringify({ server: server.id, measuredAt: new Date().toISOString(), ...found }, null, 2)}\n`);
}

async function runServer(plan: Plan, server: PlanServer, connect: Connector, llm: LlmChoice): Promise<void> {
  const env = serverEnv(server, process.env);
  if (server.listTools) saveRecord(plan, await listTools({ repo: plan.repo, server: server.id, example: server.example, credentials: server.credentials, env, override: server.override }, connect));
  if (server.probeCalls) await probeStep(plan, server, connect, env);
  if (!server.discover && !server.investigate) return;
  const auraEnv = { ...plan.loadOnlyEnv, ...env };
  const records = await auraSteps(plan, server, llm, auraEnv).catch((error: Error) => auraFailures(server, error));
  records.forEach((record) => saveRecord(plan, record));
  if (server.discover) saveRecord(plan, await offeredStep(plan, server, auraEnv));
}

function connectorFor(plan: Plan): Connector {
  if (plan.client === 'mini') return connectMini;
  return sdkConnector(plan.sdkDir as string, plan.sdkVersion as string, plan.cwd);
}

export async function runPlan(plan: Plan): Promise<void> {
  mkdirSync(plan.rawDir, { recursive: true });
  mkdirSync(plan.cwd, { recursive: true });
  const provider = plan.fakeProvider ? await startFakeProvider(plan.fakeProvider.preferredTools, { calls: plan.fakeProvider.calls }) : null;
  const llm: LlmChoice = provider ? { kind: 'openai-base-url', baseUrl: `http://127.0.0.1:${provider.port}/v1` } : plan.llm;
  const connect = connectorFor(plan);
  for (const server of plan.servers) await runServer(plan, server, connect, llm);
  if (provider) {
    const offered = provider.requests().map((body) => (body.tools as { function: { name: string } }[] | undefined ?? []).map((t) => t.function.name));
    writeFileSync(join(plan.rawDir, 'fake-provider-saw.json'), `${JSON.stringify(offered, null, 2)}\n`);
    await provider.close();
  }
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: sandbox-main.ts <plan.json>');
  await runPlan(JSON.parse(readFileSync(file, 'utf8')) as Plan);
}
