import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadLevers } from '../src/levers.ts';
import { scanRepo } from '../src/scan.ts';
import { recommendationsFor } from '../src/team.ts';
import { assertCloneThere, fixtureRepo, ROOT, skipWithoutClone } from './helpers.ts';

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

const sentry = [{ id: 'A', name: "Sentry's own MCP server", pattern: 'PAT-uses-sentry', kind: 'install', effects: [], gain: 'No gain measured.', proof: 'adoption only', source: 'https://s', how: 'h', audience: 'team', install: 'claude mcp add sentry' }] as never;
const rowsFor = (hits: readonly { pattern: string; file: string; line: number }[]) => recommendationsFor({ manifests: [] } as never, new Map(), [], { levers: sentry, hits });
const whyAt = (file: string, line: number) => rowsFor([{ pattern: 'PAT-uses-sentry', file, line }])[0].why;

test('a line of code uses the service, and a manifest or config line only shows the team does: "{" in vercel.json uses nothing', () => {
  assert.equal(whyAt('src/a.ts', 3), 'src/a.ts:3 uses this. No gain measured.');
  assert.equal(whyAt('worker/main.py', 3), 'worker/main.py:3 uses this. No gain measured.');
  assert.equal(whyAt('sentry.server.config.js', 3), 'sentry.server.config.js:3 uses this. No gain measured.');
  for (const [file, line] of [['package.json', 13], ['requirements.txt', 3], ['pyproject.toml', 5], ['vercel.json', 1], ['wrangler.toml', 2], ['supabase/config.toml', 2], ['.github/workflows/ci.yml', 3]] as const) {
    assert.equal(whyAt(file, line), `${file}:${line} shows the team uses this service. No gain measured.`);
  }
});

test('a line of code is the receipt when there is one, even when a manifest sorts first', () => {
  const rows = rowsFor([{ pattern: 'PAT-uses-sentry', file: 'package.json', line: 13 }, { pattern: 'PAT-uses-sentry', file: 'src/a.ts', line: 3 }]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].why, /^src\/a\.ts:3 uses this\./);
});

const teamLever = (name: string, pattern: string) => ({ id: name, name, pattern, kind: 'install', effects: [], gain: 'No gain measured.', proof: 'adoption only', source: 'https://s', how: 'h', audience: 'team', install: 'y' });

test('within one service a dependency line is a better receipt than a workflow, even when the workflow sorts first', () => {
  const rows = recommendationsFor({ manifests: [] } as never, new Map(), [], { levers: [teamLever('GitHub', 'PAT-uses-github')] as never, hits: [{ pattern: 'PAT-uses-github', file: '.github/workflows/ci.yml', line: 3 }, { pattern: 'PAT-uses-github', file: 'package.json', line: 9 }] });
  assert.match(rows[0].why, /^package\.json:9 /);
});

test('a workflow is true of most public repos, so its row comes after what a repo imports or declares, and before a generic one', () => {
  const levers = [teamLever('GitHub', 'PAT-uses-github'), teamLever('Cloudflare', 'PAT-uses-cloudflare'), teamLever('Vercel', 'PAT-uses-vercel'), teamLever('graphify', 'PAT-coding-agent-setup')] as never;
  const hits = [{ pattern: 'PAT-coding-agent-setup', file: 'AGENTS.md', line: 1 }, { pattern: 'PAT-uses-github', file: '.github/workflows/ci.yml', line: 3 }, { pattern: 'PAT-uses-cloudflare', file: 'wrangler.toml', line: 2 }, { pattern: 'PAT-uses-vercel', file: 'src/a.tsx', line: 1 }];
  const rows = recommendationsFor({ manifests: [] } as never, new Map(), [], { levers, hits });
  assert.deepEqual(rows.map((row) => row.name), ['Vercel', 'Cloudflare', 'GitHub', 'graphify']);
});

const rowsOfRepo = (path: string, commit: string) => recommendationsFor({ manifests: [] } as never, new Map(), [], { levers: loadLevers(), hits: scanRepo(path, { commit }).hits }).map((row) => `${row.name} | ${row.why.split(' ')[0]}`);

test('what a repo declares earns a row from a reviewed lever, and what only looks like it earns none', () => {
  const fixture = (name: string) => {
    const repo = fixtureRepo(name);
    try {
      return rowsOfRepo(repo.path, repo.commit);
    } finally {
      repo.cleanup();
    }
  };
  const declares = fixture('team-declares');
  assert.ok(declares.includes("GitHub's own MCP server | package.json:9"), declares.join('\n'));
  assert.ok(declares.includes('The cloudflare plugin from the official Claude Code marketplace | package.json:13'), declares.join('\n'));
  assert.deepEqual(fixture('team-declares-quiet'), []);
});

// The real clones, read at the commits the published runs read. Each cited line was opened and read by hand.
const REAL_ROWS: readonly { clone: string; commit: string; rows: readonly string[] }[] = [
  { clone: 'tmp/anything-llm', commit: '9caf2b4', rows: ["GitHub's own MCP server | .github/workflows/build-and-push-image-semver.yaml:7"] },
  { clone: 'tmp/aura', commit: '5efb4e8', rows: ["GitHub's own MCP server | .github/workflows/cla.yml:2", 'graphify for coding agents | CLAUDE.md:1'] },
  { clone: 'tmp/full/bolt.new', commit: 'HEAD', rows: ['The cloudflare plugin from the official Claude Code marketplace | package.json:81', "GitHub's own MCP server | .github/workflows/ci.yaml:3"] },
  { clone: 'tmp/full/farfalle', commit: 'HEAD', rows: ['The vercel plugin from the official Claude Code marketplace | src/frontend/src/app/layout.tsx:10', "GitHub's own MCP server | .github/workflows/build_and_push_docker.yml:5"] },
];

for (const { clone, commit, rows } of REAL_ROWS) {
  test(`For your team on ${clone}`, { skip: skipWithoutClone(clone) }, () => {
    assertCloneThere(clone);
    assert.deepEqual(rowsOfRepo(join(ROOT, clone), commit), rows);
  });
}
