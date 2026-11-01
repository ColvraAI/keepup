'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBundle } from '@/components/BundleContext';
import { ChangePanel } from '@/components/ChangePanel';
import { MeasurePanel } from '@/components/MeasurePanel';
import { RoiCalculator, type RoiView } from '@/components/RoiCalculator';
import { Ext } from '@/components/Ext';
import { Chip, CodeLink } from '@/components/parts';
import { longDate, shortSha } from '@/lib/format';
import { useHealth, useSavedChanges, type Change, type Health, type Measure } from '@/lib/live';
import { hashFor } from '@/lib/routes';

type Value = {
  status: 'priced' | 'no_number' | 'worked';
  roi?: RoiView;
  formula: string;
  reason?: string;
  speed?: { text: string; label: string };
  today_per_call_usd?: number;
  frontier_per_call_usd?: number;
  change_cost_usd?: number;
  value_usd?: number;
  measurable?: boolean;
  inputs: Record<string, { value: number | string; label: string } | undefined>;
};
type RepoFinding = { rank: number; title: string; effect?: string[]; proof: string; effort: string; where: { file: string; line: number }[]; why: string; sources: string[]; reach?: string; value?: Value };

const money = (value: number) => (Math.abs(value) < 1 ? `$${value.toFixed(2)}` : `$${Math.round(value).toLocaleString('en-US')}`);
const MONTHS = 12;

/** The plan's sum at the volume the person typed: (cost today - frontier cost) x calls - cost of change. */
function valueAt(value: Value, calls: number): { monthly: number; first: number; breakEven: number | null } {
  const perCall = (value.today_per_call_usd ?? 0) - (value.frontier_per_call_usd ?? 0);
  const monthly = perCall * calls;
  return { monthly, first: monthly * MONTHS - (value.change_cost_usd ?? 0), breakEven: perCall > 0 ? Math.ceil((value.change_cost_usd ?? 0) / (perCall * MONTHS)) : null };
}

/** It has a number at this volume, and the number doesn't pay back. Having a formula isn't having a gain. */
function losesMoney(value: Value | undefined, calls: number): boolean {
  return value?.status === 'priced' && valueAt(value, calls).first <= 0;
}

function ValueLine({ value, calls }: { value: Value; calls: number }) {
  const { modelPrices } = useBundle();
  if (value.roi) return <RoiCalculator roi={value.roi} prices={modelPrices} calls={calls} />;
  if (value.status !== 'priced') return <p className="finding__value small" data-testid="value-absent">No money number: {value.reason}</p>;
  const { monthly, first, breakEven } = valueAt(value, calls);
  const tokens = value.inputs.input_tokens;
  const model = value.inputs.model;
  return (
    <div className="finding__value" data-testid="lever-value">
      {first <= 0
        ? <p data-testid="break-even"><strong>{breakEven ? `Pays back above about ${breakEven.toLocaleString('en-US')} calls a month` : 'No saving at any volume'}</strong> <Chip tone="grey">projected</Chip>. At {calls.toLocaleString('en-US')} calls a month <Chip tone="quiet">assumed</Chip> it doesn’t clear its cost: {money(first)} in the first year.</p>
        : <p><strong>{`About ${money(monthly)} a month cheaper`}</strong> <Chip tone="grey">projected</Chip> at {calls.toLocaleString('en-US')} calls a month <Chip tone="quiet">assumed</Chip>. First year, after the change: {money(first)}.</p>}
      <p className="small">({money(value.today_per_call_usd ?? 0)} today − {money(value.frontier_per_call_usd ?? 0)} frontier) a call × calls × {MONTHS} months − {money(value.change_cost_usd ?? 0)} to change. {tokens ? <>{tokens.value} input tokens: {tokens.label}. </> : null}{model ? <>{String(model.value)}: {model.label}.</> : null}</p>
    </div>
  );
}

function modelsLine(run: RepoRun, findings: number): string {
  const models = (run.exact ?? []).filter((item) => item.kind === 'model' && (item.live_places?.length ?? 0) > 0);
  const gone = models.filter((item) => item.status === 'retired').length;
  const going = models.length - gone;
  if (models.length === 0) return `${findings} retired or retiring model ${findings === 1 ? 'finding' : 'findings'}`;
  return [gone ? `${gone} model${gone === 1 ? '' : 's'} here ${gone === 1 ? 'has' : 'have'} shut down` : '', going ? `${going} ${gone ? 'more' : `model${going === 1 ? '' : 's'} here`} ${going === 1 ? 'is' : 'are'} retiring` : ''].filter(Boolean).join(' and ');
}

function Speed({ value }: { value?: Value }) {
  return value?.speed ? <p className="finding__speed small"><strong>{value.speed.text}</strong> <Chip tone="grey">{value.speed.label}</Chip></p> : null;
}

/** What this page reads: the same in a recorded run and in a live scan's run file. */
type RepoRun = {
  repo: string;
  commit: string | null;
  scanned_at: string;
  profile: { one_liner: string; stack: string[]; jobs: { job: string; where: { file: string; line: number }[] }[] } | null;
  findings: RepoFinding[];
  db?: { records: number };
  recommendations?: { name: string; kind: string; why: string; install: string; source: string }[];
  dropped_levers?: { lever: string; where?: string }[];
  checks?: { dropped?: { lever?: string; where?: string }[] };
  measurements?: (Measure & { finding_rank: number })[];
  exact?: { kind: string; status?: string; live_places?: unknown[] }[];
  held_back: { thing: string; reason: string; source: string | null }[];
  incomplete?: { reason: string };
};

const MAX_PLACES = 4;
const blobUrl = (run: RepoRun, file: string, line: number) => `https://github.com/${run.repo}/blob/${run.commit}/${file}#L${line}`;

function useRun(repo: string, recorded: RepoRun | null): { run: RepoRun | null; missing: boolean } {
  const [live, setLive] = useState<RepoRun | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/run?repo=${encodeURIComponent(repo)}`, { signal: abort.signal })
      .then((response) => (response.ok ? response.json() as Promise<{ run: RepoRun }> : Promise.reject(new Error('none'))))
      .then((body) => setLive(body.run))
      .catch(() => {
        if (!abort.signal.aborted) setMissing(true);
      });
    return () => abort.abort();
  }, [repo]);
  return { run: live ?? recorded, missing };
}

function FindingCard({ finding, run, health, made, calls }: { finding: RepoRun['findings'][number]; run: RepoRun; health: Health; made: Change | null; calls: number }) {
  const extra = finding.where.length - MAX_PLACES;
  return (
    <li className="finding" data-testid="finding">
      <header className="finding__head">
        <span className="finding__rank num">{finding.rank}</span>
        <h3 className="h3">{finding.title}</h3>
      </header>
      <p className="finding__tags">{(finding.effect ?? []).map((word) => <Chip key={word} tone="blue">{word}</Chip>)}<Chip tone="grey">{finding.proof}</Chip><Chip tone="quiet">{finding.effort}</Chip></p>
      <Speed value={finding.value} />
      {finding.value ? <ValueLine value={finding.value} calls={calls} /> : null}
      <p className="finding__why">{finding.why}</p>
      <p className="finding__places mono small">
        {finding.where.slice(0, MAX_PLACES).map((place) => <span key={`${place.file}:${place.line}`}><CodeLink file={place.file} line={place.line} url={blobUrl(run, place.file, place.line)} /></span>)}
        {extra > 0 ? <span>and {extra} more</span> : null}
      </p>
      <p className="finding__sources small">{finding.sources.slice(0, 3).map((source) => <span key={source}><Ext href={source}>{source.replace(/^https?:\/\//, '')}</Ext></span>)}</p>
      {finding.value?.measurable ? <MeasurePanel repo={run.repo} rank={finding.rank} health={health} saved={(run.measurements ?? []).filter((item) => item.finding_rank === finding.rank).at(-1) ?? null} /> : null}
      <ChangePanel repo={run.repo} rank={finding.rank} health={health} made={made} />
    </li>
  );
}

function droppedLevers(run: RepoRun): { lever: string; where?: string }[] {
  return run.dropped_levers ?? (run.checks?.dropped ?? []).flatMap((item) => (item.lever ? [{ lever: item.lever, where: item.where }] : []));
}

function Understood({ run }: { run: RepoRun }) {
  if (!run.profile) return <p className="small">This run had no judge, so there’s no profile.</p>;
  return (
    <section className="repo__understood">
      <h2 className="eyebrow">What we understood</h2>
      <p className="repo__one">{run.profile.one_liner}</p>
      <ul className="repo__jobs small">
        {run.profile.jobs.map((job) => <li key={job.job}>{job.job}</li>)}
      </ul>
    </section>
  );
}

export function RepoScreen({ arg }: { arg: string | null }) {
  const { runs } = useBundle();
  const repo = arg ?? '';
  const recorded = (runs.find((item) => item.repo === repo && !item.provider_only) ?? null) as unknown as RepoRun | null;
  const { run, missing } = useRun(repo, recorded);
  const health = useHealth();
  const saved = useSavedChanges(repo);
  const [calls, setCalls] = useState(10_000);
  const levers = useMemo(() => (run?.findings ?? []).filter((finding) => !finding.reach), [run]);
  const retired = useMemo(() => (run?.findings ?? []).filter((finding) => finding.reach), [run]);
  const card = (finding: RepoFinding) => <FindingCard key={finding.rank} finding={finding} run={run as RepoRun} health={health} calls={calls} made={saved.find((item) => item.commit === run?.commit && item.finding_rank === finding.rank) ?? null} />;
  const lead = levers[0];
  if (!run) return <section className="screen repo" data-screen="repo"><p className="lede">{missing ? `No run for ${repo} yet. ` : 'Reading the run…'}<a href={hashFor('overview')}>Add it from your repos.</a></p></section>;
  return (
    <section className="screen repo" data-screen="repo">
      <header className="repo__head">
        <p className="eyebrow"><a href={hashFor('overview')}>Your repos</a></p>
        <h1 className="h2">{run.repo}</h1>
        <p className="mono small">{run.commit ? <Ext href={`https://github.com/${run.repo}/tree/${run.commit}`}>{shortSha(run.commit).slice(0, 7)}</Ext> : 'no commit'} · ran {longDate(run.scanned_at)}</p>
      </header>
      {run.incomplete ? <p className="small" role="status">{run.incomplete.reason}</p> : null}
      {lead ? (
        <section className="repo__lead" data-testid="biggest-lever">
          <p className="eyebrow">{losesMoney(lead.value, calls) ? 'Nothing clears its cost at this volume · closest' : 'Biggest lever'}</p>
          <h2 className="h3">{lead.title}</h2>
          <Speed value={lead.value} />
          {lead.value?.roi?.money ? <p className="small">The sum for this lever is in its card below, with your model and your volume.</p> : lead.value ? <ValueLine value={lead.value} calls={calls} /> : null}
          <label className="repo__volume small">Calls a month <Chip tone="quiet">assumed, change it</Chip> <input type="number" min={0} step={1000} value={calls} data-testid="assumed-volume" onChange={(event) => setCalls(Math.max(0, Number(event.target.value) || 0))} /></label>
        </section>
      ) : null}
      {levers.length === 0 ? (
        <section className="repo__lead" data-testid="nothing-big">
          <h2 className="h3">Nothing big fits this week.</h2>
          <p className="small">Checked this commit against {run.db ? `${run.db.records.toLocaleString('en-US')} new or updated things` : 'the database'} and every lever whose pattern fired here.</p>
        </section>
      ) : (
        <section className="repo__findings">
          <h2 className="eyebrow">Levers · {levers.length}</h2>
          <ol className="findings">{levers.map(card)}</ol>
        </section>
      )}
      {retired.length ? (
        <details className="repo__also" data-testid="also-retired">
          <summary>Also: {modelsLine(run, retired.length)} · <span className="mono small">{retired[0].where[0]?.file}:{retired[0].where[0]?.line}</span> · want the change?</summary>
          <ol className="findings">{retired.map(card)}</ol>
        </details>
      ) : null}
      {droppedLevers(run).length ? (
        <section className="repo__dropped" data-testid="dropped-levers">
          <h2 className="eyebrow">Dropped by the checks · {droppedLevers(run).length}</h2>
          <ul className="repo__held-list small">{droppedLevers(run).map((row) => <li key={`${row.lever}${row.where ?? ''}`}><strong>{row.lever}</strong>{row.where ? <> <span className="mono">{row.where}</span></> : null}: a claim in it couldn’t be read from its sources, so it isn’t shown.</li>)}</ul>
        </section>
      ) : null}
      {(run.recommendations ?? []).length ? (
        <section className="repo__team" data-testid="for-your-team">
          <h2 className="eyebrow">For your team</h2>
          <p className="small">For your developers’ own tools. Never a pull request.</p>
          <ul className="repo__team-list">{(run.recommendations ?? []).map((row) => <li key={row.name}><strong>{row.name}</strong> <span className="small">{row.why}</span> <code className="repo__install">{row.install}</code> <Ext href={row.source}>source</Ext></li>)}</ul>
        </section>
      ) : null}
      <Understood run={run} />
      <section className="repo__held">
        <h2 className="eyebrow">Held back · {run.held_back.length}</h2>
        <ul className="repo__held-list">
          {run.held_back.map((row) => <li key={`${row.thing}${row.reason}`} data-testid="held-back"><strong>{row.thing}</strong> <span className="small">{row.reason}</span>{row.source ? <> <Ext href={row.source}>source</Ext></> : null}</li>)}
        </ul>
      </section>
    </section>
  );
}
