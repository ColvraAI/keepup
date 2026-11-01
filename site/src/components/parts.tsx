'use client';

import type { ReactNode } from 'react';
import { friendlyRepo } from '@/lib/format';
import { Ext } from './Ext';

export type Tone = 'blue' | 'green' | 'amber' | 'grey' | 'ink' | 'quiet' | 'assume';

export function Chip({ tone = 'quiet', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}

export function RepoSwitch({ repos, value, onChange }: { repos: readonly string[]; value: string; onChange: (repo: string) => void }) {
  return (
    <div className="switch" role="group" aria-label="Choose a repo">
      {repos.map((repo) => (
        <button key={repo} type="button" aria-pressed={repo === value} onClick={() => onChange(repo)}>
          {friendlyRepo(repo)}
        </button>
      ))}
    </div>
  );
}

/** A file:line that opens the real line at the pinned commit. */
export function CodeLink({ file, line, url }: { file: string; line?: number | null; url?: string | null }) {
  const parts = file.split('/');
  const name = parts.at(-1) ?? file;
  return (
    <Ext href={url} className="code-link mono">
      {parts.slice(0, -1).map((part, index) => (
        <span key={index}>{part}/<wbr /></span>
      ))}
      <span className="code-link__end">{name}{line ? `:${line}` : ''}</span>
    </Ext>
  );
}

/** The three labels every number carries. */
export function ProofLine({ measured, projected, notYet, notYetLabel = 'Not yet measurable' }: { measured: ReactNode; projected: ReactNode; notYet: ReactNode; notYetLabel?: string }) {
  return (
    <dl className="proof-line">
      <div>
        <dt>Measured</dt>
        <dd>{measured}</dd>
      </div>
      <div>
        <dt>Projected</dt>
        <dd>{projected}</dd>
      </div>
      <div>
        <dt>{notYetLabel}</dt>
        <dd>{notYet}</dd>
      </div>
    </dl>
  );
}

/** In present mode the title says it, so the eyebrow stays off the stage unless it carries a fact the title doesn't. */
export function ScreenHead({ eyebrow, title, lede, aside, keepEyebrow = false }: { eyebrow?: ReactNode; title: ReactNode; lede?: ReactNode; aside?: ReactNode; keepEyebrow?: boolean }) {
  return (
    <header className="screen__head">
      {eyebrow ? <p className={keepEyebrow ? 'eyebrow eyebrow--keep' : 'eyebrow'}>{eyebrow}</p> : null}
      <div className="screen__title-row">
        <h1 className="h1">{title}</h1>
        {aside ? <div className="screen__aside">{aside}</div> : null}
      </div>
      {lede ? <p className="lede">{lede}</p> : null}
    </header>
  );
}
