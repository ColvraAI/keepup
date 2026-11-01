// Exact model-id extraction. The grammar is for ids as they appear in code and config.
// A display name like "Claude Sonnet 4.5" in prose is not an id, and `claude-code` isn't a model.

export type Provider = 'openai' | 'anthropic' | 'google' | 'other';
export type ModelRoute = 'direct' | 'bedrock' | 'gateway';

export interface ModelMention {
  readonly id: string;
  readonly route: ModelRoute;
}

const CLAUDE_FAMILIES = 'opus|sonnet|haiku|fable|mythos';
const ID_TAIL = '[a-z0-9.-]*';

const MODEL_SHAPES = [
  `claude-(?:${CLAUDE_FAMILIES})-[0-9]${ID_TAIL}`,
  `claude-[0-9](?:\\.[0-9]+)?(?:-[0-9])?(?:-(?:${CLAUDE_FAMILIES})${ID_TAIL})?`,
  `claude-instant${ID_TAIL}`,
  `gpt-[0-9]${ID_TAIL}`,
  `gpt-(?:image|live|realtime|transcribe|audio|oss)${ID_TAIL}`,
  `chatgpt-[0-9]${ID_TAIL}`,
  'whisper-[0-9]',
  'tts-[0-9](?:-hd)?(?:-[0-9]{4})?',
  'dall-e-[0-9]',
  `text-embedding-(?:ada|[0-9])${ID_TAIL}`,
  'text-(?:davinci|curie|babbage|ada)-[0-9]+',
  '(?:babbage|davinci)-[0-9]+',
  `(?:omni|text)-moderation-${ID_TAIL}`,
  `sora-[0-9]${ID_TAIL}`,
  `gemini-(?:[0-9]|omni|robotics|live|embedding|pro|flash|ultra|exp)${ID_TAIL}`,
  `(?:imagen|veo)-[0-9]${ID_TAIL}`,
  `embedding-[0-9]{3}`,
  `deep-research-[a-z]+-preview${ID_TAIL}`,
  `deepseek-(?:[a-z]+|v?[0-9])${ID_TAIL}`,
  `grok-[0-9]${ID_TAIL}`,
  `mistral-(?:small|medium|large|tiny|nemo)${ID_TAIL}`,
].join('|');

const MODEL_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${MODEL_SHAPES})(?![A-Za-z0-9_])`, 'g');
const O_SERIES_RE = /(?<=["'`])o[134](?:-(?:mini|preview|pro|deep-research))?(?:-\d{4}-\d{2}-\d{2})?(?=["'`])/g;
const FILE_SUFFIX = /\.(?:png|jpe?g|svg|webp|gif|js|ts|json|md|txt|py|rs|toml|ya?ml)$/;
const BEDROCK_SUFFIX = /-v[0-9]+$/;
const BEDROCK_PREFIX = /(?:^|[^\w.-])(?:[a-z]{2,4}\.)?(?:anthropic|amazon|meta|mistral)\.$/;
const GATEWAY_PREFIX = /(?:openai|anthropic|google|meta|mistralai|deepseek|x-ai)\/$/;

const QUICK_LOOK = /claude-|gpt-|gemini-|whisper-|tts-|dall-e-|embedding-|o[134]\b|-moderation-|sora-|imagen-|veo-|davinci|babbage|deep-research-|deepseek-|grok-|mistral-/;

function routeOf(before: string): ModelRoute {
  if (BEDROCK_PREFIX.test(before)) return 'bedrock';
  if (GATEWAY_PREFIX.test(before)) return 'gateway';
  return 'direct';
}

/** Strips what the id grammar over-reads: a trailing . or -, a file suffix, a Bedrock -v1. */
function cleanId(raw: string, route: ModelRoute): string | null {
  const trimmed = raw.replace(/[-.]+$/, '');
  if (FILE_SUFFIX.test(trimmed)) return null;
  return route === 'bedrock' ? trimmed.replace(BEDROCK_SUFFIX, '') : trimmed;
}

/** A cheap first look, so most lines of a big repo skip the full grammar. */
export function mayHoldModelId(line: string): boolean {
  return QUICK_LOOK.test(line);
}

export function findModelIds(line: string): ModelMention[] {
  const out: (ModelMention & { index: number })[] = [];
  for (const re of [MODEL_RE, O_SERIES_RE]) {
    for (const match of line.matchAll(re)) {
      const route = routeOf(line.slice(0, match.index));
      const id = cleanId(match[0], route);
      if (id) out.push({ id, route, index: match.index });
    }
  }
  return out.sort((a, b) => a.index - b.index).map(({ id, route }) => ({ id, route }));
}

const OPENAI_ID = /^(?:gpt-|chatgpt-|whisper-|tts-|dall-e-|text-embedding-(?:ada|3)|text-(?:davinci|curie|babbage|ada)-|babbage-|davinci-|omni-moderation|text-moderation|sora-|o[134](?:$|-))/;
const GOOGLE_ID = /^(?:gemini-|imagen-|veo-|embedding-|text-embedding-|deep-research-)/;

export function providerOf(id: string): Provider {
  if (id.startsWith('claude-')) return 'anthropic';
  if (OPENAI_ID.test(id)) return 'openai';
  if (GOOGLE_ID.test(id)) return 'google';
  return 'other';
}

/**
 * The name Anthropic's release notes use for an id, because some retirements name no id:
 * "We've retired the Claude 2.0, Claude 2.1, and Claude Sonnet 3 models."
 */
export function claudeDisplayName(id: string): string | null {
  const familyFirst = id.match(new RegExp(`^claude-(${CLAUDE_FAMILIES})-(\\d+)(?:-(\\d{1,2}))?(?=-|$)`));
  if (familyFirst) return formatClaude(familyFirst[1], familyFirst[2], familyFirst[3]);
  const versionFirst = id.match(new RegExp(`^claude-(\\d+)(?:-(\\d{1,2}))?-(${CLAUDE_FAMILIES})(?=-|$)`));
  if (versionFirst) return formatClaude(versionFirst[3], versionFirst[1], versionFirst[2]);
  const bare = id.match(/^claude-(\d+(?:\.\d+)?)(?:-|$)/);
  return bare ? `Claude ${bare[1]}` : null;
}

function formatClaude(family: string, major: string, minor?: string): string {
  const name = family[0].toUpperCase() + family.slice(1);
  return `Claude ${name} ${major}${minor ? `.${minor}` : ''}`;
}
