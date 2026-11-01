// A local stand-in for api.github.com and github.com. It implements exactly the
// endpoints the App uses, with the status codes and shapes in GitHub's docs, and
// backs refs, commits and contents with real bare repos. Every request is recorded.
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serveGit } from './fake-git-http.ts';
import { cloneBare, shareObjects } from './fake-repos.ts';
import { afterPush } from './fake-actions.ts';
import { appRoutes } from './fake-app-routes.ts';
import { repoRoutes } from './fake-repo-routes.ts';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  auth: 'jwt' | 'installation' | 'person' | 'none' | 'bad';
}

export interface FakeWorkflow { id: number; name: string; path: string; state: string }
/** head_sha unset means the check answers for any commit, for tests that only care about the state. */
export interface FakeCheckRun { name: string; status: string; conclusion: string | null; html_url: string; details_url: string; head_sha?: string; check_suite?: { id: number } }
export interface FakeRun { id: number; name: string; path: string; event: string; status: string; conclusion: string | null; head_sha?: string; html_url: string; run_number: number; created_at: string; check_suite_id?: number }
export interface FakeThread { number: number; title: string; body: string; state: string; user: string; created_at: string; comments: { id: number; body: string; user: string }[] }
export interface FakePull extends FakeThread { head: string; headSha: string; base: string; merged_at: string | null; openedSha?: string; updated_at?: string }

export interface FakeRepo {
  owner: string;
  name: string;
  bare: string;
  fork: boolean;
  parent: string | null;
  hasIssues: boolean;
  actionsEnabled: boolean;
  /** The Actions tab button on a fork. Closed, no event produces a run. See fake-actions.ts. */
  gateOpen: boolean;
  /** True on a fork made through the API: events make real runs from the workflow files on its branches. */
  workflowRuntime: boolean;
  /** Whether PUT /actions/permissions opens the gate. One person reports it does; unconfirmed, so it defaults to false. */
  permissionsPutOpensGate: boolean;
  /** The pull request object keeps its first head sha, as if GitHub hadn't caught up with a push. */
  lagPullHead: boolean;
  workflowConclusion?: (file: string) => string;
  workflows: FakeWorkflow[];
  runs: FakeRun[];
  threads: FakeThread[];
  pulls: FakePull[];
  checks: FakeCheckRun[];
  statuses: { state: string; target_url: string; context: string }[];
  /** Still copying: the repo answers, and its commits are a 409 for this many more reads. */
  notReadyPolls: number;
  /** GET /commits answers, and GET /commits/{ref} is still a 409. */
  singleCommitReadsAsCopying?: boolean;
  /** Not there yet at all: a 404 on the repo for this many more reads. */
  notFoundPolls: number;
}

export interface FakeRoute {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext, match: RegExpMatchArray) => Promise<Reply> | Reply;
}

export interface RouteContext {
  fake: FakeGitHub;
  request: RecordedRequest;
  actor: string;
  /** Null when the caller has no access to this repo: GitHub answers 404, not 403. */
  repo: (owner: string, name: string) => FakeRepo | null;
}

export interface Reply { status: number; body?: unknown }

export interface FakeOptions {
  dir: string;
  org?: string;
  appId?: number;
  slug?: string;
  botId?: number;
  installationId?: number;
  personLogin?: string;
  personRole?: string;
  personToken?: string;
  orgExists?: boolean;
  orgRepos?: string[];
  installed?: boolean;
}

const TEST_KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

export function verifyAppJwt(jwt: string, publicKeyPem: string, appId: number): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg: string };
  if (header.alg !== 'RS256') return false;
  if (!verify('RSA-SHA256', signed, createPublicKey(publicKeyPem), Buffer.from(parts[2], 'base64url'))) return false;
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { iss: string | number; exp: number; iat: number };
  const now = Math.floor(Date.now() / 1000);
  return String(claims.iss) === String(appId) && claims.exp > now && claims.iat <= now;
}

export class FakeGitHub {
  readonly options: Required<Omit<FakeOptions, 'orgRepos'>> & { orgRepos: string[] };
  readonly privateKey = TEST_KEYS.privateKey;
  readonly publicKey = TEST_KEYS.publicKey;
  readonly clientSecret = `canary-client-secret-${randomBytes(4).toString('hex')}`;
  readonly webhookSecret = `canary-webhook-secret-${randomBytes(4).toString('hex')}`;
  readonly requests: RecordedRequest[] = [];
  readonly gitRequests: { method: string; path: string; authorized: boolean }[] = [];
  readonly unhandled: string[] = [];
  readonly repos = new Map<string, FakeRepo>();
  readonly installationTokens = new Set<string>();
  readonly manifestCodes = new Map<string, { name: string; manifest: Record<string, unknown> }>();
  registeredApps = 0;
  installedOnOrg: boolean;
  appSlug: string;
  /** Fail the next POST /pulls with this message, as if a race had happened. */
  failNextPullCreate: string | null = null;
  /** The last manifest a person submitted on the fake github.com. */
  lastManifest: Record<string, unknown> | null = null;
  /** A fork the installation doesn't reach, as when someone picks "only select repositories". */
  hideFromInstallation: string | null = null;
  /** An installation of this App on someone else's account: it exists, and it isn't ours. */
  foreignInstallationId: number | null = null;
  /** An installation that belongs to a different App. */
  otherAppInstallationId: number | null = null;
  /** The App was deleted: its JWT no longer gets anywhere. */
  appDeleted = false;
  /** Who owns the App, when that isn't the org in the options. */
  appOwner: string | null = null;
  /** Values no local code could derive, so a test can tell an API response from a hand-built record. */
  apiMarker: string | null = null;
  /** Bot login as GitHub spells it, when that differs from <slug>[bot]. */
  botLoginOverride: string | null = null;
  /** Answer matching requests with this message, as a server error that repeats what it shouldn't. */
  poison: { method: string; path: RegExp; message: () => string } | null = null;
  /** Every installation token is this one, so a test can plant it in a server's stderr. */
  fixedToken: string | null = null;
  /** The refs each push really asked for, read from the wire. */
  readonly pushedRefs: { ref: string; old: string; new: string }[] = [];
  /** The next PATCH of a pull request to open answers 422, as when its branch has gone. */
  failNextReopen = false;
  /** PUT .../workflows/{id}/disable answers 403. */
  denyWorkflowSwitch = false;
  /** PUT .../actions/permissions answers 409, as under an org policy. */
  denyActionsPermissions = false;
  runCounter = 0;
  url = '';
  webUrl = '';
  gitUrl = '';
  private server: Server | null = null;

  constructor(options: FakeOptions) {
    this.options = {
      org: 'keepup-demo', appId: 4242, slug: 'keepup', botId: 987654, installationId: 777,
      personLogin: 'a-founder', personRole: 'admin', personToken: 'gho_canary_person_token',
      orgExists: true, orgRepos: [], installed: true, ...options,
    };
    this.installedOnOrg = this.options.installed;
    this.appSlug = this.options.slug;
  }

  botLogin(): string { return this.botLoginOverride ?? `${this.appSlug}[bot]`; }
  marked(url: string): string { return this.apiMarker ? `${url}#${this.apiMarker}` : url; }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        this.unhandled.push(`crash: ${String(e)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end(JSON.stringify({ message: 'fake crashed' }));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    this.webUrl = `${this.url}/web`;
    this.gitUrl = `${this.url}/git/`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }

  barePath(owner: string, name: string): string {
    return join(this.options.dir, 'github', owner, `${name}.git`);
  }

  /** Adds a repo from a bare source, as an upstream or as a fork that already exists. */
  addRepo(owner: string, name: string, source: string, extra: Partial<FakeRepo> = {}): FakeRepo {
    const bare = cloneBare(source, this.barePath(owner, name));
    const repo: FakeRepo = {
      owner, name, bare, fork: false, parent: null, hasIssues: true, actionsEnabled: true,
      gateOpen: true, workflowRuntime: false, permissionsPutOpensGate: false, lagPullHead: false, workflows: [], runs: [], threads: [], pulls: [], checks: [], statuses: [],
      notReadyPolls: 0, notFoundPolls: 0, ...extra,
    };
    const parent = extra.parent ? this.repo(...(extra.parent.split('/') as [string, string])) : undefined;
    if (parent) shareObjects(bare, parent.bare);
    this.repos.set(`${owner}/${name}`.toLowerCase(), repo);
    return repo;
  }

  repo(owner: string, name: string): FakeRepo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  /** What github.com does when a person presses "Create GitHub App" on a manifest. */
  acceptManifest(manifestJson: string): string {
    const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
    const code = `code-${randomBytes(6).toString('hex')}`;
    this.manifestCodes.set(code, { name: String(manifest.name), manifest });
    this.lastManifest = manifest;
    return code;
  }

  writeRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  pushes(): { method: string; path: string; authorized: boolean }[] {
    return this.gitRequests.filter((r) => r.method === 'POST' && r.path.endsWith('/git-receive-pack'));
  }

  private classify(header: string | undefined): RecordedRequest['auth'] {
    if (!header) return 'none';
    const [scheme, value] = header.split(' ');
    if (scheme.toLowerCase() === 'bearer' && value.split('.').length === 3) {
      return verifyAppJwt(value, this.publicKey, this.options.appId) ? 'jwt' : 'bad';
    }
    if (this.installationTokens.has(value)) return 'installation';
    if (value === this.options.personToken) return 'person';
    return 'bad';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    if (url.pathname.startsWith('/git/')) return this.handleGit(req, res, url);
    const raw = await readBody(req);
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: decodeURI(url.pathname),
      query: Object.fromEntries(url.searchParams),
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
      auth: this.classify(req.headers.authorization),
    };
    this.requests.push(request);
    const reply = await this.route(request, url.pathname);
    res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  }

  private async route(request: RecordedRequest, rawPath: string): Promise<Reply> {
    if (request.auth === 'bad') return { status: 401, body: { message: 'Bad credentials' } };
    if (this.poison && this.poison.method === request.method && this.poison.path.test(request.path)) return { status: 500, body: { message: this.poison.message() } };
    const ctx: RouteContext = {
      fake: this,
      request,
      actor: request.auth === 'person' ? this.options.personLogin : this.botLogin(),
      repo: (owner, name) => {
        const found = this.repo(owner, name);
        if (!found) return null;
        const scoped = request.auth === 'installation' && !(this.installedOnOrg && owner.toLowerCase() === this.options.org.toLowerCase());
        return scoped ? null : found;
      },
    };
    for (const route of [...appRoutes, ...repoRoutes]) {
      if (route.method !== request.method) continue;
      const match = rawPath.match(route.pattern);
      if (match) return route.handler(ctx, match);
    }
    this.unhandled.push(`${request.method} ${request.path}`);
    return { status: 404, body: { message: 'Not Found' } };
  }

  private async handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const header = req.headers.authorization ?? '';
    const decoded = Buffer.from(header.replace(/^basic /i, ''), 'base64').toString();
    const token = decoded.startsWith('x-access-token:') ? decoded.slice('x-access-token:'.length) : '';
    const authorized = this.installationTokens.has(token);
    const pathInfo = decodeURI(url.pathname.slice('/git'.length));
    this.gitRequests.push({ method: req.method ?? 'GET', path: pathInfo, authorized });
    if (authorized && this.hideFromInstallation && url.searchParams.get('service') === 'git-receive-pack' && pathInfo.includes(`/${this.hideFromInstallation}.git/`)) {
      res.writeHead(403);
      res.end(`Permission to ${pathInfo.split('/').slice(1, 3).join('/')} denied to ${this.botLogin()}.`);
      return;
    }
    if (!authorized) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="fake github"' });
      res.end('auth required');
      return;
    }
    const isPush = req.method === 'POST' && pathInfo.endsWith('/git-receive-pack');
    const chunks: Buffer[] = [];
    if (isPush) req.on('data', (c: Buffer) => chunks.push(c));
    await serveGit(req, res, { projectRoot: join(this.options.dir, 'github'), pathInfo, query: url.search.slice(1) });
    if (!isPush) return;
    const commands = readPushCommands(Buffer.concat(chunks));
    this.pushedRefs.push(...commands);
    const [, owner, name] = pathInfo.match(/^\/([^/]+)\/([^/]+)\.git\//) ?? [];
    const repo = this.repo(owner ?? '', name ?? '');
    if (repo) await afterPush(this, repo, commands.map((c) => c.ref));
  }
}

export async function startFakeGitHub(options: FakeOptions): Promise<FakeGitHub> {
  return new FakeGitHub(options).start();
}

/** The pkt-lines that open a receive-pack request: "<old> <new> <ref>\\0<capabilities>", then a flush. */
function readPushCommands(body: Buffer): { ref: string; old: string; new: string }[] {
  const commands: { ref: string; old: string; new: string }[] = [];
  for (let at = 0; at + 4 <= body.length;) {
    const length = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (!length) break;
    const [old, next, ref] = body.subarray(at + 4, at + length).toString('utf8').split('\0')[0].trim().split(' ');
    commands.push({ old, new: next, ref });
    at += length;
  }
  return commands;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
