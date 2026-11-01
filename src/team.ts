// "For your team": tools for the people who build this repo, each a lever a reviewed file names, shown only when its pattern
// fired here. Never a registry name matched to an import: that gave look-alikes, and an empty section is better than a wrong row.
// Never a pull request.
import type { Facts } from './facts.ts';
import type { Lever } from './levers.ts';
import type { Recommendation } from './run-shape.ts';
import type { Hit } from './scan.ts';
import type { DbRecord } from './search.ts';

const MAX_ROWS = 6;
/** The one pattern that says only "a coding agent is set up here": true of many repos, so it gets one row at most. */
const GENERIC_PATTERN = 'PAT-coding-agent-setup';
const MAX_GENERIC_ROWS = 1;
const PLACEHOLDER = /\{[A-Za-z_]\w*\}/g;

function kindOf(lever: Lever): Recommendation['kind'] {
  const install = lever.install ?? '';
  if (/\bmcp add\b/.test(install)) return 'mcp-server';
  if (/\bplugin\b/.test(install) || /plugin/i.test(lever.name)) return 'plugin';
  return /\bskills?\b/i.test(install) || /skill/i.test(lever.kind) ? 'skill' : 'tool';
}

function fillIn(install: string): string {
  const slots = [...new Set(install.match(PLACEHOLDER) ?? [])];
  return slots.length ? ` Fill in ${slots.join(' and ')} first.` : '';
}

/** A team lever fits when its pattern fired here: the hit is the receipt. */
function leverRows(levers: readonly Lever[], hits: readonly Pick<Hit, 'pattern' | 'file' | 'line'>[]): (Recommendation & { readonly generic: boolean })[] {
  return levers.flatMap((lever) => {
    const hit = hits.find((item) => item.pattern === lever.pattern);
    if (lever.audience !== 'team' || !lever.install || !hit) return [];
    const generic = lever.pattern === GENERIC_PATTERN;
    const receipt = generic ? `${hit.file}:${hit.line} sets up a coding agent here.` : `${hit.file}:${hit.line} uses this.`;
    return [{ name: lever.name, kind: kindOf(lever), why: `${receipt} ${lever.gain}${fillIn(lever.install)}`, install: lever.install, source: lever.source, generic }];
  });
}

export function recommendationsFor(_facts: Pick<Facts, 'manifests'>, _files: ReadonlyMap<string, string>, _records: readonly DbRecord[], team: { readonly levers?: readonly Lever[]; readonly hits?: readonly Pick<Hit, 'pattern' | 'file' | 'line'>[] } = {}): Recommendation[] {
  const rows = leverRows(team.levers ?? [], team.hits ?? []);
  const vendors = rows.filter((row) => !row.generic);
  const generic = rows.filter((row) => row.generic).slice(0, MAX_GENERIC_ROWS);
  return [...vendors, ...generic].slice(0, MAX_ROWS).map(({ generic: _generic, ...row }) => row);
}
