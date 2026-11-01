import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommendationsFor } from '../src/team.ts';

const facts = { manifests: [{ dependencies: [{ name: '@sentry/node', spec: '1' }, { name: 'express', spec: '4' }] }] } as never;
const files = new Map([['.env.example', 'SIGNOZ_API_KEY=\nPORT=1\n'], ['src/a.ts', "import x from '@supabase/supabase-js';\n"]]);

test('a registry record never makes a row, even the vendor\'s own: that needs a reviewed map first', () => {
  const records = [
    { source: 'mcp-registry', registry_name: 'io.github.SigNoz/signoz-mcp-server', packages: ['npm:signoz-mcp'], description: 'SigNoz tools' },
    { source: 'mcp-registry', registry_name: 'com.supabase/mcp', remote: true, description: 'Supabase' },
  ] as never;
  assert.deepEqual(recommendationsFor(facts, files, records), []);
});

test('a team lever fits when its pattern fired, with the hit as its receipt', () => {
  const levers = [{ id: 'A', name: "Sentry's own MCP server", pattern: 'PAT-uses-sentry', kind: 'install', effects: [], gain: 'No gain measured.', proof: 'vendor claim', source: 'https://s', how: 'h', audience: 'team', install: 'claude mcp add sentry' }, { id: 'B', name: 'Other', pattern: 'PAT-x', kind: 'install', effects: [], gain: 'g', proof: 'p', source: 's', how: 'h', audience: 'team', install: 'y' }] as never;
  const rows = recommendationsFor({ manifests: [] } as never, new Map(), [], { levers, hits: [{ pattern: 'PAT-uses-sentry', file: 'pkg.json', line: 3 }] });
  assert.deepEqual(rows.map((row) => row.install), ['claude mcp add sentry']);
  assert.match(rows[0].why, /pkg\.json:3/);
});
