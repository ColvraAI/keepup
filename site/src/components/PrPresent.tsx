'use client';

import { useBundle } from './BundleContext';
import { Ext } from './Ext';
import { Chip, type Tone } from './parts';
import { count, friendlyRepo, longDate, shortSha } from '@/lib/format';
import { isSurvivor, prFacts } from '@/lib/repos';
import { firstSentence, shortNeeds } from '@/lib/text';
import type { Pr } from '@/lib/types';

const STAGE_COLUMNS: readonly { match: RegExp; label: string }[] = [
  { match: /^server$/i, label: 'Server' },
  { match: /tools it lists/i, label: 'Tools the server lists' },
  { match: /offered to the agent/i, label: 'Tools the agent gets' },
];
const ABSENT = /Absent until it runs: ([^(]+) \(needs ([^)]+)\)/;

/** What the lab hasn't reached, as a row of its own, so the "part" in "Part measured" can be seen. */
function absentRow(notes: string): { name: string; needs: string } | null {
  const match = ABSENT.exec(notes);
  return match?.[1] && match[2] ? { name: match[1].trim(), needs: match[2].trim() } : null;
}

/** The columns a room can read, across the full width, with the label every number carries. The rest stays behind D. */
function StageTable({ pr }: { pr: Pr }) {
  const { table } = pr.lab;
  const columns = STAGE_COLUMNS.flatMap((column) => {
    const index = table.headers.findIndex((header) => column.match.test(header));
    return index >= 0 ? [{ index, label: column.label }] : [];
  });
  if (columns.length === 0 || table.rows.length === 0) return null;
  const absent = absentRow(table.notes);
  return (
    <figure className="pr-stage__measured">
      <figcaption className="mono" data-testid="pr-measured-caption">
        <b>Measured</b> · {table.rows.length} servers, on placeholders with no backend · {pr.lab.dir}/result.md{pr.lab.measured_at ? ` · ${longDate(pr.lab.measured_at)}` : ''}
      </figcaption>
      <table className="data pr-stage__table" data-testid="pr-lab-table">
        <thead><tr>{columns.map((column) => <th key={column.index}>{column.label}</th>)}</tr></thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>{columns.map((column) => <td key={column.index}>{row[column.index]?.replaceAll('`', '')}</td>)}</tr>
          ))}
          {absent ? (
            <tr className="pr-stage__absent" data-testid="pr-absent-row">
              <td>{absent.name}</td>
              <td colSpan={columns.length - 1}>Not measured yet · needs {absent.needs}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </figure>
  );
}

function LabLine({ pr }: { pr: Pr }) {
  const needs = pr.lab.needs ?? pr.needs;
  if (pr.lab.status === 'measured' && pr.lab.title_number) return <p className="pr-number num" data-testid="pr-number">{pr.lab.title_number}</p>;
  const words = pr.lab.status === 'partial' ? 'Part measured' : 'Not measured yet';
  return <p className="pr-stage__lab" data-testid="pr-not-measured">{words}{needs ? ` · needs ${shortNeeds(needs)}` : ''}</p>;
}

/**
 * What's built, first: the real patch, its base and its way back. What's missing gets one line.
 * The rest of the card waits behind D.
 */
export function PrPresent({ pr, detailHint }: { pr: Pr; detailHint: string }) {
  const bundle = useBundle();
  const facts = prFacts(pr);
  const status: Tone = pr.github?.state === 'merged' ? 'green' : 'blue';
  return (
    <article className="pr-stage" data-testid="pr-card" data-pr={pr.id}>
      <p className="eyebrow">keepup · {longDate(pr.stages[0]?.date ?? '')} · <Ext href={pr.source_url}>{pr.source}</Ext> · {friendlyRepo(pr.upstream)}</p>
      <h2 className="pr-stage__title">{isSurvivor(bundle, pr) ? <i className="kept-dot" aria-hidden="true" /> : null}{pr.title}</h2>
      <p className="pr-stage__facts num" data-testid="pr-facts">
        <span className="diff-plus">+{count(facts.additions)}</span> <span className="diff-minus">−{count(facts.deletions)}</span>
        {' · '}{facts.files} {facts.files === 1 ? 'file' : 'files'}
        <span className="pr-stage__scope"> whole pull request</span>
        {' · on '}<Ext href={pr.base_commit_url} className="mono">{shortSha(pr.base_commit)}</Ext>
      </p>
      <div className="pr-stage__state">
        {pr.github?.url ? <Ext href={pr.github.url} className="btn">Open on GitHub</Ext> : null}
        <Chip tone={status}>{pr.github ? `${pr.github.state ?? 'open'} on GitHub` : pr.status_label}</Chip>
        {pr.github?.ci?.state === 'success' ? <Chip tone="green">CI passed</Chip> : null}
        <LabLine pr={pr} />
      </div>
      <p className="pr-stage__rollback"><strong>Rollback:</strong> {firstSentence(pr.rollback)}</p>
      <StageTable pr={pr} />
      <p className="small pr-stage__hint">{detailHint}</p>
    </article>
  );
}
