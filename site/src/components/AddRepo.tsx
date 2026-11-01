'use client';

import { useEffect, useRef, useState } from 'react';
import { hashFor } from '@/lib/routes';
import { readStream, repoFromInput, useHealth } from '@/lib/live';

type Step = { name: string; detail: string };

/** The tool's front door: a shallow clone, the scan, then Claude's check, and on to the repo's page. */
export function AddRepo({ onAdded }: { onAdded: () => void }) {
  const health = useHealth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nothing, setNothing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const job = async (path: string, repo: string, controller: AbortController, onEvent: (event: Record<string, unknown>) => void): Promise<boolean> => {
    const result = await readStream(path, { repo }, controller.signal, (event) => {
      if (event.type === 'step') setSteps((list) => [...list, { name: String(event.name), detail: String(event.detail) }]);
      if (event.type === 'error') setError(String(event.message));
      onEvent(event);
    });
    if (result.refused) setError(result.refused);
    else if (!result.done) setError((old) => old ?? 'It stopped before it finished.');
    return !result.failed;
  };

  const add = async (repo: string, judge: boolean) => {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setSteps([]);
    setNothing(false);
    let hits = 0;
    let models = 0;
    let checkable = false;
    try {
      const scanned = await job('/api/scan', repo, controller, (event) => {
        if (event.type !== 'summary') return;
        if (typeof event.hits === 'number') hits = event.hits;
        if (typeof event.models === 'number') models = event.models;
        checkable = event.checkable === true;
      });
      if (!scanned) return;
      if (!checkable) {
        setNothing(true);
        return;
      }
      if (!judge) {
        setError(`${hits} pattern hits and ${models} model ids to check, but there’s no ANTHROPIC_API_KEY in .env, so Claude can’t check them here. Add it and restart.`);
        return;
      }
      if (await job('/api/judge', repo, controller, () => undefined)) {
        onAdded();
        window.location.hash = hashFor('repo', repo);
      }
    } catch {
      if (!controller.signal.aborted) setError('The connection to the local server dropped.');
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (busy || health.state !== 'present') return;
    const repo = repoFromInput(text);
    if (!repo) return setError('Give a public repo as owner/name or a GitHub URL, such as mezmo/aura.');
    void add(repo, health.judge);
    return undefined;
  };

  const absent = health.state === 'absent';
  return (
    <section className="add-repo" data-testid="live-scan">
      <h2 className="h3">Add a repo</h2>
      <form className="live__form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <input aria-label="Repo as owner/name, or a GitHub URL" placeholder="owner/name or a GitHub URL" value={text} spellCheck={false} autoCapitalize="off" disabled={absent} onChange={(event) => setText(event.target.value)} data-testid="live-input" />
        {busy ? (
          <button key="stop" className="btn btn--quiet" type="button" data-testid="live-stop" onClick={(event) => { event.preventDefault(); abort.current?.abort(); }}>Stop</button>
        ) : (
          <button key="scan" className="btn" type="submit" disabled={absent} data-testid="live-scan-go">Add</button>
        )}
      </form>
      {absent ? <p className="small" data-testid="live-absent">Adding a repo runs on your own machine, so this static copy can’t do it. Run it locally: <code>npm run dashboard</code></p> : null}
      {health.state === 'present' ? <p className="small" data-testid="live-privacy">A shallow clone onto this machine, read as text and never run. A clone Claude hasn’t checked is deleted within {health.keepMinutes ?? 20} minutes; a checked one is deleted when the dashboard stops. Each repo’s findings and each change’s masked diff stay in <code>tmp/live-scans</code> for 30 days. Claude gets masked excerpts to Anthropic’s API, with a dollar cap.</p> : null}
      {error ? <p className="live__error" role="alert">{error}</p> : null}
      {nothing ? <p className="small" data-testid="live-no-hits">No model ids and no AI API calls found, so there’s nothing here for keepup to check.</p> : null}
      {steps.length > 0 ? (
        <ol className="live__steps" data-testid="live-steps">
          {steps.map((step, index) => <li key={`${step.name}-${index}`}><strong>{step.name}</strong> <span className="mono">{step.detail}</span></li>)}
        </ol>
      ) : null}
    </section>
  );
}
