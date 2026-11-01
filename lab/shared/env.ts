// Loads .env without ever printing a value. A lab that lacks a key exits with
// code 3, so `npm run go` can tell "waiting on a key" apart from "broken".
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
export const EXIT_NEEDS_KEY = 3;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    if (value !== '') out[key] = value;
  }
  return out;
}

/** The environment with .env filled in underneath it. Real env vars win. */
export function loadEnv(root: string = REPO_ROOT, env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const path = join(root, '.env');
  const fromFile = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  return { ...fromFile, ...env };
}

export class NeedsKeyError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super(`Needs ${keys.join(' and ')} in .env. Nothing was measured.`);
    this.name = 'NeedsKeyError';
    this.keys = keys;
  }
}

export function requireKeys(keys: string[], env: Record<string, string | undefined> = loadEnv()): Record<string, string> {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new NeedsKeyError(missing);
  return Object.fromEntries(keys.map((k) => [k, env[k] as string]));
}
