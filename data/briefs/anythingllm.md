# keepup brief: Mintplex-Labs/anything-llm

Commit 9caf2b4 (30 Oct 2026). Database as of 31 Oct 2026. This is a real run; nothing in it is simulated (see README.md in this folder).

## What we understood

**The product.** An all-in-one AI app: chat with your own documents, agents with tools, a model router. It supports 39 LLM providers, 14 embedding engines and 10 vector databases. It's Node.js (server/, collector/) with a React frontend.

**The AI jobs in the code:**

| Job | How it's done today | Where |
| --- | --- | --- |
| Answer from documents | Native embedder on transformers.js (default Xenova/all-MiniLM-L6-v2), LanceDB, native reranker (Xenova/ms-marco-MiniLM-L-6-v2) | server/utils/EmbeddingEngines/native/index.js:8, server/utils/EmbeddingRerankers/native/index.js:23 |
| Ingest files | pdf-parse, OCR with tesseract.js, audio through Whisper (local Xenova/whisper-small or OpenAI whisper-1) | collector/utils/OCRLoader/index.js:111, collector/utils/WhisperProviders/OpenAiWhisper.js:11 |
| Agents with tools | Its own agent framework (aibitat), an MCP client, imported skills in its own manifest format | server/utils/agents/, server/utils/MCP/, server/utils/agents/imported.js |
| Route each message to a model | A headless agent picks a category from a fixed list | server/utils/agents/aibitat/plugins/router-classifier.js:71 |
| Text to speech | ElevenLabs, Kokoro (through an OpenAI-compatible server), OpenAI | server/utils/TextToSpeech/ |

**Stack lock.** keepup only considers:
- Node packages
- models with ONNX or transformers.js weights, because local embedding, reranking and Whisper models run through transformers.js
- APIs and MCP servers
- skills

## Checked against 41,785 new or updated things from 10 sources (1 Sep – 31 Oct 2026). 6 fit.

### 1. Your Gemini default was shut down on 1 Jun · keeps working

**Where.** server/models/systemSettings.js:919 and server/utils/AiProviders/gemini/index.js:53 fall back to gemini-2.0-flash-lite when no Gemini model is set. The agent provider does the same (server/utils/agents/aibitat/providers/gemini.js:17).

**What happened.** Google shut down gemini-2.0-flash-lite on 1 Jun 2026, so requests that fall back to it fail. The named replacement is gemini-3.1-flash-lite.

**Proof.** Vendor announcement.

**Effort.** Hours.

**Source.** https://ai.google.dev/gemini-api/docs/deprecations

### 2. Your model router can use a decision model instead of a full agent run · cheaper, faster

**Where.** server/utils/agents/aibitat/plugins/router-classifier.js. `classifyWithLLM()` (line 71) starts a headless agent with the router's fallback model. That agent's only job is to call `select_category` (line 24) with one category from a fixed list. It runs before routed messages.

**Why it fits.** This is the job decision models were built for: one answer from a fixed list, with a probability for each option.

**The options:**

| Option | What it is | Needs |
| --- | --- | --- |
| OpenAI Decisions API with gpt-6-luna | Beta 6 Oct, generally available 22 Oct. OpenAI's words: "Turn text and images into typed answers 10x faster than the Responses API". On /v1/decisions, gpt-6-luna costs $0.10 per million input tokens, and output tokens aren't charged. | An OpenAI key |
| TypeSafe Jev | Doesn't need an OpenAI key. A TanStack AI adapter (`@tanstack/ai-typesafe`) had its first real release on 21 Sep and reached 1.0 on 22 Oct, and npm already has MCP servers and libraries built on it. | A TypeSafe key, which is a new vendor |

**Proof.** Vendor claims only.

**Effort.** A day.

**Keep today's call as the fallback** when the decision model's confidence is low, so routing never gets worse.

**Sources:**
- https://developers.openai.com/api/docs/changelog (6 Oct, 22 Oct and 22 Sep entries)
- https://www.npmjs.com/package/@tanstack/ai-typesafe

### 3. OpenAI's whisper-1 shuts down on 26 Feb 2027 · keeps working

**Where.** collector/utils/WhisperProviders/OpenAiWhisper.js:11 sets `this.model = "whisper-1"`. Voice input defaults to it too (server/utils/SpeechToText/openAi/index.js:8, frontend/src/components/SpeechToText/OpenAiOptions/index.jsx:76), and the fallback list at server/utils/helpers/customModels.js:311 names it along with gpt-4o-transcribe and gpt-4o-mini-transcribe, which shut down the same day.

**What happened.** OpenAI announced the shutdown on 26 Aug 2026. The named successors are gpt-transcribe and gpt-live-transcribe. After 26 Feb 2027, audio uploads and voice input that use the OpenAI provider will fail.

**Proof.** Vendor announcement.

**Effort.** Hours.

**Source.** https://developers.openai.com/api/docs/changelog (26 Aug entry)

### 4. OpenAI's tts-1 shuts down on 6 Jan 2027 · keeps working

**Where.** server/utils/TextToSpeech/openAi/index.js:15 always sends `model: "tts-1"`.

**What happened.** OpenAI announced the shutdown on 1 Oct 2026. After 6 Jan 2027, read-aloud through the OpenAI provider will fail. The named replacement is gpt-realtime-2.1-mini, a Realtime API model, so this is a code change and not a new id.

**Proof.** Vendor announcement.

**Effort.** A day or more.

**Source.** https://developers.openai.com/api/docs/deprecations (1 Oct entry)

### 5. A newer on-device embedder for your native engine · better answers

**Where.** server/utils/EmbeddingEngines/native/index.js:8 defaults to Xenova/all-MiniLM-L6-v2. That model was trained on English. Its upstream card says it truncates at 256 word pieces; the Xenova build this code loads caps at 512 tokens, and chunks here stop at 1,000 characters, so the limit rarely bites.

**The new thing.** EmbeddingGemma 2. Google released it on 6 Oct, with an ONNX build and @huggingface/transformers 4.3.1 support the same day. Hugging Face showed about 411,000 downloads of the ONNX build in the month to 31 Oct.
- 8K-token context
- 100+ languages
- 768 dimensions, which can be cut to 128 when storage matters
- the 4-bit text model is a 175 MB download
- Apache 2.0 licence

**Proof.** Vendor model card. It reports MTEB multilingual v2 at 61.36, but compares only with EmbeddingGemma 1. There is no independent comparison with MiniLM yet.

**What it needs:**
- Move from @xenova/transformers 2.x (server/package.json:41, collector/package.json:20) to @huggingface/transformers 4.3.1 or later. The old package hasn't had a release since 29 May 2024; the new one shipped 4.3.0 on 16 Sep, 4.3.1 on 6 Oct and 4.3.2 on 27 Oct. The same move puts your native reranker and local Whisper on a maintained library.
- Re-embed existing workspaces, because vectors grow from 384 to 768 dimensions.

**Effort.** A day.

**Sources:**
- https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2
- https://huggingface.co/google/embeddinggemma-2
- https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
- https://www.npmjs.com/package/@huggingface/transformers

### 6. Load skills in the open Agent Skills format · new capability

**Where.** server/utils/agents/imported.js. Imported agent skills use AnythingLLM's own manifest (imported-manifest.schema.json), so they can't load SKILL.md skills.

**Why it fits.** The open SKILL.md format (agentskills.io) is what the public skill registries publish. ClawHub's most-downloaded skills reach hundreds of thousands of downloads, and other agent runtimes already load the format (AURA's README lists it). Supporting it would give AnythingLLM users those skills without a rewrite.

**Proof.** Adoption only, not measured.

**Effort.** A day or more.

**Sources:**
- https://agentskills.io
- https://clawhub.ai

## Watching

These fit a job you have, but aren't ready to recommend.

- **Indra OCR** (Datalab; released 13 Oct, 1,538 stars by 31 Oct). A 1M-parameter OCR model that runs on CPU, reads 80+ languages and handwriting, and keeps layout. The vendor says it's 15x faster than Tesseract, which your collector uses (collector/utils/OCRLoader/index.js:111). Not yet, for two reasons:
  - It ships as a Python package, and your collector is Node.
  - The weights' modified OpenRAIL-M licence is free for research, personal use and startups under $20M in funding or revenue, and can't be used to compete with Datalab's API.

  Sources: https://www.datalab.to/blog/indra-ocr and https://huggingface.co/datalab-to/indra-ocr

- **OXR** (5 Oct, 2,754 stars). An open document-parsing model. It's Python, has no independent results yet, and your parser works.

## Checked and held back

| Thing | Date | Why it's held back |
| --- | --- | --- |
| Claude Haiku 5.5 can return an error when sent temperature | 7 Oct | Already handled: server/utils/AiProviders/anthropic/index.js:15–26 never sends temperature, for any model. |
| GPT-6 Astra needs the Responses API for tool calls | 3 Sep | Already handled: server/utils/agents/aibitat/providers/openai.js:5–7 uses the Responses API. |
| NVIDIA Nemotron 3.5 Rerank 8B and CLM v0.1 8B (new rerankers) | 15 Oct and 21 Sep | Too large for your CPU reranker, which runs a 6-layer MiniLM. |
| MCP TypeScript SDK 1.32.2 | 23 Oct | This release adds nothing for your client: it changes only types and server registration. But server/yarn.lock:864 installs 1.24.3, which is behind the client security fix in 1.32.0. keepup doesn't read advisories, so that one is a person's call. |
| gpt-4o (shuts down 14 Jan 2027) in server/utils/agents/aibitat/example/ | 14 Jan 2027 | Developer example scripts that nothing in the app loads, and that say they must be run by hand from that folder, so the product never sends it. |
| Prompt caching for Claude | — | Already behind a setting (ANTHROPIC_CACHE_CONTROL). Sonnet 5.5's cheaper cache reads (7 Oct) make turning it on by default worth a look, but that's your call: it's a product choice. |
