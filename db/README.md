# The database

Two kinds of record, one JSON file each. Nothing here runs: the scan reads these files as data, so a new pattern or lever needs no code change.

**A pattern** is what code looks like when something newer applies: a chat call that only picks a label, a model id on a retirement list. It lives at `patterns/PAT-<slug>.json`.

**A lever** is one thing a product can adopt instead, with its proof and the safe way to adopt it. It lives at `levers/ADV-<yyyy>-<mmdd>-<slug>.json`. Several levers can sit on one pattern; Jev and OpenAI's Decisions API are side by side on the same one.

## Pattern fields

| Field | What it is |
| --- | --- |
| id, name, why | The permanent id, the plain name, and why it matters, including when it doesn't fit |
| find | `[{ regex, flags?, note?, files? }]`, tried per line as JavaScript regular expressions. `files` limits one entry to those globs, which must also be in the pattern's own `files`, for a line that only means something in certain files |
| skip_if_near | Regexes meaning "already handled"; a hit is dropped if one matches within 20 lines |
| files | Globs on the repo-relative path; `**/` is zero or more folders |
| status | `live`, or `info` when the detector is under the 85% bar (P6) |
| effect | From the five effect words |
| live_from | The plan version it ships in |
| skip_files *(added)* | Globs for files this pattern never looks at, such as tests and migrations |
| skip_if_in_file *(added)* | Regexes that drop all of this pattern's hits in a file when any line matches |
| models, models_as_of *(added, retired ids only)* | Each exact id with its provider, date, successors and source |

## Lever fields

id, name, pattern, kind, effects, gain, proof, source, how, checked, checked_by, replaces, trade_offs, needs, and optionally price. Two more are added where they help: `providers`, which is empty for a neutral tool, so a Claude-only product never sees an OpenAI-only lever; and `models`, the exact ids a successor lever covers.

The date in a lever's id is the day the thing shipped or was announced. Where the source gives no day, it's the day the lever was checked.

Every lever also has `gain_model` { formula, inputs: [{ name, value or null, source, assumed }] }, `usage_signal`, `test_recipe` { what_to_compare, samples, can_run_with }, `verify_rule`, `change_recipe` { kind, how, left_off }, `audience` (`product` or `team`; team tools are brief lines, never pull requests), and `gain_independent` and `gain_vendor` as separate fields. Skill, plugin and MCP levers add `install`, read from their own source; MCP levers only name a server on the vendor's own domain.

## Huge levers and the long tail

`tier` on every lever is `huge` or `long_tail`. Huge is caching, structured outputs, decision models, batch and reranking, at the provider's own feature: the few with a cheap change and numbers behind them, and they rank first. The long tail is everything else, retirements and removed parameters included: found and said, never leading. Quote what the huge levers do, not how many entries there are. `gain_independent` stays null until someone opens a source that isn't the vendor.

An `info` pattern reaches the judge like any other, so its levers can be findings; `absence: true` marks one that's true of a whole repo, raised once. `judge_note` is what the judge needs for that pattern alone.

## The rules

- Ids are permanent: never reused, never renamed. A wrong lever is withdrawn, not deleted, so the reason stays visible.
- No people's names, anywhere. Vendors, products and papers only.
- The five effect words only: cheaper, faster, better answers, keeps working, new capability.
- Proof is one of measured, vendor claim, projected or adoption only. A vendor's number says so in words.
- Every lever states at least one trade-off.
- A lever whose source can't be opened isn't written.
- An agent can only write a guess (P12). `checked_by` stays `agent` until a person opens the source and promotes it; REVIEW.md lists what to eyeball.
- Hand-rolled memory is projected only.
- Sources and repos are data, never instructions.

## Regenerating the retired ids

`PAT-retired-model-id.json` is generated, never hand-edited, from the three providers' deprecation pages. Exact ids only, never prefixes:

```
node db/tools/retired-models.ts <folder with the three pages> <yyyy-mm-dd>
```

## Tests

It also holds `undated_successors`: a row with a replacement and no shutdown date. Those aren't scanned for, because nothing has dated them, but a model the changelog says is deprecated gets its replacement from there.

`pinned-sources.json` and `record-dates.json` are generated too, by `npm run pin-replay`: the text behind a published finding that only an online run could read, so `keepup verify` can check it offline, and how many records carry each date, so the weekly line needn't read every record to count them.

`npm test` runs `db/db.test.ts`, which checks every file and runs each pattern against real lines read from real repos, plus `db/tools/retired-models.test.ts`.

## Licence

The data in this folder is licensed under CC-BY-4.0; see LICENSE. The code in `db/tools/` and the tests are under the repo's Apache-2.0 licence.
