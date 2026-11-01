import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseManifest } from '../src/manifests.ts';

const dep = (m: ReturnType<typeof parseManifest>, name: string) => m?.dependencies.find((d) => d.name === name);

describe('parseManifest: package.json', () => {
  const text = '{\n  "name": "server",\n  "dependencies": {\n    "@modelcontextprotocol/sdk": "^1.24.3",\n    "x": "file:../x"\n  },\n  "devDependencies": {\n    "typescript": "~5.4.0"\n  }\n}\n';
  const m = parseManifest('server/package.json', text);

  it('reads each dependency with its section and the exact line', () => {
    assert.deepEqual(dep(m, '@modelcontextprotocol/sdk'), { name: '@modelcontextprotocol/sdk', spec: '^1.24.3', ecosystem: 'npm', section: 'dependencies', file: 'server/package.json', line: 4, source: 'registry' });
    assert.equal(dep(m, 'typescript')?.section, 'devDependencies');
    assert.equal(dep(m, 'typescript')?.line, 8);
    assert.equal(dep(m, 'x')?.source, 'path');
  });

  it('reports unreadable JSON instead of guessing', () => {
    const bad = parseManifest('package.json', '{ nope');
    assert.deepEqual(bad?.dependencies, []);
    assert.match(bad?.error ?? '', /JSON/i);
  });
});

describe('parseManifest: Cargo.toml', () => {
  const text = [
    '[workspace.dependencies]',                                                               // 1
    'rig-core = { git = "https://github.com/example/rig.git", rev = "097d08d" }',             // 2
    'rmcp = { version = "0.12.0", features = ["client"] }',                                   // 3
    'serde = "1.0"',                                                                          // 4
    '',                                                                                       // 5
    '[dependencies]',                                                                         // 6
    'rmcp.workspace = true',                                                                  // 7
    'local = { path = "../local" }',                                                          // 8
    'other = { workspace = true }',                                                           // 9
    '',                                                                                       // 10
    '[dependencies.tokio]',                                                                   // 11
    'version = "1.40"',                                                                       // 12
    'features = ["full"]',                                                                    // 13
    '',                                                                                       // 14
    '[target.\'cfg(unix)\'.dependencies]',                                                    // 15
    'nix = "0.29"',                                                                           // 16
  ].join('\n');
  const m = parseManifest('Cargo.toml', text);

  it('reads version, git, path and table forms, with lines', () => {
    assert.deepEqual(dep(m, 'rmcp'), { name: 'rmcp', spec: '0.12.0', ecosystem: 'crates', section: 'workspace.dependencies', file: 'Cargo.toml', line: 3, source: 'registry' });
    assert.equal(dep(m, 'serde')?.spec, '1.0');
    assert.equal(dep(m, 'rig-core')?.source, 'git');
    assert.equal(dep(m, 'rig-core')?.line, 2);
    assert.equal(dep(m, 'local')?.source, 'path');
    assert.equal(dep(m, 'tokio')?.spec, '1.40');
    assert.equal(dep(m, 'tokio')?.line, 11);
    assert.equal(dep(m, 'nix')?.section, "target.'cfg(unix)'.dependencies");
  });

  it('leaves out workspace references, which declare no version of their own', () => {
    assert.equal(m?.dependencies.filter((d) => d.name === 'rmcp').length, 1);
    assert.equal(dep(m, 'other'), undefined);
  });
});

describe('parseManifest: Python', () => {
  it('reads requirements.txt', () => {
    const m = parseManifest('requirements.txt', '# c\nopenai==1.40.0\nanthropic>=0.30,<1\nlangchain[all]~=0.2.0  # note\n-r other.txt\nplain\n');
    assert.deepEqual(m?.dependencies.map((d) => [d.name, d.spec, d.line]), [
      ['openai', '==1.40.0', 2],
      ['anthropic', '>=0.30,<1', 3],
      ['langchain', '~=0.2.0', 4],
      ['plain', '', 6],
    ]);
    assert.equal(m?.dependencies[0].ecosystem, 'pypi');
  });

  it('reads pyproject.toml project and poetry tables, without python itself', () => {
    const text = '[project]\nname = "d"\ndependencies = [\n  "fastapi>=0.110",\n  "pydantic==2.8.0",\n]\n\n[project.optional-dependencies]\ndev = ["pytest>=8"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nhttpx = "^0.27"\n';
    const m = parseManifest('pyproject.toml', text);
    assert.deepEqual(m?.dependencies.map((d) => [d.name, d.spec, d.line]), [
      ['fastapi', '>=0.110', 4],
      ['pydantic', '==2.8.0', 5],
      ['pytest', '>=8', 9],
      ['httpx', '^0.27', 13],
    ]);
  });
});

describe('parseManifest: others', () => {
  it('returns null for a file that is not a manifest', () => {
    assert.equal(parseManifest('src/a.ts', ''), null);
  });

  it('notes go.mod and setup.py as found, with no dependencies read', () => {
    assert.deepEqual(parseManifest('go.mod', 'module x\n')?.dependencies, []);
  });
});
