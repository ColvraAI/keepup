# PR 05 · AURA: move the examples off retired and retiring Claude models

| | |
| --- | --- |
| Fork | `<demo-org>/aura` |
| Base | 5a5efba (31 Aug 2026; the replay's install day is 1 Sep) |
| Branch | `keepup/2026-09-01-retired-claude-models` |
| Opened in the replay | 1 Sep 2026 |
| Updated in the replay | 28 Sep (Claude Sonnet 5.5 released) and 30 Sep (Claude Sonnet 4.5 retirement announced) |

## What keepup saw

- examples/minimal/anthropic.toml:14 uses claude-sonnet-4-20250514. Anthropic retired that model on 15 Jun 2026, so every request now returns an error. The line is unchanged at commit 5efb4e8 (30 Oct).
- examples/complete/reasoning-models.toml:61 uses claude-sonnet-4-5-20250929. On 30 Sep, Anthropic announced it retires on 30 Nov 2026.

## The change, commit by commit

1. **1 Sep:** anthropic.toml moves to claude-sonnet-5, then the current Sonnet.
2. **28 Sep:** anthropic.toml moves to claude-sonnet-5-5. The body notes that Sonnet 5.5 returns a 400 error for forced tool use; AURA's crates don't set tool_choice, but say to check the rig fork.
3. **30 Sep:** reasoning-models.toml moves to claude-sonnet-5-5. A model id swap alone gets a 400 error: lines 69-71 send a thinking budget, so they move to adaptive thinking with output_config effort. Line 63's temperature is removed, as the migration guide says. The file's comments change to match.

**Tests.** Both examples parse with AURA's config loader. `lab/05-models/repo-tests.ts` saves that in `lab/05-models/out/repo-tests.json`.

## The lab: lab/05-models

With our OpenAI and Anthropic keys (reasoning-models.toml's coordinator and fast worker use OpenAI), run these:
- on claude-sonnet-4-20250514: record the real error
- on claude-sonnet-5-5: record a real answer
- reasoning-models.toml on claude-sonnet-5-5: record a real answer

Save the outputs. With only the Anthropic key, the two minimal cases run, the reasoning case is absent, and the result is partial and needs OPENAI_API_KEY.

**Output.** lab/05-models/result.md.

**Title.** "Example on a retired Claude model fails today, another retires 30 Nov · move to claude-sonnet-5-5": only anthropic.toml fails today, and Sonnet 4.5 answers until 30 Nov. Lab proof: the before run errors, the after run answers.

## The pull request

- **Proof:** Anthropic's release notes (15 Jun retirement, 28 Sep launch, 30 Sep deprecation), plus the lab runs.
- **Rollback:** revert the commits.

## Sources

https://platform.claude.com/docs/en/release-notes/overview
