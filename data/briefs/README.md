# Real briefs: what keepup should produce

Two real products, checked on 31 Oct 2026 against a real database of what shipped in AI from 1 Sep to 31 Oct. Nothing is simulated: every thing has a source, and every place in the code has a file and line at the stated commit.

- **anythingllm.md:** Mintplex-Labs/anything-llm (67,712 stars, Node.js). A chat-with-your-documents app with agents.
- **aura.md:** mezmo/aura (401 stars, Rust). An SRE agent platform.

They were picked to differ in domain, language and size. The database is the same for both, yet no finding appears in both briefs. That's the point: keepup reads the repo first, then searches the database for that repo.

## The database behind them

41,785 things, fetched by a one-off fetcher (not in this repo) on 31 Oct (UTC):

| Source | Records | Note |
| --- | --- | --- |
| Official MCP Registry | 35,587 | Servers updated since 1 Sep; 23 mass publishers hold 8,237 of them |
| npm | 3,953 | AI keywords, published in the window, 300 or more weekly downloads |
| GitHub | 1,088 | Created since 1 Sep, 100 or more stars |
| Hugging Face | 455 | Created since 1 Sep, 20 or more likes |
| PyPI (via ecosyste.ms) | 281 | An undercount; see docs/sources.md |
| Hacker News | 133 | Show HN and Launch HN about AI |
| Y Combinator | 120 | AI and dev-tool companies launched in the window |
| OpenRouter | 94 | Models created in the window |
| Provider changelogs | 70 | Dated entries from OpenAI, Anthropic and Google. The first count said 84 and a total of 41,799: OpenAI's headings carry no year, so 14 entries from 2023 to 2025 slipped in (D12, on the database's total). |
| ClawHub skills | 4 | Only the 2,400 most-downloaded and most-installed skills were read, and almost all of them are older than 1 Sep. A full pass by creation date takes about 9 seconds per 100 skills, so it belongs in the daily job. |

The release notes for specific libraries (rmcp, @huggingface/transformers and others) and crates.io versions were fetched per candidate, as MVP.md's step 5 describes.

## How each brief was made

1. **Facts.** A shallow clone at the default branch. A one-off inventory script (not in this repo) ran the 43 signals from docs/reference/signals.json, and the manifests and README were read.
2. **Profile.** Claude read the README, the manifests and the code around the AI call sites, then wrote "What we understood", citing a file and line for every claim.
3. **Candidates.** For each job, keyword search over the database (a one-off script, not in this repo) with the stack lock applied. Exact checks were added for the repo's own model ids and pinned dependencies: retirements in the provider changelogs, and newer versions on npm and crates.io.
4. **Judge.** Claude read each candidate's record and its primary source (model card, changelog, registry entry), plus the code at each place. It decided fit or no fit and wrote the reason. This is the job the product's judge does.
5. **Checks.** Every number and date was read from its source, and every file and line was opened at the stated commit.

## What the product does better than this demo

- **Embeddings, not keywords.** The demo found candidates with keyword search; the product adds vector search.
- **A bigger, fuller database.** The demo held 60 days. The product keeps everything current and refreshes daily, so a deadline announced earlier still shows up: whisper-1's shutdown was announced on 26 Aug.
- **Full coverage of each source**, especially skills and PyPI.
- **Repeatable where it can be.** The exact checks give the same result every time: same database, same repo, same answer, and a retirement or a protocol library with named gains stays whatever the judge says. The judge's model takes no temperature setting, so two fresh runs can differ on what only it decides. The demo's runs are replayed from a saved cache, `data/replay`: `keepup run <repo> --commit <sha> --replay` rebuilds each one at no cost, with no key and no network.

## Use them as tests

The website and the CLI must find at least these findings for these two repos at these commits, or say why not. They also must not show anything from the "Checked and held back" tables. Keep the commits pinned in the test.

Not every row of those tables turns up in a run. "Checked and held back" in a run lists what reached the program's checks or the judge, plus popular things the stack lock cut. A change the code already handles, such as Claude Haiku 5.5 and temperature, never reaches either, because no search term or pattern points at it.

test/replay.test.ts rebuilds every published run from data/replay. It needs the clones: tmp/anything-llm and tmp/aura, and full shallow copies of the other two under tmp/full. `npm run clones` fetches all four at the pinned commits, as full shallow copies, because keepup refuses a partial clone. `npm test` skips a run with no clone; `npm run verify` fails instead. The numbers, sources and exact checks in the saved runs are checked in `test/acceptance.test.ts` with no clone at all.

test/heldout.test.ts holds a second answer key, for bolt.new and farfalle, written from reading those repos after the prompts were frozen, and held-out-results.md says how the runs did against it.
