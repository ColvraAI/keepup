'use client';

import { useEffect, useMemo, useState } from 'react';
import { Beats } from '@/components/Beats';
import { useBeat } from '@/hooks/useBeat';
import { useBundle, usePresent, useRepo } from '@/components/BundleContext';
import { Ext } from '@/components/Ext';
import { Payoff } from '@/components/Payoff';
import { CodeLink, RepoSwitch, ScreenHead } from '@/components/parts';
import { friendlyRepo, longDate, shortSha } from '@/lib/format';
import { demoRepos, runFor } from '@/lib/repos';
import type { Run } from '@/lib/types';

function Profile({ run }: { run: Run }) {
  const profile = run.profile;
  if (!profile) return <p className="lede">This run had no judge, so there’s no profile. Add a key and run it again.</p>;
  return (
    <div className="profile">
      <p className="profile__one">{profile.one_liner}</p>
      <div className="profile__grid">
        <section className="profile__jobs">
          <h2 className="eyebrow">The AI jobs in this code · {profile.jobs.length}</h2>
          <ol>
            {profile.jobs.map((job) => (
              <li key={job.job}>
                <span className="profile__job">{job.job}</span>
                <span className="profile__where">
                  {job.where.slice(0, 1).map((where) => (
                    <CodeLink key={`${where.file}:${where.line}`} file={where.file} line={where.line} url={where.permalink} />
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <aside className="profile__side">
          <section>
            <h2 className="eyebrow">Stack</h2>
            <ul className="plain-list">
              {profile.stack.slice(0, 4).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="eyebrow">Stack lock · what it will never suggest</h2>
            <ul className="plain-list">
              {profile.stack_lock.slice(-3).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function UnderstoodScreen({ arg }: { arg: string | null }) {
  const bundle = useBundle();
  const repos = demoRepos(bundle);
  const { repo, setRepo } = useRepo();
  useEffect(() => {
    if (arg && repos.includes(arg)) setRepo(arg);
  }, [arg, repos, setRepo]);
  const run = useMemo(() => runFor(bundle, repo), [bundle, repo]);
  const present = usePresent();
  const [beat, setBeat] = useBeat('understood', 1, { enabled: present });
  const [instant] = useState(() => beat === 1);
  const revealed = beat === 1;
  const showProfile = !present || !revealed;
  const showPayoff = !present || revealed;
  return (
    <section className="screen understood" data-screen="understood">
      <Beats back={present && revealed ? () => setBeat(0) : null} />
      <ScreenHead
        keepEyebrow
        eyebrow={
          run ? (
            <>
              What we understood · <Ext href={`https://github.com/${run.repo}/tree/${run.commit}`}>{run.repo}@{shortSha(run.commit).slice(0, 7)}</Ext> · recorded {longDate(run.scanned_at)}
            </>
          ) : 'What we understood'
        }
        title={friendlyRepo(repo)}
        aside={
          <div className="replay__controls">
            {present && !revealed ? (
              <button type="button" className="btn" data-present-action data-present-beat data-testid="reveal-payoff" onClick={() => setBeat(1)}>
                Check it against everything new
              </button>
            ) : null}
            <RepoSwitch repos={repos} value={repo} onChange={setRepo} />
          </div>
        }
      />
      {run ? (
        <>
          {showProfile ? <Profile run={run} /> : null}
          {showPayoff ? <Payoff key={run.file} run={run} instant={instant} /> : null}
        </>
      ) : (
        <p className="lede">No recorded run for {repo} yet.</p>
      )}
    </section>
  );
}
