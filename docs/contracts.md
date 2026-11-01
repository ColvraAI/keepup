# Contracts between the lanes

Lane B (the lab and the fork branches) and Lane A (the App and the site) meet at four files. Each has one writer. If you need a field that isn't here, add it here first.

## 1. lab/<dir>/result.md (written by the lab, read by the App and the site)

Front matter, then the table that goes in the pull request under "Measured on this fork".

```
---
lab: 01-router
status: measured            # measured | partial | not_run
measured_at: 2026-11-01     # only when something really ran
title_number: 6.2x faster on 60 test messages   # only when status is measured, and only if the title has a number
needs: OPENAI_API_KEY       # what is missing, when status is partial or not_run
---
| | before | after |
| --- | --- | --- |
```

Rules:
- `status: measured` means every number in the table came from a real run saved under `lab/<dir>/out/`. The App holds a result to it: `lab:` must name this lab (or `<dir>-<variant>` for a variant), the table must have a row, and `out/manifest.json` must match, or the result counts as not measured. `writeResult` saves that manifest with a measured result: the lab's name, a hash of the result, and a hash of each file the run saved. So a lab saves its raw output before it calls `writeResult`. `repo-tests.*` and dotfiles aren't a run, and don't count.
- A result that can't be read stops that lab's pull request, and nothing else. Running the lab replaces it.
- `status: partial` means some of it ran. The table says which rows ran; everything else is absent, not estimated.
- `status: not_run` has no numbers at all, only one sentence on what running it will measure and what it needs.
- Nobody writes this file by hand. `lab/<dir>/run.ts` writes it through `lab/shared/result.ts`.
- A lab that lacks a key exits with code 3 and leaves any earlier measured result alone.
- A variant has its own numbers and its own run. `pr-jev.json` (id `01-jev`) reads `lab/01-router/result-jev.md`, written the same way, held to `out/jev/manifest.json`, and never borrows `result.md` or `out/`.

## 2. lab/<dir>/pr.json (written by Lane B, read by the App and the site)

One file per pull request. PR 01 also has `pr-jev.json` for the Claude-only variant.

```jsonc
{
  "schema": 1,
  "id": "01",                       // "01-jev" for the variant
  "spec": "docs/prs/01-anythingllm-router-decision-model.md",
  "upstream": "Mintplex-Labs/anything-llm",
  "fork": "anything-llm",           // the repo's name under DEMO_ORG
  "baseCommit": "<40-character sha>",
  "baseBranch": "replay/ead123f0",  // created on the fork; it's what the pull request targets. One pull request to a base, so Merge always works: pr-jev.json uses replay/ead123f0-jev
  "ciWorkflow": null,               // or a path such as "lab/ci/aura.yml", committed on top of the base branch when the repo's own CI won't run
  "branch": "keepup/2026-10-06-router-decision-model",
  "lab": "lab/01-router",
  "source": "OpenAI API changelog",  // <source> in the template's first line
  "sourceUrl": "https://developers.openai.com/api/docs/changelog",
  "where": [{ "path": "server/utils/agents/aibitat/plugins/router-classifier.js", "line": 71 }],
  "founderLine": "One plain-English sentence for the brief: the effect, no jargon, no measured number.",
  "effect": ["cheaper", "faster"],  // only these words: cheaper, faster, better answers, keeps working, new capability
  "effort": "A day",                // Hours | A day | A project
  "whyItFits": "One or two lines tied to this repo.",
  "risks": "What could break, and how the change guards against it.",
  "rollback": "One line.",
  "proof": {
    "vendor": { "claim": "typed answers 10x faster than the Responses API", "url": "https://..." },
    "independent": null             // or { "claim": "...", "url": "..." }
  },
  "sources": ["https://..."],
  "sourcedNumbers": [{ "text": "1.25 times", "source": "https://..." }],  // optional: each number the free text states, with where it came from: a URL, or a file in this repo
  "stages": [
    {
      "date": "2026-10-06",         // the replay date; commits carry it as author and committer date
      "patches": ["patches/0001-add-decisions-classifier.patch"],  // relative to the lab dir, applied in order
      "title": "Route messages with a decision model · {{lab.title_number}}",
      "titleUnmeasured": null,      // optional: the title to use with --allow-unmeasured, with no number and no claim of testing. Model names, versions and dates are fine; "3 official MCP servers" isn't
      "whatShipped": "The new thing, its date, one line.",
      "whatThisChanges": "Files, and what's switched on by default.",
      "comment": null               // the first stage opens the pull request, so no comment
    },
    {
      "date": "2026-10-22",
      "patches": ["patches/0002-use-ga-shared-input.patch"],
      "title": "Route messages with a decision model · {{lab.title_number}}",
      "whatShipped": "...",
      "whatThisChanges": "...",
      "comment": "Updated 22 Oct: Decisions API is generally available."
    }
  ]
}
```

Rules:
- Patches come from `git format-patch` on the local branch, so they apply with `git apply` at `baseCommit`, in order.
- `resultFile` is optional, and names the result file in the lab dir when it isn't `result.md`. `pr-jev.json` uses it for `result-jev.md`.
- `{{lab.title_number}}` is the only placeholder. A title with it can't be rendered until the lab is `measured`, and `npm run pr` refuses rather than guessing.
- A title or `founderLine` that reads as a result (`6.2x`, `×6`, `40%`, `-40%`, `120ms`, `1.5s`, `3 of 3`, `3 out of 3`, `6.2-fold`, `$0.02`, `0.02 USD`, `3.5 GB`) doesn't load. Those come from the lab.
- `whyItFits`, `risks`, `rollback`, `whatShipped`, `whatThisChanges` and `comment` may state such a number only if `sourcedNumbers` lists it.
- Nothing public may reference someone else's issue or pull request: not `github.com/<owner>/<repo>/(issues|pull|discussions)/<n>`, `<owner>/<repo>#<n>` or a closing keyword such as `fixes #12`, in any text field or patch message. GitHub puts a backlink on their timeline, and there's no taking it back. Use `redirect.github.com`, which GitHub documents as leaving none. Releases and commits are fine.
- Nothing secret goes public either. A patch that holds a secret doesn't load, and every title, body, comment, brief and patch is checked again just before it's sent, with the secrets known by then.
- `ciWorkflow` must be a YAML file directly under `lab/ci/`, holding nothing secret, because it gets pushed to a public fork.
- A patch's subject names it, and its content has to match. If a stage is on the branch and its patch has since changed under the same subject, `npm run pr` refuses: there's no force push, so a person decides.
- Titles without a number never read the result, but the body still prints the lab's table.
- Every text field is plain and specific, in the voice of the README. Nothing in it is a number that didn't come from a source or the lab.
- Evidence that the change passes the repo's own tests goes in `lab/<dir>/out/repo-tests.json` (`{ "summary": "one line", ... }`, or `repo-tests-jev.json` for the variant) or a `.txt`/`.log` of the same name, saved from the real run. Or in an optional `repoTests` field here. The site's `repo_tests` is null without one, and says nothing was recorded.

## 3. data/github-objects.json (written by the App, read by the site)

What really exists on GitHub. The site never links to a pull request, issue or install screen that isn't in this file. No file, or no entry, means "not opened yet", and the site says so.

```jsonc
{
  "schema": 1,
  "org": "keepup-demo",
  "app": { "slug": "keepup-ai", "url": "https://github.com/apps/keepup-ai", "bot": "keepup-ai[bot]" },
  "forks": { "anything-llm": "https://github.com/keepup-demo/anything-llm", "aura": "https://github.com/keepup-demo/aura" },
  "prs": {
    "01": {
      "number": 1, "url": "https://github.com/...", "title": "...", "state": "open",
      "base": "replay/ead123f0", "head": "keepup/...", "author": "keepup-ai[bot]",
      "stagesApplied": ["2026-10-06", "2026-10-22"],
      "ci": { "state": "success", "url": "https://github.com/.../actions/runs/1" },
      "checkedAt": "2026-11-01T09:00:00Z",
      "bodyDigest": "<sha256 of the body GitHub returned>",
      "baseExtraCommits": 1         // only with a ciWorkflow: how many commits the footer counted
    }
  },
  "issues": { "anything-llm/2026-10-26": { "number": 9, "url": "https://github.com/..." } }
}
```

- `state` is `open`, `closed` or `merged`, as the API reports it.
- `ci.state` is `success`, `failure`, `pending`, `neutral` (the checks were skipped or neutral, or the fork's test workflow didn't pass on this commit, so not a pass) or `none` (GitHub reports no checks). Only `success` means green, and it needs the newest run of `run-tests.yaml` (AnythingLLM) or `keepup-ci.yml` (AURA) on the branch's tip to have succeeded.
- `bodyDigest` lets `npm run go` and `npm run status` see that a pull request's words are behind its lab. A title or body that differs from what the lab's result now gives isn't done, even with every stage applied.
- Records whose `org` isn't DEMO_ORG count as absent. Setup forgets them when the org changes.

`npm run status` also looks for two small files, which nothing else reads: `data/site.json` (`{ "url": "..." }`, written by `npm run deploy` once the address answers) and `data/run-through.json` (written by the person who recorded the backup video).

## 4. .env (written by you and `npm run setup`, read by everything)

The names are in `.env.example`. The private key file lives outside the repo, and `.env` only holds its path. Scripts load `.env` through `lab/shared/env.ts` or `app/src/config.ts`, and never print a value.

## 5. data/runs/<name>.json (written by `keepup run`, read by the dashboard)

One real run of the pipeline on one repo. It's the whole answer: the dashboard reads this file and nothing else about a run. `src/run-shape.ts` is the same contract in types, and `src/pipeline.ts` is its only writer.

```jsonc
{
  "version": 1,                     // stays 1; fields are only ever added
  "repo": "mezmo/aura",             // owner/name from the origin remote, else the folder's name
  "commit": "<40-character sha>",   // null for a repo with no commits, or a working tree that differs from HEAD
  "base_commit": "<40-character sha>",  // only when "commit" is null because the tree is dirty: HEAD, which it sits on
  "commit_date": "2026-10-30",      // UTC
  "ran": { "search": true, "judge": true, "online": true },  // what really ran, so a brief never claims more
  "scanned_at": "2026-11-01T02:00:00.000Z",
  "as_of": "2026-10-31",            // the date "retired" and "breaks soon" were judged against; the database's own date unless --as-of says otherwise
  "db": {
    "fetched": "2026-10-31",        // from the newest database file's gzip header
    "records": 41785,               // really in the window; see "reconciliation"
    "by_source": { "mcp-registry": 35587, "npm": 3953, "github": 1088, "huggingface": 455, "pypi": 281, "hn": 133, "yc": 120, "openrouter": 94, "changelog": 70, "skills": 4 },
    "window": { "since": "2026-09-01", "until": "2026-10-31" },
    "reconciliation": { "changelog_in_window": 70, "changelog_year_blind": 84, "records_year_blind": 41799, "note": "..." }
  },
  "steps": [{ "name": "List files", "detail": "434 files to read, 2 skipped (...)", "ms": 350 }],  // "Reading your code", in order
  "facts": { },                     // src/facts.ts: languages, manifests, readme, ai_call_sites, signals, model_ids, checked
  "pattern_hits": [{ "pattern": "PAT-...", "file": "a.ts", "line": 1, "text": "masked" }],
  "exact": [ ],                     // src/exact-checks.ts, "kind" says which: "model" or "dependency"
  "profile": null,                  // or { "one_liner": "", "stack": [""], "jobs": [{ "job": "", "how": "", "where": [{ "file": "", "line": 1 }], "cited": [{ "file": "", "line": 1, "text": "the quote checked against that line" }] }], "stack_lock": [""] }
  "candidates_considered": 93,
  "findings": [{
    "rank": 1,                      // from 1
    "title": "",
    "effect": ["keeps working"],    // only: cheaper, faster, better answers, keeps working, new capability
    "proof": "vendor claim",        // only: measured, vendor claim, projected, adoption only
    "effort": "Hours",              // Hours | A day | A day or more | A project
    "where": [{ "file": "", "line": 1, "text": "the line, masked" }],
    "why": "",
    "options": [{ "name": "", "what": "", "needs": "", "source": "https://..." }],
    "sources": ["https://..."],
    "lever": null,                  // or a db/levers id
    "pr": null,                     // or a pull request id, as in lab/<dir>/pr.json
    "deadline": "2026-06-15",       // when it breaks, past or future, or null
    "evidence": ["the source sentences its dates and numbers were read from"],
    "locked": "the stated rule that keeps it whatever a judge says, if any",
    "reach": "sent",                // for a retirement: "sent", "picker" when it's only a choice on a list, or "undated" when code sends it with no date to stop by; a finding with a reach ranks after every lever and shows as one "Also:" line unless nothing else fits
    "value": { "status": "priced", "label": "projected", "formula": "printed", "inputs": { "calls_per_month": { "value": 10000, "label": "assumed" } }, "today_per_call_usd": 0, "frontier_per_call_usd": 0, "change_cost_usd": 0, "monthly_gain_usd": 0, "value_usd": 0, "break_even_calls_per_month": 0, "speed": { "text": "", "label": "vendor claim" } }  // lever value = (cost today - frontier cost) x frequency - cost of change; status "no_number" has "reason" and no money
  }],
  "watching": [{ "thing": "", "why": "", "source": "https://..." }],
  "held_back": [{ "thing": "", "date": "2026-10-23", "reason": "", "source": "https://..." }],  // date and source can be null
  "checks": { "passed": 12, "dropped": [{ "what": "the finding's title, with any link dead", "why": "what failed, with any link dead", "where": "file:line, when it had one" }] },
  "rank_explanation": "Order: ...",
  "usage": null,                    // or { "model": "", "input_tokens": 0, "output_tokens": 0, "usd": 0, "price_source": "https://...", "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "calls": 0, "replayed_calls": 0, "replayed_usd": 0, "max_usd": 1.5 }
  "incomplete": { "reason": "", "skipped": [""] },  // only when a run stopped early, at the dollar cap, on a refusal or at the read's time or size budget; it holds what it had, and its quiet line is never printed
  "candidate_log": { "stack_lock": [""], "provider_only": null, "jobs": [{ "job": "", "terms": [""], "matched": 0, "cut_by_stack_lock": 0, "cut_mass_publisher": 0, "cut_by_provider": 0, "cut_seen_in_earlier_job": 0, "cut_by_cap": 0, "kept": 0 }] },  // only with a judge
  "provider_only": "anthropic",     // only with --provider-only
  "recommendations": [{ "name": "", "kind": "mcp-server", "why": "", "install": "the line to run", "source": "https://..." }],  // "For your team"; never a pull request
  "measurements": [{ "version": 1, "id": "measure-...", "finding_rank": 1, "lever": "", "commit": "", "at": "", "prompt": { "file": "", "line": 1, "chars": 0, "placeholders": [] }, "disclosure": "what was sent, said first", "rows": [{ "recipe": "", "status": "measured", "n": 4, "headline": "-34% input cost", "summary": "", "cannot_prove": "", "raw": [] }], "usd": 0, "cap_usd": 0.25 }]  // only from keepup measure; a row with no key is "not measured" with "needs" and no number
}
```

Rules:
- Every string in this file has been through `src/mask.ts` just before it's written, model replies included, so a key never reaches the dashboard. A file with no reason to exist except to hold a secret, such as .env, .npmrc or a key file, never reaches a run at all.
- Everything in `findings` passed `src/checks.ts` at this commit. A finding that failed is in `checks.dropped`, not gone without a word. A brief prints only a category and the place for those; the raw text stays here, with its links dead.
- Only `keepup run --publish` writes data/runs. Any other run goes to ~/.keepup/runs or the plugin's data folder, and a run with no judge won't replace a judged one without --force. The dashboard skips a file whose `usage` is null.
- With ANTHROPIC_API_KEY set, `keepup run` is the whole pipeline: `src/claude.ts` fills the seams with `src/profile.ts`, `src/candidates.ts` and `src/judge.ts`, and `src/check.ts` checks what the judge says. It also asks the registries about dependencies and reads public model cards.
- With no key or with `--no-judge`, there's no model and no network unless asked: `profile` and `usage` are null, and `findings` holds only what the exact checks prove. `--online` lets the dependency check ask the registries and read a library's release notes. A library behind on versions is a finding only when those notes name what the code would gain.
- `usage.usd` is what this invocation spent. Answers to identical requests replay from tmp/llm-cache for free, and `usage.replayed_usd` is what those answers first cost, so a run's full cost is the two added together. data/replay holds the answers, registry replies, release notes and model cards behind the published runs, so `keepup run --replay` rebuilds them exactly.
- A model check can also carry `earliest` (the date is the provider's earliest, and is always said as "no earlier than"), `earliest_date` (an earliest date that has passed, so `effective` is null), `successors_from_page`, `page_source`, `routed_to` and `routed_sentence`. A dependency can carry `locked` (`{version, file, line}`, read from the lockfile as text). `release_notes.spec` lists protocol revisions a library took on after the declared version.
- `db.records` counts what's really in the window. The kit first said 41,799 because 14 of OpenAI's "Sep" and "Oct" changelog entries, which carry no year on the page, are from 2023 to 2025. `db.reconciliation` shows the sum.

## The replay base and CI

A pull request needs a base branch, and an old base commit gives the fairest diff: `replay/<short sha>` points at the base commit on the fork. Merge can't conflict with anything the team did later, or with another pull request, because no two share a base. A head branch starts at the base commit plus the CI commit, wherever a merge has since moved the base.

- AnythingLLM's own `run-tests.yaml` and `lint.yaml` have no branch filter, so the repo's real CI runs on these pull requests. `ciWorkflow` is null.
- AURA runs its tests from a Jenkinsfile, which forks can't use. Its base branch gets one extra commit that adds `lab/ci/aura.yml` as `.github/workflows/keepup-ci.yml` and removes every other file in `.github/workflows/`, because a `pull_request` workflow runs from the merge.
- That isn't enough for `pull_request_target`, which since 8 Dec 2025 GitHub always reads from the repo's default branch, whatever the base. AURA's CLA bot runs on it and can't pass without upstream's secret. So before the first pull request, one App commit removes every workflow file from the AURA fork's default branch, which also takes its scheduled and issue-comment workflows off the fork. This is the App's one push to a branch a spec doesn't name. The pull request body says so, and the App needs the `workflows: write` permission for both.
- Setup also tries to switch off the fork's other workflows (Docker publishing, metrics), but only as a tidy-up: a fresh fork lists none, so there's often nothing to act on. On AnythingLLM the extras that are present do no harm to a pull request.
- A fork runs no workflow until someone presses the button in its Actions tab, the API can't say whether they have, and a pull request opened before then never gets a run by itself. So a run on the pull request's own commit is the only evidence. `npm run pr -- <id> --check-actions` looks for one, `--rerun-ci` closes and reopens the pull request to fire a new event, and `npm run go` uses both, holding a fork's other pull requests until a run shows up. The hold lasts across runs of go: an open pull request with `ci.state` `none`, on a fork that has shown no run, gets the check first, and `npm run status` names the button as the next step.

## Running external code

AnythingLLM's and AURA's dependencies and tests run in Docker, never on the host. `tmp/` holds the clones and worktrees, and git ignores it.

Findings also carry `tier` (`huge` or `long_tail`, from the lever) and `value.measurable` when the lever has a before-and-after. A dropped entry in `checks.dropped` carries `lever`, the database's name for it, when a check dropped a lever. A measurement row carries `rules`; only a row at the current rules reaches a title. `recommendations` holds only team levers whose pattern fired, with `kind` read from the install line (`mcp-server`, `plugin`, `skill` or `tool`).
