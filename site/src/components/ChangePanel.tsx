'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffViewer } from './DiffViewer';
import { Ext } from './Ext';
import { Chip } from './parts';
import { parseDiff, readStream, type Change, type Health, type OpenPr } from '@/lib/live';

type Step = { name: string; detail: string };

const KIND_LINE: Record<string, string> = {
  swap: 'A small swap: a pull request.',
  'behind-a-setting': 'A bigger change: a pull request, off by default.',
  steps: 'Written steps: this needs an install, an account or a project, so there’s no code change.',
};

function OpenPullRequest({ change, health, anyway }: { change: Change; health: Health; anyway: boolean }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<OpenPr | null>(null);
  const open = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/open-pr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changeId: change.id }) });
      const body = await response.json() as OpenPr & { error?: string };
      setState(response.ok ? body : { state: 'refused', reason: body.error ?? 'That request was refused.' });
    } catch {
      setState({ state: 'refused', reason: 'The connection to the local server dropped.' });
    } finally {
      setBusy(false);
    }
  };
  if (state?.state === 'opened') return <p data-testid="pr-opened"><Ext href={state.url}>Pull request #{state.number} on {state.fork}</Ext>. CI: {state.ci}. A person merges.</p>;
  return (
    <div className="change__open">
      <button type="button" className="btn" disabled={busy} data-testid="open-pr" onClick={() => void open()}>{busy ? 'Opening…' : anyway ? 'Open pull request anyway' : 'Open pull request'}</button>
      {health.state === 'present' && !health.app && !state ? <p className="small" data-testid="pr-needs-app">The GitHub App isn’t set up in <code>.env</code> yet, so this tells you the next command and writes nothing.</p> : null}
      {health.state === 'present' && health.app && !state ? <p className="small">As the App, on a fork in the demo org. Never on the repo itself.</p> : null}
      {state?.state === 'needs_app' ? <p className="small" data-testid="pr-command">{state.detail} Next: <code>{state.command}</code></p> : null}
      {state?.state === 'refused' ? <p className="live__error" role="alert">{state.reason}</p> : null}
    </div>
  );
}

function ChangeResult({ change, health }: { change: Change; health: Health }) {
  const diff = useMemo(() => parseDiff(change.diff, change.title), [change.diff, change.title]);
  const unchecked = change.syntax.filter((line) => line.status === 'not checked');
  if (change.refused) {
    return (
      <div className="change__result" data-testid="change-refused">
        <p><Chip tone="amber">Refused</Chip> {change.refused}</p>
        <p className="small">Nothing was committed. Spent ${change.usd.toFixed(4)}.</p>
        {(change.steps ?? []).length > 0 ? <ol className="change__list">{(change.steps ?? []).map((step) => <li key={step}>{step}</li>)}</ol> : null}
      </div>
    );
  }
  if (change.kind === 'steps') {
    return (
      <div className="change__result" data-testid="change-steps">
        <p><Chip tone="grey">Steps</Chip> {KIND_LINE.steps}</p>
        {change.summary ? <p>{change.summary}</p> : null}
        <ol className="change__list">{(change.steps ?? []).map((step) => <li key={step}>{step}</li>)}</ol>
        <p className="small">Spent ${change.usd.toFixed(4)}.</p>
      </div>
    );
  }
  return (
    <div className="change__result" data-testid="change-diff">
      <p><Chip tone="blue">{change.kind}</Chip> {KIND_LINE[change.kind ?? 'swap']}</p>
      <p>{change.summary}</p>
      <p className="mono small">{change.branch} · {change.commit_sha?.slice(0, 7)} on {change.commit.slice(0, 7)}, in a temporary clone. Nothing pushed. Spent ${change.usd.toFixed(4)}.</p>
      <DiffViewer diff={diff} />
      <ul className="change__syntax" data-testid="change-syntax">
        {change.syntax.map((line) => <li key={line.file} className="small"><span className="mono">{line.file}</span> <Chip tone={line.status === 'ok' ? 'green' : 'quiet'}>{line.status === 'ok' ? 'parses' : line.status}</Chip> {line.detail}</li>)}
      </ul>
      <p className="small" data-testid="change-tests">{change.tests}</p>
      {unchecked.length > 0 ? <p className="live__error" role="alert" data-testid="change-unchecked">Nothing parsed {unchecked.map((line) => line.file).join(', ')}, so read this diff yourself. CI on the pull request is the first thing that will.</p> : null}
      {change.publish_block ? <p className="live__error" role="alert" data-testid="change-blocked">{change.publish_block}</p> : <OpenPullRequest change={change} health={health} anyway={unchecked.length > 0} />}
    </div>
  );
}

/** Make this change: the live steps, the kind it chose, the real diff, the syntax result, and the honest next step. */
export function ChangePanel({ repo, rank, health, made }: { repo: string; rank: number; health: Health; made: Change | null }) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [change, setChange] = useState<Change | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (made) setChange(made);
  }, [made]);
  const make = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setSteps([]);
    setChange(null);
    try {
      const result = await readStream('/api/change', { repo, finding: rank }, controller.signal, (event) => {
        if (event.type === 'step') setSteps((list) => [...list, { name: String(event.name), detail: String(event.detail) }]);
        if (event.type === 'change') setChange(event.change as Change);
        if (event.type === 'error') setError(String(event.message));
      });
      if (result.refused) setError(result.refused);
    } catch {
      if (!controller.signal.aborted) setError('The connection to the local server dropped.');
    } finally {
      setBusy(false);
    }
  };
  if (health.state !== 'present' && !change) {
    return (
      <div className="change">
        <button type="button" className="btn btn--quiet" disabled data-testid="make-change">Make this change</button>
        <p className="small" data-testid="make-absent">{health.state === 'checking' ? 'Looking for the local server…' : <>Writing a change runs on your own machine, so this static copy can’t do it. Run it locally: <code>npm run dashboard</code></>}</p>
      </div>
    );
  }
  return (
    <div className="change">
      {change && !change.refused ? null : <button type="button" className={change ? 'btn btn--quiet' : 'btn'} disabled={busy || health.state !== 'present' || !health.judge} data-testid="make-change" onClick={() => void make()}>{busy ? 'Writing the change…' : change ? 'Try again' : 'Make this change'}</button>}
      {health.state === 'present' && !health.judge ? <p className="small">This needs ANTHROPIC_API_KEY in <code>.env</code>, and a restart.</p> : null}
      {steps.length > 0 ? <ol className="live__steps" data-testid="change-live-steps">{steps.map((step, index) => <li key={`${step.name}-${index}`}><strong>{step.name}</strong> <span className="mono">{step.detail}</span></li>)}</ol> : null}
      {error ? <p className="live__error" role="alert">{error}</p> : null}
      {change ? <ChangeResult change={change} health={health} /> : null}
    </div>
  );
}
