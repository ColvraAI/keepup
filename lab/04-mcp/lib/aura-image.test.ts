import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { auraCommandFor, ensureAuraFromImage, type Docker } from './aura-image.ts';

const IMAGE = 'mezmo/aura:0.2.18-nightly.9@sha256:640e2f9cc12e3ef324fdf5a4c985dd4b5c61bf18072025a20a32a7c2d395751c';
const BINARY = 'not really an elf';
const options = (binDir: string) => ({ binDir, arch: 'arm64', image: IMAGE, name: 'v0.2.18-nightly.9' });
const newBinDir = () => join(mkdtempSync(join(tmpdir(), 'keepup-aura-image-')), 'bin');

/** Stands in for the docker command: `cp` lays out what the real image holds. */
function fakeDocker(calls: string[][], failOn: string | null = null): Docker {
  return (args) => {
    calls.push([...args]);
    if (args[0] === failOn) throw new Error(`docker ${failOn} failed`);
    if (args[0] === 'create') return 'container-id\n';
    if (args[0] !== 'cp') return '';
    const dest = args[2];
    mkdirSync(dirname(dest), { recursive: true });
    if (args[1].endsWith('/aura')) {
      writeFileSync(dest, BINARY);
      return '';
    }
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'ld-linux-aarch64.so.1'), 'loader');
    return '';
  };
}

test('it copies the binary and libraries out of the pinned image, for the sandbox architecture, and never starts it', () => {
  const calls: string[][] = [];
  const install = ensureAuraFromImage(options(newBinDir()), fakeDocker(calls));
  assert.deepEqual(calls.map((c) => c[0]), ['pull', 'create', 'cp', 'cp', 'rm']);
  assert.ok(calls.every((c) => !['run', 'start', 'exec'].includes(c[0])), 'nothing from the image runs on the host');
  assert.deepEqual(calls[0], ['pull', '--quiet', '--platform', 'linux/arm64', IMAGE]);
  assert.deepEqual(calls[1], ['create', '--platform', 'linux/arm64', IMAGE]);
  assert.equal(calls[2][1], 'container-id:/app/aura');
  assert.equal(calls[3][1], 'container-id:/usr/lib/aarch64-linux-gnu');
  assert.deepEqual(calls[4], ['rm', 'container-id']);
  assert.equal(readFileSync(install.binary, 'utf8'), BINARY);
  assert.ok(existsSync(install.loader));
  assert.equal(install.image, IMAGE);
  assert.match(install.binarySha256, /^[0-9a-f]{64}$/);
});

test('in the sandbox it runs through the image\'s own loader and libraries', () => {
  const install = ensureAuraFromImage(options(newBinDir()), fakeDocker([]));
  const toSandbox = (path: string) => `/sandbox${path.slice(path.lastIndexOf('/bin/'))}`;
  const dir = '/sandbox/bin/v0.2.18-nightly.9-arm64';
  assert.deepEqual(auraCommandFor(install, toSandbox), [`${dir}/lib/ld-linux-aarch64.so.1`, '--library-path', `${dir}/lib`, `${dir}/aura`]);
});

test('a copy that still matches is reused, with no call to docker', () => {
  const binDir = newBinDir();
  const first = ensureAuraFromImage(options(binDir), fakeDocker([]));
  const calls: string[][] = [];
  assert.deepEqual(ensureAuraFromImage(options(binDir), fakeDocker(calls)), first);
  assert.deepEqual(calls, []);
});

test('a binary that changed on disk, or another image, is copied again', () => {
  const binDir = newBinDir();
  const first = ensureAuraFromImage(options(binDir), fakeDocker([]));
  writeFileSync(first.binary, 'tampered');
  const calls: string[][] = [];
  assert.equal(readFileSync(ensureAuraFromImage(options(binDir), fakeDocker(calls)).binary, 'utf8'), BINARY);
  assert.ok(calls.length > 0);
  const other: string[][] = [];
  assert.equal(ensureAuraFromImage({ ...options(binDir), image: `${IMAGE}0` }, fakeDocker(other)).image, `${IMAGE}0`);
  assert.ok(other.length > 0);
});

test('a copy that fails removes the container and leaves nothing that could be reused', () => {
  const binDir = newBinDir();
  const calls: string[][] = [];
  assert.throws(() => ensureAuraFromImage(options(binDir), fakeDocker(calls, 'cp')), /docker cp failed/);
  assert.deepEqual(calls[calls.length - 1], ['rm', 'container-id']);
  const again: string[][] = [];
  ensureAuraFromImage(options(binDir), fakeDocker(again));
  assert.ok(again.length > 0, 'nothing half-copied counted as a copy');
});

test('an architecture with no known layout is refused before docker is called', () => {
  const calls: string[][] = [];
  assert.throws(() => ensureAuraFromImage({ ...options(newBinDir()), arch: 's390x' }, fakeDocker(calls)), /s390x/);
  assert.deepEqual(calls, []);
});
