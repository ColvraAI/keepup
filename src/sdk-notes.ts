// A text search can see what a repo's code sets, not what the library under it sends. So when a successor breaks on a
// setting the repo's text never mentions and an SDK makes the calls, that's "not ruled out", and the job may be the upgrade.
import type { DependencyCheck } from './exact-checks.ts';
import type { Lever } from './levers.ts';
import type { FindingOption } from './run-shape.ts';

/** Libraries that write a provider's request themselves, whichever provider it is. */
const NEUTRAL = /^(?:ai|langchain|@langchain\/core|langchain-core|llamaindex|llama-index(?:-core)?|litellm|instructor|pydantic-ai(?:-slim)?|mastra|@mastra\/core|@openai\/agents|openai-agents|dspy(?:-ai)?|crewai|haystack-ai)$/;
const FOR_PROVIDER: Readonly<Record<string, RegExp>> = {
  anthropic: /^(?:@ai-sdk\/anthropic|@langchain\/anthropic|langchain-anthropic|llama-index-llms-anthropic)$/,
  openai: /^(?:@ai-sdk\/openai|@langchain\/openai|langchain-openai|llama-index-llms-openai)$/,
  gemini: /^(?:@ai-sdk\/google(?:-vertex)?|@langchain\/google-[\w-]+|langchain-google-[\w-]+|llama-index-llms-(?:gemini|google-genai|vertex))$/,
};
const FAR_BEHIND_MAJORS = 2;
/** How a move that waits on the upgrade says so. On the screen, the upgrade's own line already says "then move". */
export const AFTER_UPGRADE = 'After the upgrade if it needs one; ';

export function sdksFor(provider: string, dependencies: readonly DependencyCheck[]): DependencyCheck[] {
  const own = FOR_PROVIDER[provider];
  return dependencies.filter((check) => NEUTRAL.test(check.name) || Boolean(own?.test(check.name)));
}

function installed(check: DependencyCheck): string {
  return check.locked?.version ?? check.spec;
}

export function sdkLabel(check: DependencyCheck): string {
  return `${check.name} ${installed(check)}`;
}

export function joinedAnd(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function notRuledOutLine(identifier: string, sdks: readonly DependencyCheck[]): string {
  return ` keepup found no ${identifier} in this repo's own text, and that doesn't rule it out: this repo calls the model through ${joinedAnd(sdks.map(sdkLabel))}, and an SDK can send ${identifier} without the code saying so. Not verified on those versions.`;
}

function furthestBehind(sdks: readonly DependencyCheck[]): DependencyCheck | undefined {
  return [...sdks].sort((a, b) => b.majors_behind - a.majors_behind || Number(Boolean(b.source)) - Number(Boolean(a.source)))[0];
}

export function sdkEffort(sdks: readonly DependencyCheck[]): 'A project' | 'A day or more' {
  return (furthestBehind(sdks)?.majors_behind ?? 0) >= FAR_BEHIND_MAJORS ? 'A project' : 'A day or more';
}

export function upgradeOption(sdks: readonly DependencyCheck[], successor: string): FindingOption {
  const lead = furthestBehind(sdks) as DependencyCheck;
  const others = sdks.filter((check) => check !== lead);
  const behind = lead.latest && lead.majors_behind > 0 ? `${sdkLabel(lead)} is ${lead.majors_behind} major version${lead.majors_behind === 1 ? '' : 's'} behind ${lead.latest}. ` : '';
  return {
    // A check wants an option's first word in the source it links to, so the library that source is about comes first.
    name: `${joinedAnd([lead, ...others].map((check) => check.name))} upgrade, then move`,
    what: `${behind}keepup can't say the installed versions work with ${successor}, so this upgrade may be what the move needs. Run your tests on it before merging.`,
    needs: lead.majors_behind >= FAR_BEHIND_MAJORS ? `A project: ${lead.majors_behind} major versions of ${lead.name}, and the packages that go with it.` : 'A day or more, with your tests.',
    source: lead.source ?? '',
  };
}

/** A model that's still live and buys time, when the provider's page lists one. It's data on the lever, and it stops being offered once its date passes. */
export function bridgeOption(levers: readonly Lever[], successor: string, asOf: string | undefined): FindingOption | null {
  const lever = levers.find((item) => item.bridge && (!asOf || item.bridge.until > asOf));
  if (!lever?.bridge) return null;
  return {
    name: `${lever.bridge.model} as a bridge`,
    what: `${lever.bridge.what} It buys time, and the move to ${successor} still has to happen. Try it on your installed SDK first.`,
    needs: lever.needs?.replace(/^Nothing new; /, 'Hours; ') ?? 'Hours.',
    source: lever.source,
  };
}
