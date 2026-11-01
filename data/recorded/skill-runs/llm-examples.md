# keepup on llm-examples

Repo: https://github.com/streamlit/llm-examples
Commit: 7cf260745675e41f92e7436d3777aafdab9dad9f
Date: 2026-11-01
Cost: USD 0.2783

A real Claude Code session, run in a container on a sanitised copy of the tracked files (scripts/skill-session.sh). Nothing in the repo was executed. The commit in the header of a brief is the copy's own first commit; the one above is upstream. Secrets are masked.

## /keepup:keepup, headless

Model claude-sonnet-5-5 · USD 0.1916 · 25 turns · 0 permission denials

The final output, as it reached the screen:

````
This is a Streamlit demo app with five AI jobs. They are an OpenAI chatbot, a LangChain and DuckDuckGo search agent, an Anthropic file Q&A page, a LangChain blog-outline generator, and a chatbot that collects user feedback.

```
keepup: llm-examples · Commit 6d773de (1 Nov 2026)
Compared with a database of 41,785 · 10 searches · 5 read closely. 1 fit.
1. 2 OpenAI models are retired
   keeps working · vendor claim · Hours
   pages/4_Langchain_PromptTemplate.py:12, Chatbot.py:26 and 2 more
   https://developers.openai.com/api/docs/deprecations
   Do: move to gpt-5.6-terra

Checked and held back: 2, in the run file. The first:
  Web search MCP servers for pages/2_Chat_with_search.py: Agent already searches via DuckDuckGoSearchRun; no...
Dropped by the checks: 1.
  it had a link no record gives

want the change?
```
````

## /keepup:apply 1

Model claude-sonnet-5-5 · USD 0.0866 · 17 turns · 0 permission denials

One commit on a local branch, keepup/2026-11-01. Not pushed. Tests not run: the skill asks first, and nobody was there to say yes.

The final output, as it reached the screen:

````
I committed finding 1 on the local branch `keepup/2026-11-01`. I haven't run the tests, and nothing has been pushed.

**What changed** (one commit, `58f8337`):
- `Chatbot.py`, `pages/2_Chat_with_search.py` and `pages/5_Chat_with_user_feedback.py` now use `gpt-5.6-terra` instead of `gpt-3.5-turbo`.
- `pages/4_Langchain_PromptTemplate.py` now uses `ChatOpenAI` with `gpt-5.6-terra` instead of `OpenAI` with `text-davinci-003`. `gpt-5.6-terra` is a chat model, so I switched the class. The call is now `llm.invoke(...).content`.
- `app_test.py` has the same model id in its fixture, so I updated it to match.

**Things to know:**
- **Cost:** `gpt-5.6-terra` costs more than `gpt-3.5-turbo`: $2 / $12 per 1M tokens against $0.50 / $1.50.
- **Lever lookup:** the lever id in the brief wasn't found. I used `PAT-retired-model-id` instead, which has the same `how` and `trade_offs`.
- **Source:** the successor comes from OpenAI's deprecations page, which is a vendor claim. I haven't checked it against the live API.
- **Tests:** I haven't run any, and I haven't checked what the repo's test setup is. The test file is `app_test.py`, which would probably run under `pytest`. Do you want me to run `pytest`? It runs the repo's code here, so I'll wait for your yes.

**To publish** (run these yourself):
```sh
git push -u origin keepup/2026-11-01
gh pr create --draft --title "2 OpenAI models are retired" --body "Moves text-davinci-003 and gpt-3.5-turbo to gpt-5.6-terra (both shut down). PromptTemplate page switched to ChatOpenAI. Proof: vendor claim. Source: https://developers.openai.com/api/docs/deprecations. Tests: not run."
```

The branch is local, and a person reviews and merges. To undo it: `git switch main && git branch -D keepup/2026-11-01`.
````

The diff it committed:

```diff
diff --git a/Chatbot.py b/Chatbot.py
index 0a4f2df..91e6127 100644
--- a/Chatbot.py
+++ b/Chatbot.py
@@ -23,7 +23,7 @@ if prompt := st.chat_input():
     client = OpenAI(api_key=openai_api_key)
     st.session_state.messages.append({"role": "user", "content": prompt})
     st.chat_message("user").write(prompt)
-    response = client.chat.completions.create(model="gpt-3.5-turbo", messages=st.session_state.messages)
+    response = client.chat.completions.create(model="gpt-5.6-terra", messages=st.session_state.messages)
     msg = response.choices[0].message.content
     st.session_state.messages.append({"role": "assistant", "content": msg})
     st.chat_message("assistant").write(msg)
diff --git a/app_test.py b/app_test.py
index 829f048..7af53ef 100644
--- a/app_test.py
+++ b/app_test.py
@@ -9,7 +9,7 @@ from openai.types.chat.chat_completion import ChatCompletion, Choice
 def create_chat_completion(response: str, role: str = "assistant") -> ChatCompletion:
     return ChatCompletion(
         id="foo",
-        model="gpt-3.5-turbo",
+        model="gpt-5.6-terra",
         object="chat.completion",
         choices=[
             Choice(
diff --git a/pages/2_Chat_with_search.py b/pages/2_Chat_with_search.py
index 399c582..0e765a6 100644
--- a/pages/2_Chat_with_search.py
+++ b/pages/2_Chat_with_search.py
@@ -36,7 +36,7 @@ if prompt := st.chat_input(placeholder="Who won the Women's U.S. Open in 2018?")
         st.info("Please add your OpenAI API key to continue.")
         st.stop()
 
-    llm = ChatOpenAI(model_name="gpt-3.5-turbo", openai_api_key=openai_api_key, streaming=True)
+    llm = ChatOpenAI(model_name="gpt-5.6-terra", openai_api_key=openai_api_key, streaming=True)
     search = DuckDuckGoSearchRun(name="Search")
     search_agent = initialize_agent(
         [search], llm, agent=AgentType.ZERO_SHOT_REACT_DESCRIPTION, handle_parsing_errors=True
diff --git a/pages/4_Langchain_PromptTemplate.py b/pages/4_Langchain_PromptTemplate.py
index 3755419..248a293 100644
--- a/pages/4_Langchain_PromptTemplate.py
+++ b/pages/4_Langchain_PromptTemplate.py
@@ -1,5 +1,5 @@
 import streamlit as st
-from langchain.llms import OpenAI
+from langchain.chat_models import ChatOpenAI
 from langchain.prompts import PromptTemplate
 
 st.title("🦜🔗 Langchain - Blog Outline Generator App")
@@ -9,13 +9,13 @@ openai_api_key = st.sidebar.text_input("OpenAI API Key", type="password")
 
 def blog_outline(topic):
     # Instantiate LLM model
-    llm = OpenAI(model_name="text-davinci-003", openai_api_key=openai_api_key)
+    llm = ChatOpenAI(model_name="gpt-5.6-terra", openai_api_key=openai_api_key)
     # Prompt
     template = "As an experienced data scientist and technical writer, generate an outline for a blog about {topic}."
     prompt = PromptTemplate(input_variables=["topic"], template=template)
     prompt_query = prompt.format(topic=topic)
     # Run LLM model
-    response = llm(prompt_query)
+    response = llm.invoke(prompt_query).content
     # Print results
     return st.info(response)
 
diff --git a/pages/5_Chat_with_user_feedback.py b/pages/5_Chat_with_user_feedback.py
index 5f58f13..4fd92eb 100644
--- a/pages/5_Chat_with_user_feedback.py
+++ b/pages/5_Chat_with_user_feedback.py
@@ -35,7 +35,7 @@ if prompt := st.chat_input(placeholder="Tell me a joke about sharks"):
         st.info("Please add your OpenAI API key to continue.")
         st.stop()
     client = OpenAI(api_key=openai_api_key)
-    response = client.chat.completions.create(model="gpt-3.5-turbo", messages=messages)
+    response = client.chat.completions.create(model="gpt-5.6-terra", messages=messages)
     st.session_state["response"] = response.choices[0].message.content
     with st.chat_message("assistant"):
         messages.append({"role": "assistant", "content": st.session_state["response"]})
```
