// sandbox.sh's lock and its stop, with a stand-in for docker on PATH: no daemon, no containers.
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'sandbox.sh');
const temp = mkdtempSync(join(tmpdir(), 'keepup-sandbox-'));
after(() => rmSync(temp, { recursive: true, force: true }));

// run: says its arguments and stays up until killed. kill: says who, and ends the run.
const DOCKER = `#!/usr/bin/env bash
log="$(dirname "$0")/docker.log"
case "$1" in
  run)
    echo "run $*" >> "$log"
    echo $$ > "$(dirname "$0")/run.pid"
    if [ -n "\${DOCKER_EXIT:-}" ]; then exit "$DOCKER_EXIT"; fi
    trap 'exit 137' TERM
    while :; do sleep 0.02; done
    ;;
  kill)
    echo "kill $2" >> "$log"
    kill -TERM "$(cat "$(dirname "$0")/run.pid" 2>/dev/null)" 2>/dev/null || true
    ;;
esac
`;

let count = 0;
function scene() {
  count += 1;
  const root = join(temp, `s${count}`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'tree'));
  copyFileSync(SCRIPT, join(root, 'scripts', 'sandbox.sh'));
  writeFileSync(join(root, 'bin', 'docker'), DOCKER);
  chmodSync(join(root, 'bin', 'docker'), 0o755);
  const lock = join(root, 'tmp', '.sandbox-lock');
  return {
    root, lock,
    start: (env: Record<string, string> = {}) => spawn('bash', [join(root, 'scripts', 'sandbox.sh'), 'aura', join(root, 'tree'), 'true'], {
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, SANDBOX_LOCK_POLL: '0.02', ...env }, stdio: ['ignore', 'ignore', 'pipe'],
    }),
    log: () => (existsSync(join(root, 'bin', 'docker.log')) ? readFileSync(join(root, 'bin', 'docker.log'), 'utf8') : ''),
  };
}

const closed = (child: ChildProcess) => new Promise<number | null>((resolve) => child.on('close', resolve));

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) await delay(25);
  assert.ok(check(), what);
}

const DEAD_PID = '999999';

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  test(`${signal} kills the container and clears the lock at once, without waiting for docker run`, async () => {
    const s = scene();
    const child = s.start();
    const done = closed(child);
    await until(() => s.log().includes('run run'), 'the container started');
    assert.ok(existsSync(join(s.lock, 'pid')));
    child.kill(signal);
    assert.equal(await done, code);
    assert.match(s.log(), /kill keepup-sandbox-/);
    assert.ok(!existsSync(s.lock), 'the lock is gone');
  });
}

test('the container is named, its whole process group gets the signal, and an exit code passes through', async () => {
  const s = scene();
  const code = await closed(s.start({ DOCKER_EXIT: '7' }));
  assert.equal(code, 7);
  const line = s.log();
  assert.match(line, /--init --name keepup-sandbox-\d+-\d+ -e TINI_KILL_PROCESS_GROUP=1 /);
  assert.ok(!existsSync(s.lock), 'a run that ends clears its lock');
});

test('a lock whose holder died is cleared straight away, and what it left running is killed', async () => {
  const s = scene();
  mkdirSync(s.lock, { recursive: true });
  writeFileSync(join(s.lock, 'pid'), DEAD_PID);
  writeFileSync(join(s.lock, 'container'), 'keepup-sandbox-left-behind');
  const started = Date.now();
  const code = await closed(s.start({ DOCKER_EXIT: '0' }));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 5000, 'not forty minutes');
  assert.match(s.log(), /kill keepup-sandbox-left-behind/);
  assert.match(s.log(), /run run/);
});

test('a lock whose holder is alive is waited for, and says who holds it', async () => {
  const s = scene();
  const first = s.start();
  const firstDone = closed(first);
  await until(() => s.log().includes('run run'), 'the first run started');
  const second = s.start({ DOCKER_EXIT: '0' });
  let said = '';
  second.stderr?.on('data', (c: Buffer) => { said += c.toString(); });
  const secondDone = closed(second);
  await until(() => said.includes('waiting for the other run'), `it said so: ${said}`);
  assert.match(said, new RegExp(`pid ${first.pid}`));
  assert.equal(s.log().match(/run run/g)?.length, 1, 'never two containers at once');
  first.kill('SIGTERM');
  await firstDone;
  assert.equal(await secondDone, 0);
});

test('SANDBOX_NO_LOCK skips the queue, and a stop still kills its container', async () => {
  const s = scene();
  const child = s.start({ SANDBOX_NO_LOCK: '1' });
  const done = closed(child);
  await until(() => s.log().includes('run run'), 'started');
  assert.ok(!existsSync(s.lock));
  child.kill('SIGINT');
  assert.equal(await done, 130);
  assert.match(s.log(), /kill keepup-sandbox-/);
});
