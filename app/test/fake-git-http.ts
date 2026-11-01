// Serves real bare repos over smart HTTP through git's own http-backend, so the
// clone, lazy blob fetch and push in app/src/git.ts run the same protocol as GitHub.
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface GitHttpOptions {
  projectRoot: string;
  /** path after the mount, e.g. /keepup-demo/aura.git/info/refs */
  pathInfo: string;
  query: string;
}

// Read once: a test may put a spy first on PATH to watch the App's git, and the server isn't what it's watching.
const SERVER_PATH = process.env.PATH;

function cgiEnv(req: IncomingMessage, opts: GitHttpOptions): NodeJS.ProcessEnv {
  return {
    PATH: SERVER_PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_PROJECT_ROOT: opts.projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: opts.pathInfo,
    QUERY_STRING: opts.query,
    REQUEST_METHOD: req.method,
    REMOTE_USER: 'x-access-token',
    REMOTE_ADDR: '127.0.0.1',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
    GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
  };
}

function splitCgi(buffer: Buffer): { headers: Record<string, string>; status: number; body: Buffer } {
  const marker = buffer.indexOf('\r\n\r\n');
  const head = buffer.subarray(0, marker).toString('utf8');
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of head.split('\r\n')) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
    else headers[name] = value;
  }
  return { headers, status, body: buffer.subarray(marker + 4) };
}

export function serveGit(req: IncomingMessage, res: ServerResponse, opts: GitHttpOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['http-backend'], { env: cgiEnv(req, opts), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', () => {
      const { headers, status, body } = splitCgi(Buffer.concat(chunks));
      res.writeHead(status, headers);
      res.end(body);
      resolve();
    });
    req.pipe(child.stdin);
  });
}
