# PR 06 · AnythingLLM: add GPT-6 Sol and GPT-6 Luna, then GPT-6.1 Sol

Commit 5edf32b9 (27 Oct) fixed the gpt-4.1-nano shutdown and also changed this fallback list, adding gpt-6-luna and gpt-6.1-sol. The list doesn't have gpt-6-sol at 9caf2b4. keepup's version is dated the day each model shipped.

| | |
| --- | --- |
| Fork | `<demo-org>/anything-llm` |
| Base | f92433b4 (21 Sep 2026, the last upstream commit before GPT-6 Sol and Luna) |
| Branch | `keepup/2026-09-22-gpt-6-models` |
| Opened in the replay | 22 Sep 2026 |
| Updated in the replay | 29 Sep 2026, GPT-6.1 Sol |

## What keepup saw

server/utils/helpers/customModels.js holds the hard-coded OpenAI model list that's shown when the call to OpenAI's live model list fails. GPT-6 Sol and GPT-6 Luna (22 Sep) and GPT-6.1 Sol (29 Sep) weren't in it. With a working key the live list passes a generic filter, so new models appear with no code change: only people whose list call fails couldn't pick them.

## The change

1. **22 Sep:** add gpt-6-sol and gpt-6-luna to the fallback list, in the shape the file already uses (name, id and any other fields), and leave temperature out of gpt-6 requests in server/utils/AiProviders/openAi/index.js.
2. **29 Sep:** add gpt-6.1-sol.

Don't copy the team's later commit. Write the change from the release notes and the file as it was at the base commit.

**Tests.** If the repo has tests for the model list, run them. Otherwise add one: the list contains the new ids and no duplicates.

## The lab: lab/06-models

With our OpenAI key, send one real request to each new model through AnythingLLM's OpenAI provider on the fork, and record that it answers.

Upstream's commit 5edf32b9 (27 Oct) changes the same file, and only gpt-6-luna and gpt-6.1-sol match. That commit's purpose was the gpt-4.1-nano shutdown, and its new default is gpt-5.6-luna. Record this in result.md's team line, not in `whyItFits`, which describes the repo as it was at the base commit.

**Output.** lab/06-models/result.md.

**Title.** "Add GPT-6 Sol and GPT-6 Luna to the OpenAI fallback model list · released today". On 29 Sep the title becomes "Add GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol to the OpenAI fallback model list", with no "released today", because GPT-6 Sol and Luna shipped on 22 Sep.

## Sources

- https://developers.openai.com/api/docs/changelog (22 Sep and 29 Sep entries)
- https://github.com/Mintplex-Labs/anything-llm/commit/5edf32b9
