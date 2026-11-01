'use client';

import type { ReactNode } from 'react';
import { useBundle } from './BundleContext';
import { Ext } from './Ext';
import { Chip, CodeLink, ProofLine, type Tone } from './parts';
import { longDate, shortSha } from '@/lib/format';
import { labLabel, labTone } from '@/lib/repos';
import { withoutEndStop } from '@/lib/text';
import type { LabTable, Pr } from '@/lib/types';

const TONE: Record<'pass' | 'partial' | 'none', Tone> = { pass: 'green', partial: 'grey', none: 'grey' };

/** Lab cells are short markdown: backticks are the only mark they use. */
function Inline({ text }: { text: string }): ReactNode {
  return text.split(/`([^`]+)`/g).map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

export function LabTableView({ table }: { table: LabTable }) {
  if (table.rows.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{table.headers.map((header, index) => <th key={index}>{header || ' '}</th>)}</tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}><Inline text={cell} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MeasuredHero({ pr }: { pr: Pr }) {
  if (pr.lab.status === 'measured' && pr.lab.title_number) {
    return <p className="pr-number num" data-testid="pr-number">{pr.lab.title_number}</p>;
  }
  return (
    <div className="not-measured" data-testid="pr-not-measured">
      <p className="not-measured__big">{pr.lab.status === 'partial' ? 'Part measured' : 'Not measured yet'}</p>
      {pr.lab.needs ?? pr.needs ? <p className="not-measured__needs">needs {pr.lab.needs ?? pr.needs}</p> : null}
    </div>
  );
}

/** An outcome isn't a fact until the lab has measured it: until then it's expected, and says whose claim it is. */
function EffectChips({ pr }: { pr: Pr }) {
  if (pr.lab.status === 'measured') return <>{pr.effect.map((effect) => <Chip key={effect}>{effect}</Chip>)}</>;
  if (pr.effect.length === 0) return null;
  return <Chip tone="assume">expected: {pr.effect.join(', ')}{pr.proof.vendor ? ' · vendor claim' : ''}</Chip>;
}

export function PrChips({ pr }: { pr: Pr }) {
  return (
    <div className="pr-chips">
      {pr.github ? <Chip tone={pr.github.state === 'merged' ? 'green' : 'blue'}>{pr.github.state ?? 'open'} on GitHub</Chip> : <Chip tone="blue">{pr.status_label}</Chip>}
      {pr.github?.ci?.state === 'success' ? <Chip tone="green">CI passed</Chip> : null}
      {pr.lab.status === 'measured' ? <Chip tone={TONE[labTone(pr)]}>{labLabel(pr)}</Chip> : null}
      <EffectChips pr={pr} />
      <Chip>effort: {pr.effort.toLowerCase()}</Chip>
    </div>
  );
}

export function PrCard({ pr }: { pr: Pr }) {
  const { requestedAppName } = useBundle();
  const author = pr.github?.author ?? null;
  const measured = pr.lab.status === 'measured';
  return (
    <article className="pr-card" data-testid="pr-card" data-pr={pr.id}>
      <header className="pr-card__head">
        <p className="eyebrow">
          keepup · {longDate(pr.stages[0]?.date ?? '')} · <Ext href={pr.source_url}>{pr.source}</Ext> · {pr.upstream}
        </p>
        <h2 className="pr-title">{pr.title}</h2>
        <MeasuredHero pr={pr} />
        <PrChips pr={pr} />
        {pr.github?.url ? (
          <Ext href={pr.github.url} className="btn">Open on GitHub</Ext>
        ) : null}
      </header>

      <dl className="pr-facts">
        <div>
          <dt>Author</dt>
          <dd>{author ?? `Will be opened by the keepup App${requestedAppName ? `, as ${requestedAppName}[bot]` : ''}`}</dd>
        </div>
        <div>
          <dt>Base commit</dt>
          <dd><Ext href={pr.base_commit_url} className="mono">{shortSha(pr.base_commit)}</Ext></dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd className="mono">{pr.branch}</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>
            {pr.where.slice(0, 2).map((where) => (
              <span className="pr-where" key={`${where.path}:${where.line}`}>
                <CodeLink file={where.path} line={where.line} url={where.url} />
              </span>
            ))}
          </dd>
        </div>
      </dl>

      <p className="pr-founder">{pr.founder_line}</p>

      {pr.lab.table.rows.length > 0 ? (
        <section className="pr-section">
          <h3 className="eyebrow">Before and after · {pr.lab.dir}{pr.lab.measured_at ? ` · ${longDate(pr.lab.measured_at)}` : ''}</h3>
          <LabTableView table={pr.lab.table} />
        </section>
      ) : null}

      <section className="pr-section">
        <h3 className="eyebrow">Proof</h3>
        <ProofLine
          measured={measured ? (pr.lab.title_number ?? 'Table above') : pr.lab.status === 'partial' ? 'Only the rows in the table above.' : 'Nothing yet.'}
          projected="Nothing on this pull request."
          notYetLabel="Not measured yet"
          notYet={measured ? 'Nothing.' : `Needs ${pr.lab.needs ?? pr.needs ?? 'a lab run'}.`}
        />
        <p className="small pr-vendor">
          {pr.proof.vendor ? <>Vendor’s claim, not ours: <Ext href={pr.proof.vendor.url}>{withoutEndStop(pr.proof.vendor.claim)}</Ext>. </> : null}
          {pr.proof.independent ? <>Independent: <Ext href={pr.proof.independent.url}>{withoutEndStop(pr.proof.independent.claim)}</Ext>.</> : 'Independent: none.'}
        </p>
        <p className="small">{pr.repo_tests ? <>Repo’s own tests, recorded: {pr.repo_tests.summary}</> : 'Repo’s own tests: nothing recorded for this one yet.'}</p>
      </section>

      <section className="pr-section pr-two">
        <div>
          <h3 className="eyebrow">Rollback</h3>
          <p>{pr.rollback}</p>
        </div>
        <div>
          <h3 className="eyebrow">Risks</h3>
          <p>{pr.risks}</p>
        </div>
      </section>
    </article>
  );
}
