// Evidence that a pull request's change passes the repo's own tests: saved by the
// lab under lab/<dir>/out/, or named in pr.json. No evidence file means null, never a guess.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoTests { file: string | null; summary: string | null; detail: unknown }

const EVIDENCE = /(repo[-_]?tests?|tests?[-_]?(result|report|summary|output|log)|ci[-_]?(result|run))[^/]*\.(json|txt|log|md)$/i;
const TAIL_LINES = 40;

function fromPrJson(raw: Record<string, unknown>): RepoTests | null {
  const value = raw.repoTests ?? raw.repo_tests;
  if (value === undefined || value === null) return null;
  return { file: null, summary: typeof value === 'string' ? value : null, detail: value };
}

function readEvidence(path: string, name: string): RepoTests {
  const content = readFileSync(path, 'utf8');
  if (name.endsWith('.json')) {
    try {
      const detail = JSON.parse(content) as { summary?: unknown };
      return { file: name, summary: typeof detail.summary === 'string' ? detail.summary : null, detail };
    } catch {
      // Falls through to the text form: the evidence is still worth showing as it is.
    }
  }
  const tail = content.trim().split('\n').slice(-TAIL_LINES);
  return { file: name, summary: tail.at(-1) ?? null, detail: tail };
}

export function findRepoTests(labPath: string, raw: Record<string, unknown>): RepoTests | null {
  const named = fromPrJson(raw);
  if (named) return named;
  const variant = String(raw.id ?? '').split('-')[1];
  const candidates = ['out', ''].flatMap((sub) => {
    const dir = join(labPath, sub);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => EVIDENCE.test(f)).map((f) => ({ dir, name: f, rel: sub ? `${sub}/${f}` : f }));
  });
  const mine = candidates.filter((c) => (variant ? c.name.includes(variant) : !c.name.includes('jev')));
  const chosen = mine[0];
  return chosen ? { ...readEvidence(join(chosen.dir, chosen.name), chosen.name), file: chosen.rel } : null;
}
