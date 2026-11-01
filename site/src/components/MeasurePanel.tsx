'use client';

import { useRef, useState } from 'react';
import { Chip } from './parts';
import { readStream, type Health, type Measure } from '@/lib/live';

function Rows({ measure }: { measure: Measure }) {
  if (measure.refused) return <p data-testid="measure-refused"><Chip tone="amber">Refused</Chip> {measure.refused}</p>;
  return (
    <ul className="measure__rows">
      {measure.rows.map((row) => (
        <li key={row.recipe} data-testid="measure-row">
          {row.status === 'measured'
            ? <><strong>{row.recipe}{row.headline ? `: ${row.headline}` : ''}</strong> <Chip tone="green">measured</Chip> <span className="mono small">n={row.n}</span><p className="small">{row.summary}</p><p className="small">What this can’t prove: {row.cannot_prove}</p></>
            : <><strong>{row.recipe}</strong> <Chip tone="quiet">not measured</Chip> <span className="small">{row.needs ? `needs ${row.needs}` : row.reason}</span></>}
        </li>
      ))}
    </ul>
  );
}

/** Measure it now: the prompt this call passes goes to the provider on your own key, after this page says so. */
export function MeasurePanel({ repo, rank, health, saved }: { repo: string; rank: number; health: Health; saved: Measure | null }) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [measure, setMeasure] = useState<Measure | null>(saved);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const run = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setSteps([]);
    try {
      const result = await readStream('/api/measure', { repo, finding: rank }, controller.signal, (event) => {
        if (event.type === 'step') setSteps((list) => [...list, `${String(event.name)}: ${String(event.detail)}`]);
        if (event.type === 'measure') setMeasure(event.measure as Measure);
        if (event.type === 'error') setError(String(event.message));
      });
      if (result.refused) setError(result.refused);
    } catch {
      if (!controller.signal.aborted) setError('The connection to the local server dropped.');
    } finally {
      setBusy(false);
    }
  };
  if (health.state !== 'present') return measure ? <div className="measure"><Rows measure={measure} /></div> : <p className="small" data-testid="measure-absent">Measuring runs on your own machine, on your key: <code>keepup measure . --finding {rank}</code></p>;
  return (
    <div className="measure">
      <button type="button" className="btn btn--quiet" disabled={busy} data-testid="measure-now" onClick={() => void run()}>{busy ? 'Measuring…' : 'Measure it now'}</button>
      <p className="small">Sends the prompt this call passes, masked, to the provider on your key. Stops at $0.25.</p>
      {steps.length > 0 ? <ol className="live__steps">{steps.map((step) => <li key={step} className="mono small">{step}</li>)}</ol> : null}
      {error ? <p className="live__error" role="alert">{error}</p> : null}
      {measure ? <><Rows measure={measure} /><p className="small">Spent ${measure.usd.toFixed(4)} of the ${measure.cap_usd} cap.</p></> : null}
    </div>
  );
}
