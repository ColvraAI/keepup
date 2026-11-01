import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assertDemoRepo, assertForkRequest, assertPushRef, assertRequestAllowed, GuardError } from '../src/guard.ts';

const env = { DEMO_ORG: 'keepup-demo' };

test('assertDemoRepo lets through only the demo org', () => {
  assert.doesNotThrow(() => assertDemoRepo('keepup-demo', 'anything-llm', env));
  assert.doesNotThrow(() => assertDemoRepo('KEEPUP-demo', 'aura', env));
});

test('assertDemoRepo refuses upstream owners, in any case', () => {
  for (const owner of ['Mintplex-Labs', 'mintplex-labs', 'MEZMO', 'mezmo']) {
    assert.throws(() => assertDemoRepo(owner, 'anything-llm', env), /never writes to an upstream/);
  }
});

test('assertDemoRepo refuses other owners, and an upstream set as the demo org', () => {
  assert.throws(() => assertDemoRepo('someone-else', 'anything-llm', env), /only writes to keepup-demo/);
  assert.throws(() => assertDemoRepo('mezmo', 'aura', { DEMO_ORG: 'mezmo' }), GuardError);
  assert.throws(() => assertDemoRepo('keepup-demo', 'aura', {}), /DEMO_ORG/);
  assert.throws(() => assertDemoRepo('', 'aura', env), GuardError);
  assert.throws(() => assertDemoRepo('', 'aura', env), /Refusing \/aura/);
  assert.throws(() => assertDemoRepo('keepup-demo', '../aura', env), GuardError);
  assert.throws(() => assertDemoRepo('keepup-demo', 'a..b', env), GuardError);
});

test('the app identity can reach the demo org and nothing upstream, reads included', () => {
  const allowed = (method: string, path: string) => assertRequestAllowed({ method, path, body: undefined }, env, 'app');
  assert.doesNotThrow(() => allowed('POST', '/repos/keepup-demo/aura/pulls'));
  assert.doesNotThrow(() => allowed('GET', '/repos/keepup-demo/aura'));
  assert.doesNotThrow(() => allowed('POST', '/app/installations/7/access_tokens'));
  assert.doesNotThrow(() => allowed('GET', '/users/keepup%5Bbot%5D'));
  assert.throws(() => allowed('GET', '/repos/mezmo/aura'), GuardError);
  assert.throws(() => allowed('POST', '/repos/Mintplex-Labs/anything-llm/pulls'), GuardError);
  assert.throws(() => allowed('POST', '/repos/other/thing/issues'), GuardError);
  assert.throws(() => allowed('DELETE', '/app/installations/7'), GuardError);
  assert.throws(() => allowed('POST', '/user/repos'), GuardError);
  assert.throws(() => allowed('POST', '/gists'), GuardError);
});

test('a person token may fork upstreams into the demo org only, and nothing else upstream', () => {
  const person = (method: string, path: string, body?: unknown) => assertRequestAllowed({ method, path, body }, env, 'person');
  assert.doesNotThrow(() => person('POST', '/repos/mezmo/aura/forks', { organization: 'keepup-demo', default_branch_only: false }));
  assert.doesNotThrow(() => person('POST', '/app-manifests/abc/conversions'));
  assert.doesNotThrow(() => person('PATCH', '/repos/keepup-demo/aura', { has_issues: true }));
  assert.doesNotThrow(() => person('GET', '/orgs/keepup-demo/repos'));
  assert.throws(() => person('POST', '/repos/mezmo/aura/forks', { organization: 'other' }), GuardError);
  assert.throws(() => person('POST', '/repos/mezmo/aura/forks', {}), GuardError);
  assert.throws(() => person('POST', '/repos/random/thing/forks', { organization: 'keepup-demo' }), GuardError);
  assert.throws(() => person('PATCH', '/repos/mezmo/aura', { has_issues: true }), GuardError);
  assert.throws(() => person('POST', '/repos/mezmo/aura/issues', { title: 'x' }), GuardError);
  assert.throws(() => person('POST', '/orgs/keepup-demo/repos', {}), GuardError);
});

test('assertForkRequest names what it refuses', () => {
  assert.throws(() => assertForkRequest('mezmo', 'aura', 'mezmo', { DEMO_ORG: 'mezmo' }), /upstream/);
  assert.throws(() => assertForkRequest('mezmo', 'nope', 'keepup-demo', env), /not one of the demo's upstreams/);
});

test('assertPushRef allows only the two named refs, plainly spelled', () => {
  const allowed = ['keepup/2026-09-22-x', 'replay/abcd1234'];
  assert.doesNotThrow(() => assertPushRef('keepup/2026-09-22-x', allowed));
  assert.doesNotThrow(() => assertPushRef('replay/abcd1234', allowed));
  for (const bad of ['main', '+keepup/2026-09-22-x', 'refs/heads/main', 'keepup/2026-09-22-x:main', 'other']) {
    assert.throws(() => assertPushRef(bad, allowed), GuardError);
  }
});

test('a percent-encoded fork name can\'t climb out of the org, as a name or on the wire', () => {
  for (const repo of ['%2e%2e/mezmo/aura', '../mezmo/aura', 'aura/../../mezmo/aura', '%2e%2e']) {
    assert.throws(() => assertDemoRepo('keepup-demo', repo, env), GuardError, repo);
  }
  const allowed = (path: string) => assertRequestAllowed({ method: 'POST', path, body: undefined }, env, 'app');
  assert.throws(() => allowed('/repos/keepup-demo/%2e%2e%2fmezmo%2faura/pulls'), GuardError);
  assert.throws(() => allowed('/repos/%2e%2e/mezmo/aura/pulls'), GuardError);
  assert.throws(() => allowed('/repos/%6dezmo/aura/pulls'), /never writes to an upstream/);
});
