// npm run record-check: runs the real `keepup check` on the pinned clones in tmp/, and saves the
// line it prints to data/recorded/keepup-check.json, which the Monday screen shows as written.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'data', 'recorded', 'keepup-check.json');
const TARGETS = [
  { repo: 'Mintplex-Labs/anything-llm', name: 'anything-llm', clone: 'tmp/anything-llm' },
  { repo: 'mezmo/aura', name: 'aura', clone: 'tmp/aura' },
];
const AS_OF = '2026-10-31';

export function checkLine(stdout: string): string {
  const lines = stdout.split('\n').filter(Boolean);
  const [line] = lines;
  if (lines.length !== 1 || !line?.startsWith('keepup:')) throw new Error('Expected exactly one keepup line from keepup check.');
  return line;
}

export function recordLine(input: { repo: string; name: string; clone: string; commit: string; asOf: string; stdout: string; recordedAt: string }) {
  return {
    repo: input.repo,
    name: input.name,
    commit: input.commit,
    as_of: input.asOf,
    command: `keepup check ${input.clone} --as-of ${input.asOf}`,
    line: checkLine(input.stdout),
    recorded_at: input.recordedAt,
  };
}

if (import.meta.main) {
  const lines = TARGETS.map((target) => {
    const path = join(ROOT, target.clone);
    if (!existsSync(path)) throw new Error(`No clone at ${target.clone}.`);
    const commit = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'keepup.ts'), 'check', path, '--as-of', AS_OF], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return recordLine({ repo: target.repo, name: target.name, clone: target.clone, commit, asOf: AS_OF, stdout, recordedAt: new Date().toISOString() });
  });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({ lines }, null, 1)}\n`);
  lines.forEach((line) => process.stdout.write(`${line.line}\n`));
}
