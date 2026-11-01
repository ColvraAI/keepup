# Test set: a 1,000-passage SciFact subset, from BEIR

**Source.** https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip. `run.ts` downloads it to `lab/.work/03-embeddings/dataset/` and saves its sha256 in `out/dataset.json`. Nothing from the dataset is committed.

**Licence.** The source repo's LICENSE.md (https://github.com/allenai/scifact/blob/master/LICENSE.md) says claims are CC BY 4.0 and the abstracts are ODC-By 1.0. `run.ts` fetches and prints that file on every run and saves it in `out/dataset.json`. Two mirrors tag it differently: the Hugging Face card for `allenai/scifact` says cc-by-nc-2.0, and the one for `BeIR/scifact` says cc-by-sa-4.0. We follow the source repo.

**Queries.** The first 200 queries of the `test` split, sorted by numeric id, that have at least one relevant document in the corpus. SciFact queries are scientific claims.

**Corpus.** A 1,000-passage SciFact subset: every passage relevant to those 200 queries (198 of them), plus the 802 lowest-id other passages, out of the 5,183 in `corpus.jsonl`, with no chunking. `corpusSubset` in `dataset.ts` is the rule, and `out/dataset.json` lists the ids. This is the spec's "small enough to run on a laptop", and it also gives the time to embed 1,000 passages directly. The whole corpus was planned at about 625 minutes for EmbeddingGemma 2 alone, at the 7,171 ms a passage the dry run saw under load (7,171 ms × 5,183 + 1,591 ms × 200).

**A subset's recall isn't comparable to published SciFact scores,** which search the whole corpus. Removing passages can only raise a relevant passage's rank, so these scores are no lower than the same model would get on all 5,183. The comparison between the two models here is still fair: both search the same 1,000 passages.

The subset's first 836 passages in id order are the corpus's first 836, so the "first 200" and "first 50" passages in `evidence/` are the same ones `compat.cjs` reads from this subset.

**Chunking is still the biggest gap between the lab and the product.** The product's splitter cuts chunks at 1,000 characters for MiniLM and 2,000 for EmbeddingGemma 2, and here 847 of the 1,000 passages are over 1,000 characters, 157 are over 2,000 and 4 are over 4,000. (In the whole corpus, that's 4,383, 743 and 20 of 5,183.) So the scores compare the models on whole passages, not what users get from chunked documents. `report.ts` prints this, with counts from the subset, in the notes under the result table, which is what the pull request body shows. Scoring the chunked path too would take far longer on the same machine, so it isn't done here.

**What the spec asked for and this set doesn't have.** The spec says to add 30 non-English queries if the set has them. SciFact is English only, so this lab says nothing about EmbeddingGemma 2's other languages.

## How the models are run

- Both models run through the pull request's `NativeEmbedder`, in the sandbox, in separate processes, MiniLM first.
- A passage is `title + " " + text`, the BEIR convention, for both models. The model's `embeddingPrefix` goes in front of it, as `TextSplitter` does in the product. For EmbeddingGemma 2 that's `title: none | text: `, so the title is inside the text and not in the card's `title:` slot, because that's what the product sends.
- A query goes through `embedTextInput`, so it gets the model's `queryPrefix`. For EmbeddingGemma 2 that's the card's `task: search result | query: `. The card also has a `task: fact checking` prefix that may suit SciFact's claims better. We don't use it, because the product searches documents and we're measuring the product.
- Batches are each model's own `maxConcurrentChunks`: 25 for MiniLM, 5 for EmbeddingGemma 2.
- A passage over 4,000 characters is embedded on its own, for both models. A batch is padded to its longest text, and in our probe a batch of 5 at 16,000 characters ran the sandbox out of memory; the subset's longest passage is 6,882 characters, and the whole corpus's is over 10,000. The product never sends a chunk that long, because its splitter cuts chunks to each model's limit.
- Whole passages go through `embedChunks`, which the query cap doesn't touch. The 200 queries are claims of at most 204 characters, so the cap doesn't touch them either.

## What the numbers mean

- **recall@5:** for each query, the share of its relevant passages in the top 5; then the mean over queries.
- **MRR@10:** for each query, 1 / the rank of the first relevant passage in the top 10, or 0; then the mean over queries.
- **Search:** brute-force cosine over the subset's 1,000 passages, with no vector database. Ties go to the earlier passage. It runs on the host from the saved vectors, because it runs no upstream code; `metrics.ts` is tested in `run.test.ts`.
- **Time to embed 1,000 passages:** wall time inside `embedChunks` for all 1,000 passages of the subset, in segments of 100. It leaves out the model load and writing checkpoints, and includes the product's own temp-file handling.
- **Peak memory:** the highest `VmHWM` of the embedding process across its sessions. It covers loading the model, passages and queries.

## Resuming

Every segment is flushed to `lab/.work/03-embeddings/full/<model>/` before it counts, so a crash loses at most one segment, and running the lab again continues. A sandbox session won't start a segment if the last one's duration says it won't fit in its 30 minutes, and the next session continues, because `scripts/sandbox.sh` lets others take its lock after 40. Times from all sessions add up, and peak memory is the highest of any session. Model load time isn't in the timed figure.

## Same default

Before any scoring, `harness/compat.cjs` checks what "nothing changes by default" needs, and the lab stops if it fails:

- `parity`: the same text through all-MiniLM-L6-v2 on the old package and through `NativeEmbedder` on the new one gives the same dimension and a cosine of at least 0.99 (an acceptance line, not a measurement), on passages cut to the 1,000 characters the product sends. The result prints the lowest cosine there and on whole passages.
- `old-first`, `new-first`: the real reranker on onnxruntime-node 1.14 and the embedder on 1.30 both work in one process, in either load order.
- `reuse`: files the old package downloaded are enough for the new one with `huggingface.co` and `cdn.anythingllm.com` blocked in the container's `/etc/hosts`, in a fresh process, so no open connection hides the block. `offline` in its output comes from a real failed request.
- `batching` (reported, never a gate): see below.
- `nomic`, `e5`: the other two models the library move takes with it, loaded for real on both packages with their own prefixes, chunk limit and batch size, on the first 50 passages and 25 claims. A failed load or a changed dimension stops the lab. How far the vectors move is reported in the result, and isn't a gate: see "The other existing models".

**MiniLM's vectors do move a little.** The line started at 0.999, set before anything was measured, and the first dry runs failed it. It was then moved to 0.99, which is the kind of change the kit's rules are wary of, so **that value is waiting on a decision**. The evidence is in `evidence/batching-200-chunks.json`, from `harness/compat.cjs --check batching`, on the first 200 SciFact passages cut to 1,000 characters and the first 50 usable claims, linux/arm64, Node 18, @huggingface/transformers 4.3.2:

| lowest cosine (mean) | |
| --- | --- |
| old against new package, one at a time | 0.995903 (0.997962) |
| old against new package, in batches of 25 | 0.994420 (0.997580) |
| old package, alone against batched | 0.989910 (0.995565) |
| new package, alone against batched | 0.992124 (0.995560) |
| new package, the same batches twice | 1.000000 (1.000000) |
| 50 claims, old against new, one at a time | 0.994998 (0.998999) |

Token ids are the same through both packages on all 250 of those texts, and it's the same model file.

What that shows:

- Batching alone is not the cause: the packages differ one at a time too. With the same tokens and weights, the difference is in what runs them (onnxruntime-node 1.14 against 1.30, and each package's pooling code). We didn't separate those two.
- Queries move too. An earlier note here said they don't, from 5 claims that all came out at 0.999999. On 50 claims that isn't true.
- Batching moves a chunk further than the package change does, within either package, and the old package's own lowest (0.989910) is under the 0.99 line. A run is repeatable, so this isn't noise.

So "the same vectors" isn't true, and "nothing changes by default" has to be judged on search. The full run measures that in `same-default.json`: MiniLM's recall@5 on the old package and on the new one, and documents embedded on the old package with queries embedded on the new one, which is what an upgrade without a re-embed gets. x64 wasn't measured.

## The other existing models

Measured at 4.3.2 on linux/arm64, on the first 50 SciFact passages and the first 25 usable claims, in `evidence/existing-model-*.json`:

| lowest cosine between packages (mean) | chunks | queries | token ids that differ |
| --- | --- | --- | --- |
| nomic-embed-text-v1 | 0.985660 (0.989744) | 0.976709 (0.986531) | 0 of 75 |
| multilingual-e5-small | 1.000000 (1.000000) | 1.000000 (1.000000) | 0 of 75 |

Both load and keep their dimensions (768 and 384). nomic-embed-text-v1 moves more than MiniLM does, with the same file and the same token ids, while multilingual-e5-small doesn't move at all. We didn't find out why.

**This needs a decision.** The gate on these models was first written at MiniLM's 0.99 line, before anything was measured, and nomic-embed-text-v1 fails it. The number wasn't moved. These two checks only report the cosine, because neither model is in this lab's table, and because a line picked after seeing 0.977 wouldn't mean anything. What the move does to nomic-embed-text-v1's search has not been measured: that's a run like `same-default.json` on that model, which this lab doesn't do. Whether that's acceptable before a founder clicks Merge is a person's call.

## What happens when Hugging Face can't be reached

`harness/hf-unreachable.cjs`, through the pull request's real code, with `huggingface.co` blocked in the container and the product's mirror up. `evidence/hf-unreachable-before-fix/` was run at commit 7ecc8634, and `evidence/hf-unreachable-after-fix/` on the final branch. Both are @huggingface/transformers 4.3.2 on Node 18.

| scenario | before | after |
| --- | --- | --- |
| `crash`: pick EmbeddingGemma 2 through the real `updateENV`, with a document in the real database | exit code 1 on an unhandled rejection, documents 1 to 0 | server stays up and logs `fetch failed`, documents 1 to 0 |
| `transient`: fails with Hugging Face down, then Hugging Face comes back | still fails: every request goes to the mirror, 404 | loads from Hugging Face, no restart |
| `after-minilm`: MiniLM falls back to the mirror, then EmbeddingGemma 2 with Hugging Face back | fails: the mirror, 404 | loads from Hugging Face |
| `external-data`: only the `.onnx_data` download fails | rejects | rejects |
| `external-data-server`: the same failure through the real `updateENV`, with a document in the real database | not run | server stays up and logs the download's error, documents 1 to 0 |

So the documents are still gone when the download fails: the reset runs first, and changing that order is outside this pull request.

**On 4.3.1, a failed weights download ends the process.** `evidence/hf-unreachable-4.3.1/` is the same `.onnx_data` failure on the version the 6 Oct stage ships, on Node 18: the final branch's code, since the 27 Oct commit changes none, with @huggingface/transformers 4.3.1 unpacked in the container and loaded through `TRANSFORMERS_DIR`. `external-data.log` is the load alone: exit code 1, with no result written. `external-data-server.json` is the real `updateENV`: exit code 1, documents 1 to 0, after `updateENV` had already returned. The library's rejection goes unhandled, so the `.catch` in `updateENV` never sees it, and the server has no `unhandledRejection` handler (a `git grep` finds one only in a test). The release calls this `from_pretrained` never settling, and its pull request's text says that in Node it can end the process. That's what happened here on every run: we never saw it hang. On 4.3.2 the same failure reaches the `.catch`, as the `after-fix` row shows.

The requests in the `after-fix` scenarios also show what "text only" means. The audio and vision files get a one-byte range request, which the package uses to read their sizes, and none of them is downloaded: the cache holds `model_q4.onnx`, `model_q4.onnx_data`, the tokenizer and the config.

## Memory at the cap

`evidence/memory-probe.log` is `harness/memory-probe.cjs` on the branch before the query cap, which doesn't touch this path because the probe calls the pipeline directly, one fresh process per line, in a 3.5 GB container. Each `[batch chars language]` line closes the run printed above it, and an exit code of 137 means it ran out of memory. At the 2,000-character cap, a batch of 5 peaks at 2,202 MB on Chinese text (1,336 tokens) and 773 MB on English (345 tokens). `evidence/memory-probe-first-run.log` is the first run, on the same inputs: 2,213 MB and 745 MB.

## Long queries

`evidence/query-cap-before.log` is `harness/query-cap.cjs` through the real `embedTextInput` on the commit before the cap, and `evidence/query-cap-after.log` is the final branch, one fresh process per line, in a 3.5 GB container. Each `[chars language]` line closes the run printed above it, and an exit code of 137 means it ran out of memory. The tokenizer as loaded reports `tokenizerLimit` 1e+30, so before the cap the whole text reached the model.

| text | before: tokens, time, peak | after: tokens, time, peak |
| --- | --- | --- |
| 8,000 characters, English | 1,379, 7.1 s, 772 MB | 352, 5.2 s, 463 MB |
| 60,000 characters, English | 10,273, exit 137 | 352, 5.8 s, 470 MB |
| 16,000 characters, Chinese | 10,676, exit 137 | 1,343, 10.4 s, 807 MB |

The "before" log also has 8,000 characters of Chinese: 5,343 tokens, 71.8 s and 3,480 MB, just under the container's limit. This is a direct call to `embedTextInput`, not a full HTTP chat. The chat routes reach it through `performSimilaritySearch` (`server/utils/chats/stream.js`, `embed.js`), and `lance/index.js` calls `embedTextInput` there. The other models' tokenizers already cut long text, so they don't change.

**Still open.** The developer API's embeddings route (`server/endpoints/api/openai/index.js:335`) passes its input straight to `embedChunks`, behind an API key. It isn't capped, because a cap in `embedChunks` would also cut chunks the splitter has already sized, once a header is added, and whole passages in this lab. The risks say so.

## Planning the full run

The dry run's per-passage times are in its `summary.md`, printed with their formula. Its 20 passages run longer than the subset's on average (1,664 characters against 1,494), and the full run's batches differ, so this is a projection.

| | per passage | per query | for 1,000 passages and 200 queries |
| --- | --- | --- | --- |
| EmbeddingGemma 2, last dry run | 2,475 ms | 482 ms | about 43 min = (2,475 ms × 1,000 + 482 ms × 200) |
| EmbeddingGemma 2, an earlier dry run with other work sharing the machine | 7,171 ms | 1,591 ms | about 125 min = (7,171 ms × 1,000 + 1,591 ms × 200) |
| all-MiniLM-L6-v2, last dry run | 301 ms | 74 ms | about 5 min = (301 ms × 1,000 + 74 ms × 200) |
| all-MiniLM-L6-v2 on the old package, last dry run | 328 ms | 16 ms | about 6 min = (328 ms × 1,000 + 16 ms × 200) |

So EmbeddingGemma 2 takes 2 to 5 of the harness's 30-minute sessions, well under its cap of 60. The compatibility checks come first. Parity and batching embed 200 passages nine times and 200 queries twice, which is about 10 min = (1,800 × 301 ms + 400 × 74 ms), and the two other models' checks add a few minutes that no run has timed. In all, that's about 70 minutes on a quiet machine and about 2 hours 40 minutes at the slower dry run's speeds, not counting time waiting for the sandbox lock. The timed row in the table is only fair on an idle machine.

`evidence/worst-batch.json` is the harness on EmbeddingGemma 2 with SciFact's five longest passages under 4,000 characters as one batch, then its longest passage (10,127 characters) alone: it finished in 78 s with a peak of 1,734 MB, so the corpus shouldn't run the 3.5 GB container out of memory.

## What the verifier's questions turned up

- **linux/x64 install** (`evidence/amd64-install.log`, under emulation, with only @huggingface/transformers and the sharp pin in a scratch folder, not the whole server). By default onnxruntime-node 1.30 downloads CUDA files from NuGet: 548 MB on disk against 288 MB. With NuGet blocked, `yarn install` fails with exit code 1. `server/.yarnrc` skips the step (`evidence/amd64-yarnrc.log`): it installs with NuGet blocked, and MiniLM still embeds on the CPU.
- **Offline load.** `pipeline()` in the new package doesn't pass `cache_dir` to its own file checks, so with `huggingface.co` unreachable a fully downloaded model failed to load with `fetch failed`, where the old package made no request at all. The earlier `reuse` check missed this: it set `allowRemoteModels` on the CommonJS copy of the package, and the embedder imports the ES module copy. The pull request now sets `env.cacheDir`, and with both model hosts blocked MiniLM and EmbeddingGemma 2 load from the cache with no requests.
