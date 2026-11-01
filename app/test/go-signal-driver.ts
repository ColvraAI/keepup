// A real go, over real processes, for go-long.test.ts to send signals to. Each step is a process that
// writes its pid and sleeps, so the test can tell a step that started from one that didn't.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGo, type GoStep } from '../src/go.ts';
import { runCommand } from '../src/go-runner.ts';

const dir = process.argv[2];
const CHILD = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
let count = 0;

function fakeLab(): void {
  writeFileSync(join(dir, 'lab', '01-x', 'run.ts'), '');
}

const { mkdirSync } = await import('node:fs');
mkdirSync(join(dir, 'lab', '01-x'), { recursive: true });
mkdirSync(join(dir, 'lab', '02-x'), { recursive: true });
fakeLab();
writeFileSync(join(dir, 'lab', '02-x', 'run.ts'), '');

const code = await runGo({}, {
  root: dir,
  env: {},
  log: (line) => process.stdout.write(`${line}\n`),
  runner: (step: GoStep) => {
    count += 1;
    return runCommand(process.execPath, ['-e', CHILD, join(dir, `step-${count}.pid`)], { cwd: dir, limitMs: 60_000, log: () => undefined, label: step.script });
  },
});
process.exit(code);
