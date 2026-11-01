---
lab: 03-embeddings
status: measured
measured_at: 2026-11-01
title_number: recall@5 0.848 → 0.950 on a 1,000-passage SciFact subset
---
| | before: all-MiniLM-L6-v2 | after: EmbeddingGemma 2 (q4) |
| --- | --- | --- |
| test set | 200 queries against every passage relevant to them (198), plus the lowest-id other passages up to 1,000 | same |
| recall@5 | 0.848 | 0.950 |
| MRR@10 | 0.752 | 0.911 |
| time to embed 1,000 passages | 85.8 s | 2375.7 s |
| peak memory (RSS) | 1909 MB | 2146 MB |
| vector dimensions | 384 | 768 |

Test set: the first 200 BEIR SciFact test queries by id, against a 1,000-passage SciFact subset: every passage relevant to those queries (198), plus the 802 lowest-id other passages, out of 5,183 in the corpus, with brute-force cosine search through the pull request's NativeEmbedder.

Recall on a subset isn't comparable to published SciFact scores, which search the whole corpus.

Each passage was embedded whole, with no text splitter, for both models, so these scores compare the models on whole passages and are not the chunked path the product uses. 847 of 1,000 passages are longer than the 1,000 characters the product cuts all-MiniLM-L6-v2 at, and 157 of 1,000 are longer than the 2,000 it cuts EmbeddingGemma 2 (q4) at.

Machine: one Docker container on Node v18.20.8, arm64, 8 CPUs, @huggingface/transformers 4.3.2. Each model ran in its own process.

Same default: all-MiniLM-L6-v2 scores recall@5 0.848 on the old package and 0.848 on the new one, and 0.848 when documents embedded on the old package meet queries embedded on the new one. Both give 384 dimensions. On 200 passages cut to the 1000 characters the product sends, the lowest cosine between packages is 0.994420; on whole passages it is 0.996092.

Batching: on the same 200 chunks of all-MiniLM-L6-v2, the lowest cosine between packages is, one at a time 0.995903, in batches of 25 0.994420. Within one package, alone against batched: old 0.989910, new 0.992124. The same batches twice on the new package: 1.000000. 200 queries one at a time, between packages: 0.992230. Token ids differ between packages on 0 of 400 of these texts.

The other existing models also move to the new package, and were loaded for real on both. Xenova/nomic-embed-text-v1: lowest cosine between packages 0.985660 on 50 chunks, 0.976709 on 25 queries, 768 dimensions on both, token ids differ on 0 of 75 texts. MintplexLabs/multilingual-e5-small: lowest cosine between packages 1.000000 on 50 chunks, 1.000000 on 25 queries, 384 dimensions on both, token ids differ on 0 of 75 texts.
