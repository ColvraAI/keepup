import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetForArch, ensureBinary, parseChecksums, releaseUrl, type FetchBytes } from './aura-binary.ts';

const TAG = 'v0.0.0-test';
const BYTES = new TextEncoder().encode('pretend this is the aura binary');
const SUM = createHash('sha256').update(BYTES).digest('hex');
const OTHER_SUM = 'a'.repeat(64);

function fakeRelease(sum: string, asset = 'aura-linux-arm64'): { fetcher: FetchBytes; urls: string[] } {
  const urls: string[] = [];
  const fetcher: FetchBytes = async (url) => {
    urls.push(url);
    if (url.endsWith('/checksums.txt')) return new TextEncoder().encode(`${sum}  ${asset}\n${OTHER_SUM}  aura-darwin-arm64\n`);
    if (url.endsWith(`/${asset}`)) return BYTES;
    throw new Error(`unexpected url ${url}`);
  };
  return { fetcher, urls };
}

test('assetForArch names the linux asset for both spellings of each architecture', () => {
  assert.equal(assetForArch('arm64'), 'aura-linux-arm64');
  assert.equal(assetForArch('aarch64'), 'aura-linux-arm64');
  assert.equal(assetForArch('amd64'), 'aura-linux-amd64');
  assert.equal(assetForArch('x86_64'), 'aura-linux-amd64');
  assert.throws(() => assetForArch('riscv64'), /no AURA release binary/);
});

test('parseChecksums reads sha256sum lines and skips anything else', () => {
  assert.deepEqual(parseChecksums(`abc  aura-linux-arm64\n\nnot a checksum line at all\ndef  checksums-for-thing\n`), { 'aura-linux-arm64': 'abc', 'checksums-for-thing': 'def' });
});

test('ensureBinary downloads, checks the checksum and keeps the tag in the file name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-binary-'));
  const { fetcher, urls } = fakeRelease(SUM);
  const info = await ensureBinary(dir, 'arm64', fetcher, TAG);
  assert.equal(info.tag, TAG);
  assert.equal(info.asset, 'aura-linux-arm64');
  assert.equal(info.sha256, SUM);
  assert.equal(info.url, `${releaseUrl(TAG)}/aura-linux-arm64`);
  assert.equal(info.file, join(dir, `${TAG}-aura-linux-arm64`));
  assert.deepEqual([...readFileSync(info.file)], [...BYTES]);
  assert.equal(statSync(info.file).mode & 0o111, 0o111, 'the sandbox can execute it');
  assert.deepEqual(urls, [`${releaseUrl(TAG)}/checksums.txt`, `${releaseUrl(TAG)}/aura-linux-arm64`]);
});

test('ensureBinary reuses a copy that still matches without downloading it again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-binary-'));
  await ensureBinary(dir, 'arm64', fakeRelease(SUM).fetcher, TAG);
  const again = fakeRelease(SUM);
  await ensureBinary(dir, 'arm64', again.fetcher, TAG);
  assert.deepEqual(again.urls, [`${releaseUrl(TAG)}/checksums.txt`]);
});

test('a checksum mismatch never reaches the disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-binary-'));
  await assert.rejects(ensureBinary(dir, 'arm64', fakeRelease(OTHER_SUM).fetcher, TAG), /failed its checksum/);
  assert.deepEqual(readdirSync(dir), []);
});

test('a release with no entry for the asset is an error, not an unverified download', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-binary-'));
  await assert.rejects(ensureBinary(dir, 'amd64', fakeRelease(SUM).fetcher, TAG), /no entry for aura-linux-amd64/);
  assert.equal(existsSync(join(dir, `${TAG}-aura-linux-amd64`)), false);
});
