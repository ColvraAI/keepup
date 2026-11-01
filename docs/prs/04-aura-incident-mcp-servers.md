# PR 04 · AURA: Sentry, then SigNoz and Dynatrace, as incident integrations

| | |
| --- | --- |
| Fork | `<demo-org>/aura` |
| Base | 3a49ac4 (24 Sep 2026, the last upstream commit before Sentry MCP v0.42.0) |
| Branch | `keepup/2026-09-25-incident-mcp-servers` |
| Opened in the replay | 25 Sep 2026, with Sentry |
| Updated in the replay | 30 Oct 2026, adding SigNoz MCP v0.17.0 and Dynatrace Managed MCP v2.0.0, new releases of servers that were already in the registry on 25 Sep |

## What keepup saw

AURA's README lists 25 integrations at this commit, and Sentry, SigNoz and Dynatrace aren't among them. examples/complete/incident-response-{datadog,mezmo}.toml show the pattern to follow.

## The change

- **examples/complete/incident-response-sentry.toml.** Copy the pattern of incident-response-datadog.toml and point the MCP server at Sentry's official server. Use its remote URL, or `npx @sentry/mcp-server`. Check its README for the current way to authenticate and pass the token, and put the token in env, never in the file. On stdio with no LLM key, search_issues and search_events still run, taking Sentry query syntax; a key and EMBEDDED_AGENT_PROVIDER only add natural-language rewriting.
- **A README row:** "Sentry | Search issues and errors, read stack traces and events, and find the release that introduced a problem". Take the tool names from the server's own tool list.
- **The 30 Oct commit:**
  - examples/complete/incident-response-signoz.toml, using the Docker image signoz/signoz-mcp-server:v0.17.0 over stdio
  - examples/complete/incident-response-dynatrace-managed.toml, using npm @dynatrace-oss/dynatrace-managed-mcp-server
  - two more README rows
- **Tests.** Every new example parses with AURA's own config loader. crates/aura-config/src/config_test.rs already loads every .toml in examples/complete, so no test edit is needed as long as the new example's tokens use `| default: ''`.

## The lab: lab/04-mcp

**Accounts.** A free Sentry account with a small demo project that has a few real errors, and SigNoz running locally in Docker with sample telemetry.

**Run.** Start AURA with each new example and record:
- the tools AURA discovers
- one investigation prompt ("why did errors spike in the last hour?")
- the tool calls it made
- the time to an answer

Save the transcripts in lab/04-mcp/out/.

**Output.** lab/04-mcp/result.md.

**Title.** "Add Sentry, SigNoz and Dynatrace as incident integrations · 2 of 3 vendor MCP servers tested, Dynatrace Managed listed but not tested". The 25 Sep version says "Add Sentry as an incident integration". "Official" fits Sentry and SigNoz, not Dynatrace Managed, which is the vendor's own server and community-supported. "Tested" fits only a server a call read a backend on, and the lab has no Dynatrace Managed cluster, so that server only lists its tools.

## The pull request

- **Proof:** Sentry's and SigNoz's official servers and Dynatrace's own server, all in the MCP Registry, plus the lab transcripts.
- **Risks:** none to existing configs. These are new examples.
- **Rollback:** delete the new examples and their README rows.

## Sources

- https://github.com/getsentry/toolkit/releases/tag/0.42.0 (the repo was getsentry/sentry-mcp)
- https://github.com/SigNoz/signoz-mcp-server
- https://github.com/dynatrace-oss/dynatrace-managed-mcp
- https://registry.modelcontextprotocol.io
