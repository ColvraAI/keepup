// A `git` first on PATH that logs its arguments and environment, then runs the real one.
// It sees what app/src/git.ts really hands to child processes, which no fake server can.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './world.ts';

const SHELL_ADDED = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);

export interface GitSpy {
  around: <T>(work: () => Promise<T>) => Promise<T>;
  argv: () => string[][];
  envDump: () => string;
  envNames: () => string[];
}

export function gitSpy(): GitSpy {
  const dir = tempDir('keepup-gitspy-');
  const argvLog = join(dir, 'argv');
  const envLog = join(dir, 'env');
  const realPath = process.env.PATH ?? '';
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nprintf '%s\\037' "$@" >> '${argvLog}'\nprintf '\\036' >> '${argvLog}'\nenv >> '${envLog}'\nPATH='${realPath}' exec git "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755);
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  return {
    around: async (work) => {
      process.env.PATH = `${dir}:${realPath}`;
      try {
        return await work();
      } finally {
        process.env.PATH = realPath;
      }
    },
    argv: () => read(argvLog).split('\x1e').filter(Boolean).map((line) => line.split('\x1f').filter(Boolean)),
    envDump: () => read(envLog),
    envNames: () => [...new Set(read(envLog).split('\n').map((l) => l.split('=')[0]).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !SHELL_ADDED.has(n) && !n.startsWith('__CF')))],
  };
}
