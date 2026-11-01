'use client';

import { useBundle } from './BundleContext';
import { Ext } from './Ext';
import { Chip, CodeLink } from './parts';
import { plural } from '@/lib/format';
import type { Run } from '@/lib/types';

export function Permissions() {
  const { manifest, requestedAppName } = useBundle();
  const { app } = manifest;
  return (
    <div className="permissions">
      <h2 className="h3">What the keepup App asks for</h2>
      <ul className="permissions__list">
        {Object.entries(app.permissions).map(([name, level]) => (
          <li key={name} data-level={level}>
            <span className="mono">{name.replaceAll('_', ' ')}</span>
            <Chip tone="quiet">{level}</Chip>
          </li>
        ))}
      </ul>
      {app.registered && app.url ? (
        <p className="small">
          The App is registered: <Ext href={app.url}>install it from GitHub</Ext>.
        </p>
      ) : (
        <p className="small">
          The App isn’t registered yet, so nothing is installed anywhere. This list is its real manifest
          {requestedAppName ? (
            <>
              , <code>app/manifest.json</code>, asking for the name <code>{requestedAppName}</code>
            </>
          ) : null}
          . What follows is a recording of a real run.
        </p>
      )}
    </div>
  );
}

const MANIFEST_STEP = 2;
const SITES_STEP = 5;
const HITS_STEP = 7;

/** What each step found appears as the step finishes, so the left column builds alongside the list. */
export function Evidence({ run, shown }: { run: Run; shown: number }) {
  const manifests = run.manifests.slice(0, 4);
  const sites = run.ai_call_sites.slice(0, 4);
  return (
    <div className="evidence">
      {shown >= MANIFEST_STEP ? (
        <section>
          <h3 className="eyebrow">Manifests · {run.manifests.length}</h3>
          <ul>
            {manifests.map((manifest) => (
              <li key={manifest.file}>
                <CodeLink file={manifest.file} url={manifest.permalink} />
                <span className="small"> {manifest.dependencies} {plural(manifest.dependencies, 'dependency', 'dependencies')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {shown >= SITES_STEP ? (
        <section>
          <h3 className="eyebrow">AI call sites · {run.ai_call_sites_total}</h3>
          <ul>
            {sites.map((site) => (
              <li key={`${site.file}:${site.line}`}>
                <CodeLink file={site.file} line={site.line} url={site.permalink} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {shown >= HITS_STEP ? (
        <section>
          <h3 className="eyebrow">Pattern hits · {run.pattern_hits_total}</h3>
          <ul>
            {run.pattern_hits.slice(0, 4).map((hit) => (
              <li key={`${hit.pattern}:${hit.file}:${hit.line}`}>
                <CodeLink file={hit.file} line={hit.line} url={hit.permalink} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
