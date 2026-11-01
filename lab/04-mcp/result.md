---
lab: 04-mcp
status: partial
measured_at: 2026-11-01
needs: SENTRY_ACCESS_TOKEN; ANTHROPIC_API_KEY or OPENAI_API_KEY, with SIGNOZ_URL and SIGNOZ_API_KEY for a running SigNoz and SENTRY_ACCESS_TOKEN for a Sentry demo project
---
| Server | before | after: tools it lists | AURA v0.2.18-nightly.9 discovers | offered to the agent | started as the example does | credentials |
| --- | --- | --- | --- | --- | --- | --- |
| SigNoz | no example at 3a49ac4 | 46, from SigNozMCP v0.17.0 | 46 | 30 | `docker run -i --rm -e SIGNOZ_URL -e SIGNOZ_API_KEY signoz/signoz-mcp-server:v0.17.0` | placeholder URL and key, no backend |
| Dynatrace Managed | no example at 3a49ac4 | 18, from Dynatrace Managed MCP Server 2.0.0 | 18 | 18 | `npx -y @dynatrace-oss/dynatrace-managed-mcp-server@2.0.0` | placeholder cluster and token, no backend |

Offered to the agent: the server's tools in the first request AURA sent, with the example's own settings, to a stand-in model provider. It costs nothing and calls no tool.

SigNoz: the example's filter offers the agent 30 of the 46 tools the server lists. The 14 write tools it holds back are 211447 of the 311095 bytes of tool definitions; the 30 it offers are 95878. Write tools offered: 0.

Dynatrace Managed: started, listed and discovered on placeholders; no tool call ran against a cluster. Its tools answer without an error when the cluster can't be reached, so a working call doesn't show one was read.

AURA v0.2.18-nightly.9 is upstream's tag on 3a49ac4, this pull request's base. The lab runs the binary from the image upstream published for that tag (`mezmo/aura:0.2.18-nightly.9`, digest `sha256:640e2f9cc12e3ef324fdf5a4c985dd4b5c61bf18072025a20a32a7c2d395751c`), not a build made here. The patches change only the README and the examples, so no code differs from the base.

Absent until it runs: Sentry (needs SENTRY_ACCESS_TOKEN); a tested investigation of Sentry and SigNoz (needs ANTHROPIC_API_KEY or OPENAI_API_KEY, with SIGNOZ_URL and SIGNOZ_API_KEY for a running SigNoz and SENTRY_ACCESS_TOKEN for a Sentry demo project).

Raw outputs are in the keepup repo, under lab/04-mcp/out/, not on this fork.
