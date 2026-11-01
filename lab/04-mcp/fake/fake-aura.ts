// A stand-in for the `aura` binary, for the host-only --dry-run: the same routes, and the
// same stream shape as lib/fixtures/real-aura-stream.sse, which the real binary produced.
// It reads the example's server names, invents obviously fake tools for them and answers
// with fake text. Given a base_url, as the offered step sets, it offers that provider its
// fake tools first, the way the real binary would.
//   CONFIG_PATH=<toml> PORT=<port> node fake-aura.ts webserver
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { agentAlias, parseServers } from '../lib/example.ts';

const config = readFileSync(process.env.CONFIG_PATH as string, 'utf8');
const alias = agentAlias(config);
const serverNames = Object.keys(parseServers(config));
const investigated = serverNames.find((name) => name !== 'pagerduty') ?? 'none';
const providerUrl = config.match(/^base_url = "(.+)"$/m)?.[1];

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function toolsFor(name: string): { tools?: { name: string; description: string }[]; transport: string } {
  // A server with no token never connects, so it has no tools key, as in the real response.
  if (name === 'pagerduty') return { transport: 'http_streamable' };
  return { transport: 'stdio', tools: [{ name: `fake_${name}_search`, description: 'Fake.' }, { name: `fake_${name}_details`, description: 'Fake.' }] };
}

async function offerTools(): Promise<void> {
  if (!providerUrl) return;
  const tools = serverNames.flatMap((name) => toolsFor(name).tools ?? []).map((tool) => ({ type: 'function', function: tool }));
  await fetch(`${providerUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }], tools }) });
}

function info(): unknown {
  return { agents: [{ id: alias, model: 'fake', mcp_servers: Object.fromEntries(serverNames.map((name) => [name, toolsFor(name)])) }] };
}

const named = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const chunk = (delta: unknown, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

function stream(): string {
  const tool = `fake_${investigated}_search`;
  return [
    named('aura.session_info', { model: 'fake' }),
    named('aura.mcp_status', { servers: [{ server_name: investigated, transport: 'stdio', status: 'connected', tools_count: 2 }] }),
    named('aura.tool_requested', { tool_id: 'call_1', tool_name: tool, arguments: {} }),
    named('aura.tool_start', { tool_id: 'call_1', tool_name: tool }),
    named('aura.tool_complete', { tool_id: 'call_1', tool_name: tool, duration_ms: 1, success: true }),
    chunk({ role: 'assistant', content: 'Fake answer from the dry-run AURA.' }),
    named('aura.usage', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ].join('');
}

const server = createServer((req, res) => {
  if (req.url === '/health') return json(res, { status: 'healthy', aura_version: 'fake' });
  if (req.url?.startsWith('/aura/info')) return json(res, info());
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      offerTools().then(() => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(stream()), () => res.writeHead(502).end());
    });
    return undefined;
  }
  res.writeHead(404).end();
  return undefined;
});

server.listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
