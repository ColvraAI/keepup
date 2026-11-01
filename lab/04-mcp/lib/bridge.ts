// The sandbox has no Docker and must never get the Docker socket, so an example whose
// server runs through `docker run -i` reaches real Docker through this: the docker
// command in the sandbox (harness/docker-shim.cjs) connects here over TCP and this runs
// the same command on the host, piping stdin and stdout. Only commands the examples
// contain are allowed, so the sandbox can't ask the host to run anything else.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type AddressInfo, type Socket } from 'node:net';

const GRACE_MS = 5000;
const HOST_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'];

export interface BridgeOptions {
  allowed: readonly (readonly string[])[];
  token: string;
  /** The docker CLI. A test passes a stand-in. */
  command?: readonly string[];
  onSpawn?: (argv: readonly string[]) => void;
  /** How long a server gets to stop by itself after its client leaves. */
  graceMs?: number;
}

export interface Bridge { port: number; close: () => Promise<void> }

interface Hello { token?: unknown; argv?: unknown; env?: unknown }

function readHello(line: string): Hello | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Hello) : null;
  } catch {
    return null;
  }
}

function refusal(hello: Hello | null, options: BridgeOptions): string | null {
  if (!hello) return 'refused: not a bridge request';
  if (hello.token !== options.token) return 'refused: wrong token';
  const asked = JSON.stringify(hello.argv);
  if (!options.allowed.some((argv) => JSON.stringify(argv) === asked)) return `refused: this is not the command the example runs: ${asked}`;
  return null;
}

function childEnv(values: unknown): NodeJS.ProcessEnv {
  const fromHost = Object.fromEntries(HOST_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return { ...fromHost, ...(values as Record<string, string>) };
}

function connectStreams(socket: Socket, child: ChildProcessWithoutNullStreams, graceMs: number): void {
  // Only once the client has left. A server stays up for as long as its client wants it.
  let stopLater: NodeJS.Timeout | undefined;
  const giveUp = () => {
    child.stdin.end();
    stopLater ??= setTimeout(() => child.kill('SIGTERM'), graceMs);
    stopLater.unref();
  };
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stdin.on('error', () => undefined);
  socket.on('error', giveUp);
  // The server's end of this socket stays half open, so 'close' waits for the child, and only 'end' says the client left.
  socket.on('end', giveUp);
  socket.on('close', giveUp);
  child.on('close', () => {
    clearTimeout(stopLater);
    socket.end();
  });
}

function start(socket: Socket, hello: Hello, options: BridgeOptions, children: Set<ChildProcessWithoutNullStreams>): void {
  const [program, ...prefix] = options.command ?? ['docker'];
  const argv = hello.argv as string[];
  options.onSpawn?.(argv);
  const child = spawn(program, [...prefix, ...argv], { env: childEnv(hello.env), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.on('close', () => children.delete(child));
  child.on('error', (error) => socket.destroy(error));
  child.stderr.resume();
  socket.write('ok\n');
  connectStreams(socket, child, options.graceMs ?? GRACE_MS);
}

function handle(socket: Socket, options: BridgeOptions, children: Set<ChildProcessWithoutNullStreams>): void {
  let buffered = Buffer.alloc(0);
  socket.on('error', () => undefined);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(10);
    if (end < 0) return;
    socket.off('data', onData);
    const hello = readHello(buffered.subarray(0, end).toString());
    const refused = refusal(hello, options);
    if (refused) {
      socket.end(`${refused}\n`);
      return;
    }
    socket.pause();
    start(socket, hello as Hello, options, children);
    socket.unshift(buffered.subarray(end + 1));
    socket.resume();
  };
  socket.on('data', onData);
}

export function startDockerBridge(options: BridgeOptions): Promise<Bridge> {
  const children = new Set<ChildProcessWithoutNullStreams>();
  const server = createServer({ allowHalfOpen: true }, (socket) => handle(socket, options, children));
  const close = () => new Promise<void>((resolve) => {
    for (const child of children) child.kill('SIGTERM');
    server.close(() => resolve());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close }));
  });
}
