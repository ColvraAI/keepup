// Renders a run to text in the shape of data/briefs/. Pure: same run, same text. renderSummary is what a founder
// reads, one screen; renderBrief is the whole thing. Repo and model text can't break out of either.
import { humanDate } from './dates.ts';
import type { CheckSummary, Coverage, Dropped, Finding, HeldBack, LeverValue, Measurement, Move, Profile, Recommendation, RoiOption, Watching } from './run-shape.ts';
import { PAYBACK_MONTHS } from './roi.ts';
import { AFTER_UPGRADE } from './sdk-notes.ts';
import { codeSpan, oneLine, plainText } from './text-safety.ts';

export function quietLine(checked: number): string {
  return `keepup: nothing new applies · ${checked.toLocaleString('en-US')} checked`;
}

/** What a session really ran. Only keepup's bundles carry candidates, so a saved run or an older session keeps its searches. */
export interface SessionCoverage {
  readonly searches: number;
  readonly reads: number;
  readonly candidates?: number;
  readonly jobs?: number;
}

const howMany = (value: number, word: string): string => `${value.toLocaleString('en-US')} ${word}${value === 1 ? '' : 's'}`;

function ranWords(coverage: SessionCoverage): string[] {
  const looked = coverage.candidates === undefined ? `${coverage.searches} searches` : `${howMany(coverage.candidates, 'candidate')} shown for ${howMany(coverage.jobs ?? 0, 'job')}`;
  return [looked, `${coverage.reads} read closely`];
}

/** When Claude Code judged, what's true is what really ran, not all of the database. */
export function coveredLine(records: number, coverage: SessionCoverage, unchecked: readonly string[] = []): string {
  return [`keepup: nothing new applies · ${records.toLocaleString('en-US')} in the database`, ...ranWords(coverage), ...unchecked].join(' · ');
}

export interface DependencyCounts {
  readonly checked: number;
  readonly unchecked: number;
  readonly behind: number;
  readonly online: boolean;
}

/** Only what a registry or the database answered counts as checked, and "far behind" is said only of those. */
export function exactOnlyLine(modelIds: number, deps: DependencyCounts): string {
  const models = `${modelIds.toLocaleString('en-US')} model ids`;
  const notChecked = deps.unchecked ? `${deps.unchecked.toLocaleString('en-US')} dependencies not checked (${deps.online ? 'no registry answer' : 'offline'})` : '';
  const checked = deps.checked || !deps.unchecked ? `${deps.checked.toLocaleString('en-US')} dependencies` : '';
  const counted = deps.unchecked ? [models, ...(deps.checked ? [`${deps.checked.toLocaleString('en-US')} dependencies checked`] : []), notChecked].join(' · ') : `${models}, ${checked}`;
  const outcome = deps.behind ? `nothing retired, and ${deps.behind} behind with no named gain` : deps.checked && !deps.unchecked ? 'nothing retired or far behind' : 'nothing retired';
  return `keepup: exact checks only · ${counted} · ${outcome}`;
}

/** Only the fields a brief reads, so a test or an older run file can render too. */
export interface BriefInput {
  readonly repo: string;
  readonly commit: string | null;
  readonly base_commit?: string;
  readonly commit_date?: string | null;
  readonly db: {
    readonly fetched: string;
    readonly records: number;
    readonly by_source: Readonly<Record<string, number>>;
    readonly window: { readonly since: string; readonly until: string };
  };
  readonly ran?: Coverage;
  readonly usage?: unknown;
  readonly facts?: { readonly model_ids?: readonly unknown[]; readonly ai_call_sites?: readonly unknown[]; readonly checked?: { readonly files: number } };
  readonly exact?: readonly { readonly kind: string; readonly status?: string }[];
  /** When Claude Code judged: what the session log saw. Its quiet line says this and no more. */
  readonly coverage?: SessionCoverage;
  /** Ids on a model list that the finder didn't recognise, so nothing was checked about them. */
  readonly unrecognised?: { readonly count: number; readonly files: readonly string[] } | null;
  readonly moves?: readonly Move[];
  readonly profile: Profile | null;
  readonly findings: readonly Finding[];
  readonly watching: readonly Watching[];
  readonly held_back: readonly HeldBack[];
  readonly checks: CheckSummary;
  readonly rank_explanation?: string;
  readonly incomplete?: { readonly reason: string; readonly skipped: readonly string[] };
  readonly recommendations?: readonly Recommendation[];
  readonly measurements?: readonly Measurement[];
}

const money = (value: number) => (Math.abs(value) < 1 ? `$${value.toFixed(2)}` : `$${Math.round(value).toLocaleString('en-US')}`);

function isRetirement(finding: Finding): boolean {
  return Boolean(finding.reach);
}

/** It has a number, and the number says it doesn't pay back at the assumed volume. A worked example can't rank, but it can still say this. */
function losesMoney(finding: Finding): boolean {
  const value = finding.value;
  if (value?.status === 'priced' && typeof value.value_usd === 'number' && value.value_usd <= 0) return true;
  const options = value?.status === 'worked' && value.roi?.money ? value.roi.options.filter((option) => option.line) : [];
  return options.length > 0 && options.every((option) => option.payback_months == null || option.payback_months > PAYBACK_MONTHS);
}

function latestMeasure(finding: Finding, run: BriefInput): Measurement | undefined {
  return (run.measurements ?? []).filter((item) => item.finding_rank === finding.rank && item.rows.some((row) => row.status === 'measured')).at(-1);
}

/** What a lever does, in money or speed. Each number carries its label; with neither, this says nothing. */
export function effectLine(finding: Finding, run: BriefInput): string {
  const value = finding.value;
  const measured = latestMeasure(finding, run)?.rows.filter((row) => row.headline).map((row) => `${row.headline} [measured, n=${row.n}]`) ?? [];
  const speed = value?.speed ? [`${value.speed.text} [${value.speed.label}]`] : [];
  const calls = value?.inputs.calls_per_month.value;
  const pays = value?.status === 'priced' && losesMoney(finding) && value.break_even_calls_per_month ? [`pays back above about ${value.break_even_calls_per_month.toLocaleString('en-US')} calls a month [projected]; ${Number(calls).toLocaleString('en-US')} calls a month, assumed, doesn't clear its cost`] : [];
  const cheaper = value?.status === 'priced' && !losesMoney(finding) && (value.monthly_gain_usd as number) > 0 ? [`about ${money(value.monthly_gain_usd as number)} a month cheaper [projected, at ${Number(calls).toLocaleString('en-US')} calls a month, assumed]`] : [];
  return [...pays, ...measured, ...speed, ...cheaper].join(' · ');
}

/** One line per option, named, with its price, source and date. */
function roiOptionText(option: RoiOption): string {
  return `${option.name} (${option.price_text}; ${option.source}${option.checked ? `, checked ${option.checked}` : ''})${option.line ? `: ${option.line}` : ''}`;
}

/** The founder's question: what it saves, what it costs, when it pays back. Or that there's no money figure. */
function roiLines(value: LeverValue | undefined): string[] {
  const roi = value?.roi;
  if (!roi) return [];
  if (!roi.money) return wrapped(`   ${roi.statement}`);
  return [
    ...roi.options.flatMap((option) => wrapped(`   ${roiOptionText(option)}`)),
    ...wrapped(`   ${roi.assumed}`),
    ...wrapped(`   ${roi.formula}.${roi.what_to_enter ? ` ${roi.what_to_enter}` : ''}`),
  ];
}

export function roiSection(value: LeverValue | undefined): string[] {
  const roi = value?.roi;
  if (!roi) return [];
  if (!roi.money) return [`**ROI.** ${plainText(roi.statement ?? '')}`, ''];
  return ['**ROI:**', ...roi.options.map((option) => `- ${roiOptionText(option)}`), '', `${roi.assumed}`, '', `${roi.formula}.${roi.what_to_enter ? ` ${roi.what_to_enter}` : ''}`, ''];
}

function formulaLines(value: LeverValue | undefined): string[] {
  if (!value) return [];
  if (value.roi) return value.status === 'priced' ? wrapped(`   Value: ${value.formula}`) : [];
  if (value.status !== 'priced') return wrapped(`   No money number: ${value.reason}`);
  const inputs = [value.inputs.input_tokens && `${value.inputs.input_tokens.value} input tokens (${value.inputs.input_tokens.label})`, value.inputs.model && `${value.inputs.model.value} (${value.inputs.model.label})`].filter(Boolean).join('; ');
  const paysBack = value.break_even_calls_per_month ? `Pays back above about ${value.break_even_calls_per_month.toLocaleString('en-US')} calls a month.` : '';
  return [...wrapped(`   Value: ${value.formula}`), ...wrapped(`   Inputs: ${inputs}. ${paysBack}`)];
}

function retirementLine(run: BriefInput, retired: readonly Finding[]): string {
  const models = (run.exact ?? []).filter((item) => item.kind === 'model' && ((item as unknown as { live_places?: unknown[] }).live_places?.length ?? 0) > 0);
  const gone = models.filter((item) => item.status === 'retired').length;
  const going = models.length - gone;
  const counted = [gone ? `${gone} model${gone === 1 ? '' : 's'} here ${gone === 1 ? 'has' : 'have'} shut down` : '', going ? `${going} ${gone ? 'more' : `model${going === 1 ? '' : 's'} here`} ${going === 1 ? 'is' : 'are'} retiring` : ''].filter(Boolean).join(' and ');
  const place = retired[0]?.where[0];
  return `Also: ${counted || `${retired.length} retired or retiring model finding${retired.length === 1 ? '' : 's'}`}${place ? ` · ${fileName(place.file)}:${place.line}` : ''} · ${OFFER}`;
}

const NOTHING_BIG = 'Nothing big fits this week.';
const NOTHING_CLEARS = 'Nothing clears its cost at the assumed volume.';
const TEAM_FULL = 3;
const TEAM_COMPACT = 2;

function teamLines(run: BriefInput, compact: boolean): string[] {
  const rows = run.recommendations ?? [];
  if (rows.length === 0) return [];
  const shown = rows.slice(0, compact ? TEAM_COMPACT : TEAM_FULL);
  const more = rows.length - shown.length;
  return ['', 'For your team (never a pull request):', ...shown.flatMap((row) => [...(compact ? [] : [fit(`  ${row.name}: ${row.why}`)]), ...wrapped(`  ${compact ? `${row.name}: ` : ''}${row.install}`, '    ')]), ...(more > 0 ? [`  And ${more} more, in the run file.`] : [])];
}

function teamSection(run: BriefInput): string[] {
  const rows = run.recommendations ?? [];
  if (rows.length === 0) return [];
  return ['## For your team', '', 'For your developers\' own tools. Never a pull request.', '', ...rows.flatMap((row) => [`- **${plainText(row.name)}.** ${plainText(row.why)} ${codeSpan(row.install)} Source: ${oneLine(row.source)}`]), ''];
}

function searched(run: BriefInput): boolean {
  return run.ran ? run.ran.search : Boolean(run.usage ?? run.profile);
}

function dependencyCounts(run: BriefInput): DependencyCounts {
  const dependencies = (run.exact ?? []).filter((item) => item.kind === 'dependency');
  const answered = dependencies.filter((item) => item.status !== undefined && item.status !== 'no-data' && item.status !== 'git');
  return { checked: answered.length, unchecked: dependencies.length - answered.length, behind: answered.filter((item) => item.status === 'behind').length, online: Boolean(run.ran?.online) };
}

/** What a Claude Code run didn't look at, in the words its header and its quiet line both use. */
function notCheckedNotes(run: BriefInput): string[] {
  const deps = dependencyCounts(run);
  const total = deps.checked + deps.unchecked;
  const unknown = run.unrecognised;
  return [
    ...(deps.unchecked ? [`${deps.unchecked.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} dependencies not checked (${deps.online ? 'no registry answer' : 'offline'})`] : []),
    ...(unknown?.count ? [`${unknown.count.toLocaleString('en-US')} model ids on ${unknown.files.length === 1 ? fileName(unknown.files[0]) : 'lists'} not recognised`] : []),
  ];
}

export const STOPPED_LINE = "keepup: stopped early, so this can't say that nothing applies";

/** A repo with nothing for keepup to read gets one plain line. A read that stopped early can't say this. */
export function noAiCode(run: BriefInput): boolean {
  return !run.incomplete && run.facts?.ai_call_sites?.length === 0 && run.facts?.model_ids?.length === 0;
}

export function noAiLine(files: number): string {
  return `keepup: no AI code found here · ${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'} read · nothing to check`;
}

function emptyLine(run: BriefInput): string {
  if (run.incomplete) return STOPPED_LINE;
  if (run.coverage && noAiCode(run)) return noAiLine(run.facts?.checked?.files ?? 0);
  if (run.coverage && searched(run)) return coveredLine(run.db.records, run.coverage, notCheckedNotes(run));
  if (searched(run)) return quietLine(run.db.records);
  return exactOnlyLine(run.facts?.model_ids?.length ?? 0, dependencyCounts(run));
}

function cell(text: string): string {
  return plainText(text).replace(/\|/g, '\\|');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function commitLine(run: BriefInput): string {
  if (run.base_commit) return `Uncommitted changes on top of ${run.base_commit.slice(0, 7)}`;
  const short = run.commit ? run.commit.slice(0, 7) : 'working tree';
  const when = run.commit_date ? ` (${humanDate(run.commit_date)})` : '';
  return `Commit ${short}${when}`;
}

function header(run: BriefInput): string[] {
  return [`# keepup brief: ${oneLine(run.repo)}`, '', `${commitLine(run)}. Database as of ${humanDate(run.db.fetched)}.`, ''];
}

function profileSection(profile: Profile): string[] {
  const jobs = profile.jobs.map((job) => {
    const where = job.where.map((place) => `${fileName(place.file)}:${place.line}`).join(', ');
    return `| ${cell(job.job)} | ${cell(job.how)} | ${where} |`;
  });
  return [
    '## What we understood', '',
    `**The product.** ${plainText(profile.one_liner)}`, '',
    `**The stack.** ${profile.stack.map(plainText).join(', ')}`, '',
    '**The AI jobs in the code:**', '',
    "| Job | How it's done today | Where |", '| --- | --- | --- |', ...jobs, '',
    '**Stack lock.** keepup only considers:', ...profile.stack_lock.map((item) => `- ${plainText(item)}`), '',
  ];
}

/** A repo's file name is its own kind of untrusted text. */
function fileName(file: string): string {
  return plainText(file);
}

function placeText(place: Finding['where'][number]): string {
  return `${fileName(place.file)}:${place.line}${place.text ? ` ${codeSpan(place.text)}` : ''}`;
}

function whereLines(finding: Finding): string[] {
  if (finding.where.length === 1) return [`**Where.** ${placeText(finding.where[0])}`, ''];
  return ['**Where:**', ...finding.where.map((w) => `- ${placeText(w)}`), ''];
}

function optionLines(finding: Finding): string[] {
  if (finding.options.length === 0) return [];
  const rows = finding.options.map((option) => `| ${cell(option.name)} | ${cell(option.what)} | ${option.needs ? `${cell(option.needs)} ` : ''}|`);
  return ['**The options:**', '', '| Option | What it is | Needs |', '| --- | --- | --- |', ...rows, ''];
}

function sourceLines(sources: readonly string[]): string[] {
  if (sources.length === 1) return [`**Source.** ${oneLine(sources[0])}`, ''];
  return ['**Sources:**', ...sources.map((source) => `- ${oneLine(source)}`), ''];
}

function findingSection(finding: Finding, index: number): string[] {
  return [
    `### ${finding.rank ?? index + 1}. ${plainText(finding.title)} · ${finding.effect.join(', ')}`, '',
    ...roiSection(finding.value),
    ...(finding.value?.status === 'priced' ? [`**Value.** ${oneLine(finding.value.formula)}. Inputs: ${Object.entries(finding.value.inputs).map(([key, input]) => `${key} ${input.value} (${input.label})`).join('; ')}.`, ''] : finding.value?.reason && !finding.value.roi ? [`**Value.** No money number: ${plainText(finding.value.reason)}`, ''] : []),
    ...(finding.value?.speed ? [`**Speed.** ${finding.value.speed.text} [${finding.value.speed.label}].`, ''] : []),
    ...whereLines(finding),
    `**Why it fits.** ${plainText(finding.why)}`, '',
    ...optionLines(finding),
    `**Proof.** ${capitalise(finding.proof)}.`, '',
    `**Effort.** ${finding.effort}.`, '',
    ...sourceLines([...new Set([...finding.sources, ...finding.options.map((option) => option.source)])].filter(Boolean)),
    ...(finding.pr ? [`**Pull request.** ${oneLine(finding.pr)}`, ''] : []),
  ];
}

/** What can be adopted. A retirement isn't counted here: it has its own line. */
function fitCount(run: BriefInput): number {
  return run.findings.filter((finding) => !isRetirement(finding)).length;
}

function shortOfSearch(run: BriefInput): string {
  if (!run.ran?.judge) return "The search and the judge didn't run.";
  return run.coverage?.candidates === undefined ? "The searches fell short, so this doesn't count as compared with the database." : "Some of keepup's bundles went unread, so this doesn't count as compared with the database.";
}

function checkedLine(run: BriefInput): string {
  if (!searched(run)) {
    const deps = dependencyCounts(run);
    const counted = deps.unchecked ? `${deps.checked + deps.unchecked} dependencies, ${deps.unchecked} of them not checked` : `${deps.checked} dependencies`;
    return `Exact checks only: ${run.facts?.model_ids?.length ?? 0} model ids and ${counted}. ${shortOfSearch(run)} ${fitCount(run)} fit.`;
  }
  if (run.coverage) return `${[`Compared with a database of ${run.db.records.toLocaleString('en-US')}`, ...ranWords(run.coverage), ...notCheckedNotes(run)].join(' · ')}. ${fitCount(run)} fit.`;
  const sources = Object.keys(run.db.by_source).length;
  return `Compared with ${run.db.records.toLocaleString('en-US')} new or updated things from ${sources} sources, fetched ${humanDate(run.db.fetched)}. ${fitCount(run)} fit.`;
}

function findingsSection(run: BriefInput): string[] {
  const levers = run.findings.filter((finding) => !isRetirement(finding));
  const retired = run.findings.filter(isRetirement);
  const lead = levers[0];
  const heading = lead ? (losesMoney(lead) ? `${NOTHING_CLEARS} Closest: ${plainText(lead.title)}` : `Biggest lever: ${plainText(lead.title)}`) : NOTHING_BIG;
  return [
    `## ${heading}`, '',
    ...(lead && effectLine(lead, run) ? [effectLine(lead, run), ''] : []),
    `## ${checkedLine(run)}`, '',
    ...(run.rank_explanation ? [run.rank_explanation, ''] : []),
    ...levers.flatMap(findingSection),
    ...(retired.length ? [retirementLine(run, retired), ''] : []),
  ];
}

function watchingSection(watching: readonly Watching[]): string[] {
  if (watching.length === 0) return [];
  return [
    '## Watching', '', "These fit a job you have, but aren't ready to recommend.", '',
    ...watching.map((item) => `- **${plainText(item.thing)}.** ${plainText(item.why)} Source: ${oneLine(item.source)}`), '',
  ];
}

const HELD_BACK_ROWS = 15;

/** One screen: the rest stay in the run file. */
function heldBackSection(heldBack: readonly HeldBack[]): string[] {
  if (heldBack.length === 0) return [];
  const rest = heldBack.length - HELD_BACK_ROWS;
  const rows = heldBack.slice(0, HELD_BACK_ROWS).map((item) => `| ${cell(item.thing)} | ${item.date ? humanDate(item.date) : '—'} | ${cell(item.reason)} |`);
  return ['## Checked and held back', '', "| Thing | Date | Why it's held back |", '| --- | --- | --- |', ...rows, '', ...(rest > 0 ? [`And ${rest} more, in the run file.`, ''] : [])];
}

const CATEGORIES: readonly [RegExp, string][] = [
  [/reads like an instruction|reads like a command|tells a founder to adopt/, 'it read like an instruction from the repo'],
  [/\blink\b|\bmarkup\b|isn't from any record or lever/, 'it had a link no record gives'],
  [/\bpackage\b|\bthe name\b/, 'it named a package no record gives'],
  [/^its shape\b/, 'its shape wasn\'t what verify takes'],
  [/\bwording\b/, 'its wording'],
  [/\bquote\b|that line says|not in the repo|no line|no quoted text|file and line|doesn't say that|citations/, 'its place in the code didn\'t hold up'],
  [/caching setting/, 'it broke a rule of the judge\'s own'],
  [/\bversion\b|\bmodel id\b|can't be read|\bdeadline\b|shutdown|announcement|price/, 'a number, date or name no source holds'],
  [/says what|promise|sources don't say/, 'a claim its source doesn\'t make'],
  [/effect word|proof|"keeps working"|"new capability"|gain|effort word|measures nothing/, 'a label that doesn\'t fit'],
  [/stays, because|sends nothing|isn't on this finding/, 'a judge\'s call the program overruled'],
];

/** Why something was dropped, in words the program chose. The rejected text itself stays in the run file. */
export function droppedCategory(item: Pick<Dropped, 'why'>): string {
  return CATEGORIES.find(([re]) => re.test(item.why))?.[1] ?? 'a check failed';
}

const SAFE_TOKEN = /^(?:[$\d.,%xXKMB]{1,24}|\d{1,2} [A-Z][a-z]{2}(?: \d{4})?|--\d\d-\d\d)$/;

/** Which number it was and where it was looked for, so a true one can be cited. Only a number or a date: the rest of a rejected sentence stays in the run file. */
export function droppedDetail(item: Pick<Dropped, 'why'>): string | null {
  const token = item.why.match(/^(.{1,24}) can't be read from any source$/)?.[1];
  return token && SAFE_TOKEN.test(token) ? `${token} isn't in its sources or on a line it cites` : null;
}

export function droppedLine(item: Dropped): string {
  const detail = droppedDetail(item);
  return `${item.lever ? `${oneLine(item.lever)}, ` : ''}${item.where ? `${oneLine(item.where)}: ` : ''}${droppedCategory(item)}${detail ? `: ${detail}` : ''}`;
}

/** A lever the checks took out is said by name. It's the point of the brief, so it comes first and survives a short screen. */
function droppedLevers(checks: CheckSummary): Dropped[] {
  return checks.dropped.filter((item) => item.lever);
}

function droppedFirst(checks: CheckSummary): Dropped[] {
  return [...droppedLevers(checks), ...checks.dropped.filter((item) => !item.lever)];
}

function droppedSection(checks: CheckSummary): string[] {
  if (checks.dropped.length === 0) return [];
  return ['## Dropped by the checks', '', ...droppedFirst(checks).map((item) => `- ${droppedLine(item)}`), ''];
}

function incompleteSection(run: BriefInput): string[] {
  if (!run.incomplete) return [];
  return ['## Incomplete', '', plainText(run.incomplete.reason), '', ...run.incomplete.skipped.map((item) => `- ${plainText(item)}`), ''];
}

function finish(lines: readonly string[]): string {
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderBrief(run: BriefInput): string {
  const tail = [...heldBackSection(run.held_back), ...droppedSection(run.checks), ...incompleteSection(run)];
  if (run.findings.length === 0 && run.watching.length === 0) {
    return finish([emptyLine(run), ...(tail.length ? ['', ...tail] : [])]);
  }
  return finish([
    ...header(run),
    ...(run.profile ? profileSection(run.profile) : []),
    ...findingsSection(run),
    ...teamSection(run),
    ...watchingSection(run.watching),
    ...tail,
  ]);
}

const IN_FULL = 3;
const SUMMARY_HELD = 1;
const SUMMARY_WATCHING = 1;
const SUMMARY_DROPPED = 2;
const MAX_LINE = 118;
const SUMMARY_PLACES = 2;
const HELD_LINES = 2;
export const OFFER = 'want the change?';

/** Cuts at a word, so what's left still reads. */
function atWord(text: string, room: number): string {
  if (text.length <= room) return text;
  const cut = text.slice(0, Math.max(0, room - 3));
  const space = cut.lastIndexOf(' ');
  return `${(space > room / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

function fit(text: string): string {
  return atWord(oneLine(text), MAX_LINE);
}

const WRAP_INDENT = '       ';

/** An action or a reason is never cut: it carries on, indented, on the next line. */
function wrapped(text: string, indent = WRAP_INDENT): string[] {
  const flat = oneLine(text).trimEnd();
  const lead = flat.match(/^ */)?.[0] ?? '';
  const out: string[] = [];
  let line = '';
  for (const word of flat.trimStart().split(/ +/)) {
    if (line && line.length + word.length + 1 > MAX_LINE) {
      out.push(line);
      line = `${indent}${word}`;
    } else line = line ? `${line} ${word}` : `${lead}${word}`;
  }
  return [...out, line];
}

const DO_LINES = 2;

/** As many whole sentences as fit in two lines, and always the first, whatever its length. A sentence is never cut; the rest stays in the run file. */
function wholeSentences(text: string): string[] {
  const all = wrapped(text);
  if (all.length <= DO_LINES) return all;
  const [first, ...rest] = oneLine(text).split(/(?<=[.!?])\s+(?=[A-Z])/);
  let kept = first;
  for (const sentence of rest) {
    if (wrapped(`${kept} ${sentence}`).length > DO_LINES) break;
    kept = `${kept} ${sentence}`;
  }
  return wrapped(kept);
}

/** Up to this many lines, for what isn't an action: a held-back row can run long, and the run file holds all of it. */
function wrappedUpTo(text: string, lines: number): string[] {
  const all = wrapped(text, '  ');
  if (all.length <= lines) return all;
  const whole = wholeSentences(text).map((line) => line.replace(/^ {7}/, '  '));
  return whole.length <= lines ? whole : [...all.slice(0, lines - 1), atWord(all.slice(lines - 1).join(' '), MAX_LINE)];
}

/** What has to survive goes in `tail`, and the head gives way. */
function fitWithTail(head: string, tail: string): string {
  const flatTail = oneLine(tail);
  return `${atWord(oneLine(head), MAX_LINE - flatTail.length)}${flatTail}`;
}

function labels(finding: Finding): string {
  return `${finding.effect.join(', ')} · ${finding.proof} · ${finding.effort}`;
}

/** gpt-4-turbo, o3-mini to gpt-5.6-sol; o4-mini to gpt-5.6-terra: only ids in this repo, and where each goes. */
function movesText(moves: readonly Move[]): string {
  const groups = new Map<string, string[]>();
  for (const move of moves) groups.set(move.to.join(' or '), [...(groups.get(move.to.join(' or ')) ?? []), move.from]);
  const parts = [...groups].sort(([a], [b]) => Number(!a) - Number(!b)).map(([to, from]) => (to ? `${from.join(', ')} to ${to}` : `${from.join(', ')} ${from.length === 1 ? 'has' : 'have'} no successor named`));
  return parts.join('; ');
}

function movesOf(finding: Finding, run: BriefInput): Move[] {
  if (finding.sdk_unverified) return [];
  const places = new Set(finding.where.map((place) => `${place.file}:${place.line}`));
  return (run.moves ?? []).filter((move) => move.places.some((place) => places.has(place)));
}

function sourceLine(source: string): string[] {
  return wrapped(`       ${source}`);
}

/** What to do, for each option: its name, how, and the vendor's number where the option carries it. The ids in this repo, when the program knows them. */
function doLines(finding: Finding, run: BriefInput): string[] {
  const moves = movesOf(finding, run);
  const firstSource = finding.options[0]?.source;
  if (moves.length) return [...wrapped(`   Do: ${movesText(moves)}`), ...(firstSource && firstSource !== finding.sources[0] ? sourceLine(firstSource) : [])];
  const shown = new Set([finding.sources[0]]);
  // With an SDK in the way, "move to the successor" is the very thing that isn't safe to say alone.
  const named = finding.sdk_unverified ? undefined : successors(finding.why);
  return finding.options.filter((option) => !option.needs.startsWith(AFTER_UPGRADE)).flatMap((option) => {
    const whole = oneLine(`   Do: ${optionName(option.name, finding)}: ${option.what}`);
    // Too long for a line, and the finding already knows the one thing to act on.
    const line = wholeSentences(named && whole.length > MAX_LINE ? `   Do: move to ${named}` : whole);
    if (!option.source || shown.has(option.source)) return line;
    shown.add(option.source);
    return [...line, ...sourceLine(option.source)];
  });
}

const NAMED_SUCCESSOR = /Named successor: (.+?)\.(?:\s|$)/;
const ITSELF_SHUT_DOWN = /(\S+) was itself shut down[^.]*(?:\.\d[^.]*)*\.(?: \w+ names (\S+) after it\.)?/g;

/** What to move to, across every model a finding groups. A successor that was itself shut down gives way to the one its maker names after it, or to nothing. */
function successors(why: string): string | undefined {
  const named = [...why.matchAll(new RegExp(NAMED_SUCCESSOR, 'g'))].flatMap((match) => match[1].split(' or '));
  if (named.length === 0) return undefined;
  const chain = new Map([...why.matchAll(ITSELF_SHUT_DOWN)].map((match) => [match[1], match[2]]));
  const live = named.flatMap((model) => (chain.has(model) ? (chain.get(model) ? [chain.get(model) as string] : []) : [model]));
  return live.length ? [...new Set(live)].join(' or ') : undefined;
}

const CHECK_FIRST = /Check before switching[^"]*"([^"]+)"/;

const LATEST = /The latest is (\d[\w.-]*\w)/;

/** An option that says "the named successors" says which, since that's what someone acts on. */
function optionName(name: string, finding: Finding): string {
  const named = finding.why.match(NAMED_SUCCESSOR)?.[1];
  return named ? name.replace(/\bthe named successors?\b/i, named) : name;
}

/** With no options: the successor a provider names, the version a library is at, or else what the finding says first. */
function plainDo(finding: Finding): string[] {
  const named = successors(finding.why) ?? finding.why.match(LATEST)?.[1];
  const first = finding.why.split(/(?<=[.!?])\s+/)[0] ?? '';
  return wrapped(`   Do: ${named ? `move to ${named}` : first}`);
}

function checkLine(finding: Finding): string[] {
  const caveat = finding.why.match(CHECK_FIRST)?.[1];
  const sdk = finding.sdk_unverified;
  return [
    ...(caveat ? wrapped(`   Check first: ${caveat}`) : []),
    ...(sdk ? wrapped(`   Not ruled out: this repo's text has no ${sdk.identifier}, but ${sdk.sdks.join(' and ')} can send it themselves. Not verified on those versions.`) : []),
  ];
}

function placesLine(finding: Finding, shown: number): string {
  const places = finding.where.slice(0, shown).map((place) => `${fileName(place.file)}:${place.line}`);
  const more = finding.where.length - places.length;
  return fit(`   ${places.join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
}

function fullFinding(finding: Finding, index: number, run: BriefInput): string[] {
  const showSum = index === 0;
  return [
    fit(`${finding.rank ?? index + 1}. ${finding.title}`),
    fit(`   ${labels(finding)}`),
    ...(index > 0 && effectLine(finding, run) ? wrapped(`   ${effectLine(finding, run)}`) : []),
    ...roiLines(finding.value),
    ...(showSum ? formulaLines(finding.value) : []),
    placesLine(finding, SUMMARY_PLACES),
    fit(`   ${finding.sources[0] ?? ''}`),
    ...(finding.options.length ? doLines(finding, run) : plainDo(finding)),
    ...checkLine(finding),
  ];
}

/** One line for what to do: the first option's source goes with it, so a link is never lost to the width of a line. */
function shortDo(finding: Finding, run: BriefInput): string[] {
  if (finding.options.length === 0) return plainDo(finding);
  const source = finding.options[0].source;
  const moves = movesOf(finding, run);
  const names = moves.length ? movesText(moves) : finding.options.map((option) => optionName(option.name, finding)).join(' or ');
  return wrapped(`   Do: ${names} · ${source}`);
}

/** Further down a full screen: the lines alone, saying their inputs are assumed. The lead lever always prints all of it. */
function roiShort(value: LeverValue | undefined): string[] {
  const roi = value?.roi;
  if (!roi) return [];
  return roi.money ? roi.options.flatMap((option) => wrapped(`   ${option.name}: ${option.line ?? 'enter your model and calls a month'} (assumed inputs, in the run file)`)) : wrapped(`   ${roi.statement}`);
}

/** Past the top three: one line of labels, the first place, and what to do. Every finding says where. */
function shortFinding(finding: Finding, index: number, run: BriefInput): string[] {
  return [fitWithTail(`${finding.rank ?? index + 1}. ${finding.title}`, ` · ${labels(finding)}`), ...(index === 0 ? roiLines(finding.value) : roiShort(finding.value)), placesLine(finding, 1), ...shortDo(finding, run), ...checkLine(finding)];
}

function summaryTail(run: BriefInput, compact: boolean): string[] {
  const watching = compact ? [] : run.watching.slice(0, SUMMARY_WATCHING).map((item) => fit(`  ${item.thing}: ${item.why}`));
  const held = compact ? [] : run.held_back.slice(0, SUMMARY_HELD).flatMap((item) => wrappedUpTo(`  ${item.thing}: ${item.reason}`, HELD_LINES));
  const dropped = (compact ? droppedLevers(run.checks) : droppedFirst(run.checks)).slice(0, SUMMARY_DROPPED).map((item) => fit(`  ${droppedLine(item)}`));
  const counted = [
    ...(run.watching.length ? [compact ? `Watching: ${run.watching.length}, in the run file.` : 'Watching:', ...watching] : []),
    ...(run.held_back.length ? [`Checked and held back: ${run.held_back.length}, in the run file.${held.length ? ' The first:' : ''}`, ...held] : []),
    ...(run.checks.dropped.length ? [`Dropped by the checks: ${run.checks.dropped.length}.`, ...dropped] : []),
    ...(run.incomplete ? [fit(`Incomplete: ${run.incomplete.reason}`)] : []),
  ];
  return counted.length ? ['', ...counted] : [];
}

/** Quiet means the line alone. What was held back stays in the run file; only something that went wrong is said aloud. */
function quietTail(run: BriefInput): string[] {
  const dropped = droppedFirst(run.checks).slice(0, SUMMARY_DROPPED).map((item) => fit(`  ${droppedLine(item)}`));
  return [
    ...(dropped.length ? ['', `Dropped by the checks: ${run.checks.dropped.length}.`, ...dropped] : []),
    ...(run.incomplete ? ['', fit(`Incomplete: ${run.incomplete.reason}`)] : []),
  ];
}

const SCREEN_LINES = 40;
/** The fullest shape that fits: the tail comes down to counts first, then fewer findings get their whole block. Nothing is cut to get there. */
const SHAPES: readonly { readonly inFull: number; readonly compact: boolean }[] = [{ inFull: IN_FULL, compact: false }, { inFull: IN_FULL, compact: true }, { inFull: 2, compact: true }, { inFull: 1, compact: true }, { inFull: 0, compact: true }];

function leadLines(lever: Finding, run: BriefInput): string[] {
  const effect = effectLine(lever, run);
  const head = losesMoney(lever) ? `${NOTHING_CLEARS} Closest: ${lever.title}` : `Biggest lever: ${lever.title}`;
  return [...wrapped(head), ...(effect ? wrapped(effect, '  ') : [])];
}

function retiredLines(run: BriefInput, inFull: number, compact: boolean): string[] {
  const retired = run.findings.filter(isRetirement);
  return [
    `keepup: ${oneLine(run.repo)} · ${commitLine(run)}`,
    ...wrapped(checkedLine(run)),
    ...retired.slice(0, inFull).flatMap((finding, index) => fullFinding(finding, index, run)),
    ...retired.slice(inFull).flatMap((finding, index) => shortFinding(finding, index + inFull, run)),
    ...summaryTail(run, compact),
    ...(retired.length ? ['', OFFER] : []),
  ];
}

function summaryLines(run: BriefInput, inFull: number, compact: boolean): string[] {
  const levers = run.findings.filter((finding) => !isRetirement(finding));
  const retired = run.findings.filter(isRetirement);
  return [
    `keepup: ${oneLine(run.repo)} · ${commitLine(run)}`,
    ...(levers.length ? leadLines(levers[0], run) : [NOTHING_BIG]),
    ...wrapped(checkedLine(run)),
    ...levers.slice(0, inFull).flatMap((finding, index) => fullFinding(finding, index, run)),
    ...levers.slice(inFull).flatMap((finding, index) => shortFinding(finding, index + inFull, run)),
    ...(retired.length ? ['', ...wrapped(retirementLine(run, retired))] : []),
    ...teamLines(run, compact),
    ...summaryTail(run, compact),
    ...(run.findings.length ? ['', ...(measureOffer(levers) ? [measureOffer(levers)] : []), OFFER] : []),
  ];
}

function measureOffer(levers: readonly Finding[]): string {
  const first = levers.find((lever) => lever.value?.measurable);
  return first ? `Measure it on your own prompt, on your key: keepup measure . --finding ${first.rank ?? 1}` : '';
}

/** What "Also" stands for, only when someone asks: each retired or retiring model with where it is and what to do. Never the brief itself. */
export function renderRetired(run: BriefInput): string {
  const shaped = SHAPES.map(({ inFull, compact }) => retiredLines(run, inFull, compact));
  return finish(shaped.find((lines) => lines.length <= SCREEN_LINES) ?? (shaped.at(-1) as string[]));
}

/** One screen: the top findings with where and source, the rest shorter, and a count of what was held back. */
export function renderSummary(run: BriefInput): string {
  if (run.findings.length === 0 && run.watching.length === 0) return finish([emptyLine(run), ...quietTail(run)]);
  const shaped = SHAPES.map(({ inFull, compact }) => summaryLines(run, inFull, compact));
  return finish(shaped.find((lines) => lines.length <= SCREEN_LINES) ?? (shaped.at(-1) as string[]));
}
