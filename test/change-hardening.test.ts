// The holes an independent end-to-end test found in `keepup change`, one test per hole.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { catalogFor, liveEnd } from '../src/change-catalog.ts';
import { forbiddenPath } from '../src/change-checks.ts';
import { makeChange, type ModelAnswer } from '../src/change.ts';
import type { Llm } from '../src/llm.ts';
import { maskText } from '../src/mask.ts';
import type { Finding } from '../src/run-shape.ts';

const roots: string[] = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(files: Record<string, string | Buffer>): { path: string; commit: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-hard-'));
  roots.push(dir);
  const path = join(dir, 'source');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), text);
  }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: path, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return { path, commit: git('rev-parse', 'HEAD'), base: join(dir, 'live') };
}

const finding = (files: string[], over: Partial<Finding> = {}): Finding => ({
  rank: 1, title: 'old-model shuts down', effect: ['keeps working'], proof: 'vendor claim', effort: 'Hours',
  where: files.map((file) => ({ file, line: 1, text: '' })), why: 'It stops answering.',
  options: [{ name: 'Move to gpt-5.6-terra', what: 'Change gpt-3.5-turbo to gpt-5.6-terra.', needs: 'Nothing new.', source: 'https://platform.example.com/changelog' }],
  sources: ['https://platform.example.com/changelog'], lever: null, pr: null, ...over,
});

function fakeLlm(answer: Partial<ModelAnswer>): Llm & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls, maxUsd: 0.5,
    ask: async <T>() => {
      calls += 1;
      return { kind: 'swap', title: 'Move the model', summary: 'Moves the default.', edits: [], steps: [], ...answer } as T;
    },
    usage: () => ({ model: 'claude-sonnet-5-5', input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, usd: 0, price_source: 'x', calls, replayed_calls: 0, replayed_usd: 0 }),
  };
}

const NOW = new Date('2026-11-01T09:00:00Z');

async function attempt(files: Record<string, string | Buffer>, f: Finding, answer: Partial<ModelAnswer>) {
  const r = repo(files);
  const llm = fakeLlm(answer);
  const result = await makeChange({ path: r.path, run: { repo: 'acme/app', commit: null, findings: [f] }, rank: 1, commit: r.commit, llm, base: r.base, now: NOW });
  return { ...r, result, llm };
}

const JS = 'const OLD = "gpt-3.5-turbo";\nexport const MODEL = OLD;\n';
const SWAP = { file: 'a.js', search: 'const OLD = "gpt-3.5-turbo";', replace: 'const OLD = "gpt-5.6-terra";', why: '' };
const js = (replace: string, over: Partial<Finding> = {}) => attempt({ 'a.js': JS }, finding(['a.js'], over), { edits: [{ ...SWAP, replace }] });

// 1. A client class that picks its endpoint from the model's name.
for (const [name, file, code, search, replace] of [
  ['LangChain JS', 'a.js', 'import { OpenAI } from "@langchain/openai";\nconst m = new OpenAI({ modelName: "gpt-3.5-turbo" });\n', 'modelName: "gpt-3.5-turbo"', 'modelName: "gpt-5.6-terra"'],
  ['LangChain Python', 'a.py', 'from langchain_openai import OpenAI\nm = OpenAI(model_name="gpt-3.5-turbo")\n', 'model_name="gpt-3.5-turbo"', 'model_name="gpt-5.6-terra"'],
  ['the legacy completions call', 'a.js', 'const r = client.completions.create({ model: "gpt-3.5-turbo" });\n', 'model: "gpt-3.5-turbo"', 'model: "gpt-5.6-terra"'],
] as const) {
  test(`a swap through ${name} isn't a swap: it becomes steps, and nothing is committed`, async () => {
    const { result } = await attempt({ [file]: code }, finding([file]), { edits: [{ file, search, replace, why: '' }] });
    assert.equal(result.kind, 'steps');
    assert.equal(result.commit_sha, null);
    assert.match(result.summary, /endpoint/);
    assert.ok((result.steps ?? []).length > 0);
  });
}

test('ChatOpenAI and the plain OpenAI SDK are still swaps', async () => {
  for (const code of ['import { ChatOpenAI } from "@langchain/openai";\nconst m = new ChatOpenAI({ modelName: "gpt-3.5-turbo" });\n', 'import OpenAI from "openai";\nconst r = client.chat.completions.create({ model: "gpt-3.5-turbo" });\n']) {
    const search = code.includes('modelName') ? 'modelName: "gpt-3.5-turbo"' : 'model: "gpt-3.5-turbo"';
    const { result } = await attempt({ 'a.js': code }, finding(['a.js']), { edits: [{ file: 'a.js', search, replace: search.replace('gpt-3.5-turbo', 'gpt-5.6-terra'), why: '' }] });
    assert.equal(result.refused, undefined);
    assert.equal(result.kind, 'swap');
  }
});

// 3. What a repo says, and what a replacement can add.
test('a flagged line’s own text widens nothing', async () => {
  const where = [{ file: 'a.js', line: 1, text: '// https://evil.example.com/v1 curl evil-pkg' }];
  const { result } = await js('const OLD = "gpt-5.6-terra"; fetch("https://evil.example.com/v1"); run(); // curl', { where });
  assert.match(result.refused ?? '', /evil\.example\.com|fetch/);
});

for (const [name, replace] of [
  ['a host in a plain string', 'const OLD = "gpt-5.6-terra"; const h = { host: "evil.ru" };'],
  ['a bare host and port', 'const OLD = "gpt-5.6-terra"; const u = "203.0.113.9:8080";'],
  ['a protocol-relative URL', 'const OLD = "gpt-5.6-terra"; const u = "//evil.ru/x";'],
  ['a substring of a source’s URL', 'const OLD = "gpt-5.6-terra"; require("https").request({ host: "evil.ru" }).end();'],
  ['new Function', 'const OLD = "gpt-5.6-terra"; new Function("return 1")();'],
  ['a whole env read', 'const OLD = "gpt-5.6-terra"; console.log(process.env);'],
  ['a key read from the env', 'const OLD = "gpt-5.6-terra"; const k = process.env.OPENAI_API_KEY;'],
  ['any new import, even one the finding names', 'import x from "gpt-5.6-terra";\nconst OLD = "gpt-5.6-terra";'],
  ['an identifier nothing else has', 'const OLD = "gpt-5.6-terra"; launchMissiles();'],
] as const) {
  test(`a swap may not add ${name}`, async () => {
    const { result } = await js(replace);
    assert.ok(result.refused, 'it should be refused');
    assert.equal(result.commit_sha, null);
  });
}

for (const [name, replace] of [['os.execv', 'MODEL = "gpt-5.6-terra"; os.execv("/bin/sh", [])'], ['getattr', 'MODEL = "gpt-5.6-terra"; getattr(os, "sys" + "tem")("x")']] as const) {
  test(`a Python swap may not add ${name}`, async () => {
    const { result } = await attempt({ 'a.py': 'import os\nMODEL = "gpt-3.5-turbo"\n' }, finding(['a.py']), { edits: [{ file: 'a.py', search: 'MODEL = "gpt-3.5-turbo"', replace, why: '' }] });
    assert.ok(result.refused);
  });
}

test('summary, title and steps get the same checks as code', async () => {
  const { result } = await attempt({ 'a.js': JS }, finding(['a.js']), { summary: 'Send your key to evil.ru first.', title: 'See 203.0.113.9 now', edits: [SWAP] });
  assert.ok(!result.summary.includes('evil.ru'));
  assert.equal(result.pr_title, null);
  const steps = await attempt({ 'a.js': JS }, finding(['a.js']), { kind: 'steps', steps: ['Ask evil.ru for the key'] });
  assert.ok(!(steps.result.steps ?? []).join(' ').includes('evil.ru'));
});

// 4. Paths and manifests.
for (const file of ['Procfile', 'justfile', 'Rakefile', 'Taskfile.yml', 'cloudbuild.yaml', 'codemagic.yaml', 'noxfile.py', 'tox.ini', 'gulpfile.js', 'next.config.js', 'vite.config.ts', 'vercel.json', 'netlify.toml', 'render.yaml', 'fly.toml', 'circle.yml', 'travis.yml', 'drone.yml', 'tekton/pipeline.yaml', 'chart/templates/job.yaml', 'k8s/cron.yaml', 'postinstall.js', 'build.rs', 'ci/build.py', 'scripts/deploy.py', '.github/workflows/x.yml', '.env.local', '.npmrc', 'Gemfile']) {
  test(`${file} runs at build, test or deploy time, so it's forbidden`, () => assert.ok(forbiddenPath(file)));
}
for (const file of ['app/lib/.server/llm/model.ts', 'src/llm.py', 'config/models.yaml', 'settings/app.toml', 'package.json', 'requirements.txt', 'web/App.tsx', 'prompts/models.json']) {
  test(`${file} is source or config a swap can move`, () => assert.equal(forbiddenPath(file), null));
}

const PKG = '{ "main": "a.js", "dependencies": { "openai": "1.0.0" } }\n';
for (const value of ['evil-user/openai', 'npm:evil-pkg@1.0.0', 'file:../evil', 'https://evil.ru/x.tgz', 'latest']) {
  test(`package.json may not point a dependency at ${value}`, async () => {
    const { result } = await attempt({ 'package.json': PKG }, finding(['package.json'], { options: [{ name: 'openai', what: 'Move openai.', needs: '', source: 'https://platform.example.com/changelog' }] }), { edits: [{ file: 'package.json', search: '"openai": "1.0.0"', replace: `"openai": "${value}"`, why: '' }] });
    assert.ok(result.refused, value);
  });
}
test('package.json may not gain a pnpm override or a new main', async () => {
  for (const [search, replace] of [['"main": "a.js"', '"main": "b.js"'], ['"main": "a.js"', '"main": "a.js", "pnpm": { "overrides": { "openai": "1.0.1" } }']] as const) {
    const { result } = await attempt({ 'package.json': PKG }, finding(['package.json']), { edits: [{ file: 'package.json', search, replace, why: '' }] });
    assert.ok(result.refused, replace);
  }
});
for (const line of ['--index-url evil.ru/simple', '-e ../evil', 'openai @ file:../evil', 'evil-sdk', 'openai', 'git+https://evil.ru/x']) {
  test(`requirements.txt may not gain: ${line}`, async () => {
    const { result } = await attempt({ 'requirements.txt': 'openai==1.0.0\n' }, finding(['requirements.txt'], { options: [{ name: 'openai', what: 'Move openai.', needs: '', source: 'https://platform.example.com/changelog' }] }), { edits: [{ file: 'requirements.txt', search: 'openai==1.0.0', replace: line, why: '' }] });
    assert.ok(result.refused, line);
  });
}
test('requirements.txt may move a dependency the finding names to a version', async () => {
  const { result } = await attempt({ 'requirements.txt': 'openai==1.0.0\n' }, finding(['requirements.txt'], { options: [{ name: 'openai', what: 'Move openai.', needs: '', source: 'https://platform.example.com/changelog' }] }), { edits: [{ file: 'requirements.txt', search: 'openai==1.0.0', replace: 'openai>=2.0,<3', why: '' }] });
  assert.equal(result.refused, undefined);
});

// 5. A refusal that was certain before the model was asked costs nothing.
test('a finding whose every file is forbidden never reaches the model, and still shows what to do', async () => {
  const { result, llm } = await attempt({ '.github/workflows/ci.yml': 'name: ci\n' }, finding(['.github/workflows/ci.yml']), { edits: [] });
  assert.equal(llm.calls(), 0);
  assert.match(result.refused ?? '', /dot/);
  assert.ok((result.steps ?? []).length > 0);
});
test('Remix’s .server folder is real app code', async () => {
  const file = 'app/.server/model.js';
  const { result } = await attempt({ [file]: JS }, finding([file]), { edits: [{ ...SWAP, file }] });
  assert.equal(result.refused, undefined);
});

// 6. Keys.
const FAKE_KEY = 'sk-ant-FAKEfake0123456789';
test('a change whose edited line holds a key is refused', async () => {
  const code = `client = openai.OpenAI(api_key="${FAKE_KEY}"); MODEL = "gpt-3.5-turbo"\n`;
  const { result } = await attempt({ 'a.py': code }, finding(['a.py']), { edits: [{ file: 'a.py', search: 'MODEL = "gpt-3.5-turbo"', replace: 'MODEL = "gpt-5.6-terra"', why: '' }] });
  assert.match(result.refused ?? '', /key|secret/);
  assert.equal(result.commit_sha, null);
});
test('a key on a line beside the change never reaches the patch on disk, and the change can’t be opened', async () => {
  const code = `KEY = "${FAKE_KEY}"\nMODEL = "gpt-3.5-turbo"\n`;
  const { result, base } = await attempt({ 'a.py': code }, finding(['a.py']), { edits: [{ file: 'a.py', search: 'MODEL = "gpt-3.5-turbo"', replace: 'MODEL = "gpt-5.6-terra"', why: '' }] });
  assert.equal(result.refused, undefined);
  assert.ok(!readFileSync(join(base, result.id, 'change.patch'), 'utf8').includes(FAKE_KEY));
  assert.match(result.publish_block ?? '', /key/);
});
test('an unnamed key handed to a client constructor is masked', () => {
  assert.equal(maskText('co = cohere.Client("0123456789abcdef0123456789abcdef01234567")'), 'co = cohere.Client("[masked]")');
  assert.equal(maskText('c = OpenAI("abcdefghijklmnopqrstuvwxyz012345")'), 'c = OpenAI("[masked]")');
  for (const fine of ['c = InferenceClient("mistralai/Mistral-7B-Instruct-v0.1")', 'c = OpenAI("https://api.example.com/v1")', 'c = Client("short")', 'c = Client("a-long-name-without-any-digits")']) assert.equal(maskText(fine), fine);
});

// 7. Bytes that aren't UTF-8.
test('a file that isn’t UTF-8 is refused, not rewritten', async () => {
  const latin = Buffer.concat([Buffer.from('// caf'), Buffer.from([0xe9]), Buffer.from('\nconst OLD = "gpt-3.5-turbo";\n')]);
  const { result } = await attempt({ 'a.js': latin }, finding(['a.js']), { edits: [SWAP] });
  assert.match(result.refused ?? '', /UTF-8/);
  assert.equal(result.commit_sha, null);
});

// 8. Parsing more than JavaScript.
for (const [file, code, search, replace] of [
  ['a.ts', 'const m: string = "gpt-3.5-turbo";\n', 'const m: string = "gpt-3.5-turbo";', 'const m: string = "gpt-5.6-terra"; }}}{{{ (('],
  ['a.tsx', 'export const A = () => <div model="gpt-3.5-turbo" />;\n', '<div model="gpt-3.5-turbo" />', '<div model="gpt-5.6-terra" }}((;'],
  ['cfg/models.yaml', 'model: gpt-3.5-turbo\n', 'model: gpt-3.5-turbo', 'model: [gpt-5.6-terra'],
  ['cfg/models.toml', 'model = "gpt-3.5-turbo"\n', 'model = "gpt-3.5-turbo"', 'model = "gpt-5.6-terra'],
] as const) {
  test(`a broken ${file} is refused`, async () => {
    const { result } = await attempt({ [file]: code }, finding([file]), { edits: [{ file, search, replace, why: '' }] });
    assert.match(result.refused ?? '', /no longer parses/);
  });
}
for (const [file, code, search, replace] of [
  ['a.ts', 'const m: string = "gpt-3.5-turbo";\n', 'const m: string = "gpt-3.5-turbo";', 'const m: string = "gpt-5.6-terra";'],
  ['a.tsx', 'export const A = () => <div model="gpt-3.5-turbo" />;\n', 'model="gpt-3.5-turbo"', 'model="gpt-5.6-terra"'],
  ['b.js', 'export const A = () => <div model="gpt-3.5-turbo" />;\n', 'model="gpt-3.5-turbo"', 'model="gpt-5.6-terra"'],
  ['cfg/models.yaml', 'model: gpt-3.5-turbo\n', 'model: gpt-3.5-turbo', 'model: gpt-5.6-terra'],
  ['cfg/models.toml', 'model = "gpt-3.5-turbo"\n', 'model = "gpt-3.5-turbo"', 'model = "gpt-5.6-terra"'],
] as const) {
  test(`a good ${file} parses`, async () => {
    const { result } = await attempt({ [file]: code }, finding([file]), { edits: [{ file, search, replace, why: '' }] });
    assert.equal(result.refused, undefined);
    assert.equal(result.syntax[0]?.status, 'ok', result.syntax[0]?.detail);
  });
}

// 9. A model that's already gone.
test('an edit may not move to an id the catalog says is shut down, even one the finding lists', async () => {
  const f = finding(['a.js'], { options: [{ name: 'Move', what: 'Change gpt-3.5-turbo to gpt-4 or gpt-5.6-terra.', needs: '', source: 'https://platform.example.com/changelog' }] });
  const { result } = await attempt({ 'a.js': JS }, f, { edits: [{ ...SWAP, replace: 'const OLD = "gpt-4";' }] });
  assert.match(result.refused ?? '', /shut down/);
});

test('a chain of successors is followed to one that is live, and it can be moved to', async () => {
  const row = (id: string, effective: string, successors: string[]) => ({ provider: 'openai', id, name: null, status: 'retiring', announced: null, effective, successors, source: 's', sentence: 's' }) as never;
  const rows = [row('old-a', '2026-01-01', ['old-b']), row('old-b', '2026-10-23', ['new-c']), row('loop-a', '2026-01-01', ['loop-b']), row('loop-b', '2026-01-01', ['loop-a'])];
  assert.equal(liveEnd('old-a', '2026-11-01', rows), 'new-c');
  assert.equal(liveEnd('old-a', '2026-02-01', rows), 'old-b');
  assert.equal(liveEnd('new-c', '2026-11-01', rows), 'new-c');
  assert.equal(liveEnd('loop-a', '2026-11-01', rows), null);
  assert.equal(catalogFor(finding(['a.js'], { why: 'Replace old-a.', options: [] }), '2026-11-01', rows).moves['old-a'], 'new-c');
  assert.equal(catalogFor(finding(['a.js']), '2026-11-01').isRetired('gpt-4'), true);
  assert.equal(catalogFor(finding(['a.js']), '2026-11-01').isRetired('gpt-5.6-terra'), false);
});

// 10. Off by default means off by default.
const setting = (replace: string) => attempt({ 'a.js': JS }, finding(['a.js']), { kind: 'behind-a-setting', edits: [{ ...SWAP, replace }] });
for (const [name, replace] of [
  ['a switch the change itself turns on', 'const config = { enabled: true };\nconst OLD = config.enabled ? "gpt-5.6-terra" : "gpt-3.5-turbo";'],
  ['an env switch with the new model as the default', 'const OLD = process.env.USE_OLD ? "gpt-3.5-turbo" : "gpt-5.6-terra";'],
  ['a negated switch', 'const OLD = process.env.NO_NEW !== "1" ? "gpt-5.6-terra" : "gpt-3.5-turbo";'],
  ['a setting that drops the old path', 'const OLD = process.env.USE_NEW ? "gpt-5.6-terra" : "gpt-5.6-terra";'],
] as const) {
  test(`off by default refuses ${name}`, async () => {
    const { result } = await setting(replace);
    assert.match(result.refused ?? '', /off by default/);
    assert.equal(result.commit_sha, null);
  });
}
for (const [name, replace] of [
  ['a ternary', 'const OLD = process.env.USE_NEW === "1" ? "gpt-5.6-terra" : "gpt-3.5-turbo";'],
  ['an or-default', 'const OLD = process.env.MODEL || "gpt-3.5-turbo";'],
  ['a named switch', 'const useNew = process.env.USE_NEW === "1";\nconst OLD = useNew ? "gpt-5.6-terra" : "gpt-3.5-turbo";'],
] as const) {
  test(`off by default accepts ${name}`, async () => {
    const { result } = await setting(replace);
    assert.equal(result.refused, undefined);
    assert.equal(result.kind, 'behind-a-setting');
  });
}
for (const replace of ['MODEL = "gpt-5.6-terra" if os.getenv("USE_NEW") else "gpt-3.5-turbo"', 'MODEL = os.getenv("MODEL", "gpt-3.5-turbo")', 'MODEL = os.environ.get("MODEL") or "gpt-3.5-turbo"']) {
  test(`off by default accepts Python: ${replace}`, async () => {
    const { result } = await attempt({ 'a.py': 'import os\nMODEL = "gpt-3.5-turbo"\n' }, finding(['a.py']), { kind: 'behind-a-setting', edits: [{ file: 'a.py', search: 'MODEL = "gpt-3.5-turbo"', replace, why: '' }] });
    assert.equal(result.refused, undefined);
  });
}

// 11. What stays on disk.
test('once the patch is written, the clone and the syntax copies are gone', async () => {
  const r = await attempt({ 'a.js': JS }, finding(['a.js']), { edits: [SWAP] });
  const { result, base } = r;
  assert.equal(existsSync(join(base, result.id, 'repo')), false);
  assert.equal(existsSync(join(base, result.id, 'syntax')), false);
  const patch = readFileSync(join(base, result.id, 'change.patch'), 'utf8');
  assert.equal(result.publish_block, undefined);
  execFileSync('git', ['apply', '--check', '-'], { cwd: r.path, input: patch });
});

test('steps are never an empty list: with no options on record, they still say where and what to check', async () => {
  const { result } = await attempt({ 'a.js': JS }, finding(['a.js'], { options: [] }), { kind: 'steps', steps: [] });
  assert.equal(result.kind, 'steps');
  assert.match((result.steps ?? [])[0] ?? '', /a\.js:1/);
  assert.match((result.steps ?? [])[1] ?? '', /platform\.example\.com/);
});
