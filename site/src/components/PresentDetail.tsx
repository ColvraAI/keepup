'use client';

import type { ReactNode } from 'react';

/** What's kept off the stage until someone asks: D opens it, D or Esc closes it. */
export function PresentDetail({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="present-detail" data-testid="present-detail" aria-label={title}>
      <header className="present-detail__head">
        <h2 className="h2">{title}</h2>
        <button type="button" className="btn btn--quiet" data-detail-close onClick={onClose}>Close</button>
      </header>
      {children}
    </aside>
  );
}
