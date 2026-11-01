# PR 07 · AnythingLLM: move the default OpenAI model off gpt-4.1-nano before it shuts down

AnythingLLM's OpenAI default, gpt-4.1-nano, was announced for shutdown on 22 Apr 2026 and shut down on 23 Oct 2026. The team's own commit 5edf32b9 moved the default on 27 Oct, 4 days after the model stopped working. keepup would have opened this on install day. This says what the dates and the code show, and nothing about what the team knew.

| | |
| --- | --- |
| Fork | `<demo-org>/anything-llm` |
| Base | bbefbc7f (31 Aug 2026, the last upstream commit before install day) |
| Branch | `keepup/2026-09-01-default-model-shutdown` |
| Base branch | `replay/bbefbc7f-default-model`, at the same commit as PR 02's `replay/bbefbc7f`: D44 gives every pull request its own base |
| Opened in the replay | 1 Sep 2026 |

## What keepup saw

OpenAI announced on 22 Apr 2026 that gpt-4.1-nano shuts down on 23 Oct 2026. That notice couldn't name gpt-5.6-luna, which OpenAI's changelog shows released on 9 Jul 2026. Wayback captures of the deprecations page show gpt-5-nano as the substitute on 26 Apr, gpt-5.4-nano on 29 May and 3 Jul, and gpt-5.6-luna on 10 Aug and 2 Sep, the capture nearest install day. So on 1 Sep the model existed and the page named it, and no other substitute is needed.

`git grep gpt-4.1-nano bbefbc7f` finds these defaults in code that runs when nothing is set:

- server/models/systemSettings.js:878, what the settings screen reads
- server/utils/AiProviders/openAi/index.js:24, what chats use
- server/utils/agents/index.js:318 and :857, and server/utils/agents/ephemeral.js:516, the agent paths
- server/utils/agents/aibitat/providers/openai.js:9 (a comment) and :18
- server/utils/agents/aibitat/providers/genericOpenAi.js:24

It also finds these, which set nothing, so they stay:

- the commented sample lines in server/.env.example and docker/.env.example, none of which calls the model a default
- the "e.g." placeholder at frontend/src/pages/WorkspaceSettings/ChatSettings/WorkspaceLLMSelection/index.jsx:226
- the context-window table at server/utils/AiProviders/modelMap/legacy.js:100-101

Outside that grep, server/utils/agents/aibitat/index.js:751 names `gpt-4`, which the same notice also shuts down. It stays: the model from the agent handlers replaces it, so it isn't this default.

## The change

One commit, dated 1 Sep: move each of those defaults to gpt-5.6-luna. OPEN_MODEL_PREF and a workspace's model still win, so nothing a person chose changes. That cuts both ways: the settings screen stores whichever model is selected when it's saved, so anyone who saved gpt-4.1-nano keeps it and still stops working on 23 Oct. The pull request says so in its risks.

Don't copy the team's later commit. Write the change from the notice and the files as they were at the base commit.

**Tests.** server/__tests__/utils/AiProviders/openAi/defaultModel.test.js: each place uses the new model when nothing is set, and an explicit setting still wins. They must fail at the base.

## The lab: lab/07-default-model

With our OpenAI key, through AnythingLLM's OpenAI provider on the fork: one real request naming gpt-4.1-nano, which records the real error, because the model shut down on 23 Oct and the lab runs after that; and one with no model set, which records the real answer from the new default. It counts as measured only when the old model is refused for a reason about the model, and the new default answers.

Nothing yet shows that gpt-5.6-luna accepts what this base sends. The provider's `#temperature` sends gpt-5 models a temperature of 1, and OpenAI's gpt-5.6-luna page says nothing about temperature, only that its default reasoning effort is medium. The first real run settles it: if the new default is refused over temperature, the patch has to leave temperature out for this model, and the risks line changes.

The team's commit goes in result.md's team line, not in `whyItFits`, which describes the repo as it was at the base commit.

**Output.** lab/07-default-model/result.md.

**Title.** "Your default OpenAI model shuts down on 23 Oct · move to gpt-5.6-luna"

## Sources

- https://developers.openai.com/api/docs/deprecations (22 Apr 2026 notice)
- https://web.archive.org/web/20260902020743/https://developers.openai.com/api/docs/deprecations (the page on 2 Sep 2026, naming gpt-5.6-luna)
- https://web.archive.org/web/20260810021133/https://developers.openai.com/api/docs/deprecations (10 Aug 2026, naming gpt-5.6-luna)
- https://web.archive.org/web/20260703035231/https://developers.openai.com/api/docs/deprecations (3 Jul 2026, naming gpt-5.4-nano)
- https://web.archive.org/web/20260529195735/https://developers.openai.com/api/docs/deprecations (29 May 2026, naming gpt-5.4-nano)
- https://web.archive.org/web/20260426114525/https://developers.openai.com/api/docs/deprecations (26 Apr 2026, naming gpt-5-nano)
- https://developers.openai.com/api/docs/changelog (9 Jul 2026 entry)
- https://developers.openai.com/api/docs/pricing
- https://github.com/Mintplex-Labs/anything-llm/commit/5edf32b9
