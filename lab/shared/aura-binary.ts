// An AURA release binary for a lab. It's downloaded once into a folder under lab/.work
// and checked against the release's own checksums.txt before anything can execute it.
// It only ever runs inside the Docker sandbox, never on the host.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_RELEASE_TAG = 'v0.2.20';

export interface BinaryInfo { tag: string; asset: string; sha256: string; url: string; file: string }
export type FetchBytes = (url: string) => Promise<Uint8Array>;

export function releaseUrl(tag: string): string {
  return `https://github.com/mezmo/aura/releases/download/${tag}`;
}

/** The `aura` asset for the sandbox's architecture. `aura webserver` is what the examples tell you to run. */
export function assetForArch(arch: string): string {
  if (arch === 'arm64' || arch === 'aarch64') return 'aura-linux-arm64';
  if (arch === 'amd64' || arch === 'x86_64') return 'aura-linux-amd64';
  throw new Error(`no AURA release binary for architecture ${arch}`);
}

export function parseChecksums(text: string): Record<string, string> {
  const pairs = text.split('\n').map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length === 2);
  return Object.fromEntries(pairs.map(([sum, name]) => [name, sum]));
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const fetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/** Returns the verified binary, reusing a copy that still matches. A mismatch never reaches the disk. */
export async function ensureBinary(binDir: string, arch: string, fetcher: FetchBytes = fetchBytes, tag: string = DEFAULT_RELEASE_TAG): Promise<BinaryInfo> {
  const asset = assetForArch(arch);
  const base = releaseUrl(tag);
  const sums = parseChecksums(Buffer.from(await fetcher(`${base}/checksums.txt`)).toString('utf8'));
  const expected = sums[asset];
  if (!expected) throw new Error(`${tag}'s checksums.txt has no entry for ${asset}`);
  const url = `${base}/${asset}`;
  const file = join(binDir, `${tag}-${asset}`);
  const info: BinaryInfo = { tag, asset, sha256: expected, url, file };
  if (existsSync(file) && sha256Of(readFileSync(file)) === expected) return info;
  const bytes = await fetcher(url);
  const actual = sha256Of(bytes);
  if (actual !== expected) throw new Error(`${asset} failed its checksum: expected ${expected}, got ${actual}`);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(file, bytes, { mode: 0o755 });
  return info;
}
