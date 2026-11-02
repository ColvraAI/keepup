// Wires Claude into the pipeline's seams: profile, candidates, judge. A cap or a refusal never loses a run:
// it writes what it has and says so.
import { buildCandidates, type Candidate, type CandidateLog } from './candidates.ts';
import { withCards } from './cards.ts';
import { allSources, loadRecords, retirements } from './db.ts';
import { judgeAll } from './judge.ts';
import { loadLevers } from './levers.ts';
import { libraryFacts } from './library-moves.ts';
import { BudgetExceededError, type Llm } from './llm.ts';
import type { JudgeInput, JudgeResult, PipelineContext, Seams } from './pipeline.ts';
import { understandProduct } from './profile.ts';
import type { Dropped, Profile, Usage } from './run-shape.ts';
import type { SearchMatch, SearchQuery } from './search.ts';
import { stackLock } from './stack-lock.ts';

export interface ClaudeOptions {
  readonly llm: Llm;
  readonly providerOnly?: string;
  /** Whether this run may fetch model cards. */
  readonly online?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly cardCacheDir?: string;
  readonly registryCacheDir?: string;
}

function usageOf(llm: Llm): Usage {
  const seen = llm.usage();
  return { ...seen, max_usd: llm.maxUsd };
}

export function declaredPackages(context: Pick<PipelineContext, 'facts'>): Set<string> {
  return new Set(context.facts.manifests.flatMap((manifest) => manifest.dependencies.map((dep) => dep.name)));
}

export function claudeSeams(options: ClaudeOptions): Seams {
  const { llm, providerOnly } = options;
  const state: { dropped: Dropped[]; log: CandidateLog | null; profileError: string | null } = { dropped: [], log: null, profileError: null };

  const profile = async (context: PipelineContext): Promise<Profile | null> => {
    try {
      const understood = await understandProduct(llm, context);
      state.dropped = understood.dropped;
      return { ...understood.profile, stack_lock: [...understood.profile.stack_lock, ...stackLock(context.facts).rules] };
    } catch (error) {
      state.profileError = (error as Error).message;
      if (!(error instanceof BudgetExceededError)) process.stderr.write(`keepup: profile failed: ${state.profileError}\n`);
      return null;
    }
  };

  const candidates = async (context: PipelineContext, understood: Profile | null, search: (query: SearchQuery) => readonly SearchMatch[]): Promise<readonly Candidate[]> => {
    if (!understood) return [];
    const built = buildCandidates(understood, search, { lock: stackLock(context.facts), declaredPackages: declaredPackages(context) });
    state.log = { ...built.log, provider_only: providerOnly ?? null };
    return options.online ? withCards(built.candidates, { fetchImpl: options.fetchImpl, cacheDir: options.cardCacheDir }) : built.candidates;
  };

  const judge = async (input: JudgeInput): Promise<JudgeResult> => {
    const changelog = loadRecords(allSources().filter((source) => source === 'changelog'));
    const facts = await libraryFacts(input.context, { online: options.online, cacheDir: options.registryCacheDir, fetchImpl: options.fetchImpl, today: input.context.asOf });
    const retiredIds = new Set([...retirements().flatMap((row) => (row.id ? [row.id] : [])), ...loadLevers().flatMap((lever) => lever.models ?? [])]);
    const judged = await judgeAll(input, { llm, providerOnly, changelog, libraryFacts: facts, retiredIds });
    const profileSkip = state.profileError ? [`Profile: ${state.profileError}`] : [];
    const skipped = [...profileSkip, ...(judged.incomplete?.skipped ?? [])];
    return {
      ...judged,
      dropped: [...state.dropped, ...(judged.dropped ?? [])],
      usage: usageOf(llm),
      candidate_log: state.log ?? undefined,
      incomplete: skipped.length ? { reason: judged.incomplete?.reason ?? 'Stopped early. This is what was checked.', skipped } : undefined,
    };
  };

  return { profile, candidates, judge };
}
