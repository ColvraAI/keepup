'use client';

import { useMemo, useState } from 'react';
import { usePresent } from './BundleContext';
import type { DiffFile, StageDiff } from '@/lib/types';

const MAX_LINES = 400;

function lineClass(line: string): string {
  if (line.startsWith('+')) return 'diff-line diff-line--add';
  if (line.startsWith('-')) return 'diff-line diff-line--del';
  return 'diff-line';
}

const NOT_THE_POINT = /test|(^|\/)\.[^/]+$|\.env|\.md$|\.example|\.ya?ml$|\.json$|\.lock$/i;
const COMPACT_FILES = 2;
const changed = (file: DiffFile): number => file.additions + file.deletions;

/** The biggest real change first, not whichever config file sorts first. */
function pickFile(files: readonly DiffFile[]): number {
  const worthReading = files.filter((file) => !NOT_THE_POINT.test(file.path));
  const pool = worthReading.length > 0 ? worthReading : files;
  const best = pool.reduce<DiffFile | null>((top, file) => (!top || changed(file) > changed(top) ? file : top), null);
  return best ? files.indexOf(best) : 0;
}

function FileBody({ file }: { file: DiffFile }) {
  const lines = file.hunks.flatMap((hunk) => [{ header: true, text: hunk.header }, ...hunk.lines.map((text) => ({ header: false, text }))]);
  const clipped = lines.slice(0, MAX_LINES);
  if (file.binary) return <p className="small diff-empty">A binary file: nothing to show as text.</p>;
  return (
    <pre className="diff-body" data-testid="diff-body">
      <code>
        {clipped.map((line, index) =>
          line.header ? (
            <span key={index} className="diff-line diff-line--hunk">{line.text}</span>
          ) : (
            <span key={index} className={lineClass(line.text)}>{line.text || ' '}</span>
          ),
        )}
      </code>
      {lines.length > MAX_LINES ? <span className="diff-line diff-line--hunk">{lines.length - MAX_LINES} more lines in this patch</span> : null}
    </pre>
  );
}

/** `scope` says what these counts cover, so they can't be mistaken for the pull request's own. */
export function DiffViewer({ diff, scope }: { diff: StageDiff; scope?: string }) {
  const present = usePresent();
  const [allFiles, setAllFiles] = useState(false);
  // The file worth reading first goes first, so it's in view even when the list is clipped.
  const files = useMemo(() => {
    const lead = pickFile(diff.files);
    return [diff.files[lead], ...diff.files.filter((_, index) => index !== lead)].filter((file): file is DiffFile => Boolean(file));
  }, [diff.files]);
  const [chosen, setChosen] = useState(0);
  const file = files[chosen] ?? files[0];
  if (!file) return <p className="small">No patch recorded for this stage.</p>;
  const compact = present && !allFiles && files.length > COMPACT_FILES + 1;
  const listed = compact ? files.slice(0, COMPACT_FILES) : files;
  const hidden = files.length - listed.length;
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="mono small">
          {scope ? <span className="diff-scope">{scope} · </span> : null}{files.length} {files.length === 1 ? 'file' : 'files'} · <span className="diff-plus">+{diff.additions}</span> <span className="diff-minus">−{diff.deletions}</span>
        </span>
        {diff.patches.map((patch) => (
          <span key={patch.path} className="diff-subject">{patch.subject}</span>
        ))}
      </div>
      <ul className="diff-files">
        {listed.map((item, index) => (
          <li key={item.path}>
            <button type="button" aria-pressed={index === chosen} onClick={() => setChosen(index)} className="mono">
              <span className="diff-files__path">{item.path}</span>
              <span className="diff-files__count">
                <span className="diff-plus">+{item.additions}</span> <span className="diff-minus">−{item.deletions}</span>
              </span>
              <span className="diff-files__status">{item.status === 'modified' ? '' : item.status}</span>
            </button>
          </li>
        ))}
        {hidden > 0 ? (
          <li>
            <button type="button" className="mono diff-files__more" data-testid="diff-more-files" onClick={() => setAllFiles(true)}>+{hidden} more {hidden === 1 ? 'file' : 'files'}</button>
          </li>
        ) : null}
      </ul>
      <FileBody key={file.path} file={file} />
    </div>
  );
}
