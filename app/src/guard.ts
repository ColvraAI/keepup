// The one gate. Every write the App makes, through the API or through git, passes
// here. The demo lives on forks in DEMO_ORG; upstream maintainers didn't ask for it.
import { assertPublicSafe } from './secrets.ts';
import { foreignReferences } from './spec-text.ts';

export const UPSTREAM_OWNERS = ['Mintplex-Labs', 'mezmo'] as const;
export const UPSTREAM_REPOS = ['Mintplex-Labs/anything-llm', 'mezmo/aura'] as const;

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
const lower = (s: string) => s.toLowerCase();

export function isUpstreamOwner(owner: string): boolean {
  return UPSTREAM_OWNERS.some((u) => lower(u) === lower(owner));
}

function demoOrg(env: Record<string, string | undefined>): string {
  const org = env.DEMO_ORG;
  if (!org) throw new GuardError('DEMO_ORG is not set, so nothing can be written. Run: npm run setup -- --org <name>');
  if (isUpstreamOwner(org)) throw new GuardError(`DEMO_ORG is ${org}, an upstream owner. The demo never writes upstream.`);
  return org;
}

/** Refuses unless owner is DEMO_ORG and not an upstream owner. */
export function assertDemoRepo(owner: string, repo: string, env: Record<string, string | undefined>): void {
  const org = demoOrg(env);
  if (!owner || isUpstreamOwner(owner)) throw new GuardError(`Refusing ${owner}/${repo}: the demo never writes to an upstream repo.`);
  if (lower(owner) !== lower(org)) throw new GuardError(`Refusing ${owner}/${repo}: keepup only writes to ${org}.`);
  if (!NAME.test(repo) || repo.includes('..')) throw new GuardError(`Refusing ${owner}/${repo}: that isn't a repository name.`);
}

/** The one call that names an upstream in its path: it creates the fork in DEMO_ORG. */
export function assertForkRequest(owner: string, repo: string, organization: unknown, env: Record<string, string | undefined>): void {
  const org = demoOrg(env);
  // KEEPUP_FORK_ONCE names the one repo a person just clicked "Open pull request" on. It only ever lands in DEMO_ORG, below.
  const allowed = [...UPSTREAM_REPOS, ...(env.KEEPUP_FORK_ONCE ? [env.KEEPUP_FORK_ONCE] : [])];
  if (!allowed.some((u) => lower(u) === lower(`${owner}/${repo}`))) {
    throw new GuardError(`Refusing to fork ${owner}/${repo}: it's not one of the demo's upstreams.`);
  }
  if (typeof organization !== 'string' || lower(organization) !== lower(org)) {
    throw new GuardError(`Refusing to fork ${owner}/${repo} anywhere but ${org}.`);
  }
}

/** The App pushes only the spec's branch and base branch, spelled exactly. */
export function assertPushRef(ref: string, allowed: readonly string[]): void {
  if (!allowed.includes(ref)) throw new GuardError(`Refusing to push ${ref}: this pull request only pushes ${allowed.join(' and ')}.`);
}

/** The last look at text on its way to a public repo: nothing secret, and nothing that lands on a timeline outside the demo org. */
export function assertPublicText(text: string, what: string, org: string): void {
  assertPublicSafe(text, what);
  const refs = foreignReferences(text, org);
  if (refs.length) throw new GuardError(`${what} references ${refs.join(', ')}, which would show on that repo's public timeline. It wasn't sent. Link through redirect.github.com, or drop it.`);
}

export type Identity = 'app' | 'person';
export interface OutgoingRequest { method: string; path: string; body: unknown }

const APP_WRITES = [/^\/app\/installations\/\d+\/access_tokens$/];
const PERSON_WRITES = [/^\/app-manifests\/[^/]+\/conversions$/];

function assertAppRequest(req: OutgoingRequest, env: Record<string, string | undefined>, parts: string[]): void {
  if (parts[0] === 'repos') {
    assertDemoRepo(parts[1] ?? '', parts[2] ?? '', env);
    return;
  }
  if (req.method !== 'GET' && !APP_WRITES.some((p) => p.test(req.path))) {
    throw new GuardError(`Refusing ${req.method} ${req.path}: the App only writes to repos in the demo org.`);
  }
}

function assertPersonRequest(req: OutgoingRequest, env: Record<string, string | undefined>, parts: string[]): void {
  if (req.method === 'GET' && parts[0] !== 'repos') return;
  if (parts[0] === 'repos') {
    if (req.method === 'POST' && parts[3] === 'forks' && parts.length === 4) {
      assertForkRequest(parts[1], parts[2], (req.body as { organization?: unknown } | undefined)?.organization, env);
      return;
    }
    assertDemoRepo(parts[1] ?? '', parts[2] ?? '', env);
    return;
  }
  if (!PERSON_WRITES.some((p) => p.test(req.path))) {
    throw new GuardError(`Refusing ${req.method} ${req.path}: setup has no reason to make that call.`);
  }
}

/** Runs on every API request before it leaves the process, for both identities. */
export function assertRequestAllowed(req: OutgoingRequest, env: Record<string, string | undefined>, identity: Identity): void {
  const parts = req.path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (identity === 'app') assertAppRequest(req, env, parts);
  else assertPersonRequest(req, env, parts);
}
