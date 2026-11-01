// A stand-in MCP server for --dry-run: newline-delimited JSON-RPC over stdio, as the MCP
// stdio transport defines it. The tool names say they're fake, and nothing it returns
// ever reaches result.md or out/.
//   node fake-mcp-server.ts <server id>
import { createInterface } from 'node:readline';

const server = process.argv[2] ?? 'fake';
export const FAKE_TOOLS = [
  { name: `fake_${server}_search`, description: 'Fake search.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: `fake_${server}_details`, description: 'Fake details.', inputSchema: { type: 'object', properties: {} } },
];

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function handle(message: { id?: unknown; method?: string; params?: { protocolVersion?: string } }): void {
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `fake-${server}`, version: '0.0.0-fake' } });
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: FAKE_TOOLS });
  } else if (message.method === 'tools/call') {
    reply(message.id, { content: [{ type: 'text', text: 'Fake tool result.' }] });
  } else {
    reply(message.id, {});
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on('end', () => process.exit(0));
