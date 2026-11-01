// Raw outputs are committed, so nothing is saved without passing through here: every
// value of a named key, then anything shaped like a credential.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SECRET_NAMES = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SENTRY_ACCESS_TOKEN', 'SIGNOZ_API_KEY', 'PAGERDUTY_API_TOKEN', 'BRIDGE_TOKEN'] as const;

const SHORTEST_SECRET = 6;
const SCRUBBED = '[scrubbed]';
const SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bsntry[a-z]*_[A-Za-z0-9_=+/-]{8,}/g,
  /\bdt0[a-z]\d\d\.[A-Za-z0-9.]{8,}/g,
  /\b(Sentry-Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/g,
  /(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Token)\s+)[^\s"']+/gi,
  /("apiToken"\s*:\s*")[^"]+/g,
  /(SIGNOZ-API-KEY\s*:\s*)\S+/gi,
];

function dynatraceTokens(configs: string | undefined): string[] {
  if (!configs) return [];
  try {
    const parsed: unknown = JSON.parse(configs);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c: { apiToken?: unknown }) => c.apiToken).filter((t): t is string => typeof t === 'string');
  } catch {
    return [configs];
  }
}

/** The secret values in an environment, read by name so a log can't hide one. */
export function secretsFrom(env: Record<string, string | undefined>): string[] {
  const named = SECRET_NAMES.map((name) => env[name]).filter((v): v is string => Boolean(v));
  return [...named, ...dynatraceTokens(env.DT_ENVIRONMENT_CONFIGS)];
}

function keepPrefix(match: string, prefix: unknown): string {
  return typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${/\s$/.test(prefix) || prefix.endsWith('"') ? '' : ' '}${SCRUBBED}` : SCRUBBED;
}

export function scrub(text: string, secrets: readonly string[]): string {
  const long = secrets.filter((s) => s.length >= SHORTEST_SECRET);
  const forms = long.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
  const byValue = forms.reduce((out, form) => out.split(form).join(SCRUBBED), text);
  return SHAPES.reduce((out, shape) => out.replace(shape, (match, prefix) => keepPrefix(match, prefix)), byValue);
}

/** The only way a raw output reaches the disk. */
export function saveRaw(file: string, content: unknown, secrets: readonly string[]): void {
  const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, scrub(text, secrets));
}
