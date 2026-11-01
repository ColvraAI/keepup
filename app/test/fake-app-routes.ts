// The /app, /orgs, /user and /installation half of the fake.
import { randomBytes } from 'node:crypto';
import type { FakeGitHub, FakeRoute, Reply, RouteContext } from './fake-github.ts';

function needsJwt(ctx: RouteContext): Reply | null {
  return ctx.request.auth === 'jwt' ? null : { status: 401, body: { message: 'A JSON web token could not be decoded' } };
}

function installationJson(fake: FakeGitHub): Record<string, unknown> {
  return {
    id: fake.options.installationId,
    app_id: fake.options.appId,
    app_slug: fake.appSlug,
    account: { login: fake.options.org, type: 'Organization' },
    repository_selection: 'all',
    html_url: `https://github.com/organizations/${fake.options.org}/settings/installations/${fake.options.installationId}`,
  };
}

const notInstalled: Reply = { status: 404, body: { message: 'Integration not found' } };

export const appRoutes: FakeRoute[] = [
  { method: 'POST', pattern: /^\/app\/installations\/(\d+)\/access_tokens$/, handler: (ctx, m) => {
    const bad = needsJwt(ctx);
    if (bad) return bad;
    if (!ctx.fake.installedOnOrg || Number(m[1]) !== ctx.fake.options.installationId) return notInstalled;
    const token = ctx.fake.fixedToken ?? `ghs_canary_${randomBytes(8).toString('hex')}`;
    ctx.fake.installationTokens.add(token);
    return { status: 201, body: { token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' } };
  } },
  { method: 'GET', pattern: /^\/app$/, handler: (ctx) => needsJwt(ctx) ?? (ctx.fake.appDeleted ? notInstalled : {
    status: 200,
    body: { id: ctx.fake.options.appId, slug: ctx.fake.appSlug, name: ctx.fake.appSlug, html_url: ctx.fake.marked(`https://github.com/apps/${ctx.fake.appSlug}`), owner: { login: ctx.fake.appOwner ?? ctx.fake.options.org } },
  }) },
  { method: 'GET', pattern: /^\/app\/installations\/(\d+)$/, handler: (ctx, m) => {
    const bad = needsJwt(ctx);
    if (bad) return bad;
    if (Number(m[1]) === ctx.fake.otherAppInstallationId) return { status: 200, body: { ...installationJson(ctx.fake), id: ctx.fake.otherAppInstallationId, app_id: ctx.fake.options.appId + 1 } };
    if (Number(m[1]) === ctx.fake.foreignInstallationId) return { status: 200, body: { ...installationJson(ctx.fake), id: ctx.fake.foreignInstallationId, account: { login: 'someone-else', type: 'Organization' } } };
    if (!ctx.fake.installedOnOrg || Number(m[1]) !== ctx.fake.options.installationId) return notInstalled;
    return { status: 200, body: installationJson(ctx.fake) };
  } },
  { method: 'GET', pattern: /^\/orgs\/([^/]+)\/installation$/, handler: (ctx) => {
    const bad = needsJwt(ctx);
    if (bad) return bad;
    return ctx.fake.installedOnOrg ? { status: 200, body: installationJson(ctx.fake) } : notInstalled;
  } },
  { method: 'GET', pattern: /^\/installation\/repositories$/, handler: (ctx) => {
    if (ctx.request.auth !== 'installation') return { status: 401, body: { message: 'Bad credentials' } };
    const repositories = [...ctx.fake.repos.values()]
      .filter((r) => r.owner.toLowerCase() === ctx.fake.options.org.toLowerCase() && r.name !== ctx.fake.hideFromInstallation)
      .map((r) => ({ name: r.name, full_name: `${r.owner}/${r.name}` }));
    return { status: 200, body: { total_count: repositories.length, repository_selection: 'all', repositories } };
  } },
  { method: 'GET', pattern: /^\/users\/([^/]+)$/, handler: (ctx, m) => {
    const login = decodeURIComponent(m[1]);
    if (login.toLowerCase() !== `${ctx.fake.appSlug}[bot]`.toLowerCase()) return { status: 404, body: { message: 'Not Found' } };
    return { status: 200, body: { login: ctx.fake.botLogin(), id: ctx.fake.options.botId, type: 'Bot' } };
  } },
  { method: 'POST', pattern: /^\/app-manifests\/([^/]+)\/conversions$/, handler: (ctx, m) => {
    const entry = ctx.fake.manifestCodes.get(m[1]);
    if (!entry) return { status: 404, body: { message: 'Not Found' } };
    ctx.fake.manifestCodes.delete(m[1]);
    ctx.fake.registeredApps += 1;
    ctx.fake.appSlug = entry.name;
    return { status: 201, body: {
      id: ctx.fake.options.appId, slug: entry.name, name: entry.name, node_id: 'x', owner: { login: ctx.fake.options.org },
      html_url: `https://github.com/apps/${entry.name}`, client_id: 'Iv1.fake', client_secret: ctx.fake.clientSecret,
      webhook_secret: ctx.fake.webhookSecret, pem: ctx.fake.privateKey,
    } };
  } },
  { method: 'GET', pattern: /^\/user$/, handler: (ctx) => ctx.request.auth === 'person'
    ? { status: 200, body: { login: ctx.fake.options.personLogin, id: 1, type: 'User' } }
    : { status: 401, body: { message: 'Bad credentials' } } },
  { method: 'GET', pattern: /^\/orgs\/([^/]+)$/, handler: (ctx, m) => ctx.fake.options.orgExists && m[1].toLowerCase() === ctx.fake.options.org.toLowerCase()
    ? { status: 200, body: { login: ctx.fake.options.org, id: 2, type: 'Organization' } }
    : { status: 404, body: { message: 'Not Found' } } },
  { method: 'GET', pattern: /^\/user\/memberships\/orgs\/([^/]+)$/, handler: (ctx, m) => m[1].toLowerCase() === ctx.fake.options.org.toLowerCase()
    ? { status: 200, body: { state: 'active', role: ctx.fake.options.personRole, organization: { login: ctx.fake.options.org } } }
    : { status: 403, body: { message: 'Must have admin rights to Repository.' } } },
  { method: 'GET', pattern: /^\/orgs\/([^/]+)\/repos$/, handler: (ctx) => {
    const names = new Set([...ctx.fake.options.orgRepos, ...[...ctx.fake.repos.values()].filter((r) => r.owner === ctx.fake.options.org).map((r) => r.name)]);
    return { status: 200, body: [...names].map((name) => ({ name, full_name: `${ctx.fake.options.org}/${name}` })) };
  } },
];
