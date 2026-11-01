// The answer keys, as data: for each published run, every finding it may hold and what each has to say. Written from reading
// data/briefs and the repos at their commits. A row here changes only by reading those again, never to match a run.
// keyViolations takes a run and says what's wrong with it, so a mutation test can prove each rule fires, with no clones.
import { allSources, dbInfo, loadRecords } from '../src/db.ts';
import { findModelIds } from '../src/model-ids.ts';
import type { ModelCheck } from '../src/exact-checks.ts';
import type { Finding, Run } from '../src/run-shape.ts';

export interface KeyFinding {
  readonly label: string;
  /** A place that identifies it, as file:line. */
  readonly at: string;
  readonly effect: readonly string[];
  readonly proof: string;
  /** What this finding has to say, wherever in it. */
  readonly says?: readonly RegExp[];
  /** What it must never say. */
  readonly never?: readonly RegExp[];
  /** Each option, as the name it must have and what it must say. */
  readonly options?: readonly (readonly [RegExp, RegExp])[];
}

export interface KeyRun {
  readonly findings: readonly KeyFinding[];
  readonly one_liner: RegExp;
  readonly stack_lock: RegExp;
  readonly watching?: readonly (readonly [RegExp, RegExp])[];
}

const KEEPS = ['keeps working'];
const VENDOR = 'vendor claim';

const ANYTHING_LLM: readonly KeyFinding[] = [
  { label: 'the Gemini default', at: 'server/models/systemSettings.js:919', effect: KEEPS, proof: VENDOR, says: [/gemini-2\.0-flash-lite was shut down on 1 Jun 2026\. Announced on 18 Feb 2026\. Named successor: gemini-3\.1-flash-lite\./, /gemini-3-pro-image-preview was shut down on 25 Jun 2026\.[^.]*\. Named successor: gemini-3-pro-image\./, /gemini-3\.1-flash-image-preview was shut down on 25 Jun 2026\.[^.]*\. Named successor: gemini-nano-banana-2\.1\./], options: [[/move to gemini-3\.6-flash/, /gemini-2\.0-flash/]] },
  { label: 'the router', at: 'server/utils/agents/aibitat/plugins/router-classifier.js:71', effect: ['cheaper', 'faster'], proof: VENDOR, says: [/fallback/], options: [[/^TypeSafe Jev$/, /TypeSafe says .*This is a vendor claim/], [/^OpenAI Decisions API$/, /OpenAI says/]] },
  { label: 'whisper-1', at: 'collector/utils/WhisperProviders/OpenAiWhisper.js:11', effect: KEEPS, proof: VENDOR, says: [/whisper-1 shuts down on 26 Feb 2027/, /Named successor: gpt-live-transcribe or gpt-transcribe/] },
  { label: 'tts-1', at: 'server/utils/TextToSpeech/openAi/index.js:15', effect: KEEPS, proof: VENDOR, says: [/tts-1 shuts down on 6 Jan 2027\. Named successor: gpt-realtime-2\.1-mini\./] },
  { label: 'EmbeddingGemma 2', at: 'server/utils/EmbeddingEngines/native/index.js:8', effect: ['better answers'], proof: VENDOR, says: [/@huggingface\/transformers 4\.3\.1 or later/, /re-embed/i] },
  { label: 'Agent Skills', at: 'server/utils/agents/imported.js:8', effect: ['new capability'], proof: 'adoption only', says: [/SKILL\.md/, /nobody has measured/i] },
  {
    label: 'the later Google models', at: 'server/utils/ImageGenerators/gemini/index.js:4', effect: KEEPS, proof: VENDOR,
    says: [/gemini-3\.1-flash-image is deprecated, with no shutdown date in the changelog\. Announced on 6 Oct 2026\. Named successor: gemini-nano-banana-2\.1\./, /gemini-2\.5-flash-image shuts down no earlier than 15 Mar 2027\. Named successor: gemini-3\.1-flash-lite-image\./, /gemini-3\.1-flash-lite shuts down no earlier than 7 May 2027\. Named successor: gemini-3\.5-flash-lite\./],
    never: [/gemini-3\.1-flash-image\b[^.]*\bto (?:the named successors \()?gemini-3\.1-flash-lite-image/, /Named by Google as the replacement\./],
    options: [[/^gemini-nano-banana-2\.1$/, /replacement for gemini-3\.1-flash-image\.$/], [/^gemini-3\.1-flash-lite-image$/, /replacement for gemini-2\.5-flash-image\.$/], [/^gemini-3\.5-flash-lite$/, /replacement for gemini-3\.1-flash-lite\.$/]],
  },
];
const ALLM_LOCK = /Node|JavaScript|ONNX|transformers\.js/;
const ALLM_LINE = /chat with their own documents/;
const ALLM_WATCH: readonly (readonly [RegExp, RegExp])[] = [[/^laya\b/, /Python-only/], [/^datalab-to\/indra-ocr$/, /Python package and its license limits commercial use/], [/^OXR$/, /Python/]];

export const KEY: Readonly<Record<string, KeyRun>> = {
  'anything-llm': { findings: ANYTHING_LLM, one_liner: ALLM_LINE, stack_lock: ALLM_LOCK, watching: ALLM_WATCH },
  'anything-llm-claude-only': {
    findings: ANYTHING_LLM.map((finding) => (finding.label === 'the router' ? { ...finding, options: finding.options?.slice(0, 1) } : finding)),
    one_liner: ALLM_LINE, stack_lock: ALLM_LOCK, watching: ALLM_WATCH,
  },
  aura: {
    one_liner: /investigate production incidents/,
    stack_lock: /Rust/,
    findings: [
      { label: 'the Gemini example', at: 'examples/minimal/gemini.toml:14', effect: KEEPS, proof: VENDOR, says: [/gemini-2\.0-flash was shut down on 1 Jun 2026\. Announced on 18 Feb 2026\. Named successor: gemini-3\.6-flash\./], options: [[/move to gemini-3\.6-flash$/, /gemini-2\.0-flash/]] },
      { label: 'the Claude examples', at: 'examples/minimal/anthropic.toml:14', effect: KEEPS, proof: VENDOR, says: [/claude-sonnet-4-20250514 was shut down on 15 Jun 2026\.[^.]*\. Named successor: claude-sonnet-5-5\./, /claude-sonnet-4-5-20250929 shuts down on 30 Nov 2026\.[^.]*\. Named successor: claude-sonnet-5-5\./, /tool_choice isn't anywhere in this repo's code/, /OpenRouter's model list no longer has it/] },
      { label: 'Claude prompt caching', at: 'examples/reference.toml:234', effect: ['cheaper', 'faster'], proof: VENDOR, says: [/prompt_caching|prompt caching/i] },
      { label: 'vendor MCP servers', at: 'README.md:', effect: ['new capability'], proof: 'adoption only', options: [[/^Sentry$/, /./], [/^SigNoz$/, /./], [/^Dynatrace Managed$/, /./]], never: [/\bofficial\b/i] },
      { label: 'gpt-4o', at: 'examples/multi-agent/writer.toml:', effect: KEEPS, proof: VENDOR, says: [/gpt-4o shuts down on 14 Jan 2027\. Named successor: gpt-6-luna\./, /gpt-4o-mini shuts down on 14 Jan 2027\. Named successor: gpt-6-luna\./], options: [[/move to gpt-6-luna$/, /gpt-6-luna/]] },
      { label: 'rmcp', at: 'Cargo.toml:49', effect: KEEPS, proof: VENDOR, says: [/Cargo\.toml:49 declares 0\.12\.0, released 18 Dec 2025\. The latest is 3\.8\.0, released 26 Oct 2026\./, /Not a gain here, as written: cancel an abandoned/] },
    ],
  },
  'bolt.new': {
    one_liner: /describe an app in chat/,
    stack_lock: /Node|TypeScript|JavaScript/,
    findings: [{ label: 'the one model', at: 'app/lib/.server/llm/model.ts:8', effect: KEEPS, proof: VENDOR, says: [/claude-3-5-sonnet-20240620 was shut down on 28 Oct 2025\.[^.]*\. Named successor: claude-sonnet-5-5\./, /toolChoice is at app\/routes\/api\.chat\.ts:18 \(toolChoice: 'none'\)/], never: [/tool_choice isn't anywhere/] }, { label: 'no tracing', at: 'app/lib/.server/llm/stream-text.ts:25', effect: ['better answers'], proof: 'adoption only', says: [/nothing[^.]*records what a call cost/] }, { label: 'no test set', at: 'app/lib/.server/llm/stream-text.ts:27', effect: ['better answers'], proof: 'adoption only', says: [/first test set|no test set|nothing[^.]*tests/i] }],
  },
  farfalle: {
    one_liner: /answer engine/,
    stack_lock: /Python/,
    findings: [{ label: 'gpt-4o', at: 'src/backend/constants.py:', effect: KEEPS, proof: VENDOR, says: [/gpt-4o shuts down on 14 Jan 2027\. Named successor: gpt-6-luna\./, /gpt-4o-mini shuts down on 14 Jan 2027\. Named successor: gpt-6-luna\./] }, { label: 'no test set', at: 'src/backend/llm/base.py:56', effect: ['better answers'], proof: 'adoption only', says: [/first test set|no test set|nothing[^.]*tests/i] }],
  },
};

function keyFindingOf(key: KeyFinding, run: Run): Finding | undefined {
  return run.findings.find((finding) => finding.where.some((place) => `${place.file}:${place.line}`.startsWith(key.at)));
}

function findingText(finding: Finding): string {
  return [finding.title, finding.why, ...finding.options.flatMap((option) => [option.name, option.what, option.needs])].join('\n');
}

function modelChecks(run: Run): ModelCheck[] {
  return run.exact.filter((item): item is ModelCheck => item.kind === 'model');
}

function findingProblems(key: KeyFinding, finding: Finding): string[] {
  const text = findingText(finding);
  const problems: string[] = [];
  if ([...finding.effect].sort().join() !== [...key.effect].sort().join()) problems.push(`${key.label}: effect is ${finding.effect.join(', ')}, and the key says ${key.effect.join(', ')}`);
  if (finding.proof !== key.proof) problems.push(`${key.label}: proof is ${finding.proof}, and the key says ${key.proof}`);
  for (const re of key.says ?? []) if (!re.test(text)) problems.push(`${key.label}: should say ${re}`);
  for (const re of key.never ?? []) if (re.test(text)) problems.push(`${key.label}: must never say ${re}`);
  if (key.options) {
    if (finding.options.length !== key.options.length) problems.push(`${key.label}: ${finding.options.length} options, and the key says ${key.options.length}`);
    for (const [name, what] of key.options) {
      const option = finding.options.find((item) => name.test(item.name));
      if (!option) problems.push(`${key.label}: no option ${name}`);
      else if (!what.test(`${option.name} ${option.what}`)) problems.push(`${key.label}: option ${option.name} should say ${what}`);
    }
  }
  return problems;
}

/** Each "<model> ... Named successor: X" has to be what the program read for that model, and for no other. */
function successorProblems(finding: Finding, run: Run): string[] {
  const named = [...finding.why.matchAll(/(?:^|\. )([\w.-]+) (?:was shut down|was due to shut down|shuts down|is deprecated)[^]*?Named successor: ([^]+?)\.(?: |$)/g)];
  return named.flatMap((match) => {
    const check = modelChecks(run).find((item) => item.model === match[1]);
    if (!check) return [];
    const said = match[2].split(' or ');
    const wrong = said.filter((name) => !check.successors.includes(name));
    return wrong.length ? [`${finding.title}: ${match[1]} is given ${wrong.join(', ')}, and its check says ${check.successors.join(', ') || 'none'}`] : [];
  });
}

/** An option named after a model has to be a successor of a model this finding is about, and say which. */
function optionSuccessorProblems(finding: Finding, run: Run): string[] {
  return finding.options.flatMap((option) => {
    const ids = findModelIds(option.name).map((mention) => mention.id);
    if (ids.length !== 1 || ids[0] !== option.name || finding.lever) return [];
    const models = modelChecks(run).filter((check) => check.successors.includes(option.name) && check.live_places.some((place) => finding.where.some((where) => where.file === place.file && where.line === place.line)));
    if (models.length === 0) return [`${finding.title}: option ${option.name} replaces no model on this finding`];
    return models.every((check) => option.what.includes(check.model)) ? [] : [`${finding.title}: option ${option.name} doesn't say which model it replaces`];
  });
}

function knownPlaces(run: Run): Set<string> {
  const models = modelChecks(run).flatMap((check) => [...check.live_places, ...check.not_live]);
  const dependencies = run.exact.flatMap((item) => (item.kind === 'dependency' ? item.places : []));
  const samples = Object.values(run.facts.signals).flatMap((signal) => signal.samples);
  return new Set([...models, ...dependencies, ...samples, ...run.pattern_hits, ...run.facts.ai_call_sites, ...run.findings.flatMap((finding) => finding.where)].map((place) => `${place.file}:${place.line}`));
}

const ROW_PLACE = /\b(?:in|at) ([\w./@()\[\]-]+\.[\w-]+):(\d+)\b/g;

/** A row's file and line has to be one the run really saw. Opening it at the commit needs a clone: see rowPlaces. */
export function rowPlaces(run: Run): { file: string; line: number; thing: string }[] {
  return run.held_back.flatMap((row) => [...row.thing.matchAll(ROW_PLACE)].map((match) => ({ file: match[1], line: Number(match[2]), thing: row.thing })));
}

function rowProblems(run: Run): string[] {
  const known = knownPlaces(run);
  return rowPlaces(run).filter((place) => !known.has(`${place.file}:${place.line}`)).map((place) => `a held-back row cites ${place.file}:${place.line}, which this run never saw`);
}

function databaseProblems(run: Run): string[] {
  const db = dbInfo();
  if (run.db.records !== db.records) return [`db.records is ${run.db.records}, and the database holds ${db.records}`];
  if (JSON.stringify(run.db.by_source) !== JSON.stringify(db.by_source)) return ['db.by_source is not what the database holds'];
  return run.db.records === loadRecords(allSources()).length ? [] : ['the database no longer counts up'];
}

function profileProblems(run: Run, key: KeyRun): string[] {
  if (!run.profile) return ['no profile'];
  return [
    ...(key.one_liner.test(run.profile.one_liner) ? [] : [`the profile should say ${key.one_liner}`]),
    ...(run.profile.stack_lock.some((rule) => key.stack_lock.test(rule)) ? [] : [`the stack lock should say ${key.stack_lock}`]),
    ...(run.profile.jobs.length >= 3 ? [] : ['the profile has fewer than 3 jobs']),
  ];
}

function watchingProblems(run: Run, key: KeyRun): string[] {
  return (key.watching ?? []).flatMap(([thing, why]) => {
    const row = run.watching.find((item) => thing.test(item.thing));
    if (!row) return [`no watching row ${thing}`];
    return why.test(row.why) ? [] : [`watching ${row.thing} should say ${why}`];
  });
}

/** Everything wrong with this run against its key. Empty is a pass. */
export function keyViolations(name: string, run: Run): string[] {
  const key = KEY[name];
  if (!key) return [`no key for ${name}`];
  const located = key.findings.map((item) => ({ item, finding: keyFindingOf(item, run) }));
  const missing = located.filter(({ finding }) => !finding).map(({ item }) => `${item.label} is missing`);
  const found = located.flatMap(({ item, finding }) => (finding ? [{ item, finding }] : []));
  const expected = new Set(found.map(({ finding }) => finding));
  const extra = run.findings.filter((finding) => !expected.has(finding)).map((finding) => `a finding the key doesn't hold: ${finding.title}`);
  return [
    ...missing,
    ...extra,
    ...(run.findings.length === key.findings.length ? [] : [`${run.findings.length} findings, and the key holds ${key.findings.length}`]),
    ...found.flatMap(({ item, finding }) => findingProblems(item, finding)),
    ...run.findings.flatMap((finding) => [...successorProblems(finding, run), ...optionSuccessorProblems(finding, run)]),
    ...rowProblems(run),
    ...databaseProblems(run),
    ...profileProblems(run, key),
    ...watchingProblems(run, key),
  ];
}
