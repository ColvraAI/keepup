// Which model AnythingLLM's router falls back to, for the moonshot prices. Read
// from the upstream code at the pinned commit when a clone is here, because the
// model id must come from the repo. With no clone it's null, never a guess.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { blobUrl, upstreamBase } from './links.ts';

const OPENAI_PROVIDER = 'server/utils/AiProviders/openAi/index.js';
const DEFAULT_MODEL = /OPEN_MODEL_PREF\s*\|\|\s*"([^"]+)"/;

export function routerFallbackModel(root: string, repo: string, pinnedCommit: string): { model: string; where: string; url: string } | null {
  const clone = join(root, 'tmp', 'anything-llm');
  if (!existsSync(join(clone, '.git'))) return null;
  const show = spawnSync('git', ['-C', clone, 'show', `${pinnedCommit}:${OPENAI_PROVIDER}`], { encoding: 'utf8', maxBuffer: 4_000_000 });
  if (show.status !== 0) return null;
  const lines = show.stdout.split('\n');
  const index = lines.findIndex((l) => DEFAULT_MODEL.test(l));
  const model = index >= 0 ? lines[index].match(DEFAULT_MODEL)?.[1] : null;
  if (!model) return null;
  const line = index + 1;
  return { model, where: `${OPENAI_PROVIDER}:${line}`, url: blobUrl(upstreamBase(repo), pinnedCommit, { path: OPENAI_PROVIDER, line }) };
}
