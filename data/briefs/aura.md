# keepup brief: mezmo/aura

Commit 5efb4e8 (release 0.2.20, 30 Oct 2026). Database as of 31 Oct 2026. This is a real run; nothing in it is simulated (see README.md in this folder).

## What we understood

**The product.** An SRE agent platform written in Rust. Teams of agents investigate production incidents through MCP tools, with human approval before sensitive actions and OpenTelemetry traces of every step. It also supports Agent Skills, A2A and an OpenAI-compatible API. Everything is configured in TOML, and it can run air-gapped.

**The AI jobs in the code:**

| Job | How it's done today | Where |
| --- | --- | --- |
| Investigate incidents with specialist agents | A fork of rig-core; the MCP client is rmcp 0.12.0 | Cargo.toml:40, Cargo.toml:49 |
| Reach production tools | MCP servers over Streamable HTTP, SSE or STDIO; 26 integrations listed | README.md:78 |
| Ground answers in runbooks | Qdrant and Bedrock Knowledge Bases | crates/aura/src/vector_store.rs:16, crates/aura/src/builder.rs:2315 |
| Call models | OpenAI, Anthropic, Bedrock, Gemini, Ollama and OpenRouter; Anthropic prompt caching is opt-in | crates/aura-config/src/config.rs:102 |
| Trace everything | OpenTelemetry 0.27 | Cargo.toml:68, crates/aura/Cargo.toml:54, crates/aura/src/logging.rs:414 |

**Stack lock.** AURA is Rust, so keepup only considers MCP servers, HTTP APIs, Rust crates, models and skills. Python and TypeScript libraries are skipped unless they ship an MCP server or an API.

## Checked against 41,785 new or updated things from 10 sources (1 Sep – 31 Oct 2026). 4 fit.

### 1. Three vendors' MCP servers for incident tools AURA can't reach yet · new capability

**Where.** The README's integrations table lists 26 tools, and none of these three. examples/complete/incident-response-{checkly,datadog,mezmo}.toml already show the pattern to copy.

| Server | Version and date | What it gives your agents | How it runs |
| --- | --- | --- | --- |
| Sentry MCP (getsentry/toolkit, formerly getsentry/sentry-mcp) | v0.42.0, 25 Sep | Errors, issues and debugging context | Remote server, or npm @sentry/mcp-server |
| SigNoz MCP | v0.17.0, 30 Oct | Metrics, traces, logs, alerts and dashboards from the open-source OpenTelemetry backend. It fits your self-hosted users. | Docker image signoz/signoz-mcp-server:v0.17.0 |
| Dynatrace Managed MCP | v2.0.0, 30 Oct | Logs, events and metrics from self-hosted Dynatrace | npm @dynatrace-oss/dynatrace-managed-mcp-server |

**Proof.** All three are listed in the MCP Registry. Sentry's and SigNoz's are official. Dynatrace Managed is the vendor's own server, and it's community-supported. None has been measured on your agents yet.

**Effort.** Hours each: a TOML example and a README row, no Rust.

**Source.** https://registry.modelcontextprotocol.io (entries io.github.getsentry/sentry-mcp, io.github.SigNoz/signoz-mcp-server, io.github.dynatrace-oss/dynatrace-managed-mcp)

### 2. Example configs use Claude models that are retired or retiring · keeps working

**Where:**
- examples/minimal/anthropic.toml:14 uses claude-sonnet-4-20250514. Anthropic has retired it, so requests return an error. This is the minimal Anthropic example.
- examples/complete/reasoning-models.toml:61 uses claude-sonnet-4-5-20250929. Anthropic announced on 30 Sep that it retires on 30 Nov 2026.
- examples/minimal/openrouter.toml:22 uses anthropic/claude-sonnet-4, which OpenRouter no longer lists. The same retired id is commented out at examples/reference.toml:228, examples/quickstart-orchestration-math/config.toml:46 and .env.example:21, and Sonnet 4.5 at deployment/helm/aura/values.yaml:119.

**The successor** is claude-sonnet-5-5, released 28 Sep.

**Check before switching.** A model id swap alone breaks examples/complete/reasoning-models.toml: lines 69-71 send a thinking budget, which returns a 400 error on Sonnet 5.5, so they move to adaptive thinking with effort, and the migration guide says to remove the temperature on line 63. Sonnet 5.5 also returns a 400 error for forced tool use, which AURA doesn't use: its crates never set tool_choice, and in the rig fork only Extractor does, which AURA never builds.

**Effort.** Hours.

**Source.** https://platform.claude.com/docs/en/release-notes/overview (28 Sep and 30 Sep entries, and the Claude Sonnet 4 retirement)

### 3. Your MCP client library is three major versions behind · keeps working

**Where.** Cargo.toml:49 pins rmcp 0.12.0, released 18 Dec 2025. The latest is 3.8.0 (26 Oct 2026), which implements the 2026-07-28 MCP spec.

**What the last 60 days added** that an SRE agent with approvals would use:
- no more endless SSE reconnects on permanent errors (3.8.0)
- the current MCP spec: AURA's client speaks 2025-03-26, three spec revisions behind

Not a gain as written: cancelling a tools/call whose caller dropped it (3.6.0, 20 Oct). Approvals gate before the call, AURA sends tools/call through send_cancellable_request, which that guard doesn't cover, and its streaming path already cancels in-flight calls on disconnect, timeout and shutdown.

**Proof.** The library's own changelog.

**Effort.** A project. It's three majors, and the rig fork (Cargo.toml:40) carries its own rmcp feature.

**Sources:**
- https://crates.io/crates/rmcp
- https://github.com/modelcontextprotocol/rust-sdk/blob/main/crates/rmcp/CHANGELOG.md

### 4. Claude prompt caching is opt-in, and it just got cheaper · cheaper

**Where.** examples/reference.toml:234 has `# prompt_caching = true` commented out. The setting is declared at crates/aura-config/src/config.rs:102 and defaults to off; a test asserts that default at crates/aura-config/src/config_test.rs:355.

**What changed.** Since 7 Oct, Claude Sonnet 5.5 cache reads cost 0.05x the input price. Multi-agent sessions re-send the same system prompts and tool lists every turn.

**Proof.** Vendor pricing. The saving depends on how long your sessions run, and keepup can't see that from code.

**Effort.** Hours.

**Source.** https://platform.claude.com/docs/en/release-notes/overview (7 Oct entry)

## Checked and held back

| Thing | Why it's held back |
| --- | --- |
| claude-3-sonnet-20240229, a retired model, in crates/aura-config/src/writer.rs:225 | It's a test fixture inside `#[cfg(test)]` (line 210), so nothing ever sends it to the API. |
| Grafana MCP v2.1.1 (20 Oct) | Grafana is already in your integrations, and nothing in your examples pins an old version. |
| A community "observability gateway" MCP server on npm (Prometheus and Loki in one server) | A small third-party server; the official Grafana server already covers Loki. |
| Rust AI gateways new this autumn | AURA calls providers directly and routes per agent in TOML. A gateway adds a hop you don't need. |
| New SRE agent platforms on GitHub (for example AegisOps, 10 Sep) | They compete with AURA rather than plug into it. A competitor is never a lever. |
