// Reads what an AURA example asks for, so the lab starts each server exactly as the
// example does and can't drift from it. It covers the small part of TOML these examples
// use and throws on anything else rather than guessing.

export interface StdioSpec { name: string; transport: 'stdio'; cmd: string[]; args: string[]; env: Record<string, string> }
export interface HttpSpec { name: string; transport: 'http_streamable'; url: string; headers: Record<string, string> }
export type ServerSpec = StdioSpec | HttpSpec;

export type LlmChoice =
  | { kind: 'as-is' }
  | { kind: 'openai-base-url'; baseUrl: string }
  | { kind: 'anthropic'; model: string };

type Value = string | string[] | Record<string, string>;
interface RawServer { fields: Record<string, Value>; tables: Record<string, Record<string, string>> }

const SERVER_SECTION = /^\[mcp\.servers\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\]$/;
const ANY_SECTION = /^\[+[^\]]+\]+$/;
const KEY_VALUE = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/;
const INLINE_ENTRY = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*")/g;
const WITH_DEFAULT = /\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\|\s*default:\s*'([^']*)'\s*\}\}/g;
const SIMPLE = /\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g;

function parseValue(raw: string, line: string): Value {
  const text = raw.trim();
  try {
    if (text.startsWith('{') && text.endsWith('}')) {
      const entries = [...text.matchAll(INLINE_ENTRY)].map((m) => [m[1], JSON.parse(m[2]) as string]);
      return Object.fromEntries(entries) as Record<string, string>;
    }
    return JSON.parse(text) as string | string[];
  } catch {
    throw new Error(`cannot read this example line: ${line}`);
  }
}

/** The config lines of a file: no comments, blanks or the insides of multi-line strings. */
function configLines(toml: string): string[] {
  const kept: string[] = [];
  let inMultiline = false;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const quotes = line.split('"""').length - 1;
    if (inMultiline) {
      if (quotes % 2 === 1) inMultiline = false;
      continue;
    }
    if (quotes % 2 === 1) {
      inMultiline = true;
      continue;
    }
    if (line && !line.startsWith('#')) kept.push(line);
  }
  return kept;
}

function collectServers(toml: string): Map<string, RawServer> {
  const servers = new Map<string, RawServer>();
  let current: { name: string; table: string | null } | null = null;
  for (const line of configLines(toml)) {
    const section = line.match(SERVER_SECTION);
    if (section) {
      current = { name: section[1], table: section[2] ?? null };
      if (!servers.has(section[1])) servers.set(section[1], { fields: {}, tables: {} });
      continue;
    }
    if (ANY_SECTION.test(line)) {
      current = null;
      continue;
    }
    const pair = current && line.match(KEY_VALUE);
    if (!current || !pair) continue;
    const server = servers.get(current.name) as RawServer;
    if (current.table) server.tables[current.table] = { ...server.tables[current.table], [pair[1]]: parseValue(pair[2], line) as string };
    else server.fields[pair[1]] = parseValue(pair[2], line);
  }
  return servers;
}

function toSpec(name: string, raw: RawServer): ServerSpec {
  const { transport, cmd, args, env, url } = raw.fields;
  if (transport === 'stdio') {
    if (!Array.isArray(cmd)) throw new Error(`server ${name} needs cmd`);
    const envTable = { ...(env as Record<string, string> | undefined), ...raw.tables.env };
    return { name, transport, cmd, args: Array.isArray(args) ? args : [], env: envTable };
  }
  if (transport === 'http_streamable') {
    if (typeof url !== 'string') throw new Error(`server ${name} needs url`);
    return { name, transport, url, headers: { ...raw.tables.headers } };
  }
  throw new Error(`server ${name} has an unsupported transport: ${String(transport)}`);
}

export function parseServers(toml: string): Record<string, ServerSpec> {
  return Object.fromEntries([...collectServers(toml)].map(([name, raw]) => [name, toSpec(name, raw)]));
}

function fill(text: string, env: Record<string, string | undefined>): string {
  const withDefaults = text.replace(WITH_DEFAULT, (_, name: string, fallback: string) => env[name] ?? fallback);
  return withDefaults.replace(SIMPLE, (_, name: string) => {
    const value = env[name];
    if (value === undefined) throw new Error(`the example needs ${name}, and it is not set`);
    return value;
  });
}

const fillAll = (table: Record<string, string>, env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(table).map(([k, v]) => [k, fill(v, env)]));

/** The same substitution AURA makes when it loads a config: {{ env.X }} and {{ env.X | default: 'y' }}. */
export function resolveTemplates(spec: ServerSpec, env: Record<string, string | undefined>): ServerSpec {
  if (spec.transport === 'http_streamable') return { ...spec, url: fill(spec.url, env), headers: fillAll(spec.headers, env) };
  return { ...spec, cmd: spec.cmd.map((c) => fill(c, env)), args: spec.args.map((a) => fill(a, env)), env: fillAll(spec.env, env) };
}

export function commandLine(spec: StdioSpec): string {
  return [...spec.cmd, ...spec.args].join(' ');
}

export function agentAlias(toml: string): string {
  const alias = configLines(toml).find((line) => line.startsWith('alias'))?.match(KEY_VALUE);
  if (!alias) throw new Error('the example has no alias');
  return JSON.parse(alias[2]) as string;
}

/** The example with its [agent.llm] table changed. The rest stays byte for byte. */
export function withLlm(toml: string, llm: LlmChoice): string {
  if (llm.kind === 'as-is') return toml;
  const marker = '[agent.llm]\n';
  const start = toml.indexOf(marker);
  if (start < 0) throw new Error('the example has no [agent.llm] table');
  const body = start + marker.length;
  if (llm.kind === 'openai-base-url') return `${toml.slice(0, body)}base_url = "${llm.baseUrl}"\n${toml.slice(body)}`;
  const nextSection = toml.slice(body).search(/^\[/m);
  const rest = nextSection < 0 ? '' : toml.slice(body + nextSection);
  const lines = ['provider = "anthropic"', 'api_key = "{{ env.ANTHROPIC_API_KEY }}"', `model = "${llm.model}"`];
  return `${toml.slice(0, body)}${lines.join('\n')}\n${rest}`;
}

/** The text of a file a patch adds, so a dry run can read the examples with no worktree. */
export function newFileFromPatch(patch: string, path: string): string {
  const header = `diff --git a/${path} b/${path}\nnew file mode`;
  const start = patch.indexOf(header);
  if (start < 0) throw new Error(`the patch does not add ${path}`);
  const hunk = patch.indexOf('\n@@ ', start);
  const lines = patch.slice(patch.indexOf('\n', hunk + 1) + 1).split('\n');
  const end = lines.findIndex((line) => !line.startsWith('+'));
  return `${lines.slice(0, end < 0 ? lines.length : end).map((line) => line.slice(1)).join('\n')}\n`;
}
