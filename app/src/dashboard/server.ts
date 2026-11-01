// The local dashboard: site/out on 127.0.0.1, plus the small API only this server has.
// Node built-ins only. A static deploy has the same pages and none of this.
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkRequest, parseSlug } from './guard.ts';
import { contentType, resolveStatic } from './static.ts';

export type ScanEvent =
  | { type: 'step'; name: string; detail: string; ms?: number }
  | { type: 'hit'; pattern: string; file: string; line: number; text: string }
  | { type: 'finding'; rank: number; title: string; effect: string[]; proof: string; effort: string; where: { file: string; line: number }[]; why: string }
  | { type: 'summary'; [key: string]: unknown }
  | { type: 'change'; change: unknown }
  | { type: 'measure'; measure: unknown }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type Emit = (event: ScanEvent) => void;
export type Job = (slug: string, emit: Emit, signal: AbortSignal) => Promise<void>;

export type DashboardOptions = {
  root: string;
  port: number;
  scan: Job;
  judge: Job;
  /** How long a clone waits for "Have Claude check them". The page says it, and shouldn't have to guess. */
  keepMinutes?: number;
  judgeAvailable: () => boolean;
  /** The product's API. All optional, so a server with none of it answers 404. */
  change?: (repo: string, rank: number, emit: Emit, signal: AbortSignal) => Promise<void>;
  measure?: (repo: string, rank: number, emit: Emit, signal: AbortSignal) => Promise<void>;
  openPr?: (changeId: string) => Promise<unknown>;
  repos?: () => unknown[];
  readRun?: (repo: string) => unknown;
  savedChanges?: (repo: string) => unknown[];
  appConfigured?: () => boolean;
};

export type DashboardServer = { server: Server; port: number; close: () => Promise<void> };

const MAX_BODY_BYTES = 4096;
const MAX_RANK = 999;
const CHANGE_ID = /^change-[0-9a-f]{7}-\d{1,3}-[0-9a-f]{6}$/;
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'That request is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/.test(type)) throw new HttpError(415, 'Send application/json.');
  const text = await readBody(req);
  try {
    return JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    throw new HttpError(400, 'That is not JSON.');
  }
}

async function readSlug(req: IncomingMessage): Promise<string> {
  const slug = parseSlug((await readJson(req))?.repo);
  if (!slug) throw new HttpError(400, 'Give a public repo as owner/name, such as mezmo/aura.');
  return slug;
}

function stream(req: IncomingMessage, res: ServerResponse, slug: string, job: Job): Promise<void> {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const emit: Emit = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  return job(slug, emit, abort.signal)
    .catch((error: unknown) => emit({ type: 'error', message: error instanceof Error ? error.message : 'The scan failed.' }))
    .finally(() => res.end());
}

function serveFile(res: ServerResponse, root: string, urlPath: string): void {
  const file = resolveStatic(root, urlPath);
  const target = file ?? resolveStatic(root, '/404.html');
  if (!target) {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const immutable = urlPath.startsWith('/_next/static/');
  res.writeHead(file ? 200 : 404, {
    ...HEADERS,
    'Content-Type': contentType(target),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res);
}

async function exclusive(state: { busy: boolean }, res: ServerResponse, work: () => Promise<void>): Promise<void> {
  if (state.busy) return json(res, 429, { ok: false, error: 'One at a time. The first is still running.' });
  state.busy = true;
  try {
    await work();
  } finally {
    state.busy = false;
  }
  return undefined;
}

async function routeChange(req: IncomingMessage, res: ServerResponse, options: DashboardOptions, state: { busy: boolean }): Promise<void> {
  const change = options.change;
  if (!change) return json(res, 404, { ok: false, error: 'No such route.' });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only.' });
  const body = await readJson(req);
  const repo = parseSlug(body?.repo);
  if (!repo) throw new HttpError(400, 'Give a repo as owner/name.');
  const rank = body?.finding;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > MAX_RANK) throw new HttpError(400, 'Give a finding by its rank.');
  if (!options.judgeAvailable()) return json(res, 409, { ok: false, error: 'No ANTHROPIC_API_KEY in .env, so keepup can’t write a change here.' });
  return exclusive(state, res, () => stream(req, res, repo, (slug, emit, signal) => change(slug, rank, emit, signal)));
}

/** The same doors as a change. A missing key isn't refused here: the measure itself says "not measured · needs X". */
async function routeMeasure(req: IncomingMessage, res: ServerResponse, options: DashboardOptions, state: { busy: boolean }): Promise<void> {
  const measure = options.measure;
  if (!measure) return json(res, 404, { ok: false, error: 'No such route.' });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only.' });
  const body = await readJson(req);
  const repo = parseSlug(body?.repo);
  if (!repo) throw new HttpError(400, 'Give a repo as owner/name.');
  const rank = body?.finding;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > MAX_RANK) throw new HttpError(400, 'Give a finding by its rank.');
  return exclusive(state, res, () => stream(req, res, repo, (slug, emit, signal) => measure(slug, rank, emit, signal)));
}

async function routeOpenPr(req: IncomingMessage, res: ServerResponse, options: DashboardOptions, state: { busy: boolean }): Promise<void> {
  const openPr = options.openPr;
  if (!openPr) return json(res, 404, { ok: false, error: 'No such route.' });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only.' });
  const id = (await readJson(req))?.changeId;
  if (typeof id !== 'string' || !CHANGE_ID.test(id)) throw new HttpError(400, 'That isn’t a change keepup made.');
  return exclusive(state, res, async () => json(res, 200, await openPr(id)));
}

function routeReads(req: IncomingMessage, res: ServerResponse, options: DashboardOptions, path: string): void {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only.' });
  if (path === '/api/repos') return json(res, 200, { ok: true, repos: options.repos?.() ?? [] });
  const repo = parseSlug(new URL(req.url ?? '/', 'http://local').searchParams.get('repo'));
  if (!repo) return json(res, 400, { ok: false, error: 'Give a repo as owner/name.' });
  if (path === '/api/changes') return json(res, 200, { ok: true, changes: options.savedChanges?.(repo) ?? [] });
  const run = options.readRun?.(repo) ?? null;
  return run ? json(res, 200, { ok: true, run }) : json(res, 404, { ok: false, error: 'This session has no run for that repo.' });
}

async function route(req: IncomingMessage, res: ServerResponse, options: DashboardOptions, port: number, state: { busy: boolean }): Promise<void> {
  const check = checkRequest({ host: req.headers.host, origin: req.headers.origin }, port);
  if (!check.ok) return json(res, 403, { ok: false, error: check.reason });
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  if (path === '/api/health') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only.' });
    return json(res, 200, { ok: true, service: 'keepup-dashboard', judge: options.judgeAvailable(), ...(options.appConfigured ? { app: options.appConfigured() } : {}), ...(options.keepMinutes ? { keep_minutes: options.keepMinutes } : {}) });
  }
  if (path === '/api/scan' || path === '/api/judge') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only.' });
    const slug = await readSlug(req);
    if (path === '/api/judge' && !options.judgeAvailable()) {
      return json(res, 409, { ok: false, error: 'No ANTHROPIC_API_KEY in .env, so Claude can’t check these here.' });
    }
    if (state.busy) return json(res, 429, { ok: false, error: 'One scan at a time. The first is still running.' });
    state.busy = true;
    try {
      await stream(req, res, slug, path === '/api/scan' ? options.scan : options.judge);
    } finally {
      state.busy = false;
    }
    return undefined;
  }
  if (path === '/api/change') return routeChange(req, res, options, state);
  if (path === '/api/measure') return routeMeasure(req, res, options, state);
  if (path === '/api/open-pr') return routeOpenPr(req, res, options, state);
  if (path === '/api/repos' || path === '/api/run' || path === '/api/changes') return routeReads(req, res, options, path);
  if (path.startsWith('/api/')) return json(res, 404, { ok: false, error: 'No such route.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'GET only.' });
  return serveFile(res, options.root, path);
}

export function startDashboard(options: DashboardOptions): Promise<DashboardServer> {
  const state = { busy: false };
  let port = options.port;
  const server = createServer((req, res) => {
    route(req, res, options, port, state).catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return json(res, error.status, { ok: false, error: error.message });
      process.stderr.write(`dashboard: ${error instanceof Error ? error.message : String(error)}\n`);
      return json(res, 500, { ok: false, error: 'Something failed on this server. The terminal has the detail.' });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        close: () =>
          new Promise((done, fail) => {
            server.closeAllConnections();
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
