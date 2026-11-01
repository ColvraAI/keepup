// .env edits for setup: other lines survive, empty keys fill in place, set keys stay unless asked.
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './objects.ts';

export interface EnvUpdate { written: string[]; kept: string[] }

const KEY = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function updateEnvFile(path: string, values: Record<string, string>, opts: { overwrite?: boolean } = {}): EnvUpdate {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const seen = new Set<string>();
  const written: string[] = [];
  const kept: string[] = [];
  const next = lines.map((line) => {
    const match = line.match(KEY);
    const key = match?.[1];
    if (!key || !(key in values)) return line;
    seen.add(key);
    const hasValue = (match?.[2] ?? '').trim() !== '';
    if (hasValue && !opts.overwrite) {
      kept.push(key);
      return line;
    }
    written.push(key);
    return `${key}=${values[key]}`;
  });
  const added = Object.keys(values).filter((k) => !seen.has(k));
  writeFileAtomic(path, `${[...next, ...added.map((k) => `${k}=${values[k]}`)].join('\n')}\n`, 0o600);
  return { written: [...written, ...added], kept };
}
