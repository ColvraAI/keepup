// npm run clones: the repos the published runs read, at the pinned commits, under tmp/. keepup refuses a partial clone,
// so this fetches a full shallow copy of one commit. It uses the network and touches nothing that already exists.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED: readonly { readonly dir: string; readonly remote: string; readonly commit: string }[] = [
  { dir: 'tmp/anything-llm', remote: 'https://github.com/Mintplex-Labs/anything-llm.git', commit: '9caf2b4c29d9782f1cba4142be2525ebfa0ecd43' },
  { dir: 'tmp/aura', remote: 'https://github.com/mezmo/aura.git', commit: '5efb4e8b1c00d4d3d03d28e89d1500238904fd35' },
  { dir: 'tmp/full/bolt.new', remote: 'https://github.com/stackblitz/bolt.new.git', commit: 'eda10b121221b30825a4c16eec5da1fd3eb1eb99' },
  { dir: 'tmp/full/farfalle', remote: 'https://github.com/rashadphz/farfalle.git', commit: 'a9dd4939d21f4da6bb3ef7de138caba0f2ffab13' },
];

const ROOT = join(import.meta.dirname, '..');

function fetchOne(dir: string, remote: string, commit: string): void {
  const path = join(ROOT, dir);
  if (existsSync(join(path, '.git'))) {
    process.stdout.write(`clones: ${dir} is already there\n`);
    return;
  }
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  git('init', '-q');
  git('remote', 'add', 'origin', remote);
  git('fetch', '-q', '--depth', '1', 'origin', commit);
  git('update-ref', 'HEAD', 'FETCH_HEAD');
  process.stdout.write(`clones: ${dir} at ${commit.slice(0, 7)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const { dir, remote, commit } of PINNED) fetchOne(dir, remote, commit);
}
