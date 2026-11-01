import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agentAlias, commandLine, newFileFromPatch, parseServers, resolveTemplates, withLlm, type HttpSpec, type StdioSpec } from './example.ts';

const EXAMPLE = `# Incident response agent.
# A comment with [mcp.servers.fake] in it, and = signs.

[mcp]
sanitize_schemas = true

# PagerDuty
[mcp.servers.pagerduty]
transport = "http_streamable"
url = "https://mcp.pagerduty.com/mcp"
description = "PagerDuty"

[mcp.servers.pagerduty.headers]
Authorization = "Token {{ env.PAGERDUTY_API_TOKEN | default: '' }}"

[mcp.servers.signoz]
transport = "stdio"
cmd = ["docker"]
args = ["run", "-i", "--rm", "-e", "SIGNOZ_URL", "signoz/signoz-mcp-server:v0.17.0"]
env = { SIGNOZ_URL = "{{ env.SIGNOZ_URL | default: '' }}", LOG = "info" }
description = "SigNoz"

[agent]
name = "Incident Response Agent"
alias = "incident-response/signoz"
mcp_filter = ["pagerduty:*"]
system_prompt = """
A prompt with a line that looks like a section:
[mcp.servers.not_real]
transport = "stdio"
"""
turn_depth = 10

[agent.llm]
provider = "openai"
api_key = "{{ env.OPENAI_API_KEY }}"
model = "gpt-5.2"
`;

test('parseServers reads each server, its transport fields and its tables', () => {
  const servers = parseServers(EXAMPLE);
  assert.deepEqual(Object.keys(servers).sort(), ['pagerduty', 'signoz']);
  const signoz = servers.signoz as StdioSpec;
  assert.equal(signoz.transport, 'stdio');
  assert.deepEqual(signoz.cmd, ['docker']);
  assert.deepEqual(signoz.args, ['run', '-i', '--rm', '-e', 'SIGNOZ_URL', 'signoz/signoz-mcp-server:v0.17.0']);
  assert.deepEqual(signoz.env, { SIGNOZ_URL: "{{ env.SIGNOZ_URL | default: '' }}", LOG: 'info' });
  const pagerduty = servers.pagerduty as HttpSpec;
  assert.equal(pagerduty.url, 'https://mcp.pagerduty.com/mcp');
  assert.deepEqual(pagerduty.headers, { Authorization: "Token {{ env.PAGERDUTY_API_TOKEN | default: '' }}" });
});

test('a line inside a multi-line string is never read as config', () => {
  assert.equal(parseServers(EXAMPLE).not_real, undefined);
});

test('a server with a shape this reader does not know is an error, not a guess', () => {
  assert.throws(() => parseServers('[mcp.servers.x]\ntransport = "sse"\nurl = "http://x"\n'), /unsupported transport/);
  assert.throws(() => parseServers('[mcp.servers.x]\ntransport = "stdio"\ncmd = ["a"] # trailing\n'), /cannot read/);
  assert.throws(() => parseServers('[mcp.servers.x]\ntransport = "stdio"\n'), /needs cmd/);
  assert.throws(() => parseServers('[mcp.servers.x]\ntransport = "http_streamable"\n'), /needs url/);
});

test('resolveTemplates fills defaults and values the way AURA does, and leaves the spec alone', () => {
  const spec = parseServers(EXAMPLE).signoz as StdioSpec;
  const before = JSON.stringify(spec);
  assert.deepEqual((resolveTemplates(spec, {}) as StdioSpec).env, { SIGNOZ_URL: '', LOG: 'info' });
  assert.deepEqual((resolveTemplates(spec, { SIGNOZ_URL: 'http://x' }) as StdioSpec).env, { SIGNOZ_URL: 'http://x', LOG: 'info' });
  assert.equal(JSON.stringify(spec), before);
  const http = parseServers(EXAMPLE).pagerduty as HttpSpec;
  assert.equal((resolveTemplates(http, { PAGERDUTY_API_TOKEN: 't' }) as HttpSpec).headers.Authorization, 'Token t');
});

test('a template with no default and no value is an error', () => {
  const spec: HttpSpec = { name: 'x', transport: 'http_streamable', url: '{{ env.NOPE }}', headers: {} };
  assert.throws(() => resolveTemplates(spec, {}), /NOPE/);
});

test('commandLine prints the stdio command as the example runs it', () => {
  assert.equal(commandLine(parseServers(EXAMPLE).signoz as StdioSpec), 'docker run -i --rm -e SIGNOZ_URL signoz/signoz-mcp-server:v0.17.0');
});

test('agentAlias reads the alias the server answers to', () => {
  assert.equal(agentAlias(EXAMPLE), 'incident-response/signoz');
  assert.throws(() => agentAlias('[agent]\nname = "x"\n'), /no alias/);
});

test('withLlm leaves the example alone unless asked, and swaps only the llm block', () => {
  assert.equal(withLlm(EXAMPLE, { kind: 'as-is' }), EXAMPLE);
  const fake = withLlm(EXAMPLE, { kind: 'openai-base-url', baseUrl: 'http://127.0.0.1:9/v1' });
  assert.ok(fake.includes('base_url = "http://127.0.0.1:9/v1"'));
  assert.ok(fake.includes('model = "gpt-5.2"'));
  assert.ok(fake.includes('[mcp.servers.signoz]'));
  const claude = withLlm(EXAMPLE, { kind: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.ok(claude.includes('provider = "anthropic"'));
  assert.ok(claude.includes('api_key = "{{ env.ANTHROPIC_API_KEY }}"'));
  assert.ok(claude.includes('model = "claude-sonnet-5-5"'));
  assert.ok(!claude.includes('gpt-5.2'));
  assert.ok(claude.includes('alias = "incident-response/signoz"'));
});

test('newFileFromPatch rebuilds a file the patch adds, and refuses one it does not', () => {
  const patch = [
    'From abc Mon Sep 17 00:00:00 2001',
    'Subject: [PATCH 1/1] feat: add it',
    '',
    '---',
    ' a.toml | 2 ++',
    '',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,1 +1,2 @@',
    ' keep',
    '+added to the readme',
    'diff --git a/a.toml b/a.toml',
    'new file mode 100644',
    'index 000..111',
    '--- /dev/null',
    '+++ b/a.toml',
    '@@ -0,0 +1,2 @@',
    '+# one',
    '+two = "2"',
    '-- ',
    '2.0.0',
  ].join('\n');
  assert.equal(newFileFromPatch(patch, 'a.toml'), '# one\ntwo = "2"\n');
  assert.throws(() => newFileFromPatch(patch, 'README.md'), /does not add/);
  assert.throws(() => newFileFromPatch(patch, 'nope.toml'), /does not add/);
});
