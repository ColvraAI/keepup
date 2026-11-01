// Turns exact-check results into findings and held-back rows with no model involved. This is the floor
// of a run: a judge can add to it and drop what no stated rule keeps, but with no judge a run still says what's provably so.
import type { ChangelogEntry } from './changelogs.ts';
import { addDays, humanDate } from './dates.ts';
import type { DependencyCheck, ModelCheck } from './exact-checks.ts';
import type { Lever } from './levers.ts';
import { earliestDeadline, modelHeldBack, PROVIDER_NAMES } from './model-rows.ts';
import { liveEnd } from './change-catalog.ts';
import { findRetirement, type Retirement, statusAsOf } from './retirements.ts';
import type { ExactResult, Finding, FindingOption, HeldBack, Move, Where } from './run-shape.ts';
import { AFTER_UPGRADE, bridgeOption, joinedAnd, sdkEffort, sdkLabel, sdksFor, upgradeOption } from './sdk-notes.ts';
import type { Gain } from './release-notes.ts';
import { caveatLine, successorCaveats, successorNames, tradeOffLines } from './successor-notes.ts';

const MIN_MAJORS_BEHIND = 2;
const URGENT_DAYS = 31;
export const AI_LIBRARY = /openai|anthropic|langchain|llama|xenova|huggingface|transformers|modelcontextprotocol|(?:^|[-_/])mcp(?:$|[-_/])|^rmcp$|^rig-|ollama|cohere|mistral|groq|gemini|genai|bedrock|qdrant|lancedb|pinecone|chroma|weaviate|milvus|tiktoken|embedding|^ai$|@ai-sdk/i;
/** A protocol every tool call goes through. Falling far behind one, with notes naming what's missed, stays a finding. */
const PROTOCOL_LIBRARY = /^rmcp$|^@modelcontextprotocol\/|^mcp$|^mcp-sdk$/;
export const RETIREMENT_RULE = 'a model this code sends is retired or retiring';
export const PROTOCOL_RULE = 'a protocol library with release notes that name what the code misses';
/** A place that's the value sent when nothing is set, rather than one choice among many. */
const DEFAULT_LINE = /(?:\?\?|\|\|)\s*["'`]|\bdefault\w*\s*[:=]|\{[^}]*\bmodel\s*=\s*["'`]/i;
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';

export interface FindingsContext {
  readonly lineText: (file: string, line: number) => string;
  readonly window: { readonly since: string; readonly until: string };
  /** With these, a run groups one finding per lever and names only current successors. */
  readonly levers?: readonly Lever[];
  readonly asOf?: string;
  readonly retirements?: readonly Retirement[];
  readonly changelog?: readonly ChangelogEntry[];
  readonly files?: ReadonlyMap<string, string>;
  /** Every model check in the run, so a finding can name where the same model goes through a gateway. */
  readonly allModels?: readonly ModelCheck[];
  /** Every dependency in the run, so a finding can say which SDK writes its requests. */
  readonly dependencies?: readonly DependencyCheck[];
  /** The ids OpenRouter lists today, when an online run asked. */
  readonly openRouterIds?: ReadonlySet<string> | null;
}

export interface FloorResult {
  readonly findings: readonly Finding[];
  readonly watching: readonly never[];
  readonly held_back: readonly HeldBack[];
  /** Writes a retirement finding again for fewer models, the same way. */
  readonly rebuild?: (checks: readonly ModelCheck[]) => Finding;
  /** Writes a dependency finding again without the release-note lines a judge showed this code doesn't gain from. */
  readonly rebuildDependency?: (check: DependencyCheck, notGains: readonly NotGain[]) => Finding | null;
  /** Where each id moves to, for the brief's Do line. */
  readonly moves?: readonly Move[];
}

export interface NotGain {
  readonly text: string;
  readonly why: string;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function leversFor(checks: readonly ModelCheck[], context?: FindingsContext): Lever[] {
  const ids = new Set(checks.map((check) => check.model));
  return (context?.levers ?? []).filter((lever) => lever.models?.some((model) => ids.has(model)));
}

/** A table's successor is the provider's literal answer. A changelog's can be stale, so a lever checked against the page outranks it. */
function namedSuccessors(check: ModelCheck, context?: FindingsContext): readonly string[] {
  if (check.successors_from_page) return check.successors;
  const levers = leversFor([check], context);
  if (levers.length === 0) return check.successors;
  const leverText = levers.map((lever) => `${lever.name} ${lever.how}`).join(' ').toLowerCase();
  return check.successors.filter((name) => leverText.includes(name.toLowerCase()));
}

function shutdownWords(check: Pick<ModelCheck, 'effective' | 'earliest'>): string {
  return `${check.earliest ? 'no earlier than' : 'on'} ${humanDate(check.effective as string)}`;
}

function modelLine(check: ModelCheck, context?: FindingsContext): string {
  const announced = check.announced ? ` Announced on ${humanDate(check.announced)}.` : '';
  const named = namedSuccessors(check, context);
  const successors = named.length ? ` Named successor: ${named.join(' or ')}.` : '';
  if (check.variant_of) return `${check.model} is a pinned version of ${check.variant_of}, which ${check.status === 'retired' ? 'was shut down' : 'shuts down'}${check.effective ? ` on ${humanDate(check.effective)}` : ''}.${announced}${successors}`;
  if (check.status === 'retired') return `${check.model} was shut down${check.effective ? ` on ${humanDate(check.effective)}` : ''}.${announced}${successors}`;
  if (check.status === 'retiring') return `${check.model} shuts down ${shutdownWords(check)}.${announced}${successors}`;
  if (check.earliest_date) return `${check.model} was due to shut down no earlier than ${humanDate(check.earliest_date)}. That date has passed, so it may already be gone.${announced}${successors}`;
  return `${check.model} is deprecated, with no shutdown date in the changelog.${announced}${successors}`;
}

/** A successor can be on its way out too. That's its own sentence, so the provider's literal answer stays literal. */
function chainNotes(checks: readonly ModelCheck[], context?: FindingsContext): string[] {
  if (!context?.retirements) return [];
  const names = unique(checks.flatMap((check) => namedSuccessors(check, context)));
  return names.flatMap((name) => {
    const next = findRetirement(name, context.retirements as readonly Retirement[]);
    if (!next || next.routed_to) return [];
    const onward = next.successors.length ? ` ${PROVIDER_NAMES[next.provider]} names ${next.successors.join(' or ')} after it.` : '';
    const status = context.asOf ? statusAsOf(next, context.asOf) : next.status;
    const end = context.asOf ? liveEnd(name, context.asOf, context.retirements as readonly Retirement[]) : null;
    const instead = end && end !== name && !next.successors.includes(end) ? ` Following that chain, ${end} is what's live, so move there.` : end && end !== name ? ` Move to ${end} instead.` : '';
    if (status === 'retired') return [`${name} was itself shut down${next.effective ? ` on ${humanDate(next.effective)}` : ''}.${onward}${instead}`];
    if (status === 'retiring') return [`${name} itself shuts down ${shutdownWords(next)}.${onward}`];
    return [`${name} is itself deprecated.${onward}`];
  });
}

function hasDefaultPlace(check: ModelCheck): boolean {
  return check.live_places.some((place) => !place.catalog && DEFAULT_LINE.test(place.text));
}

function severity(check: ModelCheck): number {
  const sent = check.live_places.some((place) => !place.catalog);
  if (check.status === 'retired') return hasDefaultPlace(check) ? 0 : sent ? 1 : 4;
  if (check.earliest_date) return sent ? 2 : 5;
  if (check.status === 'retiring') return sent ? 3 : 6;
  return sent ? 3 : 7;
}

/** The most serious live default first, so a title and a why open on what a founder has to act on. */
function bySeverity(checks: readonly ModelCheck[]): ModelCheck[] {
  return [...checks].sort((a, b) => severity(a) - severity(b) || (a.effective ?? '9999') .localeCompare(b.effective ?? '9999') || a.model.localeCompare(b.model));
}

function singleModelTitle(check: ModelCheck, provider: string): string {
  if (check.status === 'retired' && check.effective && hasDefaultPlace(check)) return `Your default ${check.model} was shut down on ${humanDate(check.effective)}`;
  if (check.status === 'retired') return `${provider} has shut down ${check.model}`;
  if (check.status === 'retiring') return `${provider}'s ${check.model} shuts down ${shutdownWords(check)}`;
  return `${provider} has deprecated ${check.model}`;
}

function groupTitle(checks: readonly ModelCheck[], provider: string, statuses: string, inPicker: boolean): string {
  const [lead] = checks;
  const others = checks.length - 1;
  const plural = others === 1 ? '' : 's';
  if (lead.status === 'retired' && lead.effective && hasDefaultPlace(lead)) return `Your default ${lead.model} was shut down on ${humanDate(lead.effective)}, and ${others} more ${provider} model${plural} ${others === 1 ? 'is' : 'are'} ${statuses}`;
  const dates = unique(checks.map((check) => check.effective));
  const where = inPicker ? ' in your picker' : '';
  if (dates.length === 1 && dates[0] && checks.every((check) => check.status === 'retiring')) {
    const named = checks.find((check) => check.live_places.some((place) => !place.catalog));
    return named ? `${named.model} and ${others} more ${provider} model${plural} shut down ${shutdownWords(named)}` : `${checks.length} ${provider} models${where} shut down ${shutdownWords(checks[0])}`;
  }
  const soonest = earliestDeadline(checks);
  const hedge = soonest && checks.every((check) => check.earliest && check.status === 'retiring') ? `, no earlier than ${humanDate(soonest)}` : '';
  return `${checks.length} ${provider} models${where} are ${statuses}${hedge}`;
}

/** A bridge is only evidence on a finding that offers it. */
function leverEvidence(lever: Lever): string {
  const { bridge: _bridge, ...rest } = lever;
  return JSON.stringify(rest);
}

function leverOption(lever: Lever): FindingOption {
  return { name: lever.name, what: lever.how, needs: lever.needs ?? '', source: lever.source };
}

function joined(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Each replacement says which model it replaces and where that model is set, because a group can hold several of each. */
function modelOptions(checks: readonly ModelCheck[], provider: string, context?: FindingsContext): FindingOption[] {
  const levers = leversFor(checks, context);
  if (levers.length > 0) return levers.map(leverOption);
  return unique(checks.flatMap((check) => namedSuccessors(check, context))).map((name) => {
    const replaced = checks.filter((check) => namedSuccessors(check, context).includes(name));
    const places = replaced.flatMap((check) => [...check.live_places].sort((a, b) => Number(Boolean(a.catalog)) - Number(Boolean(b.catalog))).slice(0, 1).map((place) => `${check.model} to it at ${place.file}:${place.line}`));
    const live = context?.retirements && context.asOf ? liveEnd(name, context.asOf, context.retirements) ?? name : name;
    return {
      name: live,
      what: live === name ? `Named by ${provider} as the replacement for ${joined(replaced.map((check) => check.model))}.` : `${provider} named ${name} as the replacement for ${joined(replaced.map((check) => check.model))}, and ${name} has itself been shut down. Following ${provider}'s successors leads here.`,
      needs: places.length ? `Change ${joined(places)}.` : '',
      source: replaced.find((check) => check.page_source)?.page_source ?? replaced[0].source,
    };
  });
}

const STATUS_ORDER: readonly ModelCheck['status'][] = ['retired', 'retiring', 'deprecated'];

function livePlaces(checks: readonly ModelCheck[]): Where[] {
  const places = new Map(checks.flatMap((check) => check.live_places.map(({ file, line, text }) => [`${file}:${line}`, { file, line, text }] as const)));
  return [...places.values()];
}

function pickerLine(checks: readonly ModelCheck[]): string {
  const files = unique(checks.flatMap((check) => check.live_places.filter((place) => place.catalog).map((place) => place.file)));
  return files.length ? `${files.join(', ')} ${files.length === 1 ? 'feeds' : 'feed'} a picker or a lookup, so a person can still choose these: put the replacement on that list.` : '';
}

/** What a lever moves this very id to, as in "Change old-id to new-id". */
function mappedSuccessors(check: ModelCheck, context?: FindingsContext): string[] {
  const id = check.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return leversFor([check], context).flatMap((lever) => [...lever.how.matchAll(new RegExp(`\\b${id}\\s+to\\s+([\\w.-]*\\w)`, 'g'))].map((match) => match[1]));
}

interface CaveatFacts {
  readonly lines: string[];
  readonly evidence: string[];
  readonly sources: string[];
  /** A setting the successor rejects that the repo's text never mentions, when an SDK writes the request. */
  readonly unverified?: { readonly identifier: string; readonly successor: string; readonly sdks: readonly DependencyCheck[] };
}

function caveatsFor(checks: readonly ModelCheck[], context?: FindingsContext): CaveatFacts {
  if (!context?.changelog || !context.files) return { lines: [], evidence: [], sources: [] };
  const names = successorNames(checks.flatMap((check) => namedSuccessors(check, context)), checks.flatMap((check) => mappedSuccessors(check, context)).join(' '));
  const caveats = successorCaveats(names, checks[0].provider, context.changelog, context.files);
  const tradeOffs = tradeOffLines(checks.map((check) => ({ places: check.live_places, levers: leversFor([check], context) })), context.files);
  const sdks = sdksFor(checks[0].provider, context.dependencies ?? []);
  const absent = caveats.find((caveat) => caveat.identifier && caveat.places.length === 0);
  return {
    lines: [...tradeOffs.map((item) => item.line), ...caveats.map((caveat) => caveatLine(caveat, sdks))],
    evidence: [...tradeOffs.map((item) => item.sentence), ...caveats.map((caveat) => caveat.sentence), ...(absent ? sdks.flatMap((check) => [sdkLabel(check), `${check.majors_behind} major versions`, check.latest ?? '']) : [])],
    sources: [...tradeOffs.map((item) => item.source), ...caveats.map((caveat) => caveat.source), ...(absent ? sdks.flatMap((check) => (check.source ? [check.source] : [])) : [])],
    ...(absent && sdks.length ? { unverified: { identifier: absent.identifier as string, successor: absent.successor, sdks } } : {}),
  };
}

const PICKER_REACH = 3;

function asksOpenRouter(file: string, line: number, files: ReadonlyMap<string, string> | undefined): boolean {
  if (/openrouter/i.test(file)) return true;
  const lines = files?.get(file)?.split('\n') ?? [];
  return lines.slice(Math.max(0, line - 1 - PICKER_REACH), line).some((text) => /openrouter/i.test(text));
}

/** The same model asked for by a gateway route in a config someone copies: the same family, on its own schedule. */
function gatewayCompanions(checks: readonly ModelCheck[], context?: FindingsContext): { places: Where[]; lines: string[]; evidence: string[]; sources: string[] } {
  const names = new Set(checks.flatMap((check) => [check.model, ...familyNames(check.model)]));
  const others = (context?.allModels ?? []).filter((check) => check.provider === checks[0].provider && familyNames(check.model).some((name) => names.has(name)));
  const places = others.flatMap((check) => check.not_live.filter((place) => place.why === 'gateway' && place.route === 'gateway' && (place.context === 'example' || place.context === 'config')).map((place) => ({ place, id: check.model })));
  const unlisted = (id: string, prefix: string) => context?.openRouterIds && !context.openRouterIds.has(`${prefix}/${id}`);
  const prefix = (text: string) => text.match(/["'`]?([\w-]+)\/[\w.-]+["'`]?/)?.[1] ?? 'anthropic';
  const facts = places.map(({ place, id }) => {
    const openRouter = asksOpenRouter(place.file, place.line, context?.files);
    const missing = openRouter && unlisted(id, prefix(place.text));
    return {
      where: { file: place.file, line: place.line, text: place.text },
      line: `${place.file}:${place.line} asks ${openRouter ? 'OpenRouter' : 'a gateway'} for ${prefix(place.text)}/${id}, the same model${missing ? ', and OpenRouter\'s model list no longer has it' : ', on that gateway\'s own schedule'}.`,
      evidence: missing ? [`OpenRouter's model list at ${OPENROUTER_MODELS} has no ${prefix(place.text)}/${id}.`] : [],
      sources: missing ? ['https://openrouter.ai/models'] : [],
    };
  });
  return { places: facts.map((fact) => fact.where), lines: facts.map((fact) => fact.line), evidence: facts.flatMap((fact) => fact.evidence), sources: facts.flatMap((fact) => fact.sources) };
}

/** claude-sonnet-4-20250514 and claude-sonnet-4 are one family; a date stamp isn't part of the name. */
function familyNames(id: string): string[] {
  return [id, id.replace(/-\d{8}$/, '')];
}

function checkEvidence(check: ModelCheck, context?: FindingsContext): string[] {
  return [
    check.sentence,
    ...(check.effective ? [`${check.model} shuts down on ${check.effective}.`] : []),
    ...(check.earliest_date ? [`${check.model} shuts down no earlier than ${check.earliest_date}.`] : []),
    ...(check.announced ? [`${check.model} was announced on ${check.announced}.`] : []),
    ...(check.successors.length ? [`Successors the provider names: ${[...check.successors, ...namedSuccessors(check, context)].join(', ')}.`] : []),
    ...(chainNotes([check], context)),
  ];
}

/** What makes a retirement urgent: code sends it, and there's a date it stops. A deprecation with no date breaks nothing yet. */
function isDatedAndSent(check: ModelCheck): boolean {
  return (check.status === 'retired' || Boolean(check.effective) || Boolean(check.earliest_date)) && check.live_places.some((place) => !place.catalog);
}

/** When a default that's already gone leads, its date is the one that matters. A group's soonest date is the fallback. */
function deadlineOf(checks: readonly ModelCheck[]): string | null {
  const [lead] = checks;
  return lead.status === 'retired' && hasDefaultPlace(lead) && lead.effective ? lead.effective : earliestDeadline(checks);
}

function reachOf(checks: readonly ModelCheck[], inPicker: boolean): Finding['reach'] {
  if (inPicker) return 'picker';
  return checks.some(isDatedAndSent) ? 'sent' : 'undated';
}

const ROUTE_REACH = 6;
const ROUTES: readonly (readonly [RegExp, string])[] = [[/["'`]?(?:providerId|provider)["'`]?\s*[:=]\s*["'`][^"'`]*vertex/i, 'Vertex']];

/** The entry a table's line sits in: up to the braces around it. */
function entryAround(lines: readonly string[], at: number): string[] {
  const opened = lines.slice(Math.max(0, at - ROUTE_REACH), at + 1).findLastIndex((line) => /\{\s*$/.test(line));
  const from = opened === -1 ? at : Math.max(0, at - ROUTE_REACH) + opened;
  const closed = lines.slice(at, at + ROUTE_REACH).findIndex((line) => /^\s*\}/.test(line));
  return lines.slice(from, closed === -1 ? at + 1 : at + closed + 1);
}

/** A lever speaks for the provider's own key. An entry in a table can go another way, and then that sentence isn't true of it. */
function routedElsewhere(checks: readonly ModelCheck[], context?: FindingsContext): string {
  const notes = ROUTES.flatMap(([pattern, name]) => {
    const places = checks.flatMap((check) => check.live_places.filter((place) => place.catalog && entryAround(context?.files?.get(place.file)?.split('\n') ?? [], place.line - 1).some((line) => pattern.test(line))));
    if (places.length === 0) return [];
    const at = [...new Set(places.map((place) => `${place.file}:${place.line}`))];
    return [`${joinedAnd(at)} ${at.length === 1 ? 'goes' : 'go'} through ${name}, which uses its own credentials and not that key.`];
  });
  return notes.join(' ');
}

function withRouteNotes(options: readonly FindingOption[], note: string): FindingOption[] {
  return options.map((option) => (note ? { ...option, needs: `${option.needs} ${note}`.trim() } : option));
}

/** With an SDK in the way, the move isn't "nothing new": the bridge first if there is one, then the move, with the upgrade it may need. */
function unverifiedOptions(options: readonly FindingOption[], caveats: CaveatFacts, levers: readonly Lever[], context?: FindingsContext): FindingOption[] {
  if (!caveats.unverified) return [...options];
  const { sdks, successor } = caveats.unverified;
  const bridge = bridgeOption(levers, successor, context?.asOf);
  const moves = options.map((option) => ({ ...option, needs: option.needs.replace(/^Nothing new; /, AFTER_UPGRADE) }));
  return [...(bridge ? [bridge] : []), upgradeOption(sdks, successor), ...moves];
}

export function modelFinding(given: readonly ModelCheck[], context?: FindingsContext): Finding {
  const checks = bySeverity(given);
  const provider = PROVIDER_NAMES[checks[0].provider];
  const statuses = STATUS_ORDER.filter((status) => checks.some((check) => check.status === status)).join(' or ');
  const inPicker = checks.every((check) => check.live_places.every((place) => place.catalog));
  const caveats = caveatsFor(checks, context);
  const levers = leversFor(checks, context);
  const gateway = gatewayCompanions(checks, context);
  const chain = chainNotes(checks, context);
  return {
    title: checks.length === 1 ? singleModelTitle(checks[0], provider) : groupTitle(checks, provider, statuses, inPicker),
    effect: ['keeps working'],
    proof: 'vendor claim',
    effort: caveats.unverified ? sdkEffort(caveats.unverified.sdks) : 'Hours',
    where: [...livePlaces(checks), ...gateway.places],
    why: [...checks.map((check) => modelLine(check, context)), ...chain, pickerLine(checks), ...gateway.lines, ...caveats.lines].filter(Boolean).join(' '),
    options: unverifiedOptions(withRouteNotes(modelOptions(checks, provider, context), routedElsewhere(checks, context)), caveats, levers, context),
    sources: unique([...checks.map((check) => check.source), ...checks.flatMap((check) => (check.page_source ? [check.page_source] : [])), ...levers.map((lever) => lever.source), ...caveats.sources, ...gateway.sources]),
    lever: levers[0]?.id ?? null,
    pr: null,
    deadline: deadlineOf(checks),
    evidence: [...checks.flatMap((check) => checkEvidence(check, context)), ...caveats.evidence, ...gateway.evidence, ...levers.map(leverEvidence), ...(caveats.unverified ? levers.flatMap((lever) => (lever.bridge ? [lever.bridge.what] : [])) : [])],
    locked: RETIREMENT_RULE,
    reach: reachOf(checks, inPicker),
    ...(caveats.unverified ? { sdk_unverified: { identifier: caveats.unverified.identifier, sdks: caveats.unverified.sdks.map(sdkLabel) } } : {}),
  };
}

const MAX_CHAIN = 6;

/** Where a named successor ends up: one that's gone or going gives way to what its maker names after it. Nothing at all when the chain ends on a dead model. */
function followSuccessor(name: string, context: FindingsContext, seen: readonly string[] = []): string[] {
  const row = context.retirements ? findRetirement(name, context.retirements) : null;
  if (!row || row.routed_to || seen.includes(name) || seen.length >= MAX_CHAIN) return [name];
  if (row.successors.length === 0) return context.asOf && statusAsOf(row, context.asOf) === 'retired' ? [] : [name];
  return unique(row.successors.flatMap((next) => followSuccessor(next, context, [...seen, name])));
}

/** What each id on a finding moves to, for a Do line built from what's really in this repo. */
export function moveTable(checks: readonly ModelCheck[], context: FindingsContext): Move[] {
  return checks.filter((check) => check.live_places.length > 0 && !check.routed_to).map((check) => {
    const named = namedSuccessors(check, context);
    const direct = named.length ? named : mappedSuccessors(check, context);
    return { from: check.model, to: unique(direct.flatMap((name) => followSuccessor(name, context))), places: check.live_places.map((place) => `${place.file}:${place.line}`) };
  });
}

/** One finding per lever. What's already gone or goes within a month is one job per provider, however many levers it spans. */
function groupKey(check: ModelCheck, context: FindingsContext | undefined): string {
  if (!context?.levers || !context.asOf) return check.provider;
  const dueNow = check.effective ? check.effective <= addDays(context.asOf, URGENT_DAYS) : check.status === 'retired' || Boolean(check.earliest_date);
  if (dueNow) return `${check.provider}\0now`;
  return `${check.provider}\0${leversFor([check], context)[0]?.id ?? 'later'}`;
}

function modelGroups(live: readonly ModelCheck[], context: FindingsContext | undefined): ModelCheck[][] {
  const groups = new Map<string, ModelCheck[]>();
  for (const check of live) {
    const key = groupKey(check, context);
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  return [...groups.values()];
}

function dependencyWhere(check: DependencyCheck, context: FindingsContext): Where[] {
  return check.places.map(({ file, line }) => ({ file, line, text: context.lineText(file, line).trim() }));
}

/** Another dependency that turns this library on through its own features, such as a fork that carries it. It moves too. */
function carriers(check: DependencyCheck, context: FindingsContext): Where[] {
  const wanted = `"${check.name}"`;
  return unique(check.places.map((place) => place.file)).flatMap((file) => (context.files?.get(file)?.split('\n') ?? []).flatMap((text, index) => {
    const isOwn = check.places.some((place) => place.file === file && place.line === index + 1);
    return !isOwn && text.includes(wanted) && /\bfeatures\s*=/.test(text) ? [{ file, line: index + 1, text: text.trim() }] : [];
  }));
}

function dependencyWhy(check: DependencyCheck): string {
  const place = check.places.map(({ file, line }) => `${file}:${line}`).join(' and ');
  const verb = check.places.length === 1 ? 'declares' : 'declare';
  const declared = check.declared_date ? `, released ${humanDate(check.declared_date)}` : '';
  return `${place} ${verb} ${check.spec}${declared}. The latest is ${check.latest}, released ${humanDate(check.latest_date as string)}.`;
}

function gainsLine(gains: readonly Gain[]): string {
  return gains.length ? `Its release notes list: ${gains.map((gain) => `${gain.text} (${gain.version})`).join('; ')}. Nobody has measured these on this product.` : '';
}

function specLine(check: DependencyCheck): string {
  const spec = check.release_notes?.spec ?? [];
  if (spec.length === 0) return '';
  return `Its release notes add spec versions yours doesn't have: ${spec.map((item) => `${item.spec} (${item.version})`).join(' and ')}.`;
}

function notGainLine(notGains: readonly NotGain[]): string {
  return notGains.map((item) => `Not a gain here, as written: ${item.text}. ${item.why}`.trim()).join(' ');
}

function isMarked(gain: Gain, notGains: readonly NotGain[]): boolean {
  const text = gain.text.toLowerCase();
  return notGains.some((item) => text.includes(item.text.toLowerCase()) || item.text.toLowerCase().includes(text));
}

function carrierLine(places: readonly Where[], name: string): string {
  return places.length ? `${places.map((place) => `${place.file}:${place.line}`).join(' and ')} also ${places.length === 1 ? 'carries' : 'carry'} its own ${name} feature, so that moves too.` : '';
}

const NO_MENTION = 'Nothing in the code that uses this library mentions it.';
const NOTE_WORD = /[a-z][a-z-]{3,}/g;
const NOTE_STOP = new Set(['support', 'client', 'server', 'with', 'from', 'that', 'this', 'into', 'when', 'after', 'allow', 'adds', 'make', 'default', 'option', 'exchange', 'request', 'requests', 'tools', 'call', 'read', 'tokens']);

/** A new feature only counts if this code has anything to do with it. A fix counts regardless, because it fixes what's already there. */
function unusedFeatures(check: DependencyCheck, context: FindingsContext): NotGain[] {
  const users = [...(context.files ?? [])].filter(([, text]) => text.includes(`${check.name}::`) || text.includes(`"${check.name}"`) || text.includes(`'${check.name}'`)).map(([, text]) => text.toLowerCase());
  if (users.length === 0) return [];
  return (check.release_notes?.gains ?? []).filter((gain) => gain.kind === 'add').flatMap((gain) => {
    const words = (gain.text.toLowerCase().match(NOTE_WORD) ?? []).filter((word) => !NOTE_STOP.has(word));
    return words.some((word) => users.some((text) => text.includes(word))) ? [] : [{ text: gain.text, why: NO_MENTION }];
  });
}

export function dependencyFinding(check: DependencyCheck, context: FindingsContext, judged: readonly NotGain[] = []): Finding {
  const notGains = [...unusedFeatures(check, context), ...judged];
  const all = check.release_notes?.gains ?? [];
  const gains = all.filter((gain) => !isMarked(gain, notGains));
  const marked = all.filter((gain) => isMarked(gain, notGains)).map((gain) => ({ text: `${gain.text} (${gain.version})`, why: notGains.find((item) => isMarked(gain, [item]))?.why ?? '' }));
  const fixes = gains.some((gain) => gain.kind === 'fix');
  const carried = carriers(check, context);
  const spec = check.release_notes?.spec ?? [];
  const lead = gains[0] ? `: ${gains[0].text} (${gains[0].version})` : spec[0] ? `: it doesn't have the ${spec[0].spec} spec version (${spec[0].version})` : '';
  return {
    title: `${check.name} is ${check.majors_behind} major versions behind${lead}`,
    effect: [fixes ? 'keeps working' : 'new capability'],
    proof: 'vendor claim',
    effort: 'A project',
    where: [...dependencyWhere(check, context), ...carried],
    why: [dependencyWhy(check), gainsLine(gains), specLine(check), notGainLine(marked), carrierLine(carried, check.name)].filter(Boolean).join(' '),
    options: [],
    sources: unique([check.source, check.release_notes?.url].flatMap((url) => (url ? [url] : []))),
    lever: null,
    pr: null,
    deadline: null,
    evidence: [check.spec, ...[check.latest, check.latest_date, check.declared_date].flatMap((value) => (value ? [value] : [])), ...all.map((gain) => `${gain.text} ${gain.version}`), ...spec.map((item) => `${item.text} ${item.spec} ${item.version}`), fixes ? 'fix' : 'add'],
    ...(PROTOCOL_LIBRARY.test(check.name) ? { locked: PROTOCOL_RULE } : {}),
  };
}

/** Age alone is never a finding: it takes release notes that name what the code would get. */
function isDependencyFinding(check: DependencyCheck): boolean {
  if (!AI_LIBRARY.test(check.name) || !check.latest || !check.latest_date) return false;
  return check.status === 'behind' && check.majors_behind >= MIN_MAJORS_BEHIND && (check.release_notes?.gains.length ?? 0) > 0;
}

function olderDependencyRow(check: DependencyCheck): HeldBack[] {
  if (!AI_LIBRARY.test(check.name) || !check.latest || !check.latest_date || isDependencyFinding(check)) return [];
  if (check.status === 'behind' && check.majors_behind >= MIN_MAJORS_BEHIND) {
    return [{ thing: `${check.name} is ${check.majors_behind} major versions behind`, date: check.latest_date, reason: 'Being behind isn\'t enough, and no release notes were read that name what this code would gain.', source: check.source }];
  }
  if (check.stale) return [{ thing: `${check.name} has had no release since ${humanDate(check.latest_date)}`, date: check.latest_date, reason: 'Nothing here shows it failing, so it only matters when another change needs it moved.', source: check.source }];
  return [];
}

/** A range that allows a release says nothing about what's installed, so the lockfile gets its say, and a protocol library's notes with it. */
function rangeReason(check: DependencyCheck): string {
  const { file, line } = check.places[0];
  const range = `Your range ${check.spec} (${file}:${line})`;
  if (!check.locked || check.locked.version === check.latest) return `${range} already allows it${check.locked ? `, and ${check.locked.file}:${check.locked.line} installs it` : ''}.`;
  const between = (check.release_notes?.gains ?? []).filter((gain) => /redirect|secur|vulnerab|auth/i.test(gain.text)).slice(0, 1);
  const named = between.length ? ` Between those, its release notes name: ${between[0].text} (${between[0].version}). keepup doesn't read advisories, so that one is a person's call.` : '';
  return `${range} allows it, but ${check.locked.file}:${check.locked.line} installs ${check.locked.version}.${named}`;
}

function dependencyHeldBack(check: DependencyCheck, context: FindingsContext): HeldBack[] {
  const inWindow = check.latest_date !== null && check.latest_date >= context.window.since;
  if (check.status !== 'allowed-by-range' || check.stale || !inWindow || !AI_LIBRARY.test(check.name)) return olderDependencyRow(check);
  return [{ thing: `${check.name} ${check.latest}`, date: check.latest_date, reason: rangeReason(check), source: check.source }];
}

export function findingsFromExact(exact: readonly ExactResult[], context: FindingsContext): FloorResult {
  const models = exact.filter((item): item is ModelCheck => item.kind === 'model');
  const dependencies = exact.filter((item): item is DependencyCheck => item.kind === 'dependency');
  const whole: FindingsContext = { ...context, allModels: models, dependencies };
  const live = models.filter((check) => check.live_places.length > 0 && !check.routed_to);
  const findings = modelGroups(live, whole).map((checks) => modelFinding(checks, whole));
  const onAFinding = new Set(findings.flatMap((finding) => finding.where.map((place) => `${place.file}:${place.line}`)));
  const named = new Set(findings.flatMap((finding) => finding.sdk_unverified?.sdks ?? []));
  const heldDependencies = dependencies.filter((check) => !named.has(sdkLabel(check)));
  return {
    findings: [...findings, ...dependencies.filter(isDependencyFinding).map((check) => dependencyFinding(check, whole))],
    watching: [],
    held_back: [
      ...modelHeldBack(models.filter((check) => !check.not_live.some((place) => onAFinding.has(`${place.file}:${place.line}`) && place.route === 'gateway'))),
      ...heldDependencies.flatMap((check) => dependencyHeldBack(check, whole)),
    ],
    rebuild: (checks) => modelFinding(checks, whole),
    rebuildDependency: (check, notGains) => (isDependencyFinding(check) ? dependencyFinding(check, whole, notGains) : null),
    moves: moveTable(live, whole),
  };
}
