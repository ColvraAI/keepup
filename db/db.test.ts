// Checks every file in db/patterns and db/levers, then runs each pattern against lines read
// from real repos. Regex false positives kill the product, so the real lines live here as tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPatterns, scanFiles } from '../src/scan.ts';

const DB = import.meta.dirname;
const CLONES = join(DB, '..', 'tmp');
const EFFECTS = new Set(['cheaper', 'faster', 'better answers', 'keeps working', 'new capability']);
const PROOFS = new Set(['measured', 'vendor claim', 'projected', 'adoption only']);
const STATUSES = new Set(['live', 'info']);
const NEAR_LINES = 20;
// Hashes of names that appear on the pages we read, so this file doesn't print the names it keeps out.
// The regexes below catch most others.
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const KNOWN_PEOPLE = new Set(['899ca970ae9f1a7f7b40c1c5af9a10f19763cbf00b083c49901e39ee7b5873d8']);
const TWO_WORD_NAME = /(?=\b([A-Z][a-z]+ [A-Z][a-z]+)\b)/g;
const namesKnownPerson = (text: string, known: Set<string> = KNOWN_PEOPLE): boolean => [...text.matchAll(TWO_WORD_NAME)].some((match) => known.has(sha256(match[1])));
const PERSON_SHAPES = [
  /\bby [A-Z][a-z]+ [A-Z][a-z]+\b/,
  /\b[A-Z][a-z]+ [A-Z][a-z]+, (?:founder|co-founder|CEO|CTO)\b/,
  /[\w.-]+@[\w-]+\.[a-z]{2,}/,
  /(?:^|\s)@[a-z][\w-]+(?=\s|$)/,
];

type Find = { regex: string; flags?: string; note?: string; files?: string[] };
type Pattern = {
  id: string; name: string; find: Find[]; skip_if_near: string[]; files: string[];
  why: string; status: string; effect: string[]; live_from: string;
  skip_files?: string[]; skip_if_in_file?: string[];
  models?: { id: string; provider: string; date: string; successors: string[]; source: string }[];
};
type Lever = {
  id: string; name: string; pattern: string; kind: string; effects: string[]; gain: string; proof: string;
  source: string; how: string; checked: string; checked_by: string; replaces: string; trade_offs: string[];
  needs: string; price?: string; providers?: string[]; models?: string[];
};

function readAll<T>(dir: string): { file: string; data: T }[] {
  const path = join(DB, dir);
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .map((file) => ({ file, data: JSON.parse(readFileSync(join(path, file), 'utf8')) as T }));
}

const patterns = readAll<Pattern>('patterns');
const levers = readAll<Lever>('levers');
const patternById = new Map(patterns.map(({ data }) => [data.id, data]));

const pattern = (id: string): Pattern => {
  const found = patternById.get(id);
  if (!found) throw new Error(`No pattern ${id}`);
  return found;
};

const firesOn = (p: Pattern, line: string): boolean => p.find.some((f) => new RegExp(f.regex, f.flags ?? '').test(line));

/** Whether a pattern fires at a line of a real file, skip_if_near included. */
function firesAt(p: Pattern, lines: string[], lineNumber: number): boolean {
  const index = lineNumber - 1;
  if (!firesOn(p, lines[index])) return false;
  const near = lines.slice(Math.max(0, index - NEAR_LINES), index + NEAR_LINES + 1);
  return !p.skip_if_near.some((s) => near.some((line) => new RegExp(s).test(line)));
}

function linesAt(clone: string, commit: string, path: string): string[] {
  const out = spawnSync('git', ['-C', join(CLONES, clone), 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (out.status !== 0) throw new Error(`Can't read ${path} at ${commit} in ${clone}: ${out.stderr}`);
  return out.stdout.split('\n');
}

test('there are patterns and levers', () => {
  assert.ok(patterns.length >= 8);
  assert.ok(levers.length >= 20);
});

for (const { file, data: p } of patterns) {
  test(`pattern ${file} has every field`, () => {
    assert.equal(`${p.id}.json`, file, 'the id matches the file name');
    assert.match(p.id, /^PAT-[a-z0-9-]+$/);
    assert.ok(p.name.trim());
    assert.ok(p.why.trim());
    assert.ok(Array.isArray(p.find) && p.find.length > 0);
    assert.ok(Array.isArray(p.skip_if_near));
    assert.ok(Array.isArray(p.files) && p.files.length > 0);
    assert.ok(STATUSES.has(p.status), `status "${p.status}"`);
    assert.match(p.live_from, /^v\d+\.\d+$/);
    assert.ok(p.effect.length > 0);
    for (const word of p.effect) assert.ok(EFFECTS.has(word), `effect "${word}"`);
  });

  test(`pattern ${file} regexes compile`, () => {
    for (const f of p.find) assert.doesNotThrow(() => new RegExp(f.regex, f.flags ?? ''), f.regex);
    for (const s of [...p.skip_if_near, ...(p.skip_if_in_file ?? [])]) assert.doesNotThrow(() => new RegExp(s), s);
  });

  test(`pattern ${file}: a find with its own files can reach them`, () => {
    for (const f of p.find.filter((entry) => entry.files !== undefined)) {
      assert.ok(f.files?.length, f.regex);
      for (const glob of f.files ?? []) assert.ok(p.files.includes(glob), `${glob} is in the pattern's files, or this find never runs there`);
    }
  });
}

for (const { file, data: l } of levers) {
  test(`lever ${file} has every field`, () => {
    assert.equal(`${l.id}.json`, file, 'the id matches the file name');
    assert.match(l.id, /^ADV-\d{4}-\d{4}-[a-z0-9-]+$/);
    for (const key of ['name', 'kind', 'gain', 'how', 'replaces', 'needs'] as const) assert.ok(l[key].trim(), key);
    assert.ok(patternById.has(l.pattern), `pattern ${l.pattern} exists`);
    assert.ok(PROOFS.has(l.proof), `proof "${l.proof}"`);
    assert.ok(l.effects.length > 0);
    for (const word of l.effects) assert.ok(EFFECTS.has(word), `effect "${word}"`);
    assert.doesNotThrow(() => new URL(l.source));
    assert.match(l.source, /^https:\/\//);
    assert.match(l.checked, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(l.checked_by, 'agent', 'a person promotes a lever, never an agent');
    assert.ok(l.trade_offs.length > 0, 'every lever states a trade-off');
    for (const t of l.trade_offs) assert.ok(t.trim());
  });

  test(`lever ${file} labels vendor numbers`, () => {
    const hasNumber = /\$\d|\b\d+(?:\.\d+)?x\b|\d+%/.test(l.gain);
    if (hasNumber) assert.notEqual(l.proof, 'measured', 'nothing here has been measured');
    if (/\b\d+x\b|\d+%/.test(l.gain)) assert.match(l.gain, /vendor claim|listed|words/, 'a vendor number says so in words');
  });

  test(`lever ${file} lists every model it names in the retired list`, () => {
    const known = new Set((pattern('PAT-retired-model-id').models ?? []).map((m) => m.id));
    for (const id of l.models ?? []) assert.ok(known.has(id), id);
  });
}

test('ids are unique', () => {
  const ids = [...patterns.map(({ data }) => data.id), ...levers.map(({ data }) => data.id)];
  assert.equal(new Set(ids).size, ids.length);
});

test('the known-people check finds a hashed name among other capitalized words', () => {
  const known = new Set([sha256('Jane Example')]);
  assert.ok(namesKnownPerson('Notes From Jane Example today', known));
  assert.ok(!namesKnownPerson('Notes From Jane Sample today', known));
});

test('no people\'s names', () => {
  for (const { file, data } of [...patterns, ...levers]) {
    const text = Object.values(data as Record<string, unknown>).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
    assert.ok(!namesKnownPerson(text), `${file} names a person on the known list`);
    for (const shape of PERSON_SHAPES) assert.doesNotMatch(text, shape, file);
  }
});

test('every pattern has at least one lever', () => {
  const used = new Set(levers.map(({ data }) => data.pattern));
  for (const { data } of patterns) assert.ok(used.has(data.id), `${data.id} has no lever`);
});

test('a label-picking call shows both Jev and the Decisions API', () => {
  const ids = levers.filter(({ data }) => data.pattern === 'PAT-label-picking-call').map(({ data }) => data.id);
  assert.ok(ids.includes('ADV-2026-0915-typesafe-jev'));
  assert.ok(ids.includes('ADV-2026-1022-openai-decisions-api'));
});

test('real lines fire the info patterns that can now become findings', () => {
  // Each line is copied from the repo named beside it; the judge decides from the code around it.
  const real: readonly (readonly [string, string, string])[] = [
    ['PAT-http-api-no-mcp', 'src/api.ts', 'const app = express();'], // dzhng/deep-research src/api.ts:6
    ['PAT-no-test-set', 'operate/models/apis.py', '        response = client.messages.create('], // OthersideAI/self-operating-computer operate/models/apis.py
    ['PAT-no-tracing', 'services/chatService.js', '        const stream = await openai.chat.completions.create({'], // clusterzx/paperless-ai services/chatService.js:131
  ];
  for (const [id, file, line] of real) assert.ok(firesAt(pattern(id), [line], 1), `${id}: ${file}: ${line}`);
});

test('patterns not shown to clear the 85% bar stay information only', () => {
  for (const id of ['PAT-hand-rolled-memory', 'PAT-http-api-no-mcp', 'PAT-scheduled-llm-no-batch']) {
    assert.equal(pattern(id).status, 'info', id);
  }
});

test('every lever is huge or long tail, and each kind of huge lever has its price or discount on file', () => {
  for (const { file, data } of levers) assert.ok(['huge', 'long_tail'].includes((data as Record<string, any>).tier), file);
  const huge = levers.map(({ data }) => data as Lever & Record<string, any>).filter((lever) => lever.tier === 'huge');
  for (const pattern of ['PAT-prompt-caching-off', 'PAT-hand-parsed-json', 'PAT-label-picking-call', 'PAT-scheduled-llm-no-batch', 'PAT-search-results-into-prompt']) {
    assert.ok(huge.some((lever) => lever.pattern === pattern), pattern);
  }
  for (const lever of huge) assert.notEqual(lever.audience, 'team', lever.id);
  for (const lever of huge.filter((item) => ['PAT-prompt-caching-off', 'PAT-scheduled-llm-no-batch', 'PAT-label-picking-call'].includes(item.pattern))) {
    assert.ok(lever.gain_model.inputs.some((input: { value: unknown }) => input.value !== null), `${lever.id} has no price input`);
  }
});

test('a retired model or a removed parameter is never a huge lever', () => {
  for (const { data } of levers.filter((l) => ['PAT-retired-model-id', 'PAT-removed-parameter', 'PAT-removed-sampling-param'].includes(l.data.pattern))) {
    assert.equal((data as Record<string, any>).tier, 'long_tail', data.id);
  }
});

test('the hand-rolled memory lever is projected only', () => {
  for (const { data } of levers.filter((l) => l.data.pattern === 'PAT-hand-rolled-memory')) assert.equal(data.proof, 'projected');
});

// Lines read from real repos while sampling; a trailing comment says where each came from.
// A line with no comment is the shape of the code, not a quote from a repo.
const MUST_FIRE: Record<string, string[]> = {
  'PAT-own-skill-format': [
    '    : path.resolve(process.env.STORAGE_DIR, "plugins", "agent-skills");', // AnythingLLM server/utils/agents/imported.js:9
    'const SKILLS_DIR: &str = "skills";', // AURA skill_store.rs:52, a false alarm only the judge can catch
    'skillsDir = realDir', // onyx tools/ods/cmd/install_skill.go:367
  ],
  'PAT-hand-parsed-json': [
    'data = json.loads(model_response["message"])', // SWE-agent sweagent/tools/parsing.py:485
    'for raw_line in response.replace("```json", "").replace("```", "").splitlines():', // gpt-researcher deep_research.py:104
    "match = re.search(r'```(?:json)?\\s*([\\s\\S]+?)\\s*```', text)", // gpt-researcher evals/quality_eval/metrics.py:44
    'agent_dict = json_repair.loads(response) if response is not None else None', // gpt-researcher agent_creator.py:61
    "if text.startswith('```json') and text.endswith('```'):", // browser-use browser_use/llm/google/chat.py:490
  ],
  'PAT-label-picking-call': [
    '      name: "select_category",', // AnythingLLM router-classifier.js:24
    'async function classifyWithLLM(rules, prompt, router) {', // AnythingLLM router-classifier.js:71
    'Respond with "True" if PASSAGE is relevant to QUERY and "False" otherwise.', // graphiti openai_reranker_client.py:72
    'Rate the authority of each domain below as a research source on a scale of 0.0 to 1.0.', // gpt-researcher metrics.py:193
  ],
  'PAT-retired-model-id': [
    '    this.model = "whisper-1";', // AnythingLLM OpenAiWhisper.js:11
    'model = "claude-sonnet-4-20250514"', // AURA examples/minimal/anthropic.toml:14
    '  model: gpt-4o', // AURA deployment/helm/aura/values-prod.yaml:37
    '"gemini-2.0-flash-lite";', // AnythingLLM server/utils/AiProviders/gemini/index.js:53
  ],
  'PAT-removed-parameter': [
    'const myAssistants = await openai.beta.assistants.list({', // chatbot-ui route.ts:18
    "headers: { 'OpenAI-Beta': 'assistants=v1', ...options?.headers },", // LibreChat azureAssistants/initialize.js:25
  ],
  'PAT-removed-sampling-param': [
    'temperature: chatSettings.temperature,', // chatbot-ui anthropic/route.ts:66
    'temperature=0', // devika src/llm/claude_client.py:23
  ],
  'PAT-prompt-caching-off': [
    '# prompt_caching = true', // AURA examples/reference.toml:234
    '        prompt_caching: bool,', // AURA crates/aura-config/src/config.rs:102
    'const response = await anthropic.messages.create({', // chatbot-ui anthropic/route.ts:63
  ],
  'PAT-http-api-no-mcp': ['const app = express();', 'app = FastAPI(lifespan=lifespan)'],
  'PAT-hand-rolled-memory': ['${formatChatHistoryAsString(input.chatHistory.slice(-10))}'], // Perplexica researcher/index.ts:52
  // The regex only says "a model call". The files glob is what makes it a scheduled job.
  'PAT-scheduled-llm-no-batch': ['const completion = await groq.chat.completions.create({'], // a cron/src/util/getBias.ts:31
};

const MUST_NOT_FIRE: Record<string, string[]> = {
  'PAT-own-skill-format': [
    '      id: "agent-skills",', // AnythingLLM useSkillSections.js:88, a UI section id
    'if (importedSkills.length > 0) {', // AnythingLLM useSkillSections.js:121
  ],
  'PAT-hand-parsed-json': [
    'text = text.replace(/```[\\s\\S]*?```/g, " ");', // AnythingLLM messageToSpeech.js:18, a fence for speech
    'if (line.trim().startsWith("```")) {', // AnythingLLM markdown.js:105, rendering
    'message = json.loads(raw_message)', // autogen ws.py:83, a websocket frame
    'value = json_repair.loads(env_value)', // gpt-researcher config.py:286, an env var
    '(acc, line) => acc + JSON.parse(line).message.content,', // chatbot-ui chat-helpers:311, a stream frame
    'import json_repair',
  ],
  'PAT-label-picking-call': [
    `return "true" if value else "false"`, // onyx gitbook/connector.py:252
    'Return True if we should try to index, False if not.', // onyx docprocessing/utils.py:247
    'error_message = f"Please answer with one of: {valid}"', // aider io.py:897, a CLI prompt
    '"""Classify an MCP streamable-HTTP request into a gate verdict input.', // onyx mcp_jsonrpc.py:1
    'Use exactly one of these types. Other code belongs in a regular code block.', // LibreChat artifacts/index.ts:25
    'If none of the provided entity types accurately classify an extracted entity, the type should be set to None.', // graphiti
    "engine.add_argument('--public-set', help='explicitly classify this set as public; repeatable')", // quivr results.py:671
  ],
  'PAT-retired-model-id': [
    '    "gpt-4o": 128000,', // AnythingLLM modelMap/legacy.js:86, a lookup table
    '<option value={4096}>4,096 (gpt-3.5-turbo)</option>', // AnythingLLM AzureAiOptions:71, a label
    'endpoint (e.g. <code>whisper-1</code>).', // AnythingLLM GenericOpenAiOptions:60, prose
    '# model = "claude-sonnet-4-20250514"', // AURA examples/reference.toml:228, commented out
    'model = "claude-sonnet-4-6"', // an active model
    'model = "gpt-4.5-turbo-new"',
    'modelId: "anthropic.claude-sonnet-4-20250514-v1:0"', // Bedrock has its own lifecycle
    'encoder = tiktoken.encoding_for_model("gpt-4o")', // khoj helpers.py:994, a tokenizer
  ],
  'PAT-removed-parameter': [
    "app.include_router(prompts.router, prefix='/api/v1/prompts', tags=['prompts'])", // open-webui main.py:904, its own route
    '// openai.beta.assistants.list() was removed here',
  ],
  'PAT-removed-sampling-param': [
    'temperature: float,', // khoj anthropic/utils.py:187, a signature
    'temperature = 1.0', // khoj anthropic/utils.py:109, a local
    '# temperature=0.2',
  ],
  'PAT-hand-rolled-memory': [
    'for chat in chat_history[-4:]:', // khoj image/generate.py:70, context for one image prompt, not memory
  ],
  'PAT-prompt-caching-off': [
    'self._project_client.agents.messages.create(', // autogen _azure_ai_agent.py:882, Azure agents
    'client.beta.threads.messages.create(thread_id)', // OpenAI Assistants
    '# Prompt caching (default: off). Places cache_control breakpoints so', // AURA reference.toml:229, the explanation
    '// const r = await anthropic.messages.create({',
  ],
};

for (const [id, lines] of Object.entries(MUST_FIRE)) {
  test(`${id} fires on real lines`, () => {
    for (const line of lines) assert.ok(firesOn(pattern(id), line), line);
  });
}

for (const [id, lines] of Object.entries(MUST_NOT_FIRE)) {
  test(`${id} stays quiet on real lines`, () => {
    for (const line of lines) assert.ok(!firesOn(pattern(id), line), line);
  });
}

const loaded = loadPatterns();
/** The real scan on one line of one file, so a pattern's globs, its skip_files and a find's own files all count. */
const scanFires = (id: string, file: string, line: string): boolean => scanFiles([{ path: file, text: `${line}\n` }], loaded.filter((p) => p.id === id)).hits.length > 0;

// What a repo declares, for the team's own tools. Same rule as above: a trailing comment says where a real line came from.
const DECLARED_FIRES: readonly (readonly [string, string, string])[] = [
  ['PAT-uses-cloudflare', 'package.json', '    "@cloudflare/workers-types": "^4.20240620.0",'], // bolt.new package.json:81
  ['PAT-uses-cloudflare', 'package.json', '    "wrangler": "^3.63.2",'], // bolt.new package.json:98
  ['PAT-uses-cloudflare', 'package.json', '    "cloudflare": "^4.0.0",'],
  ['PAT-uses-cloudflare', 'requirements-dev.txt', 'cloudflare==4.0.0'],
  ['PAT-uses-cloudflare', 'pyproject.toml', '  "cloudflare>=4.0",'],
  ['PAT-uses-cloudflare', 'wrangler.toml', 'name = "bolt"'], // bolt.new wrangler.toml:2
  ['PAT-uses-cloudflare', 'wrangler.toml', 'compatibility_date = "2024-07-01"'], // bolt.new wrangler.toml:4
  ['PAT-uses-cloudflare', 'workers/api/wrangler.toml', 'main = "src/index.ts"'],
  ['PAT-uses-cloudflare', 'wrangler.json', '{'],
  ['PAT-uses-cloudflare', 'wrangler.jsonc', '{'],
  ['PAT-uses-github', '.github/workflows/cla.yml', 'on:'], // AURA .github/workflows/cla.yml:2
  ['PAT-uses-github', '.github/workflows/ci.yaml', 'on:'], // bolt.new .github/workflows/ci.yaml:3
  ['PAT-uses-github', '.github/workflows/lint.yml', '"on": [push]'],
  ['PAT-uses-github', '.github/workflows/lint.yml', "'on': push"],
  ['PAT-uses-github', 'package.json', '    "@octokit/auth-app": "^8.3.1",'], // keepup package.json:35
  ['PAT-uses-github', 'package.json', '    "octokit": "^5.0.5"'], // keepup package.json:36
  ['PAT-uses-github', 'requirements.txt', 'PyGithub==2.6.0'],
  ['PAT-uses-github', 'requirements.txt', 'pygithub'],
  ['PAT-uses-github', 'pyproject.toml', '  "PyGithub>=2.0",'],
  ['PAT-uses-linear', 'package.json', '    "@linear/sdk": "^60.0.0",'],
  ['PAT-uses-sentry', 'package.json', '    "@sentry/node": "^10.0.0",'], // ColvraAI/keepup examples/support-bot/package.json:13
  ['PAT-uses-sentry', 'apps/web/package.json', '    "@sentry/nextjs": "^10.0.0",'],
  ['PAT-uses-sentry', 'requirements.txt', 'sentry-sdk[fastapi]==2.20.0'],
  ['PAT-uses-sentry', 'requirements.txt', 'sentry_sdk>=2.0'],
  ['PAT-uses-sentry', 'pyproject.toml', '  "sentry-sdk[fastapi]>=2.0",'],
  ['PAT-uses-sentry', 'pyproject.toml', '  "sentry-sdk[fastapi]",'],
  ['PAT-uses-sentry', 'pyproject.toml', 'dependencies = ["fastapi>=0.115", "sentry-sdk>=2.0"]'],
  ['PAT-uses-sentry', 'pyproject.toml', 'sentry-sdk = { version = "^2.0", extras = ["fastapi"] }'],
  ['PAT-uses-sentry', 'sentry.client.config.ts', 'Sentry.init({'],
  ['PAT-uses-sentry', 'src/frontend/sentry.edge.config.mjs', '  Sentry.init({'],
  ['PAT-uses-stripe', 'package.json', '    "stripe": "^18.0.0"'], // ColvraAI/keepup examples/support-bot/package.json:16
  ['PAT-uses-stripe', 'package.json', '    "@stripe/stripe-js": "^7.0.0",'],
  ['PAT-uses-stripe', 'package.json', '    "stripe": "latest",'],
  ['PAT-uses-stripe', 'package.json', '    "stripe": "workspace:*",'],
  ['PAT-uses-stripe', 'requirements.txt', 'stripe'],
  ['PAT-uses-stripe', 'requirements.txt', 'stripe>=12.0\r'],
  ['PAT-uses-stripe', 'requirements.txt', 'stripe ; python_version >= "3.10"'],
  ['PAT-uses-stripe', 'requirements/requirements-prod.txt', 'stripe~=12.0  # payments'],
  ['PAT-uses-stripe', 'pyproject.toml', 'stripe = "^12.0"'],
  ['PAT-uses-supabase', 'package.json', '    "@supabase/supabase-js": "^2.50.0",'], // fragments package.json:37
  ['PAT-uses-supabase', 'package.json', '    "supabase": "^2.0.0",'],
  ['PAT-uses-supabase', 'requirements.txt', 'supabase==2.10.0'],
  ['PAT-uses-supabase', 'pyproject.toml', '  "supabase>=2.0",'],
  ['PAT-uses-supabase', 'supabase/config.toml', 'project_id = "shop"'],
  ['PAT-uses-supabase', 'apps/web/supabase/config.toml', 'project_id = "shop"'],
  ['PAT-uses-vercel', 'src/frontend/package.json', '    "@vercel/analytics": "^1.2.2",'], // farfalle src/frontend/package.json:31
  ['PAT-uses-vercel', 'package.json', '    "@vercel/kv": "^2.0.0",'], // fragments package.json:40
  ['PAT-uses-vercel', 'package.json', '    "vercel": "^41.0.0",'],
  ['PAT-uses-vercel', 'vercel.json', '{'],
  ['PAT-uses-vercel', 'apps/web/vercel.json', '{ "rewrites": [] }'],
];

const DECLARED_STAYS_QUIET: readonly (readonly [string, string, string])[] = [
  // A script, a description or a keyword isn't a dependency.
  ['PAT-uses-cloudflare', 'package.json', '    "deploy": "npm run build && wrangler pages deploy",'], // bolt.new package.json:10
  ['PAT-uses-cloudflare', 'package.json', '    "typegen": "wrangler types",'], // bolt.new package.json:19
  ['PAT-uses-cloudflare', 'package.json', '    "wrangler": "wrangler dev",'],
  ['PAT-uses-github', 'package.json', '  "homepage": "https://github.com/mezmo/aura#readme",'], // AURA package.json:15
  ['PAT-uses-github', 'package.json', '    "url": "git+https://github.com/mintplex-labs/anything-llm.git"'], // AnythingLLM package.json:11
  ['PAT-uses-github', 'package.json', '    "epub2": "git+https://github.com/Mintplex-Labs/epub2-static.git#main",'], // AnythingLLM collector/package.json:24
  ['PAT-uses-stripe', 'package.json', '    "stripe": "stripe listen --forward-to localhost:3000",'],
  ['PAT-uses-stripe', 'package.json', '    "stripe",'],
  ['PAT-uses-stripe', 'package.json', '  "name": "stripe",'],
  ['PAT-uses-stripe', 'package.json', '  "description": "stripe payments",'],
  ['PAT-uses-supabase', 'package.json', '    "supabase": "supabase start",'],
  ['PAT-uses-vercel', 'package.json', '    "vercel": "vercel dev",'],
  // A look-alike name isn't the service.
  ['PAT-uses-cloudflare', 'package.json', '    "@remix-run/cloudflare": "^2.10.2",'], // bolt.new package.json:48
  ['PAT-uses-linear', 'package.json', '    "linear-sdk": "^1.0.0",'],
  ['PAT-uses-linear', 'requirements.txt', 'linear==1.0'],
  ['PAT-uses-sentry', 'package.json', '    "sentry-testkit": "^5.0.0",'],
  ['PAT-uses-sentry', 'requirements.txt', 'sentry-sdk-extras==1.0'],
  ['PAT-uses-stripe', 'package.json', '    "stripe-mock": "^1.0.0",'],
  ['PAT-uses-stripe', 'requirements.txt', 'stripe-mock==1.0'],
  ['PAT-uses-stripe', 'requirements.txt', 'pystripe==1.0'],
  ['PAT-uses-stripe', 'pyproject.toml', '  "stripe-mock>=1.0",'],
  // Build tools from Vercel run anywhere, so they don't say the team runs there.
  ['PAT-uses-vercel', 'package.json', '    "@vercel/ncc": "^0.38.0",'],
  ['PAT-uses-vercel', 'package.json', '    "@vercel/nft": "^0.27.0",'],
  ['PAT-uses-vercel', 'package.json', '    "@vercel/style-guide": "^6.0.0",'],
  // A comment says nothing.
  ['PAT-uses-sentry', 'requirements.txt', '# sentry-sdk==2.20.0'],
  ['PAT-uses-sentry', 'pyproject.toml', '  # "sentry-sdk>=2.0",'],
  ['PAT-uses-sentry', 'pyproject.toml', '# sentry-sdk = "^2.0"'],
  ['PAT-uses-sentry', 'sentry.client.config.ts', '// Sentry.init({'],
  ['PAT-uses-cloudflare', 'wrangler.toml', '# name = "bolt"'],
  ['PAT-uses-supabase', 'supabase/config.toml', '# project_id = "shop"'],
  ['PAT-uses-github', '.github/workflows/ci.yml', '# on: push'],
  // pyproject.toml has lists and keys that aren't dependencies.
  ['PAT-uses-stripe', 'pyproject.toml', 'keywords = ["stripe", "payments"]'],
  ['PAT-uses-stripe', 'pyproject.toml', 'description = "stripe>=12.0 is what we looked at"'],
  ['PAT-uses-stripe', 'pyproject.toml', 'stripe = "shop.cli:main"'],
  ['PAT-uses-supabase', 'pyproject.toml', '  "supabase",'],
  ['PAT-uses-supabase', 'pyproject.toml', 'supabase = "shop.cli:db"'],
  // The same line in another file means nothing. A word in a README never counts.
  ['PAT-uses-stripe', 'README.md', '    "stripe": "^18.0.0",'],
  ['PAT-uses-stripe', 'README.md', 'import stripe'],
  ['PAT-uses-stripe', 'docs/setup.txt', 'stripe==12.0'],
  ['PAT-uses-stripe', 'src/scaffold.ts', '    "stripe": "^18.0.0",'], // the manifest a product writes for its users
  ['PAT-uses-stripe', 'src/generate.py', 'stripe==12.0'],
  ['PAT-uses-stripe', 'src/generate.py', 'stripe = "^12.0"'],
  ['PAT-uses-sentry', 'src/app.ts', 'Sentry.init({'],
  ['PAT-uses-vercel', 'package.json', '{'],
  ['PAT-uses-vercel', 'vercel.json.example', '{'],
  ['PAT-uses-vercel', 'vercel.json', '  {'], // a nested object, so a file wouldn't fire once for each
  ['PAT-uses-cloudflare', 'pyproject.toml', 'name = "bolt"'],
  ['PAT-uses-cloudflare', 'wrangler.toml.example', 'name = "bolt"'],
  ['PAT-uses-supabase', 'config.toml', 'project_id = "shop"'],
  ['PAT-uses-github', '.github/dependabot.yml', 'on:'],
  ['PAT-uses-github', '.github/workflows/README.md', 'on:'],
  ['PAT-uses-github', 'docker-compose.yml', 'on:'],
  ['PAT-uses-github', '.github/workflows/ci.yml', '  on:'],
  ['PAT-uses-github', '.github/workflows/ci.yml', '    runs-on: ubuntu-latest'],
  // GitHub only runs workflows at the top of a repo.
  ['PAT-uses-github', 'packages/app/.github/workflows/ci.yml', 'on:'],
  ['PAT-uses-github', '.github/workflows/old/ci.yml', 'on:'],
  // What a product scaffolds for its users isn't this team's stack.
  ['PAT-uses-stripe', 'templates/next/package.json', '    "stripe": "^18.0.0",'],
  ['PAT-uses-sentry', 'template/requirements.txt', 'sentry-sdk==2.20.0'],
  ['PAT-uses-supabase', 'sandbox-templates/next/package.json', '    "@supabase/supabase-js": "^2.50.0",'],
  ['PAT-uses-vercel', 'templates/next/vercel.json', '{'],
  ['PAT-uses-cloudflare', 'starters/worker/wrangler.toml', 'name = "starter"'],
  ['PAT-uses-supabase', 'templates/app/supabase/config.toml', 'project_id = "shop"'],
  ['PAT-uses-github', 'templates/.github/workflows/ci.yml', 'on:'],
  // Tests, fixtures and examples were always out.
  ['PAT-uses-stripe', 'examples/support-bot/package.json', '    "stripe": "^18.0.0"'],
  ['PAT-uses-stripe', 'test/fixtures/repos/shop/package.json', '    "stripe": "^18.0.0"'],
  ['PAT-uses-sentry', 'tests/integration/requirements.txt', 'sentry-sdk==2.20.0'],
];

test('what a repo declares fires its service', () => {
  for (const [id, file, line] of DECLARED_FIRES) assert.ok(scanFires(id, file, line), `${id}: ${file}: ${line}`);
});

test('a word that only looks like a declaration stays quiet', () => {
  for (const [id, file, line] of DECLARED_STAYS_QUIET) assert.ok(!scanFires(id, file, line), `${id}: ${file}: ${line}`);
});

test('a lever\'s install line is whole: GitHub\'s used to stop at 100 characters, in the middle of a word', () => {
  const github = levers.find(({ data }) => data.id === 'ADV-2026-1101-mcp-github')?.data as Lever & { install: string; change_recipe: { how: string } };
  assert.equal(github.install, 'claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PAT -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server'); // github/github-mcp-server docs/installation-guides/install-claude.md:78
  assert.equal(github.how, github.install);
  assert.equal(github.change_recipe.how, github.install);
});

test('sample code is out of the label-picking pattern', () => {
  // autogen's samples/ has an abstract classify_intent with no model behind it. The line can match, so the file glob drops it.
  assert.ok(pattern('PAT-label-picking-call').skip_files?.includes('**/samples/**'));
});

test('a comment naming cache_control does not count as handled', () => {
  const p = pattern('PAT-prompt-caching-off');
  const near = p.skip_if_near.map((s) => new RegExp(s));
  assert.ok(!near.some((re) => re.test('# Prompt caching (default: off). Places cache_control breakpoints so')));
  assert.ok(!near.some((re) => re.test('/// Anthropic prompt caching (`cache_control` breakpoints).')));
  assert.ok(near.some((re) => re.test('cache_control: { type: "ephemeral" },')));
});

const HAVE_ANYTHINGLLM = existsSync(join(CLONES, 'anything-llm'));
const HAVE_AURA = existsSync(join(CLONES, 'aura'));
const LLM = '9caf2b4';
const AURA = '5efb4e8';

test('acceptance: AnythingLLM at 9caf2b4', { skip: !HAVE_ANYTHINGLLM && 'no local clone' }, () => {
  const router = linesAt('anything-llm', LLM, 'server/utils/agents/aibitat/plugins/router-classifier.js');
  assert.ok(firesAt(pattern('PAT-label-picking-call'), router, 71));
  const whisper = linesAt('anything-llm', LLM, 'collector/utils/WhisperProviders/OpenAiWhisper.js');
  assert.ok(firesAt(pattern('PAT-retired-model-id'), whisper, 11));
});

test('acceptance: AURA at 5efb4e8', { skip: !HAVE_AURA && 'no local clone' }, () => {
  const retired = pattern('PAT-retired-model-id');
  assert.ok(firesAt(retired, linesAt('aura', AURA, 'examples/minimal/anthropic.toml'), 14));
  assert.ok(firesAt(retired, linesAt('aura', AURA, 'examples/complete/reasoning-models.toml'), 61));
  const caching = pattern('PAT-prompt-caching-off');
  assert.ok(firesAt(caching, linesAt('aura', AURA, 'examples/reference.toml'), 234));
  assert.ok(firesAt(caching, linesAt('aura', AURA, 'crates/aura-config/src/config.rs'), 102));
});

test('acceptance: held back in the AURA brief stays quiet', { skip: !HAVE_AURA && 'no local clone' }, () => {
  const fixture = linesAt('aura', AURA, 'crates/aura-config/src/writer.rs');
  assert.ok(!firesAt(pattern('PAT-retired-model-id'), fixture, 225), 'a #[cfg(test)] fixture never reaches the API');
});

test('every lever turns usage into a gain, keeps vendor and independent numbers apart, and team tools stay brief lines', () => {
  for (const { file, data } of levers) {
    const l = data as Lever & Record<string, any>;
    for (const key of ['gain_model', 'usage_signal', 'test_recipe', 'verify_rule', 'change_recipe', 'audience']) assert.ok(l[key] != null, `${file} ${key}`);
    assert.ok('gain_independent' in l && 'gain_vendor' in l, file);
    assert.ok(['product', 'team'].includes(l.audience), file);
    for (const i of l.gain_model.inputs) assert.equal(typeof i.assumed, 'boolean', file);
    if (l.audience === 'team') assert.ok(!/pull request$/.test(l.change_recipe.kind) && l.change_recipe.kind === 'written steps', file);
    if (l.proof !== 'vendor claim') assert.equal(l.gain_vendor, null, file);
  }
});
