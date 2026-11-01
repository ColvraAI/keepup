// Prices and the agent model, read from their sources and never typed. A price that
// can't be found throws, so a lab table can't print a guess.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DB_FETCHED, openRouterPrice } from '../shared/prices.ts';

/** Dollars per million tokens. Cached and cache-write tokens are billed at their own rate. */
export interface Rates {
  label: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  source: string;
  fetched: string;
}

const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing';
const OPENAI_CHANGELOG_URL = 'https://developers.openai.com/api/docs/changelog';
const OPENAI_DECISIONS_URL = 'https://developers.openai.com/api/docs/guides/decisions';
const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const TYPESAFE_MODELS_URL = 'https://docs.typesafe.ai/models';

const vendorPath = (root: string, name: string) => join(root, 'tmp', 'vendor-docs', name);
const readVendor = (root: string, name: string) => readFileSync(vendorPath(root, name), 'utf8');
const fetchedOn = (root: string, name: string) => statSync(vendorPath(root, name)).mtime.toISOString().slice(0, 10);

const cells = (row: string) => row.split('|').slice(1, -1).map((cell) => cell.trim());
const dollars = (cell: string) => Number(cell.replace(/[^0-9.]/g, ''));

/** The first row for a model on the pricing page, which is the Standard tier: input, output, cached, 30m write. */
function openAiRow(model: string, root: string): string[] {
  const row = readVendor(root, 'openai-pricing.md').split('\n').find((line) => line.startsWith(`| ${model} |`));
  if (!row) throw new Error(`no price for ${model} on the OpenAI pricing page`);
  return cells(row);
}

export function agentRates(model: string, root: string): Rates {
  const [, input, output, cached, write] = openAiRow(model, root);
  const inputRate = dollars(input);
  return {
    label: model,
    input: inputRate,
    output: dollars(output),
    cached: cached === '-' ? inputRate : dollars(cached),
    cacheWrite: write ? dollars(write) : inputRate,
    source: `OpenAI pricing page, Standard tier (${OPENAI_PRICING_URL})`,
    fetched: fetchedOn(root, 'openai-pricing.md'),
  };
}

/** Input from data/db, cached input from the changelog line, cache writes from the pricing page, and no charge for output. */
export function decisionsRates(root: string): Rates {
  const price = openRouterPrice('openai/gpt-6-luna', root);
  const changelog = gunzipSync(readFileSync(join(root, 'data', 'db', 'changelog-openai.txt.gz'))).toString('utf8');
  const line = changelog.match(/GPT-6 Luna: \$([\d.]+) input, \$([\d.]+) cached input/);
  if (!line) throw new Error('no GPT-6 Luna cached price in the OpenAI changelog');
  if (!readVendor(root, 'decisions.md').includes('Output tokens are not charged.')) throw new Error('the Decisions guide no longer says output is free');
  const [, , , , write] = openAiRow('gpt-6-luna', root);
  return {
    label: 'gpt-6-luna on /v1/decisions',
    input: price.inputPerMTok,
    cached: Number(line[2]),
    cacheWrite: dollars(write),
    output: 0,
    source: `${price.source}, OpenAI changelog (${OPENAI_CHANGELOG_URL}) 22 Sep line, OpenAI pricing page (${OPENAI_PRICING_URL}) for cache writes, Decisions guide (${OPENAI_DECISIONS_URL}) for free output`,
    fetched: DB_FETCHED,
  };
}

/** "claude-sonnet-4-6" is "Claude Sonnet 4.6" on the page: input, 5m write, 1h write, cache hits, output. */
export function anthropicRates(model: string, root: string): Rates {
  const name = model.replace(/^claude-/, 'Claude-').split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ').replace(/(\d) (\d)$/, '$1.$2');
  const row = readVendor(root, 'anthropic-pricing.md').split('\n').find((line) => line.startsWith(`| ${name} `));
  if (!row) throw new Error(`no price for ${model} on the Anthropic pricing page`);
  const [, input, write, , hits, output] = cells(row);
  return {
    label: model,
    input: dollars(input),
    cacheWrite: dollars(write),
    cached: dollars(hits),
    output: dollars(output),
    source: `Anthropic pricing page (${ANTHROPIC_PRICING_URL})`,
    fetched: fetchedOn(root, 'anthropic-pricing.md'),
  };
}

export function jevRates(root: string): Rates {
  const text = readVendor(root, 'typesafe-models.md');
  const match = text.match(/Price \(per Btok \/ per Mtok\) \| \\\$\d+ \/ \\\$([\d.]+)/);
  if (!match) throw new Error('no price for Jev on the TypeSafe models page');
  if (!text.includes('Output tokens are free.')) throw new Error('the TypeSafe models page no longer says output is free');
  const input = Number(match[1]);
  return {
    label: 'jev-1.14.0 on /v1/systemone',
    input,
    cached: input,
    cacheWrite: input,
    output: 0,
    source: `TypeSafe models page (${TYPESAFE_MODELS_URL})`,
    fetched: fetchedOn(root, 'typesafe-models.md'),
  };
}

const ONBOARDING_PATTERN = {
  openai: /process\.env\.OPEN_MODEL_PREF \|\| "([^"]+)"/,
  anthropic: /process\.env\.ANTHROPIC_MODEL_PREF \|\| "([^"]+)"/,
};

/**
 * The model onboarding preselects for a provider. The onboarding step renders
 * frontend/src/components/LLMSelection/OpenAiOptions, which selects OpenAiModelPref, and
 * server/models/systemSettings.js sets the default for that setting.
 */
export function onboardingModel(systemSettingsSource: string, provider: keyof typeof ONBOARDING_PATTERN): string {
  const match = systemSettingsSource.match(ONBOARDING_PATTERN[provider]);
  if (!match) throw new Error(`no onboarding default for ${provider} in systemSettings.js`);
  return match[1];
}

/** Whether OpenAI's deprecations page lists a shutdown for this model, and what it names instead. */
export function substituteFor(model: string, deprecationsPage: string): { shutdown: string; substitute: string } | null {
  const row = deprecationsPage.split('\n').find((line) => line.startsWith('|') && line.includes(`\`${model}\``));
  if (!row) return null;
  const parts = cells(row);
  const named = parts[parts.length - 1].match(/`([^`]+)`/);
  return named ? { shutdown: parts[0], substitute: named[1] } : null;
}
