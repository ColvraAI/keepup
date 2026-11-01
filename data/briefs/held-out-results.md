# Held-out results

Passing the answer keys in anythingllm.md and aura.md is weak evidence on its own, because the judge's rules were written while reading those two repos. So this is a second test, on two repos the prompts were never tuned against: stackblitz/bolt.new at eda10b1 and rashadphz/farfalle at a9dd493.

The answer key is test/heldout.test.ts. It was written from reading each repo's code at its commit, after the prompts were frozen and before either judged run existed. Earlier runs had already shown the exact checks on these repos, so the retirement rows aren't blind; the "must not" rows are the real test of the judge.

## What it asked, and what happened

| Repo | Key says | Result |
| --- | --- | --- |
| bolt.new | Must find: the one model it sends, claude-3-5-sonnet-20240620 at app/lib/.server/llm/model.ts:8, is retired | Found. One line under the levers, with the retirement date read from Anthropic's changelog |
| bolt.new | Must not: anything for a job it doesn't have (reranking, vector databases, speech) | None shown |
| bolt.new | Must not: a library behind on versions with nothing named but its age | The judge held back @ai-sdk/anthropic: the release notes name nothing this code uses |
| bolt.new | Must not: a library in a language it doesn't use | None shown |
| farfalle | Must find: gpt-4o and gpt-4o-mini at src/backend/constants.py, shutting down on 14 Jan 2027, with gpt-6-luna named | Found |
| farfalle | Must not: a retirement claim on a model only a gateway serves | None shown |
| farfalle | Must not: anything for a job it doesn't have (embeddings, speech, MCP) | None shown |
| farfalle | Must not: prompt caching with no caching setting in the code | None shown; the judge held it back itself |

On bolt.new, too, prompt caching was never proposed as a finding: the judge held it back itself, because the code has no caching setting to switch on. So no caching finding reached step 5 on either repo.

## The counts, read from data/runs

test/heldout.test.ts checks every number here against the run files.

| Repo | Findings | Held back | Watching | Dropped by step 5 |
| --- | --- | --- | --- | --- |
| bolt.new | 3 | 11 | 0 | 3 |
| farfalle | 2 | 19 | 0 | 0 |

The key was first written when patterns under the 85% bar never reached the judge, and each run had one finding. They reach it now, so the judge read those hits too, and the key grew by reading the code at these commits again: bolt.new has no tracing and no test set for its prompt (its only spec is its message parser), and farfalle has no test set. farfalle's Logfire set-up at src/backend/main.py:7 counts as tracing, so it gets no tracing finding. None of the held-back rows was recommended.

### What step 5 dropped on bolt.new

- E2B (e2b and @e2b/code-interpreter)
- Mistral: Mistral Large 4
- langchain (with @langchain/core and @langchain/anthropic)

### What step 5 dropped on farfalle

Nothing.

## What this doesn't show

Two repos is a small sample, and both are small. Neither run tests whether the judge finds a big new thing that fits: the two levers it did find are the absences a third of small products have. On the question "would it recommend something it shouldn't", they pass; on "would it recommend something good on a repo it has never seen", they say nothing. That needs a key with a known good candidate, on a third repo.
