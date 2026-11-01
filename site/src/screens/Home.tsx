'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AddRepo } from '@/components/AddRepo';
import { useBundle } from '@/components/BundleContext';
import { Chip } from '@/components/parts';
import { longDate, shortSha } from '@/lib/format';
import type { LiveRepo } from '@/lib/live';
import { hashFor } from '@/lib/routes';

type Row = { repo: string; commit: string | null; when: string; fits: number; held: number; live: boolean };

function useLiveRepos(): { repos: LiveRepo[]; refresh: () => void } {
  const [repos, setRepos] = useState<LiveRepo[]>([]);
  const refresh = useCallback(() => {
    if (!/^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) return;
    fetch('/api/repos')
      .then((response) => (response.ok ? response.json() as Promise<{ repos?: LiveRepo[] }> : { repos: [] }))
      .then((body) => setRepos(body.repos ?? []))
      .catch(() => setRepos([]));
  }, []);
  useEffect(refresh, [refresh]);
  return { repos, refresh };
}

function RepoRow({ row }: { row: Row }) {
  return (
    <li className="repos__row" data-testid="repo-row">
      <a className="repos__name" href={hashFor('repo', row.repo)}>{row.repo}</a>
      <span className="repos__counts"><strong className="num">{row.fits}</strong> fit</span>
      <span className="repos__counts"><strong className="num">{row.held}</strong> held back</span>
      <span className="mono small">{row.commit ? shortSha(row.commit).slice(0, 7) : 'no commit'}</span>
      <span className="small">{row.when ? longDate(row.when) : ''}</span>
      <span>{row.live ? <Chip tone="blue">checked here</Chip> : <Chip tone="quiet">recorded run</Chip>}</span>
    </li>
  );
}

export function HomeScreen() {
  const { runs } = useBundle();
  const { repos, refresh } = useLiveRepos();
  const rows = useMemo<Row[]>(() => {
    const live = repos.map((repo) => ({ repo: repo.repo, commit: repo.commit, when: repo.scanned_at, fits: repo.findings, held: repo.held_back, live: true }));
    const recorded = runs.filter((run) => !run.provider_only && run.usage && !repos.some((repo) => repo.repo === run.repo))
      .map((run) => ({ repo: run.repo, commit: run.commit, when: run.scanned_at, fits: run.findings.filter((finding) => !finding.reach).length, held: run.held_back.length, live: false }));
    return [...live, ...recorded];
  }, [repos, runs]);
  return (
    <section className="screen home" data-screen="overview">
      <AddRepo onAdded={refresh} />
      <section className="repos">
        <h2 className="eyebrow">Your repos · {rows.length}</h2>
        <ul className="repos__list">{rows.map((row) => <RepoRow key={row.repo} row={row} />)}</ul>
      </section>
    </section>
  );
}
