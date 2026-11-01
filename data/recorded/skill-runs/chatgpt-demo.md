# keepup on chatgpt-demo

Repo: https://github.com/anse-app/chatgpt-demo
Commit: 03b47a79d901325a812a03a5d6b12049a6005a6c
Date: 2026-11-01
Cost: USD 0.1917

A real Claude Code session, run in a container on a sanitised copy of the tracked files (scripts/skill-session.sh). Nothing in the repo was executed. The commit in the header of a brief is the copy's own first commit; the one above is upstream. Secrets are masked.

## /keepup:keepup, headless

Model claude-sonnet-5-5 · USD 0.0896 · 12 turns · 0 permission denials

The final output, as it reached the screen:

````
This is a streaming ChatGPT-style chat UI. It sends chat completions to OpenAI from `src/utils/openAI.ts`. `keepup verify` has run, and this is its brief:

```
keepup: chatgpt-demo · Commit 762d946 (1 Nov 2026)
Compared with a database of 41,785 · 2 searches · 2 read closely. 1 fit.
1. Your default gpt-3.5-turbo was shut down on 23 Oct 2026
   keeps working · vendor claim · Hours
   src/utils/openAI.ts:5
   https://developers.openai.com/api/docs/deprecations
   Do: move to gpt-5.6-terra

Checked and held back: 1, in the run file. The first:
  gpt-3.5-turbo-0301, a retired model, in src/utils/openAI.ts:49: It is only in a comment, so nothing sends it.

want the change?
```
````

## /keepup:apply on a dirty tree: it refused

Model claude-haiku-5-5 · USD 0.0016 · 3 turns · 0 permission denials

README.md had a change on purpose. It also says there is no finding, because at that point the skill read the brief without --dir. That is fixed, and the apply below read it.

The final output, as it reached the screen:

````
I stopped before making any change, for two reasons.

1. **The working tree is dirty.** `git status --porcelain` shows `M README.md`. Keepup won't mix its change with yours, so I haven't created a branch or touched any file. I haven't stashed or committed `README.md` either. Commit or stash it yourself, then run `/keepup:apply 1` again.

2. **There's no finding to apply.** This session didn't print a brief, so I read the last one with `keepup get verified.findings`. It failed: `verified.json isn't there yet. Run keepup prepare first.` Run `/keepup` first to produce a brief, then say yes to finding 1.

Nothing has been pushed, and no branch was created.
````

## /keepup:apply 1

Model claude-sonnet-5-5 · USD 0.0656 · 13 turns · 1 permission denials

One commit on a local branch, keepup/2026-11-01. Not pushed. No remote exists in the copy. Tests not run: this repo has no test script.

The final output, as it reached the screen:

````
I committed the model swap on a new local branch, `keepup/2026-11-01`. Nothing has been pushed, and I didn't run any tests.

**What changed:** the default model moves from `gpt-3.5-turbo`, which OpenAI shut down on 23 Oct 2026, to its named successor `gpt-5.6-terra`. The edits are:
- `src/utils/openAI.ts:5`: the default value.
- `README.md` and `README.zh-CN.md`: the documented default for `OPENAI_API_MODEL`.

Setting `OPENAI_API_MODEL` still overrides the default. I left the commented-out `gpt-3.5-turbo-0301` line at `src/utils/openAI.ts:49` alone.

**Cost:** `gpt-5.6-terra` is more expensive. It costs $2 in and $12 out per 1M tokens, against $0.50 and $1.50 for `gpt-3.5-turbo`. The deprecations page covers OpenAI's own API, so if this app calls a gateway or compatible server, check that server's model list first.

**Tests:** I added no test, because the repo has no test setup (no test script in `package.json` and no test files).

**To publish it, run this yourself:**
```sh
git push -u origin keepup/2026-11-01
gh pr create --draft --title "Your default gpt-3.5-turbo was shut down on 23 Oct 2026" --body "Moves the default model from the retired gpt-3.5-turbo to its named successor gpt-5.6-terra (src/utils/openAI.ts, both READMEs). OPENAI_API_MODEL still overrides it. Cost is higher: 2 USD in / 12 USD out vs 0.50 / 1.50 per 1M tokens. Proof: vendor claim. Source: https://developers.openai.com/api/docs/deprecations. Tests: none exist in the repo, none run."
```

To undo it: `git switch main && git branch -D keepup/2026-11-01`
````

The diff it committed:

```diff
diff --git a/README.md b/README.md
index 0d03597..a90aacb 100644
--- a/README.md
+++ b/README.md
@@ -174,7 +174,7 @@ You can control the website through environment variables.
 | `HEAD_SCRIPTS` | Inject analytics or other scripts before `</head>` of the page | `null` |
 | `PUBLIC_SECRET_KEY` | Secret string for the project. Use for generating signatures for API calls | `null` |
 | `SITE_PASSWORD` | Set password for site, support multiple password separated by comma. If not set, site will be public | `null` |
-| `OPENAI_API_MODEL` | ID of the model to use. [List models](https://platform.openai.com/docs/api-reference/models/list) | `gpt-3.5-turbo` |
+| `OPENAI_API_MODEL` | ID of the model to use. [List models](https://platform.openai.com/docs/api-reference/models/list) | `gpt-5.6-terra` |
 
 ## Enable Automatic Updates
 
diff --git a/README.zh-CN.md b/README.zh-CN.md
index 8cd8c3c..f86161d 100644
--- a/README.zh-CN.md
+++ b/README.zh-CN.md
@@ -165,7 +165,7 @@ Environment: OPENAI_API_KEY=YOUR_OPEN_API_KEY
 | `HEAD_SCRIPTS` | 在页面的 `</head>` 之前注入分析或其他脚本 | `null` |
 | `PUBLIC_SECRET_KEY` | 项目的秘密字符串。用于生成 API 调用的签名 | `null` |
 | `SITE_PASSWORD` | 为网站设置密码，支持使用英文逗号创建多个密码。如果未设置，则该网站将是公开的 | `null` |
-| `OPENAI_API_MODEL` | 使用的 OpenAI 模型。[模型列表](https://platform.openai.com/docs/api-reference/models/list) | `gpt-3.5-turbo` |
+| `OPENAI_API_MODEL` | 使用的 OpenAI 模型。[模型列表](https://platform.openai.com/docs/api-reference/models/list) | `gpt-5.6-terra` |
 
 ## 开启同步更新
 
diff --git a/src/utils/openAI.ts b/src/utils/openAI.ts
index a51ae95..ddaf134 100644
--- a/src/utils/openAI.ts
+++ b/src/utils/openAI.ts
@@ -2,7 +2,7 @@ import { createParser } from 'eventsource-parser'
 import type { ParsedEvent, ReconnectInterval } from 'eventsource-parser'
 import type { ChatMessage } from '@/types'
 
-export const model = import.meta.env.OPENAI_API_MODEL || 'gpt-3.5-turbo'
+export const model = import.meta.env.OPENAI_API_MODEL || 'gpt-5.6-terra'
 
 export const generatePayload = (
   apiKey: string,
```

## /keepup:apply on a finding that needs an account

Model claude-sonnet-5-5 · USD 0.0349 · 4 turns · 0 permission denials

The finding was put in place by hand from a real lever in db/levers, because none of these repos produced one. No branch, no commit: written steps.

The final output, as it reached the screen:

````
I made no code changes for finding 1 and created no branch, because it needs an install and an account. The skill says to write the steps out and stop in that case. The finding's own option says the same: written steps in a tracked issue, not a pull request.

**Finding 1: Memory across chats (ADV-2026-1101-mem0)**
- Where: `src/utils/openAI.ts:5`
- Source: https://github.com/mem0ai/mem0
- Proof: vendor claim only. Nothing has been measured on this product.

**Steps**
1. Create a mem0 account and API key. Alternatively, choose a self-hosted store, which the mem0 table says performs differently from the managed platform.
2. Add the mem0 package to the project. Keep the key in an environment variable and out of the repo.
3. Add a setting, for example `MEMORY_ENABLED`, that is off by default. With it off, `src/utils/openAI.ts` behaves exactly as it does today.
4. With the setting on, do two things around the model call:
   - Before the call, retrieve the stored memories for the user and add them to the prompt.
   - After the call, store the new conversation turn.
5. Start with one memory type only.
6. Replay real conversations with the setting on and off. Compare token use and latency, and check whether the answers get better. mem0 quotes about 7K retrieval tokens at about 1s p50 on its managed platform. Don't rely on that until you have measured it here.
7. Keep the setting off until those numbers justify turning it on.

The pattern lookup (`keepup levers`) has no entry for this finding's id, so these steps come from the finding itself.

I ran no tests and nothing has been pushed. The working tree is still clean and you're still on `main`, so there is nothing to undo.
````
