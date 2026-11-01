import type { ReactNode } from 'react';
import { safeHttps } from '@/lib/format';

/** An outward link. Without a real https address it renders as plain text, never a dead link. */
export function Ext({ href, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  const url = safeHttps(href);
  if (!url) return <span className={className}>{children}</span>;
  return (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
