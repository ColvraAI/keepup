// The held-back rows for model ids with no live place. A row states what's true of every place the id is in, not only the
// first, because a reason that's right for one line can be false for the id: "nothing sends it" while a gateway default does.
import { humanDate } from './dates.ts';
import type { ModelCheck, NotLivePlace } from './exact-checks.ts';
import type { HeldBack } from './run-shape.ts';

export const PROVIDER_NAMES: Readonly<Record<ModelCheck['provider'], string>> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google' };

export function earliestDeadline(checks: readonly ModelCheck[]): string | null {
  const dates = checks.flatMap((check) => (check.effective ? [check.effective] : [])).sort();
  return dates[0] ?? null;
}

const REASONS: Readonly<Record<NotLivePlace['why'], string>> = {
  test: "It's in a test, so nothing ever sends it to the API.",
  comment: "It's only in a comment, so nothing sends it.",
  docs: "It's in the docs, not in code that runs.",
  bedrock: 'This id goes through Amazon Bedrock, and the announcement covers the provider\'s own API.',
  gateway: "A gateway serves this id, and keepup can't see its plan, so check with them.",
  catalog: "It's listed in a table of known models, and nothing imports that table to send it.",
  limits: "It's in a table of model sizes, and an entry there sends nothing.",
  display: "It's text shown to a person, so nothing sends it.",
  exclusion: "It's on a list of models the code refuses, so nothing sends it.",
  tokenizer: 'It only picks a tokenizer, so nothing sends it to the provider.',
  label: "It's only the label on a token-limit choice in a menu, so nothing sends it.",
  example_script: "It's in a developer's example script that nothing in the app loads, so the product never sends it.",
};
const GROUP_REASONS: Partial<Record<NotLivePlace['why'], string>> = {
  catalog: "They're listed in a table of known models, and nothing imports that table to send one.",
  limits: "They're in a table of model sizes, and an entry there sends nothing.",
  exclusion: "They're on a list of models the code refuses, so nothing sends them.",
};
const SHORT: Readonly<Record<NotLivePlace['why'], string>> = {
  test: 'a test', comment: 'a comment', docs: 'the docs', bedrock: 'Amazon Bedrock', gateway: 'a gateway', catalog: 'an unused table', limits: 'a table of sizes',
  display: 'text shown to a person', exclusion: 'a refused list', tokenizer: 'a tokenizer lookup', label: 'a menu label', example_script: 'an example script',
};
const GATEWAY_NAMES: readonly (readonly [RegExp, string])[] = [
  [/cometapi/i, 'CometAPI'], [/openrouter/i, 'OpenRouter'], [/litellm/i, 'LiteLLM'], [/azure/i, 'Azure'], [/lemonade/i, 'Lemonade'], [/lmstudio/i, 'LM Studio'],
  [/ollama/i, 'Ollama'], [/groq/i, 'Groq'], [/together/i, 'Together'], [/fireworks/i, 'Fireworks'], [/deepinfra/i, 'DeepInfra'], [/novita/i, 'Novita'], [/foundry/i, 'Foundry'],
  [/generic|compatible/i, 'an OpenAI-compatible server'], [/docker/i, 'Docker Model Runner'], [/nvidia/i, 'NVIDIA'], [/perplexity/i, 'Perplexity'], [/mistral/i, 'Mistral'], [/deepseek/i, 'DeepSeek'],
];

function gatewayName(file: string): string {
  return GATEWAY_NAMES.find(([re]) => re.test(file))?.[1] ?? 'a gateway';
}

function testReason(place: NotLivePlace): string {
  return place.test_block_line
    ? `It's a test fixture inside \`#[cfg(test)]\` (line ${place.test_block_line}), so nothing ever sends it to the API.`
    : REASONS.test;
}

function reasonFor(place: NotLivePlace): string {
  return place.why === 'test' ? testReason(place) : REASONS[place.why];
}

function statusWord(check: ModelCheck): string {
  if (check.status === 'retired') return 'a retired';
  return check.status === 'retiring' ? 'a retiring' : 'a deprecated';
}

function list(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Any code path through a gateway outranks "nothing sends it", because something does. */
function gatewayPlaces(check: ModelCheck): NotLivePlace[] {
  return check.not_live.filter((place) => place.why === 'gateway' && !place.commented);
}

/** What the maker said about this id. Nothing read says what a gateway will do, so that's left for them to answer. */
function makerSays(check: ModelCheck): string {
  const maker = PROVIDER_NAMES[check.provider];
  const when = check.effective ? `${check.earliest ? 'no earlier than' : 'on'} ${humanDate(check.effective)}` : '';
  if (check.status === 'retired') return `${maker} retired this id${when ? ` ${when}` : ''}`;
  if (check.status === 'retiring') return `${maker} retires this id ${when}`;
  return `${maker} has deprecated this id`;
}

function planOf(names: readonly string[]): string {
  if (names.length !== 1) return "keepup can't see their plans";
  return /^an? /.test(names[0]) ? "keepup can't see its plan" : `keepup can't see ${names[0]}'s plan`;
}

function gatewayReason(check: ModelCheck, places: readonly NotLivePlace[], others: readonly NotLivePlace[]): string {
  const found = [...new Set(places.map((place) => gatewayName(place.file)))];
  const named = found.filter((name) => name !== 'a gateway');
  const names = named.length ? named : found;
  const rest = [...new Set(others.filter((place) => place.why !== 'gateway').map((place) => SHORT[place.why]))];
  const sent = `Sent through ${list(names)}. ${makerSays(check)}, and ${planOf(names)}, so check with ${names.length === 1 && /^an? /.test(names[0]) ? 'whoever runs it' : 'them'}.`;
  return rest.length ? `${sent} Its other places are ${list(rest)}.` : sent;
}

function primaryPlace(check: ModelCheck): NotLivePlace {
  return gatewayPlaces(check)[0] ?? check.not_live.find((place) => place.why === 'example_script') ?? check.not_live.find((place) => place.test_block_line) ?? check.not_live[0];
}

function singleReason(check: ModelCheck, place: NotLivePlace): string {
  const gateway = gatewayPlaces(check);
  if (gateway.length) return gatewayReason(check, gateway, check.not_live);
  const others = [...new Set(check.not_live.filter((other) => other.why !== place.why).map((other) => SHORT[other.why]))];
  return others.length ? `${reasonFor(place)} Its other places are ${list(others)}.` : reasonFor(place);
}

function routedRow(check: ModelCheck): HeldBack {
  const place = check.live_places[0] ?? check.not_live[0];
  return {
    thing: `${check.model}, a deprecated model, in ${place.file}:${place.line}`,
    date: check.announced,
    reason: `${PROVIDER_NAMES[check.provider]} says ${check.routed_sentence}, so nothing breaks. Update the name to ${check.routed_to} when you next touch it.`,
    source: check.source,
  };
}

function groupKeyOf(check: ModelCheck, place: NotLivePlace): string {
  return GROUP_REASONS[place.why] && gatewayPlaces(check).length === 0 ? `${check.provider}\0${place.file}\0${place.why}` : check.model;
}

/** One row each, except that a shared table gets one row for all its ids. A model the provider auto-routes gets a row even when it's live. */
export function modelHeldBack(checks: readonly ModelCheck[]): HeldBack[] {
  const routed = checks.filter((check) => check.routed_to && (check.live_places.length > 0 || check.not_live.length > 0));
  const groups = new Map<string, { place: NotLivePlace; checks: ModelCheck[] }>();
  for (const check of checks.filter((c) => !c.routed_to && c.live_places.length === 0 && c.not_live.length > 0)) {
    const place = primaryPlace(check);
    const key = groupKeyOf(check, place);
    const group = groups.get(key) ?? { place, checks: [] };
    groups.set(key, { place: group.place, checks: [...group.checks, check] });
  }
  const rows = [...groups.values()].map(({ place, checks: grouped }) => ({
    thing: grouped.length === 1
      ? `${grouped[0].model}, ${statusWord(grouped[0])} model, in ${place.file}:${place.line}`
      : `${grouped.length} ${PROVIDER_NAMES[grouped[0].provider]} model ids in ${place.file}`,
    date: earliestDeadline(grouped) ?? grouped[0].announced,
    reason: grouped.length === 1 ? singleReason(grouped[0], place) : GROUP_REASONS[place.why] ?? reasonFor(place),
    source: grouped[0].source,
  }));
  return [...rows, ...routed.map(routedRow)];
}
