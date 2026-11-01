// What this lab runs. Versions and paths come from docs/prs/04, the examples and the
// registries (npm, Docker Hub, GitHub releases), read on 1 Nov 2026.
import { SENTRY_EVENT_MESSAGE, SERVICE, SPIKE_MINUTES } from './testset/send-signoz-telemetry.ts';

export const LAB_NAME = '04-mcp';
export const BASE_COMMIT = '3a49ac4803a1399c69dda6c7a0de1e69f6c085da';
export const BASE_SHORT = '3a49ac4';

/**
 * The tag upstream put on the base commit, so what it holds is the fork's code at that commit: the
 * patches change only the README and the examples. A test holds the tag against the repo's history.
 */
export const AURA_TAG = 'v0.2.18-nightly.9';
/** The image upstream published for that tag, read from Docker Hub on 1 Nov 2026, and pinned by digest so a moved tag can't change what runs. */
export const AURA_IMAGE_NAME = 'mezmo/aura:0.2.18-nightly.9';
export const AURA_IMAGE_DIGEST = 'sha256:640e2f9cc12e3ef324fdf5a4c985dd4b5c61bf18072025a20a32a7c2d395751c';
export const AURA_IMAGE = `${AURA_IMAGE_NAME}@${AURA_IMAGE_DIGEST}`;
/** The lower bound of @dynatrace-oss/dynatrace-managed-mcp-server@2.0.0's engines field, ">=26.12.1 <27". */
export const NODE_VERSION = '26.12.1';
export const SDK_VERSION = '1.32.2';

export const INVESTIGATION_PROMPT = 'why did errors spike in the last hour?';
/** The model the examples name, as their siblings do. */
export const EXAMPLE_MODEL = 'gpt-5.2';
/** Used only when the person has an Anthropic key and no OpenAI key. The successor named in docs/prs/05. */
export const ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export type ServerId = 'sentry' | 'signoz' | 'dynatrace_managed';

export interface LabServer {
  id: ServerId;
  label: string;
  example: string;
  /** Without these the server is not started at all. */
  required: readonly string[];
  /** Values that let the server list its tools with no account and no backend. Nothing here is secret. */
  placeholders: Readonly<Record<string, string>>;
  placeholderNote: string;
  /** With these set the server gets real data, and the investigation can run against it. */
  backend: readonly string[];
  /** The spec has a backend for these, so the title needs an investigation of each. */
  mustInvestigate: boolean;
  /**
   * The tools whose working call shows good credentials and a live backend, by reading what the
   * integration is for. A tool that isn't here never counts toward "tested". It's a list of what
   * counts, so a tool the server adds later counts for nothing until someone checks it.
   * lib/fixtures/no-credentials-calls-*.json holds what each server did with no good credentials.
   */
  readsBackend: readonly string[];
  /** Printed when only the listing and discovery ran. */
  notCalledNote: string;
  /** Printed for a server whose working calls can't show a backend was read. */
  callsProveNothing: string;
  /** What this backend held for the investigation, which the lab planted. See testset/notes.md. */
  testData: string;
}

export const SERVERS: readonly LabServer[] = [
  {
    id: 'sentry',
    label: 'Sentry',
    example: 'examples/complete/incident-response-sentry.toml',
    required: ['SENTRY_ACCESS_TOKEN'],
    placeholders: {},
    placeholderNote: '',
    backend: ['SENTRY_ACCESS_TOKEN'],
    mustInvestigate: true,
    // The hosted server lists search_errors, search_logs and search_traces; the wrapper reaches the rest, each of
    // which needs event:read or project:read in the definitions of Sentry's server at 0.42.0.
    // Left out: search_sentry_tools, search_docs, get_doc, get_sentry_mcp_info and whoami, which read no project.
    readsBackend: ['search_issues', 'search_errors', 'search_logs', 'search_traces', 'search_events', 'search_issue_events', 'get_issue_details', 'get_issue_activity', 'get_issue_breadcrumbs', 'get_issue_tag_values', 'get_event_stacktrace', 'get_trace_details', 'get_span_details', 'find_releases', 'get_release_details'],
    notCalledNote: '',
    callsProveNothing: '',
    testData: `Sentry held error events sent by hand with the message "${SENTRY_EVENT_MESSAGE}".`,
  },
  {
    id: 'signoz',
    label: 'SigNoz',
    example: 'examples/complete/incident-response-signoz.toml',
    required: [],
    placeholders: { SIGNOZ_URL: 'http://signoz.invalid:8080', SIGNOZ_API_KEY: 'placeholder' },
    placeholderNote: 'placeholder URL and key, no backend',
    backend: ['SIGNOZ_URL', 'SIGNOZ_API_KEY'],
    mustInvestigate: true,
    // Left out: the docs tools and the dashboard templates, which answer with no backend; the tools about SigNoz's
    // own settings; and any tool the probe's arguments couldn't get past its checks, so nothing shows it needs a backend.
    readsBackend: ['signoz_search_logs', 'signoz_aggregate_logs', 'signoz_search_traces', 'signoz_aggregate_traces', 'signoz_get_trace_details', 'signoz_query_metrics', 'signoz_list_metrics', 'signoz_list_services', 'signoz_get_service_top_operations', 'signoz_list_alerts', 'signoz_list_alert_rules', 'signoz_get_field_keys', 'signoz_get_field_values'],
    notCalledNote: '',
    callsProveNothing: '',
    testData: `SigNoz held an hour of logs and spans the lab wrote for a made-up ${SERVICE} service, with a payment gateway timing out for the last ${SPIKE_MINUTES} minutes.`,
  },
  {
    id: 'dynatrace_managed',
    label: 'Dynatrace Managed',
    example: 'examples/complete/incident-response-dynatrace-managed.toml',
    required: [],
    placeholders: {
      DT_ENVIRONMENT_CONFIGS: JSON.stringify([{ apiEndpointUrl: 'https://dynatrace.invalid/', environmentId: 'placeholder', alias: 'placeholder', apiToken: 'placeholder' }]),
    },
    placeholderNote: 'placeholder cluster and token, no backend',
    backend: ['DT_ENVIRONMENT_CONFIGS'],
    mustInvestigate: false,
    // Empty on purpose: every tool it lists answered without an error against a cluster that can't be reached.
    readsBackend: [],
    notCalledNote: 'Dynatrace Managed: started, listed and discovered on placeholders; no tool call ran against a cluster.',
    callsProveNothing: "Its tools answer without an error when the cluster can't be reached, so a working call doesn't show one was read.",
    testData: '',
  },
];

const mustInvestigate = SERVERS.filter((s) => s.mustInvestigate);
const neverTested = SERVERS.filter((s) => !s.mustInvestigate).map((s) => s.label).join(' and ');

/**
 * What a measured result can say: "tested" only fits a server a call read a backend on, which the
 * measured gate holds for these and no call can do for the rest (their readsBackend is empty).
 * "Official" fits Sentry and SigNoz, not Dynatrace Managed, which is the vendor's own and community-supported.
 */
export const TITLE_NUMBER = `${mustInvestigate.length} of ${SERVERS.length} vendor MCP servers tested, ${neverTested} listed but not tested`;

/** Only for --dry-run --sandbox --junk-sentry-token: shows what hosted Sentry does with a token that can't be good. */
export const JUNK_SENTRY_TOKEN = 'junk-token-not-a-real-sentry-token';

/** What the stand-in model asks for in a sandbox dry run: tools that need no credentials, then tools that read a backend. */
export const DRY_RUN_CALLS = [
  { name: 'search_sentry_tools', arguments: { query: 'find the release that introduced a problem' } },
  { name: 'execute_sentry_tool', arguments: { name: 'search_docs', arguments: { query: 'releases' } } },
  { name: 'execute_sentry_tool', arguments: { name: 'search_issues', arguments: { organizationSlug: 'demo', query: 'is:unresolved' } } },
  { name: 'search_issues', arguments: { organizationSlug: 'demo', query: 'is:unresolved' } },
  // The SigNoz server answers INDEX_NOT_READY while it builds its docs index, so this waits for it.
  { name: 'signoz_search_docs', arguments: { searchText: 'logs' }, delayMs: 60_000 },
  { name: 'signoz_list_services', arguments: {} },
  { name: 'dynatrace_managed_list_problems', arguments: { environment_alias: 'ALL_ENVIRONMENTS' } },
];

export const CONFIG_NAMES = ['SIGNOZ_URL', 'DT_ENVIRONMENT_CONFIGS'] as const;
export const LLM_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
export const NEEDS_INVESTIGATION = 'ANTHROPIC_API_KEY or OPENAI_API_KEY, with SIGNOZ_URL and SIGNOZ_API_KEY for a running SigNoz and SENTRY_ACCESS_TOKEN for a Sentry demo project';
