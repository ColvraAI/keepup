// The shapes the pull request code shares, so its files don't import each other for types.
import type { Env } from './config.ts';
import type { GitContext } from './git.ts';
import type { BotIdentity, Client } from './github.ts';
import type { CiRecord } from './objects.ts';
import type { PrSpec } from './specs.ts';
import type { LabView } from './template.ts';

export class PrStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrStateError';
  }
}

export interface PrOptions {
  update?: string;
  all?: boolean;
  allowUnmeasured?: boolean;
  waitCi?: boolean;
}

export interface PrDeps {
  root: string;
  env: Env;
  org: string;
  slug: string;
  octokit: Client;
  gitBaseUrl: string;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  nowMs: () => number;
  ciTimeoutMs: number;
  /** How long --wait-ci waits while GitHub reports no checks at all. */
  ciNoneTimeoutMs: number;
  ciPollMs: number;
  /** How long --check-actions waits for a first run, and how often it looks. */
  gateWindowMs: number;
  gatePollMs: number;
  log: (line: string) => void;
}

export interface PrOutcome {
  id: string;
  number: number;
  url: string;
  opened: boolean;
  pushedStages: string[];
  edited: boolean;
  commented: number;
  ci: CiRecord;
  ciTimedOut: boolean;
  state: string;
}

/** The fields the code reads. Both the list and the single-pull responses have them. */
export interface Pull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  updated_at?: string;
}

export interface RepoRun {
  spec: PrSpec;
  deps: PrDeps;
  owner: string;
  repo: string;
  identity: BotIdentity;
  git: GitContext;
}

export interface Run extends RepoRun {
  opts: PrOptions;
  lab: LabView;
  subjects: Map<string, string[]>;
  baseExtraCommits: number;
}
