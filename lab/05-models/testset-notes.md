# lab/05-models: what it sends, and what the dry run checks

## The test set

Two prompts, written for this lab, in `cases.ts`. There's nothing to score: the point is whether the config gets an answer at all.

| Prompt | Used for | Why |
| --- | --- | --- |
| "Name the capital of France in one word." | `examples/minimal/anthropic.toml`, before and after | The smallest real request. Anything but an error proves the model id works. |
| "A nightly batch job became far slower…" (`REASONING_PROMPT`) | `examples/complete/reasoning-models.toml`, after | The file's coordinator sends "careful multi-step reasoning" to `deep-analysis`, so this is worded to reach the Claude worker. |

## Which binary, and why it counts as the fork's code

Every case, real and dry, runs AURA's `v0.2.12` release binary (`aura-linux-*`, `aura webserver`), checked against the release's `checksums.txt`. It was released on 28 Aug, before the replay's first stage, and it's the base commit's own code: the base commit is version 0.2.12, pins the same rig (`5b0238a1`), and adds only CI, docs and tests to that release. A test holds this against the repo's history: outside CI, docs and test-only paths, the one file changed is `crates/aura-web-server/src/streaming/handlers.rs`, and that diff only adds lines inside its `#[cfg(test)]` module.

The later releases aren't that code. `v0.2.13` adds an MCP refactor, and `v0.2.20` (30 Oct) pins rig at `097d08d`. In dry runs `v0.2.20` sent the minimal example a default `max_tokens` of 128000 where `v0.2.12` sends 64000, and reported token usage on an orchestrated run where `v0.2.12` reports zeros. The example TOMLs are read from the base commit, plus this pull request's patches, so "before" and "after" differ only by the patches.

The run does not build the fork from source: Docker has 4 GB here, and a release binary gives the same code without it.

## Token usage and cost

The minimal example's runs are priced from the `usage` AURA returns, when it returns any. The reasoning run is never priced, because it mixes OpenAI and Claude tokens and one price can't cover it. On this release AURA's reply reports zeros for an orchestrated run, so `report.ts` reads zero tokens as "no usage reported" and says so, instead of printing a cost of nothing.

## What each key runs

`examples/minimal/anthropic.toml`, before and after, needs only `ANTHROPIC_API_KEY`, so those two cases run on that key alone.

`examples/complete/reasoning-models.toml` runs its coordinator and `fast` worker on `gpt-5.2`, so it needs `OPENAI_API_KEY` as well, as its own header says, and the spec asks for both. Without the OpenAI key the case is absent: the table has no row for it and a line under the table says why, `status` is `partial`, `needs` is `OPENAI_API_KEY`, and the lab exits 3. No config is rewritten to get around a missing key. With both keys all three cases run, and a clean run is `measured`.

Without the Anthropic key nothing can run: it writes `not_run`, names what's missing in `needs`, sends no request and exits 3. One key can't beat a measured result, so with one on file a run on one key sends nothing and leaves it alone.

A coordinator can write a good answer after its worker failed, and AURA still answers HTTP 200. So an orchestrated row counts as answered only when AURA's log shows the `deep-analysis` worker's request and "Outcome: N of N tasks succeeded". AURA also wraps a provider error in an HTTP 200 chat completion, so the before row reads the reply's text, not the status.

The before row counts only when that text has both `404` and `not_found_error`. An overload, a rate limit or a failed connection on that one request says nothing about the retirement, so the run is `partial` and the table shows the real words.

No page says a retired model returns exactly that. The release note of 15 Jun says requests "will now return an error", model-deprecations says they "fail", and api/errors describes a 404 as "the endpoint path and any resource IDs in the request URL", and a model id isn't in the URL. So this rule was an assumption for the first real run to check. The first real run checked it, on 1 Nov 2026 (`out/before-minimal/response.json`): the API answered 404 `not_found_error` with the message `model: claude-sonnet-4-20250514`, so the rule stands. That's one response, and it shows what a user of this file gets. The same answer comes back for an id that never existed or one the organization can't use (Anthropic's error notes in the claude-api skill, `shared/error-codes.md`), so that the cause is the retirement rests on the release note and model-deprecations, not on this row.

## How the raw outputs show what AURA sent

The harness turns on rig's trace log for its request bodies (`RUST_LOG` in `harness/run-cases.sh`), so each `server.log` holds the JSON AURA really sent. No filter it sets logs headers. `AURA_DEBUG_PROVIDER_ERRORS=true` makes AURA repeat the provider's error instead of its generic message.

## The dry run

`npm run lab -- 05 --dry-run` runs the real binary in the sandbox against `fake-provider.ts` on the host, reached through `host.docker.internal` (Docker Desktop). AURA's config has a `base_url` for the Anthropic and OpenAI providers, so the fake sits at the HTTP boundary and everything in AURA runs for real. The dry run covers the reasoning example as shipped, and its fake worker calls `read_artifact` before `submit_result`, so a real tool loop runs.

It also runs two probes that never reach a real API:

- `probe-display-summarized`: the reasoning example with `display = "summarized"`. The pull request says not to set that on a worker that calls tools yet, because the binary sends the summary back doubled on the worker's next turn, and Anthropic documents a 400 error for changed thinking blocks. The doubling is what the binary really did; the 400 is the fake applying the documented rule. If the doubling stops, the dry run reports a problem, and that sentence comes out of the pull request.
- `probe-empty-thinking`: the reasoning example as patched. The fake returns an empty thinking block with a signature, as Sonnet 5.5 does by default, and the probe checks that the worker's next request came back without it. If that block ever comes back, the dry run reports a problem, and the sentence about rig dropping it comes out of the pull request.

The fake enforces what Anthropic documents for these models, so a config the real API would refuse fails here too:

| Rule | Source |
| --- | --- |
| A retired model returns 404 `not_found_error` | No page says so (see above). The first real run returned exactly this (`out/before-minimal/response.json`) |
| `thinking.type: "enabled"` with a budget returns a 400 error | Sonnet 5.5 migration guide |
| `thinking.type: "disabled"` returns a 400 error on Sonnet 5.5 | Sonnet 5.5 migration guide |
| `temperature`, `top_p` and `top_k` return a 400 error, whatever the value | Sonnet 5.5 model page. Stricter than the API here: model-deprecations and api/migration-2026-10-21 say that holds on API version `2026-10-21`, and that earlier versions refuse only a non-default value. rig sends `2023-06-01` (`rig/rig-core/src/providers/anthropic/completion.rs:38` at `5b0238a1`), and the old file's 1.0 is the default, so it isn't what would fail. It's removed because the migration guide says to, and this rule keeps it out |
| Forced tool use returns a 400 error on Sonnet 5.5 | release notes, 28 Sep 2026 |
| A changed thinking block returns a 400 error | build-with-claude/thinking, thinking-troubleshooting |
| Thinking arrives first, with empty text under the default `display` | build-with-claude/thinking |

### Not enforced by the fake

Sonnet 5.5's migration guide says to pass thinking blocks back unchanged in tool-use loops, including empty ones, and the thinking page lists that as required within a tool-use turn. rig drops the empty ones (`rig/rig-core/src/providers/anthropic/streaming.rs:393` at `5b0238a1`, the rev the base pins), and the fake accepts the request anyway, on purpose. The docs say adaptive thinking doesn't need a turn to start with a thinking block and that the API might disable thinking when the history is incompatible, but they don't say what happens on this exact request, so a rule here would be a guess. A clean dry run therefore says nothing about whether the worker kept its reasoning.

A real run with both keys records what it can: `result.md` says how many of the worker's follow-up requests after a tool call sent a thinking block back, read from AURA's trace log. The log doesn't show the blocks in the replies, so it can't show whether the API disabled thinking. If the real API refuses the request, the reasoning row shows that error and the run is `partial`. A run on the Anthropic key alone says nothing about any of this.

Nothing the fake returns reaches `result.md` or `out/`; its output stays in `lab/.work/05-models/dry-run/`. It downloads the release binary into `lab/.work/bin/`, the one shared cache, and registers a git worktree on `tmp/aura` for the length of the run.

## The repo's own tests

`node lab/05-models/repo-tests.ts` writes `out/repo-tests.json`, the evidence `docs/contracts.md` asks for. In the sandbox it starts at the base commit, puts each stage's patches on in order, and runs `cargo test -p aura-config --locked` after each, the one command the fork's CI runs (`lab/ci/aura.yml`). That includes `test_all_shipped_configs_parse`, the spec's test: the shipped configs load through AURA's own config loader, both changed examples among them. It needs no key, and the rest of the workspace's tests don't run, since only example TOML files change. Every count is read from cargo's output, and it refuses to save anything if the tree it tested isn't the branch's. `run.ts` clears the last run from `out/` but keeps this file, and `shared/result.ts` leaves it out of a run's manifest.
