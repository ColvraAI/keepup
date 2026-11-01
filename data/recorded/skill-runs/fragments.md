# keepup on fragments

Repo: https://github.com/e2b-dev/fragments
Commit: 3b11c7fcd4dcc37b2f1effde35960cf6ec4bd3c7
Date: 2026-11-01
Cost: USD 0.2619

A real Claude Code session, run in a container on a sanitised copy of the tracked files (scripts/skill-session.sh). Nothing in the repo was executed. The commit in the header of a brief is the copy's own first commit; the one above is upstream. Secrets are masked.

## /keepup:keepup, headless

Model claude-sonnet-5-5 · USD 0.1682 · 19 turns · 0 permission denials

Run after the fixes in test/brief-honesty.test.ts. Top finding labelled A project, with the SDK named as not verified. Tried once against the real API in the container on ai 3.4.33 and @ai-sdk/anthropic 1.2.12: claude-sonnet-5-5 returned HTTP 400, and claude-sonnet-4-6 returned an object.

The final output, as it reached the screen:

````
Fragments is a Next.js app. It streams a structured code fragment from a user-picked model, produces structured code edits, and merges those edits through the Morph apply model.

```
keepup: fragments · Commit 54cfb95 (1 Nov 2026)
Compared with a database of 41,785 · 6 searches · 5 read closely · 54 of 57 dependencies not checked (offline) · 21
       model ids on lib/models.json not recognised. 5 fit.
1. Anthropic's claude-sonnet-4-5-20250929 shuts down on 30 Nov 2026
   keeps working · vendor claim · A project
   app/page.tsx:35, lib/models.json:116
   https://platform.claude.com/docs/en/release-notes/overview
   Do: claude-sonnet-4-6 as a bridge: Anthropic lists claude-sonnet-4-6 as active, and retires it no sooner than 17
       Feb 2027. It buys time, and the move to Claude Sonnet 5.5 still has to happen.
       https://platform.claude.com/docs/en/about-claude/model-deprecations
   Do: ai and @ai-sdk/anthropic upgrade, then move: ai 3.4.33 is 4 major versions behind 7.0.159. keepup can't say the
       installed versions work with Claude Sonnet 5.5, so this upgrade may be what the move needs.
       https://www.npmjs.com/package/ai
   Check first: Forced tool use ( tool_choice types any and tool ) returns a 400 error.
   Not ruled out: this repo's text has no tool_choice, but @ai-sdk/anthropic 1.2.12 and ai 3.4.33 can send it
       themselves. Not verified on those versions.
2. 6 OpenAI models in your picker are retired
   keeps working · vendor claim · Hours
   lib/models.json:67, lib/models.json:88 and 7 more
   https://developers.openai.com/api/docs/deprecations
   Do: gpt-4-turbo, o3-mini to gpt-5.6-sol; gpt-4.1-nano to gpt-5.6-luna; gpt-4.5-preview to gpt-6-luna; o1-mini,
       o4-mini to gpt-5.6-terra
3. 8 Google models in your picker are retired or deprecated · keeps working · vendor claim · Hours
   lib/models.json:186 and 9 more
   Do: gemini-2.0-flash, gemini-2.0-flash-001, gemini-2.5-flash-preview-05-20 to gemini-3.6-flash;
       gemini-2.0-flash-lite, gemini-2.0-flash-lite-001 to gemini-3.5-flash-lite; gemini-2.5-pro-preview-05-06 to
       gemini-3.1-pro-preview; gemini-1.5-flash, gemini-1.5-flash-002 have no successor named ·
       https://ai.google.dev/gemini-api/docs/deprecations
4. 4 OpenAI models in your picker shut down on 11 Dec 2026 · keeps working · vendor claim · Hours
   lib/models.json:4 and 4 more
   Do: gpt-5, o3 to gpt-5.6-sol; gpt-5-mini to gpt-5.6-terra; gpt-5-nano to gpt-5.6-luna ·
       https://developers.openai.com/api/docs/deprecations
5. 4 OpenAI models in your picker shut down on 14 Jan 2027 · keeps working · vendor claim · Hours
   lib/models.json:46 and 3 more
   Do: gpt-4.1, gpt-4.1-mini, gpt-4o, gpt-4o-mini to gpt-6-luna · https://developers.openai.com/api/docs/deprecations

Checked and held back: 1, in the run file.

want the change?
```
````

## /keepup:apply 1, on the brief before it

Model claude-sonnet-5-5 · USD 0.0937 · 10 turns · 0 permission denials

One commit on local branch keepup/2026-11-01, from a /keepup session on the same copy just before the one above, with a cheaper model. It made the bridge change only. Not pushed. Tests not run: it asked first, and there was no one to answer. Separately, claude --permission-mode default in a real terminal stopped at the first command of /keepup:apply 1 and asked; the branch had not changed.

The final output, as it reached the screen:

````
I committed finding 1 on the local branch `keepup/2026-11-01`. I haven't run the tests and haven't pushed anything.

The finding has `sdk_unverified`, and it offers a bridge, so I made only the bridge change.
- **`app/page.tsx:35`:** the default model is now `claude-sonnet-4-6`.
- **`lib/models.json`:** I added a Claude Sonnet 4.6 entry to the picker. I left the 4.5 entry in place so saved selections keep working until it shuts down on 30 Nov 2026.
- **Bridge date:** Anthropic lists `claude-sonnet-4-6` as active, and retires it no sooner than 17 Feb 2027.

**The move to `claude-sonnet-5-5` is not done or verified.** Sonnet 5.5 returns a 400 for forced tool use (`tool_choice` any or tool). keepup found no `tool_choice` in this repo's own text, which doesn't rule it out. The repo calls the model through `@ai-sdk/anthropic` 1.2.12 and `ai` 3.4.33, and either could send it without the code saying so. The move to 5.5 is not verified on those versions, and the SDK upgrade is still to do. The bridge is also untried on them.

I didn't touch findings 2–5. They're OpenAI and Google picker entries, and you only asked for 1.

**Tests:** `package.json` has `npm test`, which runs `tsx --test lib/*.test.ts app/api/*.test.ts`. That runs the repo's code on this machine, so I haven't run it. Say yes and I will.

Nothing has been pushed. To push and open a draft PR, run:

```sh
git push -u origin keepup/2026-11-01
gh pr create --draft --title "Anthropic's claude-sonnet-4-5-20250929 shuts down on 30 Nov 2026" --body "Moves the default to claude-sonnet-4-6 as a bridge and adds it to the picker (lib/models.json). The move to claude-sonnet-5-5 is NOT verified on @ai-sdk/anthropic 1.2.12 / ai 3.4.33 (tool_choice may be sent by the SDK; not verified), and the SDK upgrade is still to do. The bridge date is no sooner than 17 Feb 2027. Proof: vendor claim. Source: https://platform.claude.com/docs/en/about-claude/model-deprecations. Tests: not run."
```

To undo it: `git switch main && git branch -D keepup/2026-11-01`
````

The diff it committed:

```diff
diff --git a/app/page.tsx b/app/page.tsx
index 7988456..d4bd901 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -32,7 +32,7 @@ export default function Home() {
   const [languageModel, setLanguageModel] = useLocalStorage<LLMModelConfig>(
     'languageModel',
     {
-      model: 'claude-sonnet-4-5-20250929',
+      model: 'claude-sonnet-4-6',
     },
   )
 
diff --git a/lib/models.json b/lib/models.json
index fbbdd28..0a53f17 100644
--- a/lib/models.json
+++ b/lib/models.json
@@ -112,6 +112,13 @@
       "name": "Claude Haiku 4.5",
       "multiModal": true
     },
+    {
+      "id": "claude-sonnet-4-6",
+      "provider": "Anthropic",
+      "providerId": "anthropic",
+      "name": "Claude Sonnet 4.6",
+      "multiModal": true
+    },
     {
       "id": "claude-sonnet-4-5-20250929",
       "provider": "Anthropic",
```
