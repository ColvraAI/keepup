---
lab: 05-models
status: partial
measured_at: 2026-11-01
needs: OPENAI_API_KEY
---
| | before | after |
| --- | --- | --- |
| `examples/minimal/anthropic.toml` | claude-sonnet-4-20250514: error. The upstream model provider (anthropic/claude-sonnet-4-20250514) returned an error: CompletionError: ProviderError: SSE Error: Invalid status code 404 Not Found with message: {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-20250514"},"request_id":"req_011Cgbe8krxPEjZaw2hz9XrH"} | claude-sonnet-5-5: answered "Paris" |

n = 1 chat request per cell, sent to AURA's OpenAI-compatible endpoint. Test set: "Name the capital of France in one word." for the minimal example, written for this lab.

Not run: `examples/complete/reasoning-models.toml`, as shipped: OpenAI coordinator, Claude worker. It also needs OPENAI_API_KEY, so it has no row here.

AURA v0.2.12 release binary aura-linux-arm64, sha256 4116e3d7cf6ff71909b7f019cd6b0b98166f6b21d18c6fffcbcd876bb6ca83b9 checked against the release's checksums.txt, run in Docker. The base commit adds only CI, docs and tests to this release, so this binary is the base commit's own code. "before" is the file at the base commit; "after" is the base commit plus this pull request's patches. Raw outputs: lab/05-models/out/.

Cost of the minimal example's runs: $0.000110, from 30 input and 5 output tokens at $2/$10 per MTok (OpenRouter (https://openrouter.ai/anthropic/claude-sonnet-5.5), fetched 2026-10-31).
