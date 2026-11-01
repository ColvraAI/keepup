// Part two's moving parts: start AURA with a config, ask it what tools it discovered,
// send one prompt, and read the stream as it arrives so the timings are real.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { parseFrames, summarize, toolNamesByServer } from '../lib/sse.ts';

const HEALTH_TIMEOUT_MS = 60_000;
const ASK_TIMEOUT_MS = 600_000;
const STOP_GRACE_MS = 5000;

export interface AuraOptions {
  command: readonly string[];
  configPath: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  cwd: string;
}

export interface Answer { status: number; raw: string; firstTextMs: number | null; totalMs: number }

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`AURA exited with code ${child.exitCode} before it was healthy`);
    const healthy = await fetch(`${baseUrl}/health`).then((r) => r.ok, () => false);
    if (healthy) return;
    await sleep(250);
  }
  throw new Error('AURA did not become healthy in time');
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function auraEnv(options: AuraOptions, port: number): NodeJS.ProcessEnv {
  return {
    ...options.env,
    CONFIG_PATH: options.configPath,
    HOST: '127.0.0.1',
    PORT: String(port),
    AURA_CUSTOM_EVENTS: 'true',
    TOOL_RESULT_MODE: 'aura',
    TOOL_RESULT_MAX_LENGTH: '4000',
    AURA_DEBUG_PROVIDER_ERRORS: 'true',
    FIRST_CHUNK_TIMEOUT_SECS: '240',
    SHUTDOWN_TIMEOUT_SECS: '2',
    NO_COLOR: '1',
    DO_NOT_TRACK: '1',
    AURA_TELEMETRY_DISABLED: '1',
    // Info level names servers and counts. Debug would print each child's env, so it stays off.
    RUST_LOG: 'info',
  };
}

/** Runs `fn` against a healthy AURA and always stops it. */
export async function withAura<T>(options: AuraOptions, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const port = await freePort();
  const log = openSync(options.logFile, 'a');
  const [program, ...prefix] = options.command;
  const child = spawn(program, [...prefix, 'webserver'], { env: auraEnv(options, port), cwd: options.cwd, stdio: ['ignore', log, log] });
  const failed = new Promise<never>((_, reject) => child.once('error', reject));
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await Promise.race([waitForHealth(baseUrl, child), failed]);
    return await fn(baseUrl);
  } finally {
    await stop(child);
    closeSync(log);
  }
}

export async function discover(baseUrl: string, alias: string): Promise<Record<string, string[]>> {
  const res = await fetch(`${baseUrl}/aura/info?detail=tools:summary`);
  if (!res.ok) throw new Error(`/aura/info answered ${res.status}`);
  return toolNamesByServer(await res.json(), alias);
}

export async function ask(baseUrl: string, alias: string, prompt: string): Promise<Answer> {
  const began = Date.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: alias, stream: true, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  });
  const decoder = new TextDecoder();
  let raw = '';
  let firstTextMs: number | null = null;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    raw += decoder.decode(part, { stream: true });
    if (firstTextMs === null && summarize(parseFrames(raw)).answer.length > 0) firstTextMs = Date.now() - began;
  }
  return { status: res.status, raw, firstTextMs, totalMs: Date.now() - began };
}
