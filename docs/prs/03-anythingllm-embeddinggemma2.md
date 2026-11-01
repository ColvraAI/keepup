# PR 03 · AnythingLLM: EmbeddingGemma 2 for the native embedder

| | |
| --- | --- |
| Fork | `<demo-org>/anything-llm` |
| Base | a72104c5 (3 Oct 2026, the last upstream commit before 4 Oct in UTC; D23) |
| Branch | `keepup/2026-10-04-embeddinggemma-2` |
| Opened in the replay | 4 Oct 2026, as the library move only. That's what lab/03-embeddings/pr.json builds: 4 Oct is the ONNX repo's creation date on Hugging Face, and 4.3.0 can't run the model. |
| Updated in the replay | 6 Oct 2026, 4.3.1 and the model (Google's launch day); 27 Oct 2026, @huggingface/transformers 4.3.2 |

## What keepup saw

- server/utils/EmbeddingEngines/native/index.js:8 defaults to Xenova/all-MiniLM-L6-v2. That model was trained on English. Its upstream card says it truncates at 256 word pieces; the Xenova build this code loads caps at 512 tokens.
- The native embedder, the native reranker and local Whisper all load through @xenova/transformers 2.x (server/package.json:41, collector/package.json:20). That package hasn't had a release since 29 May 2024.

## The change

- **4 Oct: add `@huggingface/transformers`** at exactly 4.3.0, and load the native embedder through it. Pin sharp to 0.34.5 under that package, because sharp 0.35 needs Node 20.9 and CI and Docker run Node 18. No Node bump. Check the migration notes from @xenova/transformers in its docs.
- **6 Oct: bump to exactly 4.3.1, the first release that can run the model, and add `onnx-community/embeddinggemma-2-ONNX`** to the native embedder's supported models (constants.js), at dtype q4 (175 MB text model, about 207 MB with the tokenizer). The feature-extraction pipeline loads every encoder in the config, so pass a config with vision_config and audio_config set to null through the existing pipeline call. Use the query and document prefixes its model card asks for.
- **Cap this model's queries.** Its tokenizer config sets model_max_length to 1e+30, so nothing cuts a long text before the model, and the 2,000-character chunk limit only reaches document chunks. A chat message goes straight to embedTextInput, so embedTextInput cuts this model's queries to that same limit.
- **Keep MiniLM as the default.** EmbeddingGemma 2 is an option in the embedder picker, with a warning that switching re-embeds the workspace (384 to 768 dimensions).
- **Leave the reranker and local Whisper on the old package** in this pull request, and say so in the body. That's a follow-up pull request.
- **Tests.** The supported model loads in a test with a tiny fixture, and the dimension is reported correctly.

## The 27 Oct update

Bump to @huggingface/transformers 4.3.2 as the third commit. It's pinned exactly, so a range couldn't have brought it in.

## The lab: lab/03-embeddings

**Test set.** A public retrieval set small enough to run on a laptop: 200 queries with their known relevant passages from a BEIR dataset (pick one with a clear licence, such as SciFact). Add 30 non-English queries if the set has them. As built: the first 200 SciFact test queries by id, against a 1,000-passage subset, which is every passage relevant to those queries plus the lowest-id other passages up to 1,000. A subset's recall isn't comparable to published SciFact scores.

**Measure.** Recall@5 and MRR@10 for MiniLM and EmbeddingGemma 2, both run locally through the code in this pull request. Also time to embed 1,000 passages on the same machine, and memory used.

**Output.** lab/03-embeddings/result.md.

**Title.** "EmbeddingGemma 2 for the native embedder · recall@5 <before> → <after> on a 1,000-passage SciFact subset".

## The pull request

- **Proof:** measured on this fork, plus the vendor's model card (MTEB multilingual v2: 61.36).
- **Risks:** a bigger download, slower embedding on small machines, a re-embed when switching, and only the first 2,000 characters of a long chat message being searched. The model is opt-in, but the library move isn't: every existing embedder model moves to the new library on 4 Oct.
- **Rollback:** pick MiniLM again in settings.

## Sources

- https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2
- https://huggingface.co/google/embeddinggemma-2
- https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
- https://www.npmjs.com/package/@huggingface/transformers
