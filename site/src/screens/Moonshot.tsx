'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Beats } from '@/components/Beats';
import { useBundle, usePresent } from '@/components/BundleContext';
import { Ext } from '@/components/Ext';
import { Chip, ScreenHead } from '@/components/parts';
import { PresentDetail } from '@/components/PresentDetail';
import { useBeat } from '@/hooks/useBeat';
import { useDetailKey } from '@/hooks/useSkip';
import { count, friendlyRepo, longDate, shortSha, usd } from '@/lib/format';
import { cacheFor, DEFAULT_ASSUMPTIONS, DEFAULT_BASE_MODEL, DEFAULT_CHEAP_MODEL, GOAL_SHARE, measuredLevers, planFor, priceFor, shortModel, type Assumptions, type Plan as PlanNumbers } from '@/lib/moonshot-calc';
import { labLabel, replayFor } from '@/lib/repos';
import type { MoonshotPrice } from '@/lib/types';

type FieldKey = keyof Assumptions;
const FIELDS: readonly { key: FieldKey; label: string; percent?: boolean }[] = [
  { key: 'messages', label: 'Messages a month' },
  { key: 'inputTokens', label: 'Input tokens per message' },
  { key: 'outputTokens', label: 'Output tokens per message' },
  { key: 'cacheableShare', label: 'Share of input that repeats', percent: true },
  { key: 'cacheHitRate', label: 'Cache hit rate', percent: true },
  { key: 'cheapShare', label: 'Messages a smaller model can answer', percent: true },
];

/** What a median rests on, beside it: three points from one commit isn't three independent results. */
function pointsOf(points: readonly { commit: string }[]): string | null {
  if (points.length === 0) return null;
  const commits = new Set(points.map((point) => point.commit)).size;
  return `${points.length} ${points.length === 1 ? 'point' : 'points'}, ${commits} ${commits === 1 ? 'commit' : 'commits'}`;
}

function Fleet() {
  const bundle = useBundle();
  const present = usePresent();
  const { runs, moonshot } = bundle;
  const rows = runs.filter((run) => !run.provider_only);
  const total = rows.reduce((sum, run) => sum + run.findings.length, 0);
  const held = rows.reduce((sum, run) => sum + run.held_back.length, 0);
  return (
    <section className="fleet" data-testid="fleet">
      <h2 className="h2">{present ? `Fleet: ${rows.length} repos, ${total} findings, ${held} held back` : `Fleet: ${rows.length} repos, one view`}</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Repo</th><th>Commit</th><th>Findings</th><th>Held back</th><th>Watching</th><th>Replay: PRs opened</th><th>Team, median days later</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((run) => {
              const replay = moonshot.fleet.find((item) => item.repo === run.repo);
              const points = pointsOf(replayFor(bundle, run.repo)?.summary.team_points ?? []);
              return (
                <tr key={run.file}>
                  <td>{run.repo}</td>
                  <td><Ext href={`https://github.com/${run.repo}/tree/${run.commit}`} className="mono">{shortSha(run.commit).slice(0, 7)}</Ext></td>
                  <td className="num">{run.findings.length}</td>
                  <td className="num">{run.held_back.length}</td>
                  <td className="num">{run.watching.length}</td>
                  <td className="num">{replay ? replay.prs_opened : 'not replayed'}</td>
                  <td><span className="num">{replay ? (replay.median_days_later ?? 'no point yet') : 'not replayed'}</span>{points ? <span className="fleet__points"> · {points}</span> : null}</td>
                </tr>
              );
            })}
            <tr className="fleet__total">
              <td>Across the fleet</td><td /><td className="num">{total}</td><td className="num">{held}</td><td colSpan={3} />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Assumption({ field, value, onChange }: { field: (typeof FIELDS)[number]; value: number; onChange: (value: number) => void }) {
  const shown = field.percent ? Math.round(value * 100) : value;
  return (
    <label className="assume">
      <span>{field.label}</span>
      <span className="assume__input">
        <input
          type="number"
          min={0}
          max={field.percent ? 100 : undefined}
          step={field.percent ? 5 : field.key === 'messages' ? 10_000 : 100}
          value={shown}
          data-testid={`assume-${field.key}`}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed) || parsed < 0) return;
            onChange(field.percent ? Math.min(parsed, 100) / 100 : parsed);
          }}
        />
        {field.percent ? <em>%</em> : null}
      </span>
    </label>
  );
}

const PriceLink = ({ price }: { price: MoonshotPrice }) => (
  <Ext href={price.url}>{price.name.split(': ').at(-1)}: {usd(price.price_in_per_m)} in, {usd(price.price_out_per_m)} out per million ({price.source}, {longDate(price.fetched)})</Ext>
);

function ModelPick({ label, testId, prices, value, onChange }: { label: string; testId: string; prices: readonly MoonshotPrice[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="assume assume--model">
      <span>{label}</span>
      <select value={value} data-testid={testId} onChange={(event) => onChange(event.target.value)}>
        {prices.map((price) => <option key={price.model_id} value={price.model_id}>{shortModel(price)}</option>)}
      </select>
    </label>
  );
}

type Lever = { id: string; name: string; label: string; tone: 'quiet' | 'green' | 'grey'; figure: string | null; detail: ReactNode };

function LeverRow({ lever, compact }: { lever: Lever; compact: boolean }) {
  return (
    <li className="lever" data-testid="lever">
      <h3 className="h3">{lever.name} <Chip tone={lever.tone}>{lever.label}</Chip></h3>
      {lever.figure ? <p className="lever__figure num">{lever.figure}</p> : null}
      {compact ? null : <div className="lever__detail">{lever.detail}</div>}
    </li>
  );
}

function useLevers(a: Assumptions, base: MoonshotPrice, cheap: MoonshotPrice, plan: PlanNumbers): Lever[] {
  const { moonshot, prs } = useBundle();
  const cache = cacheFor(moonshot, base);
  const fallback = moonshot.router_fallback;
  const baseName = shortModel(base);
  return [
    {
      id: 'baseline', name: 'Baseline', label: 'projected', tone: 'quiet', figure: `${usd(plan.baseline, 0)} a month`,
      detail: (
        <>
          <p className="formula mono">messages × (input × in price + output × out price) ÷ 1M = {usd(plan.baseline, 0)}</p>
          <p className="small">This isn’t the product’s default model. It assumes all the traffic is on <PriceLink price={base} />.{fallback ? <> AnythingLLM’s own OpenAI default is <Ext href={fallback.url} className="mono">{fallback.model}</Ext>. {fallback.note}</> : null}</p>
        </>
      ),
    },
    {
      id: 'routing', name: 'Send simple messages to a smaller model', label: 'projected', tone: 'quiet', figure: usd(plan.routingSaved, 0),
      detail: (
        <>
          <p className="formula mono">messages × {Math.round(a.cheapShare * 100)}% × (input × saved per M in + output × saved per M out) ÷ 1M = {usd(plan.routingSaved, 0)}</p>
          <p className="small"><PriceLink price={cheap} /></p>
        </>
      ),
    },
    {
      id: 'caching', name: cache ? `Cache what repeats, on ${baseName} (${providerName(cache.provider)})` : `Cache what repeats, on ${baseName}`, label: 'projected', tone: 'quiet', figure: usd(plan.cachingSaved, 0),
      detail: cache ? (
        <>
          <p className="formula mono">messages × {Math.round((1 - a.cheapShare) * 100)}% × input × {Math.round(a.cacheableShare * 100)}% × {Math.round(a.cacheHitRate * 100)}% × in price × (1 − {cache.multiplier}) ÷ 1M = {usd(plan.cachingSaved, 0)}</p>
          <p className="small">This line is for {providerName(cache.provider)} only. <Ext href={cache.url}>“{cache.quote}”</Ext> {longDate(cache.date)}. Leaves out what cache writes cost, which this source doesn’t state.</p>
        </>
      ) : <p className="small">The data holds no cache price for {baseName}, so caching counts for nothing here.</p>,
    },
    ...measuredLevers(prs).map((pr): Lever => ({
      id: pr.id, name: `PR ${pr.id}: ${pr.title}`, tone: pr.lab.status === 'measured' ? 'green' : 'grey', label: pr.lab.status === 'measured' ? 'measured' : 'not measured yet', figure: pr.lab.status === 'measured' ? pr.lab.title_number : null,
      detail: <p className="small">{pr.lab.status === 'measured' ? pr.lab.title_number : `${labLabel(pr)}. It counts for nothing in the number above until it runs.`}</p>,
    })),
  ];
}

const PROVIDER_NAME: Readonly<Record<string, string>> = { anthropic: 'Anthropic', openai: 'OpenAI' };
const providerName = (id: string): string => PROVIDER_NAME[id] ?? id;

const USAGE_LATER = 'Later, usage data could replace the volumes. A saving stays projected until the change has shipped and been measured.';

function Plan({ a, setA, base, cheap, plan, setBaseId, setCheapId }: { a: Assumptions; setA: (a: Assumptions) => void; base: MoonshotPrice; cheap: MoonshotPrice; plan: PlanNumbers; setBaseId: (id: string) => void; setCheapId: (id: string) => void }) {
  const { moonshot } = useBundle();
  const present = usePresent();
  const [detail, setDetail] = useState(false);
  useDetailKey(useCallback(() => setDetail((open) => !open), []));
  const levers = useLevers(a, base, cheap, plan);
  return (
    <section className="goal">
      <div className="goal__head">
        <h2 className="h2">Goal: Cut AnythingLLM’s AI cost by {Math.round(GOAL_SHARE * 100)}%</h2>
        <p className="goal__result" data-testid="goal-result">
          <span className="num">−{Math.round(plan.share * 100)}%</span>
          <span className="goal__label">projected, if all its traffic ran on {shortModel(base)} · {usd(plan.saved, 0)} of {usd(plan.baseline, 0)} a month</span>
        </p>
        <div className="goal__bar" aria-hidden="true">
          <i style={{ width: `${Math.min(plan.share, 1) * 100}%` }} />
          <b style={{ left: `${GOAL_SHARE * 100}%` }}><span>goal</span></b>
        </div>
      </div>
      <div className="goal__grid">
        <div className="goal__inputs">
          <p className="goal__assumed">Every input here is an assumption. A static scan can’t see traffic, so change them.</p>
          <ModelPick label="Model all the traffic is on" testId="assume-base" prices={moonshot.prices} value={base.model_id} onChange={setBaseId} />
          <ModelPick label="Smaller model for simple messages" testId="assume-cheap" prices={moonshot.prices} value={cheap.model_id} onChange={setCheapId} />
          {FIELDS.map((field) => (
            <Assumption key={field.key} field={field} value={a[field.key]} onChange={(value) => setA({ ...a, [field.key]: value })} />
          ))}
          {present ? null : <p className="small" data-testid="usage-later">{USAGE_LATER}</p>}
        </div>
        <ol className="levers">{levers.map((lever) => <LeverRow key={lever.id} lever={lever} compact={present} />)}</ol>
      </div>
      {present && detail ? (
        <PresentDetail title="Each lever, with its formula and price" onClose={() => setDetail(false)}>
          <ol className="levers">{levers.map((lever) => <LeverRow key={lever.id} lever={lever} compact={false} />)}</ol>
          <p className="small" data-testid="usage-later">{USAGE_LATER}</p>
        </PresentDetail>
      ) : null}
    </section>
  );
}

function Goal() {
  const { moonshot } = useBundle();
  const [a, setA] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [baseId, setBaseId] = useState(DEFAULT_BASE_MODEL);
  const [cheapId, setCheapId] = useState(DEFAULT_CHEAP_MODEL);
  const base = priceFor(moonshot, baseId);
  const cheap = priceFor(moonshot, cheapId);
  const cache = base ? cacheFor(moonshot, base) : null;
  const plan = useMemo(() => (base && cheap ? planFor(a, base, cheap, cache?.multiplier ?? null) : null), [a, base, cheap, cache]);
  if (!base || !cheap || !plan) return <p className="lede">Not measured yet · needs the prices in data/db.</p>;
  return <Plan a={a} setA={setA} base={base} cheap={cheap} plan={plan} setBaseId={setBaseId} setCheapId={setCheapId} />;
}

export function MoonshotScreen() {
  const { moonshot, runs } = useBundle();
  const present = usePresent();
  const [beat, setBeat] = useBeat('moonshot', 1, { enabled: present });
  const showFleet = beat === 1;
  const count_ = runs.filter((run) => !run.provider_only).length;
  return (
    <section className="screen moonshot" data-screen="moonshot">
      <ScreenHead keepEyebrow eyebrow={`Bonus · what keepup becomes · ${moonshot.label}`} title={`From one repo to ${count(count_)}, from findings to a goal`} />
      <Beats forward={present && !showFleet ? () => setBeat(1) : null} back={present && showFleet ? () => setBeat(0) : null} />
      {present && showFleet ? null : <Goal />}
      {present && !showFleet ? null : <Fleet />}
      {present && !showFleet ? null : <p className="small moonshot__foot">Fleet numbers are from the recorded runs of {friendlyRepo(moonshot.fleet[0]?.repo ?? '')}, {friendlyRepo(moonshot.fleet[1]?.repo ?? '')} and the others in <code>data/runs</code>. Every dollar on this screen is projected.</p>}
    </section>
  );
}
