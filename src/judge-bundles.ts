// What the judge is shown, one bundle at a time: the exact-check floor, each pattern with its levers and the
// code at each hit, and each job with its candidates' records and the code at each place.
// All of it is masked repo text and public records, fenced as untrusted data.
import type { Candidate } from './candidates.ts';
import { pathContext } from './code-context.ts';
import type { LibraryFact } from './library-moves.ts';
import { type Lever, leverAllowed, type PatternMeta } from './levers.ts';
import { codeBlocks, type Place, untrustedBlock } from './repo-text.ts';
import type { Finding, Job } from './run-shape.ts';
import type { Hit } from './scan.ts';
import type { DbRecord } from './search.ts';

const HIT_RADIUS = 20;
const FLOOR_RADIUS = 3;
const JOB_RADIUS = 20;
const MAX_HITS = 12;
/** A hard stop on one pattern's spend. What's past it is counted on the run's incomplete line, never silently cut. */
export const MAX_HIT_SETS = 4;
/** An info pattern gets one set: it's the judge that makes it a finding, so what it reads is what it can check. */
const INFO_HIT_SETS = 1;
/** An absence is true of the whole repo. A few calls show it; more would only cost more. */
const ABSENCE_PLACES = 3;
const INFO_RULE = 'A scan can\'t prove it from a line, so it counts only if the code shown really has the problem. If it does, it\'s a finding like any other.';
const ABSENCE_RULE = 'This is an absence across the whole repo, raised once: at most one finding, citing one or two of the calls shown, with the first step to fix it.';
const MAX_FLOOR_PLACES = 8;
const MAX_JOB_FILES = 4;
/** A file this short is shown whole, so a table of supported models can be read end to end. */
const WHOLE_FILE_LINES = 220;
const MAX_DESCRIPTION = 320;
const RELATED_LIMIT = 3;
export const RETIRED_PATTERN = 'PAT-retired-model-id';
const CODE_NAME = /\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kt)$/;
const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'your', 'calls', 'only', 'model', 'models', 'turn', 'move', 'shuts', 'down', 'retires', 'retired', 'anthropic', 'openai', 'gemini', 'google', 'claude']);

export interface Bundle {
  readonly id: string;
  readonly kind: 'floor' | 'pattern' | 'job';
  readonly prompt: string;
  readonly urls: readonly { readonly url: string; readonly text: string }[];
}

export interface FloorItem {
  readonly id: string;
  readonly finding: Finding;
  readonly levers: readonly Lever[];
  /** For a library behind on versions: code near what its notes name, so "already handled" can be seen. */
  readonly callers?: string;
}

function leverText(lever: Lever): string {
  const { id, name, kind, effects, gain, proof, source, how, replaces, trade_offs, needs, price, providers } = lever;
  return JSON.stringify({ id, name, kind, effects, gain, proof, source, how, replaces, trade_offs, needs, price, providers }, null, 0);
}

function recordText(candidate: Pick<Candidate, 'record' | 'official' | 'declared' | 'card'>): string {
  const { record, official, declared, card } = candidate;
  const { source, kind, name, url, released, updated, version, packages, remote, registry_name, task, library, license, stars, likes, downloads, downloads_week, installs, language, model_id, price_in_per_m, price_out_per_m } = record as DbRecord & Record<string, unknown>;
  const description = String(record.description ?? '').slice(0, MAX_DESCRIPTION);
  return JSON.stringify({
    source, kind, name, url, description, released, updated, version, packages, remote, registry_name, task, library, license, stars, likes, downloads, downloads_week, installs, language, model_id, price_in_per_m, price_out_per_m,
    ...(official ? { namespace_matches_vendor: true } : {}),
    ...(declared ? { already_a_dependency: true } : {}),
    ...(card ? { model_card_start: card } : {}),
  });
}

export function recordUrls(record: DbRecord): string[] {
  return [record.url, record.repo_url, record.homepage, record.hn_url, record.yc_url].filter((url): url is string => typeof url === 'string' && url.startsWith('http'));
}

function keywordsOf(lever: Lever): string[] {
  return lever.name.toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 5 && !STOP_WORDS.has(word)).map((word) => word.slice(0, 5));
}

/** Changelog entries about the same thing as a lever, so dates in a finding can be read from a record. */
export function relatedChangelog(lever: Lever, changelog: readonly DbRecord[]): DbRecord[] {
  const keys = keywordsOf(lever);
  if (keys.length === 0) return [];
  const providers = lever.providers ?? [];
  return changelog
    .filter((entry) => (providers.length === 0 || providers.includes(String(entry.provider))))
    .filter((entry) => {
      const text = String(entry.description ?? '').toLowerCase();
      return keys.filter((key) => text.includes(key)).length >= Math.min(2, keys.length);
    })
    .slice(0, RELATED_LIMIT);
}

export function floorItems(findings: readonly Finding[], levers: readonly Lever[], modelsIn: (finding: Finding) => readonly string[], callersOf: (finding: Finding) => string = () => ''): FloorItem[] {
  return findings.map((finding, index) => {
    const ids = modelsIn(finding);
    const callers = callersOf(finding);
    return { id: `F${index + 1}`, finding, levers: levers.filter((lever) => lever.models?.some((model) => ids.includes(model))), ...(callers ? { callers } : {}) };
  });
}

const GAIN_WORD = /[a-z][a-z-]{4,}/g;
const GAIN_STOP = new Set(['after', 'abandoned', 'transport', 'request', 'requests', 'client', 'server', 'default', 'pending', 'tokens', 'support', 'permanent', 'errors', 'tools', 'prompts', 'resources', 'follow', 'same-origin', 'streamable', 'origin', 'version', 'versions']);
const LINES_PER_GAIN = 6;
const MAX_CALLER_LINE = 200;

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lines in non-test files that use the library and share a word with what its notes name, a few for each note. */
export function callerLines(library: string, gains: readonly string[], files: ReadonlyMap<string, string>): string {
  const name = escapeForRegex(library);
  const uses = new RegExp(`\\b${name}::|from\\s+["'\`]${name}|require\\(["'\`]${name}`);
  const count = (text: string) => text.split(library).length;
  const users = [...files].filter(([file, text]) => CODE_NAME.test(file) && pathContext(file) !== 'test' && uses.test(text)).sort((a, b) => count(b[1]) - count(a[1]));
  const found = gains.flatMap((gain) => {
    const words = (gain.toLowerCase().match(GAIN_WORD) ?? []).filter((word) => !GAIN_STOP.has(word));
    return users.flatMap(([file, text]) => text.split('\n').flatMap((line, index) => (words.some((word) => line.toLowerCase().includes(word)) ? [`${file}:${index + 1}| ${line.trim().slice(0, MAX_CALLER_LINE)}`] : []))).slice(0, LINES_PER_GAIN);
  });
  return [...new Set(found)].join('\n');
}

export function floorBundle(items: readonly FloorItem[], files: ReadonlyMap<string, string>): Bundle | null {
  if (items.length === 0) return null;
  const blocks = items.map((item) => {
    const places = item.finding.where.slice(0, MAX_FLOOR_PLACES);
    const leverBlocks = item.levers.map((lever) => untrustedBlock('lever', lever.id, leverText(lever)));
    return [
      `### ${item.id}: ${item.finding.title}`,
      `What the program proved: ${item.finding.why}`,
      ...(item.finding.locked ? [`This one stays whatever you answer, because ${item.finding.locked}. Give it a note saying what it means here.`] : []),
      untrustedBlock('places', 'where this is in the code', item.finding.where.map((place) => `${place.file}:${place.line}`).join(', ')),
      ...leverBlocks,
      codeBlocks(files, places, FLOOR_RADIUS, MAX_FLOOR_PLACES),
      ...(item.callers ? [untrustedBlock('code', 'lines near what its release notes name, in files that use this library', item.callers)] : []),
    ].join('\n');
  }).join('\n\n');
  const prompt = `${blocks}

These facts were proved by a program from the provider changelogs and the package registries: the dates and versions are right. Your job for each one is only whether it matters to this product. Give one floor_verdict per id, and leave "findings" empty.

- keep: true when this code really depends on it. A retired or retiring model that real code or a config users copy sends to the provider stays. A dependency stays if the product's main AI path runs on it and it has been abandoned (the program says it has had no release for a long time), or if it's the protocol library the product's main path relies on and the gap is big. Being behind on an optional or ordinary client library that works, with nothing in the code showing a problem, is keep: false.
- note: one or two plain sentences on what this means for this product: what breaks or what to do. If a lever is shown, recommend the replacement it gives, and call it by the model's name. If keep is false, why it doesn't matter here. No numbers, dates or versions that aren't already above.
- effort: the honest size of the change.
- not_live: a listed place that really is a comment, a test helper or text shown to a person. A list a person can pick from is live, because the pick gets sent. Say why.
- not_gains: for a library, each line its release notes list that isn't a gain for this code: the code shown already does that itself through its own calls, as with its own cancellation, retry or reconnect handling, or nothing here uses it. "text" copies that line. "why" says so in one plain sentence, naming the file and line that shows it. Leave it empty for a model. A line the code shown says nothing about stays a gain.`;
  return { id: 'Exact checks', kind: 'floor', prompt, urls: items.flatMap((item) => item.levers.flatMap((lever) => [{ url: lever.id, text: leverText(lever) }, { url: lever.source, text: leverText(lever) }])) };
}

function leverUrls(lever: Lever, changelog: readonly DbRecord[]): Bundle['urls'] {
  const related = relatedChangelog(lever, changelog);
  return [
    { url: lever.id, text: leverText(lever) },
    { url: lever.source, text: leverText(lever) },
    ...related.map((entry) => ({ url: String(entry.url), text: `${entry.released} ${entry.description}` })),
  ];
}

/** Every hit reaches the judge: a file's hits stay together, a set at a time, and test files come last. The bundles' findings merge into one per lever. */
export function hitChunks(hits: readonly Hit[], maxSets = MAX_HIT_SETS): Hit[][] {
  const ordered = [...hits].sort((a, b) => Number(pathContext(a.file) === 'test') - Number(pathContext(b.file) === 'test'));
  const chunks = ordered.reduce<Hit[][]>((sets, hit) => {
    const last = sets.at(-1);
    return last && last.length < MAX_HITS ? [...sets.slice(0, -1), [...last, hit]] : [...sets, [hit]];
  }, []);
  return chunks.slice(0, maxSets);
}

function shownHits(pattern: PatternMeta, hits: readonly Hit[]): Hit[][] {
  if (pattern.absence) return hitChunks(hits.slice(0, ABSENCE_PLACES), 1);
  return hitChunks(hits, pattern.status === 'live' ? MAX_HIT_SETS : INFO_HIT_SETS);
}

function patternRules(pattern: PatternMeta): string {
  const rules = [pattern.status === 'info' ? INFO_RULE : '', pattern.absence ? ABSENCE_RULE : '', pattern.judge_note ?? ''].filter(Boolean);
  return rules.length ? `\n\n${rules.join(' ')}` : '';
}

export function patternBundles(input: {
  readonly hits: readonly Hit[];
  readonly exactPlaces: ReadonlySet<string>;
  readonly levers: readonly Lever[];
  readonly patterns: readonly PatternMeta[];
  readonly changelog: readonly DbRecord[];
  readonly files: ReadonlyMap<string, string>;
  readonly providerOnly?: string;
}): Bundle[] {
  return input.patterns.flatMap((pattern) => {
    const hits = input.hits.filter((hit) => hit.pattern === pattern.id && !(pattern.id === RETIRED_PATTERN && input.exactPlaces.has(`${hit.file}:${hit.line}`)));
    // A team lever is for the "For your team" section, and never a finding in the product's code.
    const levers = input.levers.filter((lever) => lever.pattern === pattern.id && lever.audience !== 'team' && leverAllowed(lever, input.providerOnly));
    if (hits.length === 0 || levers.length === 0) return [];
    const urls = levers.flatMap((lever) => leverUrls(lever, input.changelog));
    const leverBlocks = levers.map((lever) => untrustedBlock('lever', lever.id, leverText(lever)));
    const related = levers.flatMap((lever) => relatedChangelog(lever, input.changelog));
    const relatedBlocks = [...new Set(related)].map((entry) => untrustedBlock('changelog', String(entry.url), `${entry.released} ${entry.description}`));
    return shownHits(pattern, hits).map((shown, index, chunks) => {
    const prompt = `Pattern: ${pattern.name}. ${pattern.why}

The scan fired ${hits.length} times${hits.length > shown.length ? `; here are ${shown.length} of them, set ${index + 1} of ${chunks.length}` : ''}. Read the code around each hit and decide if the pattern is really there.

${leverBlocks.join('\n')}
${relatedBlocks.join('\n')}
${codeBlocks(input.files, shown, HIT_RADIUS, MAX_HITS)}

${untrustedBlock('places', 'the hits', shown.map((hit) => `${hit.file}:${hit.line}`).join(', '))}

At most one finding for this pattern: one finding however many places fire, with every real place listed under "where". Show the levers that fit side by side as options, each with what it costs and needs. A lever that doesn't fit this product's providers isn't an option. Where the hit is a false alarm, say so in held_back. Set "lever" to the id of the first option. Leave floor_verdicts empty.${patternRules(pattern)}`;
    return { id: chunks.length > 1 ? `${pattern.id} (${index + 1} of ${chunks.length})` : pattern.id, kind: 'pattern' as const, prompt, urls };
    });
  });
}

/** Only for a job that reaches outside systems through MCP. */
const MCP_RULE = `

This job connects to outside systems through MCP. If the README keeps a list of integrations by vendor, teams read that list to see whether their own tools work, and each team runs the tools it runs: having one vendor on the list doesn't cover a team that uses another. So the vendor's own server for a well-known tool of the same kinds as that list, whose vendor is missing from it, is a fit: new capability, a config example and a README row, Hours each. Put up to three of the strongest in one finding, each as an option, and cite the README's list as "where", copying one row of the numbered list shown below. If three well-known vendors with their own servers are missing, list all three: a self-hosted edition of a product, a namespace ending in -oss, or a different way of running it is no reason to leave one out, or to hold it back. Name only the missing vendors, never the ones already on the list. Prefer vendors teams would recognise, and one they can run themselves if the product supports self-hosting. A little-known vendor, a third-party server, or a vendor already on the list is no fit. If there's no such list, and users just attach whatever server they like, adding one more is no fit.`;

const README_LIST = /^#{1,4}\s.*\b(?:integrations?|connectors?|supported tools|works with)\b/i;
const README_LIST_LINES = 60;

/** The README's list of integrations, numbered, so a row can be cited. The prefix holds the README without line numbers. */
function readmeList(files: ReadonlyMap<string, string>): string {
  const file = [...files.keys()].find((path) => /^readme(?:\.[a-z]+)?$/i.test(path));
  const lines = file ? files.get(file)?.split('\n') ?? [] : [];
  const at = lines.findIndex((line) => README_LIST.test(line));
  if (!file || at === -1) return '';
  return `\n\nThe README's list, numbered:\n${codeBlocks(files, [{ file, line: at + 1 + README_LIST_LINES / 2 }], README_LIST_LINES / 2, 1)}`;
}

const SIBLING_TABLE = /(?:require\(\s*|from\s+)["'`]\.\/((?:[\w-]*(?:constants|models|supported)[\w-]*))(?:\.[a-z]+)?["'`]/g;

/** A short table a shown file loads from right beside it, such as its supported-models list. */
function siblingTables(files: ReadonlyMap<string, string>, shown: readonly Place[]): Place[] {
  return shown.flatMap(({ file }) => [...(files.get(file) ?? '').matchAll(SIBLING_TABLE)].flatMap((match) => {
    const folder = file.split('/').slice(0, -1).join('/');
    const path = [`${folder}/${match[1]}.js`, `${folder}/${match[1]}.ts`, `${folder}/${match[1]}.json`].find((candidate) => (files.get(candidate)?.split('\n').length ?? Infinity) <= WHOLE_FILE_LINES);
    return path && !shown.some((place) => place.file === path) ? [{ file: path, line: 1 }] : [];
  }));
}

function jobCode(files: ReadonlyMap<string, string>, where: readonly Place[]): string {
  const short = where.filter((place) => (files.get(place.file)?.split('\n').length ?? Infinity) <= WHOLE_FILE_LINES);
  const long = where.filter((place) => !short.includes(place));
  const whole = codeBlocks(files, short.map((place) => ({ file: place.file, line: 1 })), WHOLE_FILE_LINES, MAX_JOB_FILES);
  const tables = siblingTables(files, where);
  const tableBlock = tables.length ? `\nA table those files load. Anything a model on it already offers is not a gain, so never name that in a title or as what's new:\n${codeBlocks(files, tables, WHOLE_FILE_LINES, MAX_JOB_FILES)}` : '';
  return [whole, tableBlock, codeBlocks(files, long, JOB_RADIUS, MAX_JOB_FILES)].filter(Boolean).join('\n');
}

function watchBlock(watch: readonly Candidate[]): string {
  if (watch.length === 0) return '';
  return `\n\nThese fit the job but can't run in this stack today, because of their language or model format, so they can only go in watching or held_back, never in findings:\n${untrustedBlock('records', 'the database', watch.map(recordText).join('\n'))}`;
}

function factsBlock(facts: readonly LibraryFact[]): string {
  if (facts.length === 0) return '';
  return `\n\nWhat the program knows about a library this job sits on. Anything that needs this library moved has to name where it moves to, cite those manifest lines under "where", and name the other code that moves with it. Moving it and re-embedding is "A day or more", not "A project", unless the code shows more. A number from the code has to be on a line you list under "where", so leave out any you don't cite. A local model whose card names concrete gains and whose weights that package can load is a finding, not watching:\n${untrustedBlock('library', 'the manifests and the registry', facts.map((fact) => fact.text).join('\n'))}`;
}

export function jobBundle(job: Job, candidates: readonly Candidate[], files: ReadonlyMap<string, string>, facts: readonly LibraryFact[] = []): Bundle | null {
  const fit = candidates.filter((candidate) => !candidate.watch_only);
  const watch = candidates.filter((candidate) => candidate.watch_only);
  if (candidates.length === 0) return null;
  const records = fit.map(recordText).join('\n');
  const mcpRule = /\bMCP\b/.test(`${job.job} ${job.how}`) ? `${MCP_RULE}${readmeList(files)}` : '';
  const relevant = facts.filter((fact) => job.where.some((place) => fact.users.includes(place.file)));
  const prompt = `${untrustedBlock('job', 'what an earlier step wrote about this job', `The job: ${job.job}. How it's done today: ${job.how}`)}

The code at this job's places:
${jobCode(files, job.where as readonly Place[])}

New things found for this job (${fit.length}, from a keyword search, so most won't fit):
${untrustedBlock('records', 'the database', records)}${watchBlock(watch)}${factsBlock(relevant)}

At most one or two findings for this job, only for the strongest real fits; findings may well be empty. Anything else that is a near miss goes in held_back or watching. "lever" is "". Leave floor_verdicts empty.${mcpRule}`;
  return {
    id: `Job: ${job.job}`,
    kind: 'job',
    prompt,
    urls: [
      ...candidates.flatMap((candidate) => recordUrls(candidate.record).map((url) => ({ url, text: recordText(candidate) }))),
      ...relevant.map((fact) => ({ url: fact.url, text: fact.text })),
    ],
  };
}
