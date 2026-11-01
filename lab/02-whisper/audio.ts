// The audio lives only under lab/.work/, which git ignores. Each file is checked against
// the hash in testset.json, so every run measures the same recording.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyAudio, type Recording } from './testset.ts';

export type FetchBytes = (url: string) => Promise<Uint8Array>;

const ATTEMPTS = 3;
const RETRY_WAIT_MS = 2000;

/** archive.org sometimes answers 500 and then recovers, so a server error or a dropped connection gets another try. */
export function retryingFetch(get: (url: string) => Promise<Response>, waitMs: number = RETRY_WAIT_MS): FetchBytes {
  return async (url) => {
    let failure = new Error(`${url} was not tried`);
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (attempt > 1) await delay(waitMs);
      try {
        const response = await get(url);
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        failure = new Error(`${url} answered ${response.status}`);
        if (response.status < 500) break;
      } catch (error) {
        failure = new Error(`${url} failed: ${(error as Error).message}`);
      }
    }
    throw failure;
  };
}

export const fetchBytes: FetchBytes = retryingFetch((url) => fetch(url));

function isValid(recording: Recording, path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    verifyAudio(recording, readFileSync(path));
    return true;
  } catch {
    return false;
  }
}

/** The path of a recording under dir, downloading it only when it's missing or isn't the right file. */
export async function ensureAudio(recording: Recording, dir: string, fetcher: FetchBytes = fetchBytes): Promise<string> {
  const path = join(dir, recording.audioFile);
  if (isValid(recording, path)) return path;
  const bytes = await fetcher(recording.audioUrl);
  verifyAudio(recording, bytes);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, bytes);
  return path;
}
