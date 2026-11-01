# PR 01 · AnythingLLM: route messages with a decision model

| | |
| --- | --- |
| Fork | `<demo-org>/anything-llm` |
| Base | ead123f0 (5 Oct 2026, the last upstream commit before the Decisions API beta) |
| Branch | `keepup/2026-10-06-router-decision-model` |
| Opened in the replay | 6 Oct 2026, Decisions API beta |
| Updated in the replay | 22 Oct 2026, Decisions API GA and @tanstack/ai-typesafe 1.0 |

## What keepup saw

server/utils/agents/aibitat/plugins/router-classifier.js:71: `classifyWithLLM()` starts a headless agent with the router's fallback model. Its only job is to call `select_category` (line 24) with one category from a fixed list. That's a label-picking call, which is exactly the job decision models were built for.

## The change

- **Add `classifyWithDecisions()`.** It sends the user's message and the category list (titles plus descriptions, in priority order, plus "none") to the OpenAI Decisions API with gpt-6-luna, and gets back one category and its probability. Before writing it, check the current request shape at https://developers.openai.com/api/docs/guides/decisions (use Context7 or the page itself). Don't write it from memory.
- **Use it first when the router has an OpenAI key and the setting is on.** When the probability is under 0.70, or the call fails, fall back to `classifyWithLLM()` unchanged. Log which path answered.
- **Setting:** `ROUTER_CLASSIFIER=decisions|agent`. The default stays `agent`, so nothing changes until a person switches it on.
- **Tests.** Unit tests with a fake Decisions client: the right category, low confidence falling back to the agent, an API error falling back to the agent, and "none".

## The 22 Oct update (a second commit on the same branch)

Use what GA added, after checking the docs: shared-input caching for the category list, and `input_json` if it fits. Add a line to the pull request body: "Updated 22 Oct: Decisions API is generally available."

## The Claude-only variant (a second branch and pull request)

**Branch:** `keepup/2026-10-22-router-jev`, built on ead123f0, the same base as PR 01. (D3 would make it afd2da90, the last upstream commit before 22 Oct in UTC. It stays on ead123f0 as a recorded exception, because it's the same change re-planned for a Claude-only product, on PR 01's base, and lab/01-router/pr-jev.json says so in its own text.) When the founder's setting says "Claude-only" (no OpenAI), the same change uses TypeSafe Jev instead, through its API or `@tanstack/ai-typesafe` (check its docs). The fallback and the tests are the same.

## The lab: lab/01-router

**Test set.** Write 3 to 5 router rules in the style AnythingLLM's model router uses (title plus description), for example "coding", "billing", "summarise a document", "chit-chat". Then write 60 messages with their correct rule; 10 should be "none". Save them as lab/01-router/testset.jsonl.

**Run.** Run both classifiers on the 60 messages:
- the current agent path, with the fallback model set to what AnythingLLM's onboarding suggests for OpenAI at the base. That's gpt-4.1-nano, which shut down on 23 Oct, so the lab uses OpenAI's named substitute, gpt-5.6-luna, and says so
- the Decisions API path

Use real API calls with our keys.

**Measure.** Accuracy against the labels, p50 and p95 latency, and cost. Cost is tokens times the prices in data/db (OpenRouter plus the OpenAI changelog), with the date of the price. The Decisions path is priced on input only, because output tokens aren't charged on /v1/decisions (OpenAI's Decisions guide).

**Output.** lab/01-router/result.md, a table with n, accuracy, p50, p95, cost per 1,000 messages and the date. The pull request title uses the measured speed-up or cost cut, whichever is larger, e.g. "Route messages with a decision model · 6.2x faster on 60 test messages". If accuracy drops more than 2 points, the title says so and the default stays off.

## The pull request

Use the template in app/src/template.ts:
- **Proof:** measured on this fork (the lab table), plus the vendor's own claim ("typed answers 10x faster than the Responses API", OpenAI changelog, 6 Oct).
- **Risks:** a different provider for routing, and a probabilistic answer. The fallback keeps today's behaviour.
- **Rollback:** set `ROUTER_CLASSIFIER=agent`.

## Sources

- https://developers.openai.com/api/docs/changelog (6 Oct, 22 Oct and 22 Sep entries)
- https://www.npmjs.com/package/@tanstack/ai-typesafe
