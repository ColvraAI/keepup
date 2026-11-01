'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readRepo, writeRepo } from '@/lib/beats';
import type { Bundle } from '@/lib/types';

const Context = createContext<Bundle | null>(null);
const PresentContext = createContext(false);
const RepoContext = createContext<{ repo: string; setRepo: (repo: string) => void } | null>(null);

export const PresentProvider = PresentContext.Provider;
export const usePresent = (): boolean => useContext(PresentContext);

export function BundleProvider({ bundle, children }: { bundle: Bundle; children: ReactNode }) {
  const [repo, setChosen] = useState(bundle.replay.repos[0]?.repo ?? '');
  // After mount, so the first render matches the static page. It lands with the first screen, before it's painted.
  useEffect(() => {
    const saved = readRepo();
    if (saved) setChosen(saved);
  }, []);
  const setRepo = useCallback((next: string) => {
    writeRepo(next);
    setChosen(next);
  }, []);
  const choice = useMemo(() => ({ repo, setRepo }), [repo, setRepo]);
  return (
    <Context.Provider value={bundle}>
      <RepoContext.Provider value={choice}>{children}</RepoContext.Provider>
    </Context.Provider>
  );
}

export function useBundle(): Bundle {
  const bundle = useContext(Context);
  if (!bundle) throw new Error('useBundle needs BundleProvider');
  return bundle;
}

/** The repo in view: choosing AURA on one screen means AURA on the next. */
export function useRepo(): { repo: string; setRepo: (repo: string) => void } {
  const choice = useContext(RepoContext);
  if (!choice) throw new Error('useRepo needs BundleProvider');
  return choice;
}
