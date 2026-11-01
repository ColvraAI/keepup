// npm run lab -- <id> [--dry-run]
// Finds lab/<id>-*/run.ts and runs it. Exit code 3 means it is waiting on a key.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LAB_ROOT = import.meta.dirname;

export function findLab(id: string, root: string = LAB_ROOT): string | null {
  const dir = readdirSync(root, { withFileTypes: true }).find((d) => d.isDirectory() && d.name.startsWith(`${id}-`));
  if (!dir) return null;
  const script = join(root, dir.name, 'run.ts');
  return existsSync(script) ? script : null;
}

if (import.meta.main) {
  const [id, ...rest] = process.argv.slice(2);
  if (!id) {
    console.error('Usage: npm run lab -- <id> [--dry-run]');
    process.exit(2);
  }
  const script = findLab(id);
  if (!script) {
    console.error(`No lab found for ${id} (looked for lab/${id}-*/run.ts).`);
    process.exit(2);
  }
  const run = spawnSync(process.execPath, [script, ...rest], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
