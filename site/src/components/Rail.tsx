'use client';

import { useState } from 'react';
import { useBundle } from './BundleContext';
import { count, longDate } from '@/lib/format';
import { hashFor, RAIL, type ScreenId } from '@/lib/routes';

function isActive(current: ScreenId, screen: ScreenId, children?: readonly { screen: ScreenId }[]): boolean {
  return current === screen || (screen === 'overview' && current === 'repo') || Boolean(children?.some((child) => child.screen === current));
}

export function Rail({ current, onPresent }: { current: ScreenId; onPresent: () => void }) {
  const { manifest, pulse } = useBundle();
  const [open, setOpen] = useState(false);
  return (
    <nav className={open ? 'rail rail--open' : 'rail'} aria-label="keepup">
      <div className="rail__top">
        <a className="rail__mark" href={hashFor('overview')} onClick={() => setOpen(false)}>
          keepup
        </a>
        <button type="button" className="rail__menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Menu'}
        </button>
      </div>
      <div className="rail__body">
        <ul className="rail__list">
          {RAIL.map((item) => {
            const active = isActive(current, item.screen, item.children);
            return (
              <li key={item.label}>
                <a
                  href={hashFor(item.screen)}
                  aria-current={active ? 'page' : undefined}
                  className="rail__link"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </a>
                {item.children && item.children.length > 0 ? (
                  <ul className="rail__sub">
                    {item.children.map((child) => (
                      <li key={child.label}>
                        <a
                          href={hashFor(child.screen)}
                          aria-current={current === child.screen ? 'page' : undefined}
                          onClick={() => setOpen(false)}
                        >
                          {child.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="rail__foot">
          <button type="button" className="rail__present" onClick={onPresent}>
            Present <kbd>P</kbd>
          </button>
          <p className="mono">
            {count(pulse.total)} records
            <br />
            fetched {longDate(manifest.database_fetched)}
          </p>
          <p className="mono">{manifest.github.exists ? `On GitHub: ${manifest.github.org ?? 'yes'}` : 'Nothing on GitHub yet'}</p>
        </div>
      </div>
    </nav>
  );
}
