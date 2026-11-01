'use client';

import type { ReactNode } from 'react';
import { firstSentence, withoutEndStop } from '@/lib/text';
import { Ext } from './Ext';

/** The brief is the real markdown app/src/brief.ts writes. Only its bold, links, lists and rule are read. */
function inline(text: string): ReactNode[] {
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https:[^)]+)\)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(last, match.index));
    if (match[1]) nodes.push(<strong key={match.index}>{match[1]}</strong>);
    else nodes.push(<Ext key={match.index} href={match[3]}>{match[2]}</Ext>);
    last = match.index + match[0].length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

/** "1. A sentence. · better answers · effort: a day": the head of an item, without the stop before its first tag. */
function ItemHead({ line }: { line: string }) {
  const [plain = '', ...tags] = line.replace(/^\d+\.\s*/, '').split(' · ');
  return (
    <p className="brief__item">
      <span>{inline(withoutEndStop(plain))}.</span>{' '}
      {tags.length ? <span className="brief__tags mono">{tags.join(' · ')}</span> : null}
    </p>
  );
}

function Block({ block, compact }: { block: string; compact: boolean }) {
  const lines = block.split('\n');
  if (lines.every((line) => line.startsWith('- '))) {
    return (
      <ul className="brief__list">
        {lines.map((line, index) => <li key={index}>{inline(compact ? firstSentence(line.slice(2)) : line.slice(2))}</li>)}
      </ul>
    );
  }
  return (
    <div className={/^Nothing (else )?new for this product/.test(block) ? 'brief__quiet' : 'brief__block'}>
      {lines.map((line, index) => {
        if (/^\d+\.\s/.test(line)) return <ItemHead key={index} line={line} />;
        return <p key={index} className={/^\s+/.test(line) ? 'brief__sub' : ''}>{inline(line.trim())}</p>;
      })}
    </div>
  );
}

export function BriefBody({ body, compact = false }: { body: string; compact?: boolean }) {
  const [main = '', footnote] = body.split(/\n---\n/);
  const blocks = main.split(/\n\n+/).filter(Boolean);
  return (
    <div className="brief__body">
      {blocks.map((block, index) =>
        /^\*\*[^*]+\*\*$/.test(block.trim()) ? (
          <h3 key={index} className="brief__heading">{block.replaceAll('*', '')}</h3>
        ) : (
          <Block key={index} block={block} compact={compact} />
        ),
      )}
      {footnote && !compact ? <p className="small brief__foot">{inline(footnote.trim())}</p> : null}
    </div>
  );
}
