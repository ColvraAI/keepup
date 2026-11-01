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
/** A line of code uses a service. A manifest or config line only shows the team does: "{" in vercel.json uses nothing. */
const CODE_FILE = /\.(?:py|tsx?|jsx?|mjs|cjs)$/;
const WORKFLOW_FILE = /^\.github\/workflows\//;

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

/** Lower says more: a line of code, then a manifest or config line, then a workflow, which is true of most public repos. */
function receiptRank(file: string): number {
  if (CODE_FILE.test(file)) return 0;
  return WORKFLOW_FILE.test(file) ? 2 : 1;
}

function receiptFor(hit: Pick<Hit, 'file' | 'line'>, generic: boolean): string {
  const place = `${hit.file}:${hit.line}`;
  if (generic) return `${place} sets up a coding agent here.`;
  return CODE_FILE.test(hit.file) ? `${place} uses this.` : `${place} shows the team uses this service.`;
}

/** A team lever fits when its pattern fired here: the hit that says most is the receipt. */
function leverRows(levers: readonly Lever[], hits: readonly Pick<Hit, 'pattern' | 'file' | 'line'>[]): (Recommendation & { readonly generic: boolean; readonly rank: number })[] {
  return levers.flatMap((lever) => {
    const fired = hits.filter((item) => item.pattern === lever.pattern);
    const hit = fired.toSorted((a, b) => receiptRank(a.file) - receiptRank(b.file))[0];
    if (lever.audience !== 'team' || !lever.install || !hit) return [];
    const generic = lever.pattern === GENERIC_PATTERN;
    return [{ name: lever.name, kind: kindOf(lever), why: `${receiptFor(hit, generic)} ${lever.gain}${fillIn(lever.install)}`, install: lever.install, source: lever.source, generic, rank: receiptRank(hit.file) }];
  });
}

export function recommendationsFor(_facts: Pick<Facts, 'manifests'>, _files: ReadonlyMap<string, string>, _records: readonly DbRecord[], team: { readonly levers?: readonly Lever[]; readonly hits?: readonly Pick<Hit, 'pattern' | 'file' | 'line'>[] } = {}): Recommendation[] {
  const rows = leverRows(team.levers ?? [], team.hits ?? []);
  const vendors = rows.filter((row) => !row.generic).toSorted((a, b) => a.rank - b.rank);
  const generic = rows.filter((row) => row.generic).slice(0, MAX_GENERIC_ROWS);
  return [...vendors, ...generic].slice(0, MAX_ROWS).map(({ generic: _generic, rank: _rank, ...row }) => row);
}
