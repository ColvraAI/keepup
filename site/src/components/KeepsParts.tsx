'use client';

import { useBundle } from './BundleContext';
import { DiffViewer } from './DiffViewer';
import { Ext } from './Ext';
import { Chip } from './parts';
import { friendlyRepo, longDate, shortDate, shortSha } from '@/lib/format';
import { addedExamples } from '@/lib/keeps-up';
import { hashFor } from '@/lib/routes';
import { isSurvivor, runFor } from '@/lib/repos';
import { shortNeeds, firstSentence } from '@/lib/text';
import type { Pr, PrStage } from '@/lib/types';

/** The commits on the pull request, one dot each. The new one drops in, then its diff appears. */
function StageTimeline({ pr, active }: { pr: Pr; active: number }) {
  return (
    <ol className="moment-commits" data-testid="stage-timeline">
      {pr.stages.map((stage, index) => (
        <li key={stage.date} className={index === active ? 'on' : ''}>
          <span className="mono">{longDate(stage.date)}</span>
          <span>{stage.comment ? firstSentence(stage.comment) : 'keepup would open the pull request'}</span>
        </li>
      ))}
    </ol>
  );
}

function PrLink({ pr }: { pr: Pr }) {
  const bundle = useBundle();
  return (
    <div className="moment-pr">
      <a href={hashFor('pr', pr.id)}>{isSurvivor(bundle, pr) ? <i className="kept-dot" aria-hidden="true" /> : null}PR {pr.id} · {pr.title}</a>
      <Chip tone="blue">{pr.status_label}</Chip>
    </div>
  );
}

export function UpdateMoment({ pr, stage }: { pr: Pr; stage: PrStage }) {
  return (
    <div className="moment moment--arrives" data-testid="moment-update">
      <div className="moment__text">
        <p className="moment__date mono">{longDate(stage.date)}</p>
        <h2 className="h2">{firstSentence(stage.comment ?? '')}</h2>
        <PrLink pr={pr} />
        <p>{firstSentence(stage.what_shipped)}</p>
        <StageTimeline pr={pr} active={pr.stages.indexOf(stage)} />
      </div>
      <div className="moment__diff"><DiffViewer key={stage.date} diff={stage.diff} scope={`this commit, ${shortDate(stage.date)}`} /></div>
    </div>
  );
}

export function GrowsMoment({ pr, stage }: { pr: Pr; stage: PrStage }) {
  const bundle = useBundle();
  const run = runFor(bundle, pr.upstream);
  const language = run?.languages[0]?.language;
  const about = run?.profile?.one_liner.split(',')[0];
  const earlier = pr.stages.slice(0, pr.stages.indexOf(stage));
  const before = earlier.flatMap((item) => addedExamples(item.diff));
  const after = addedExamples(stage.diff);
  return (
    <div className="moment moment--arrives" data-testid="moment-grows">
      <div className="moment__text">
        <p className="moment__date mono">{longDate(stage.date)} · {friendlyRepo(pr.upstream)}{language ? ` · ${language}` : ''}</p>
        <h2 className="h2">{firstSentence(stage.comment ?? '')}</h2>
        {about ? <p className="small">{about}.</p> : null}
        <PrLink pr={pr} />
        <div className="grows">
          <div>
            <p className="eyebrow">{shortDate(pr.stages[0]?.date ?? '')}</p>
            <p className="grows__count num">{before.length}</p>
            <ul className="mono">{before.map((name) => <li key={name}>{name}</li>)}</ul>
          </div>
          <span className="grows__arrow" aria-hidden="true">→</span>
          <div>
            <p className="eyebrow">{shortDate(stage.date)}</p>
            <p className="grows__count num">{before.length + after.length}</p>
            <ul className="mono">
              {before.map((name) => <li key={name}>{name}</li>)}
              {after.map((name, index) => <li key={name} className="grows__new" style={{ '--row': index } as React.CSSProperties}>{name}</li>)}
            </ul>
          </div>
        </div>
        <p className="moment__line">Different product, different pull requests.</p>
      </div>
      <div className="moment__diff"><DiffViewer key={stage.date} diff={stage.diff} scope={`this commit, ${shortDate(stage.date)}`} /></div>
    </div>
  );
}

function PlanCard({ pr, provider, fresh, dropped }: { pr: Pr; provider: string; fresh: boolean; dropped: string | null }) {
  const needs = pr.lab.needs ?? pr.needs;
  const classes = ['plan', fresh ? 'plan--fresh' : '', dropped ? 'plan--dropped' : ''].filter(Boolean).join(' ');
  return (
    <article className={classes} data-testid={fresh ? 'plan-new' : 'plan-card'}>
      <p className="plan__provider">{provider}</p>
      {dropped ? <p className="plan__dropped" data-testid="plan-dropped">{dropped}</p> : null}
      <PrLink pr={pr} />
      <p className="plan__line">{pr.founder_line}</p>
      <p className="small">
        Base <Ext href={pr.base_commit_url} className="mono">{shortSha(pr.base_commit)}</Ext> · <span className="mono">{pr.branch}</span>
        {needs ? <> · not measured yet, needs {shortNeeds(needs)}</> : null}
      </p>
    </article>
  );
}

export function ClaudeOnlyMoment({ main, variant, on, setOn }: { main: Pr; variant: Pr; on: boolean; setOn: (value: boolean) => void }) {
  const stage = variant.stages[0];
  return (
    <div className="moment moment--plans" data-testid="moment-claude" data-on={on}>
      <div className="plans__head">
        <label className="toggle">
          <input type="checkbox" role="switch" checked={on} data-testid="claude-only-toggle" onChange={(event) => setOn(event.target.checked)} />
          <span className="toggle__track" aria-hidden="true"><i /></span>
          <span className="toggle__label">We’re Claude-only</span>
        </label>
        <h2 className="h2" data-testid="claude-only-title">{on ? `keepup would re-plan PR ${main.id} on Jev` : `PR ${main.id} uses OpenAI’s Decisions API`}</h2>
      </div>
      <div className="plans">
        <PlanCard pr={main} provider="OpenAI Decisions API" fresh={false} dropped={on ? 'Needs OpenAI, so keepup drops it' : null} />
        {on ? <PlanCard pr={variant} provider="Jev" fresh dropped={null} /> : <div className="plan plan--empty" aria-hidden="true" />}
      </div>
      {on ? <p className="small plans__note">A recorded run of the engine with the provider set to Anthropic leaves only the Jev option. The patch itself was prepared ahead, and this switch shows it.</p> : null}
      {on && stage ? <div className="moment__diff"><DiffViewer key={`${variant.id}-${stage.date}`} diff={stage.diff} scope={`this commit, ${shortDate(stage.date)}`} /></div> : null}
    </div>
  );
}
