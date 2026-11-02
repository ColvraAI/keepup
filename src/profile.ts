// Step 2: "What we understood". Claude reads the README, manifests and bounded excerpts of code, which can be a whole
// short file but never a secret, and every claim it makes must cite a file and line that really say so. Its prose
// goes through the same checks as a finding, and later prompts fence it as untrusted, because a repo can steer it.
import { type Provenance, proseProblem, quoteProblem } from './check.ts';
import { pathContext } from './code-context.ts';
import type { Llm } from './llm.ts';
import type { PipelineContext } from './pipeline.ts';
import { codeWindows, offeredPaths, repoPrefix, UNTRUSTED_RULE, untrustedBlock } from './repo-text.ts';
import type { Dropped, Job, Profile } from './run-shape.ts';

const MAX_FILES_TO_READ = 14;
const HEAD_LINES = 45;
const NEAR_LINES = 6;
const MAX_SAMPLES_PER_FILE = 3;
const PICK_TOKENS = 3000;
const PROFILE_TOKENS = 6000;
const CITED_RADIUS = 40;
/** A profile cites code, it doesn't cite the web: no link in its prose is ever fine. */
const NO_LINKS: Provenance = { allowed: new Set(), textFor: () => '' };

const SYSTEM = `You are the part of keepup that reads a product's code and says what it does with AI, so that later steps can check it against what's new in AI.

${UNTRUSTED_RULE}

Plain words, written for a founder. No marketing. Only say what the text you were given shows.`;

const PICK_SCHEMA = {
  type: 'object',
  properties: { files_to_read: { type: 'array', items: { type: 'string' } } },
  required: ['files_to_read'],
  additionalProperties: false,
} as const;

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    one_liner: { type: 'string' },
    stack: { type: 'array', items: { type: 'string' } },
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          job: { type: 'string' },
          how: { type: 'string' },
          where: {
            type: 'array',
            items: {
              type: 'object',
              properties: { file: { type: 'string' }, line: { type: 'integer' }, quote: { type: 'string' } },
              required: ['file', 'line', 'quote'],
              additionalProperties: false,
            },
          },
          search_terms: { type: 'array', items: { type: 'string' } },
        },
        required: ['job', 'how', 'where', 'search_terms'],
        additionalProperties: false,
      },
    },
    stack_lock: { type: 'array', items: { type: 'string' } },
  },
  required: ['one_liner', 'stack', 'jobs', 'stack_lock'],
  additionalProperties: false,
} as const;

const PICK_PROMPT = `Which files show how this product really does its AI work? Think of the jobs: answering, retrieving, embedding, routing, agents and tools, skills or plugins, speech, parsing documents, picking and calling models.

Name up to ${MAX_FILES_TO_READ} paths, from the lists above, most useful first. Prefer real code over tests, examples and docs. Include the place that sets the default for each local model or engine (embedder, reranker, speech, OCR), and the place that loads tools or skills. Backend code over UI components. You'll see the start of each file.`;

const PROFILE_PROMPT = `Write "What we understood".

- one_liner: what the product is and who it's for, in one or two plain sentences.
- stack: languages and the main AI libraries, a few words each.
- jobs: 3 to 8 AI jobs this product does. Keep apart the parts that could be replaced on their own, such as embedding, reranking, OCR, speech, routing, and loading skills or plugins. Cite real code wherever you were shown it, not the README. For each:
  - job: the job in a few plain words, such as "Answer questions from documents".
  - how: how it's done today, naming the libraries and models the code shows.
  - where: 1 to 4 places that show it. "file" is a path you were shown. "line" is the number at the start of that line in a numbered excerpt. "quote" is text copied exactly from that one line, without the number. Cite only lines you can see. A README line counts when the README is what shows it; its lines are the numbered ones in the "README lines" block.
  - search_terms: 5 to 10 lowercase keywords for finding new tools that do this job in a database of packages, models and MCP servers. Search matches whole words in short descriptions, so use the plain words such a tool's own one-line description would use, one or two words each, like "embedding", "ocr", "reranker", "text to speech", "agent skills". Name what the tool does, not what it is: never "mcp server", "ai", "tool", "agent", "llm", "api", and no brand names of what's already used. If the product connects to outside systems through MCP or plugins, name the kinds of system its users would connect next, in the words those vendors use for what they hold: for an ops product "metrics", "traces", "logs", "alerts", "error monitoring", "issue tracking"; for a sales product "crm", "contacts", "invoices".
- stack_lock: short lines saying what kinds of new thing this product could actually adopt, given its language and how it runs local models. For example, a Rust product can't import a Python library, so only MCP servers, HTTP APIs, Rust crates, models and skills; a Node app's local models need ONNX or transformers.js weights.`;

interface RawPlace {
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

interface RawJob {
  readonly job: string;
  readonly how: string;
  readonly where: readonly RawPlace[];
  readonly search_terms: readonly string[];
}

export interface RawProfile {
  readonly one_liner: string;
  readonly stack: readonly string[];
  readonly jobs: readonly RawJob[];
  readonly stack_lock: readonly string[];
}

const WANTED = 'A profile is one_liner, stack, jobs and stack_lock. Each job is job, how, where and search_terms. Each place in where is file, line and quote.';
const isText = (value: unknown): value is string => typeof value === 'string';
const isTextList = (value: unknown): boolean => Array.isArray(value) && value.every(isText);

function placeFits(raw: unknown): boolean {
  const { file, line, quote } = (raw ?? {}) as Record<string, unknown>;
  return isText(file) && Number.isInteger(line) && isText(quote);
}

function jobFits(raw: unknown): boolean {
  const { job, how, where, search_terms: terms } = (raw ?? {}) as Record<string, unknown>;
  return isText(job) && isText(how) && Array.isArray(where) && where.every(placeFits) && isTextList(terms);
}

/** What a model hands over is checked at the door, and the message says what shape was wanted. An apostrophe travels as &apos;, as it does for verify. */
export function parseProfile(text: string): RawProfile {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.replaceAll('&apos;', "'")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Can't read the profile: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw?.jobs)) throw new Error(`"jobs" has to be a list. ${WANTED}`);
  const badJob = raw.jobs.findIndex((job) => !jobFits(job));
  if (badJob !== -1) throw new Error(`"jobs" item ${badJob + 1} isn't the right shape. ${WANTED}`);
  if (!isText(raw.one_liner) || !isTextList(raw.stack) || !isTextList(raw.stack_lock)) throw new Error(`"one_liner", "stack" and "stack_lock" are missing or the wrong shape. ${WANTED}`);
  return raw as unknown as RawProfile;
}

function usefulSamples(context: PipelineContext, file: string): number[] {
  const lines = context.facts.ai_call_sites.filter((site) => site.file === file).map((site) => site.line);
  const fromSignals = Object.values(context.facts.signals).flatMap((signal) => signal.samples.filter((sample) => sample.file === file).map((sample) => sample.line));
  return [...new Set([...lines, ...fromSignals])].slice(0, MAX_SAMPLES_PER_FILE);
}

/** The start of a file and a few lines around each hit in it: bounded, though a short file fits whole. */
export function fileExcerpt(context: PipelineContext, file: string): string {
  const text = context.files.get(file);
  if (text === undefined) return '';
  const head = text.split('\n').slice(0, HEAD_LINES).map((line, index) => `${index + 1}| ${line.slice(0, 300)}`).join('\n');
  const samples = usefulSamples(context, file).filter((line) => line > HEAD_LINES + NEAR_LINES);
  const rest = samples.length ? `\n...\n${codeWindows(text, samples, NEAR_LINES)}` : '';
  return untrustedBlock('code', file, `${head}${rest}`);
}

function readmeLines(context: PipelineContext): string {
  const readme = context.facts.readme;
  const text = readme ? context.files.get(readme.file) : undefined;
  if (!readme || text === undefined) return '';
  const lines = text.split('\n').slice(0, 200).map((line, index) => `${index + 1}| ${line.slice(0, 200)}`).join('\n');
  return untrustedBlock('readme-lines', `README lines: ${readme.file}`, lines);
}

function callSiteExcerpts(context: PipelineContext, picked: readonly string[]): string {
  const sites = context.facts.ai_call_sites.filter((site) => pathContext(site.file) === 'code' && !picked.includes(site.file));
  const files = [...new Set(sites.map((site) => site.file))].slice(0, 6);
  return files.map((file) => {
    const lines = sites.filter((site) => site.file === file).map((site) => site.line).slice(0, 2);
    return untrustedBlock('code', file, codeWindows(context.files.get(file) ?? '', lines, NEAR_LINES));
  }).join('\n');
}

function citedCode(raw: RawProfile, files: ReadonlyMap<string, string>): string {
  const lines = raw.jobs.flatMap((job) => job.where.map(({ file, line }) => ({ file, line })));
  return lines.map(({ file, line }) => codeWindows(files.get(file) ?? '', [line], CITED_RADIUS)).join('\n');
}

/** Whatever a profile sentence may be read from: the README, the manifests, and the code around what it cites. */
function profileCorpus(raw: RawProfile, context: VerifyContext): string {
  const text = [context.readme ?? '', context.manifests ?? '', citedCode(raw, context.files)].join('\n');
  // claude-3-5-sonnet in the code is "Claude 3.5" in a sentence.
  const versions = [...text.matchAll(/\b[a-z]+-(\d+)-(\d+)\b/g)].map((match) => `${match[1]}.${match[2]}`);
  return `${text}\n${[...new Set(versions)].join(' ')}`;
}

export interface VerifyContext {
  readonly files: ReadonlyMap<string, string>;
  readonly readme?: string;
  readonly manifests?: string;
}

/** A manifest was shown to the model as name@spec, so a citation can quote that for the line that declares it. */
function quoteHolds(quote: string, line: string): boolean {
  const declared = quote.match(/^(@?[^@\s]+)@(.+)$/);
  if (declared && line.includes(declared[1]) && line.includes(declared[2])) return true;
  return quote !== '' && line.includes(quote) && !quoteProblem(quote, line);
}

function keptJob(job: RawJob, context: VerifyContext, corpus: string, dropped: Dropped[]): Job[] {
  const where = job.where.filter((place) => {
    const line = context.files.get(place.file)?.split('\n')[place.line - 1];
    const ok = line !== undefined && quoteHolds(place.quote.trim(), line);
    if (!ok) dropped.push({ what: `A citation for "${job.job}"`, why: `${place.file}:${place.line} doesn't say that` });
    return ok;
  });
  if (where.length === 0) {
    dropped.push({ what: `The job "${job.job}"`, why: 'none of its citations checked out' });
    return [];
  }
  const problem = proseProblem(`${job.job}\n${job.how}`, corpus, NO_LINKS);
  if (problem) {
    dropped.push({ what: `The job "${job.job}"`, why: problem, where: `${where[0].file}:${where[0].line}` });
    return [];
  }
  return [{ job: job.job, how: job.how, where: where.map(({ file, line }) => ({ file, line })), search_terms: job.search_terms, cited: where.map(({ file, line, quote }) => ({ file, line, text: quote.trim() })) }];
}

function keptLines(what: string, lines: readonly string[], corpus: string, dropped: Dropped[]): string[] {
  return lines.filter((line) => {
    const problem = proseProblem(line, corpus, NO_LINKS);
    if (problem) dropped.push({ what, why: problem });
    return !problem;
  });
}

/** A claim stays only if the file and line exist and the quote is really on that line, and its prose reads from what it was shown. */
export function verifyProfile(raw: RawProfile, input: ReadonlyMap<string, string> | VerifyContext): { profile: Profile; dropped: Dropped[] } {
  const context: VerifyContext = input instanceof Map ? { files: input } : input as VerifyContext;
  const corpus = profileCorpus(raw, context);
  const dropped: Dropped[] = [];
  const jobs = raw.jobs.flatMap((job) => keptJob(job, context, corpus, dropped));
  const [oneLiner = ''] = keptLines('The one-line summary', [raw.one_liner], corpus, dropped);
  return { profile: { one_liner: oneLiner, stack: keptLines('A line about the stack', raw.stack, corpus, dropped), jobs, stack_lock: keptLines('A line of the stack lock', raw.stack_lock, corpus, dropped) }, dropped };
}

/** The text a profile's sentences may be read from, as the checks read it. */
export function verifyContextOf(context: Pick<PipelineContext, 'facts' | 'files'>): VerifyContext {
  const readme = context.facts.readme ? context.files.get(context.facts.readme.file) : '';
  const manifests = context.facts.manifests.flatMap((manifest) => manifest.dependencies.map((dep) => `${dep.name} ${dep.spec} ${dep.spec.match(/\d+\.\d+/)?.[0] ?? ''}`)).join('\n');
  return { files: context.files, readme, manifests };
}

export async function understandProduct(llm: Pick<Llm, 'ask'>, context: PipelineContext): Promise<{ profile: Profile; dropped: Dropped[] }> {
  const prefix = repoPrefix(context);
  const pick = await llm.ask<{ files_to_read: string[] }>({ purpose: 'Pick the files to read', system: SYSTEM, prefix, prompt: PICK_PROMPT, schema: PICK_SCHEMA, maxTokens: PICK_TOKENS, effort: 'low' });
  const offered = offeredPaths(context);
  const picked = pick.files_to_read.filter((file) => context.files.has(file) && offered.has(file)).slice(0, MAX_FILES_TO_READ);
  const excerpts = picked.map((file) => fileExcerpt(context, file)).join('\n');
  const prompt = [readmeLines(context), excerpts, callSiteExcerpts(context, picked), PROFILE_PROMPT].filter(Boolean).join('\n\n');
  const raw = await llm.ask<RawProfile>({ purpose: 'What we understood', system: SYSTEM, prefix, prompt, schema: PROFILE_SCHEMA, maxTokens: PROFILE_TOKENS, effort: 'medium' });
  return verifyProfile(raw, verifyContextOf(context));
}
