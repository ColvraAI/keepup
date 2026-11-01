// The local server's API, as the site reads it. A static deploy has none of this, and says so.
import { useEffect, useState } from 'react';
import type { DiffFile, StageDiff } from './types';

export type Health = { state: 'checking' } | { state: 'absent' } | { state: 'present'; judge: boolean; app: boolean; keepMinutes: number | null };

export const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** owner/name, or any GitHub URL for one; null when it's neither. */
export function repoFromInput(text: string): string | null {
  const trimmed = text.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+?)(?:\/.*)?$/i.exec(trimmed);
  const slug = url?.[1] ?? trimmed;
  return SLUG.test(slug) ? slug : null;
}

export function useHealth(): Health {
  const [health, setHealth] = useState<Health>({ state: 'checking' });
  useEffect(() => {
    if (!/^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) {
      setHealth({ state: 'absent' });
      return undefined;
    }
    const abort = new AbortController();
    fetch('/api/health', { signal: abort.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ judge?: boolean; app?: boolean; keep_minutes?: number }>) : Promise.reject(new Error('absent'))))
      .then((body) => setHealth({ state: 'present', judge: body.judge === true, app: body.app === true, keepMinutes: body.keep_minutes ?? null }))
      .catch(() => {
        if (!abort.signal.aborted) setHealth({ state: 'absent' });
      });
    return () => abort.abort();
  }, []);
  return health;
}

export type Stream = { refused: string | null; done: boolean; failed: boolean };

/** An error can arrive inside a 200 stream, so a job only succeeded if the stream says done and never said error. */
export async function readStream(path: string, body: unknown, signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void): Promise<Stream> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const answer = await response.json().catch(() => ({ error: 'That request was refused.' })) as { error?: string };
    return { refused: answer.error ?? 'That request was refused.', done: false, failed: true };
  }
  const reader = response.body?.getReader();
  if (!reader) return { refused: 'This browser can’t read a stream.', done: false, failed: true };
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;
  let sawError = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { refused: null, done: sawDone, failed: sawError || !sawDone };
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.filter(Boolean).forEach((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'done') sawDone = true;
      if (event.type === 'error') sawError = true;
      onEvent(event);
    });
  }
}

export type LiveRepo = { repo: string; commit: string | null; scanned_at: string; findings: number; held_back: number; usd: number | null };

export type SyntaxLine = { file: string; status: 'ok' | 'failed' | 'not checked'; detail: string };

export type Change = {
  id: string;
  repo: string;
  commit: string;
  finding_rank: number;
  kind: 'swap' | 'behind-a-setting' | 'steps' | null;
  branch: string | null;
  commit_sha: string | null;
  title: string;
  summary: string;
  files: string[];
  diff: string;
  syntax: SyntaxLine[];
  tests: string;
  usd: number;
  refused?: string;
  steps?: string[];
  publish_block?: string;
};

/** Changes already made for this repo, so a reload shows them rather than offering to make them again. */
export function useSavedChanges(repo: string): Change[] {
  const [changes, setChanges] = useState<Change[]>([]);
  useEffect(() => {
    if (!repo || !/^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) return undefined;
    const abort = new AbortController();
    fetch(`/api/changes?repo=${encodeURIComponent(repo)}`, { signal: abort.signal })
      .then((response) => (response.ok ? response.json() as Promise<{ changes?: Change[] }> : { changes: [] }))
      .then((body) => setChanges(body.changes ?? []))
      .catch(() => undefined);
    return () => abort.abort();
  }, [repo]);
  return changes;
}

export type MeasureRow = { recipe: string; status: 'measured' | 'not measured' | 'refused'; needs?: string; reason?: string; n?: number; summary?: string; headline?: string; cannot_prove?: string };
export type Measure = { id: string; finding_rank: number; disclosure: string; rows: MeasureRow[]; usd: number; cap_usd: number; refused?: string };

export type OpenPr =
  | { state: 'needs_app'; command: string; detail: string }
  | { state: 'opened'; url: string; number: number; fork: string; ci: string }
  | { state: 'refused'; reason: string };

function fileFrom(chunk: string): DiffFile {
  const lines = chunk.split('\n');
  const path = /^diff --git a\/.+ b\/(.+)$/.exec(lines[0] ?? '')?.[1] ?? 'unknown';
  const hunks = lines.slice(1).reduce<DiffFile['hunks']>((list, line) => {
    if (line.startsWith('@@')) return [...list, { header: line, lines: [] }];
    const last = list.at(-1);
    return last ? [...list.slice(0, -1), { ...last, lines: [...last.lines, line] }] : list;
  }, []).map((hunk) => (hunk.lines.at(-1) === '' ? { ...hunk, lines: hunk.lines.slice(0, -1) } : hunk));
  const body = hunks.flatMap((hunk) => hunk.lines);
  return { path, status: 'modified', additions: body.filter((line) => line.startsWith('+')).length, deletions: body.filter((line) => line.startsWith('-')).length, binary: false, hunks } as DiffFile;
}

/** A unified diff, in the shape the existing viewer reads. */
export function parseDiff(diff: string, subject: string): StageDiff {
  const files = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith('diff --git ')).map(fileFrom);
  return { files, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0), patches: [{ path: 'change.patch', subject }] } as StageDiff;
}
