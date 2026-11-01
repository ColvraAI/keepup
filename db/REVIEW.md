# Levers waiting for a person

## Review these first: the 13 huge levers

The database's value is these, not its size, so don't quote a total. An agent wrote all of them, and none has been reviewed by a person (P12). Open each source and check the independent number before anyone repeats it. JSONSchemaBench and the Deriv post were opened by an agent on 2026-11-01; the rest of the plan's independent numbers for decision models (gpt-researcher's README, Explorbot) were not opened, so they aren't here.

One to settle: ADV-2026-1007-anthropic-prompt-caching says a Sonnet 5.5 cache read is $0.10 (0.05x), and another Anthropic reference this project reads says $0.20 (0.1x). The read multiplier stays empty until a person opens the pricing page, and the projected value uses 0.1x, the smaller saving.

| Lever | Independent number |
| --- | --- |
| ADV-2024-0415-openai-batch | **None opened yet.** |
| ADV-2024-0806-openai-structured-outputs | JSONSchemaBench (arXiv 2501.10868), table 4, on hard GitHub schemas: unconstrained output complied 13% of the time; OpenAI complied 100%, but only on the 9% of those schemas it accepted. The paper doesn't say strict mode, and says closed-source and open engines aren't directly comparable. |
| ADV-2024-0830-gemini-structured-output | **None opened yet.** |
| ADV-2024-0919-contextual-retrieval | **None opened yet.** |
| ADV-2024-1217-anthropic-message-batches | **None opened yet.** |
| ADV-2025-0707-gemini-batch | **None opened yet.** |
| ADV-2026-0129-anthropic-structured-outputs | **None opened yet.** |
| ADV-2026-0709-openai-prompt-caching | Deriv's engineers, on their own production agent: an 85.8% cache-hit rate cut input-token costs 77%, after restructuring prompts. That's input tokens only, and the post's dollar figures are illustrative; it doesn't say which provider that agent runs on. |
| ADV-2026-0915-typesafe-jev | **None opened yet.** |
| ADV-2026-1007-anthropic-prompt-caching | Deriv's engineers, on their own production agent: an 85.8% cache-hit rate cut input-token costs 77%, after restructuring prompts. That's input tokens only, and the post's dollar figures are illustrative; it doesn't say which provider that agent runs on. |
| ADV-2026-1022-openai-decisions-api | **None opened yet.** |
| ADV-2026-1101-cohere-rerank | Anthropic's contextual-retrieval study: with reranking, failed top-20 retrievals fell 67%. |
| ADV-2026-1101-gemini-implicit-caching | **None opened yet.** |


Plan decision P12: a lever an agent wrote is a guess until a person opens its source. Last time, 7 of 20 agent-written levers were wrong. An agent opened every source below on 2026-11-01 and read the fact off the page, so each one has checked_by "agent". None has been checked by a person yet.

To promote a lever: open the source, eyeball the fact, then set checked_by to the person's role and checked to today. If it's wrong, withdraw it; don't delete it.

| Lever | Source | Eyeball this |
| --- | --- | --- |
| ADV-2026-0129-anthropic-structured-outputs | https://platform.claude.com/docs/en/build-with-claude/structured-outputs | Out of beta on 29 Jan 2026 in the release notes; the parameter is output_config.format, moved from output_format. |
| ADV-2024-0806-openai-structured-outputs | https://developers.openai.com/api/docs/guides/structured-outputs | The changelog dates Structured Outputs to 6 Aug 2024; the limit is 5000 properties and 10 levels of nesting. |
| ADV-2024-0830-gemini-structured-output | https://ai.google.dev/gemini-api/docs/structured-output | The changelog entry of 30 Aug 2024 is for Gemini 1.5 Flash; the Limitations section lists the unenforced keywords. |
| ADV-2026-1101-ai-sdk-output-object | https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data | The current docs teach generateText with Output.object rather than generateObject. Confirm before suggesting either. |
| ADV-2026-0909-instructor | https://pypi.org/project/instructor/ | PyPI shows 1.17.0 as the latest, uploaded 9 Sep 2026, MIT. |
| ADV-2026-1022-openai-decisions-api | https://developers.openai.com/api/docs/guides/decisions | Pricing section: "Output tokens are not charged." The brief quotes $0.50 per million output, which is the general gpt-6-luna rate. |
| ADV-2026-0915-typesafe-jev | https://typesafe.ai/blog/introducing-system-one-models-and-jev | Launch post dated 15 Sep 2026: $0.042/MTok input and free output, and 70ms-500ms. The models page confirms the price for jev-1.14.0. |
| ADV-2026-1022-tanstack-ai-typesafe | https://www.npmjs.com/package/@tanstack/ai-typesafe | npm shows 0.0.0 on 18 Sep 2026 and 1.0.0 on 22 Oct 2026. |
| ADV-2026-0930-claude-sonnet-4-5-retires | https://platform.claude.com/docs/en/about-claude/model-deprecations | Retirement date 30 Nov 2026, replacement claude-sonnet-5-5. |
| ADV-2026-0615-claude-sonnet-4-opus-4-retired | https://platform.claude.com/docs/en/about-claude/model-deprecations | The deprecation page names claude-sonnet-5-5; the 15 Jun release note named Sonnet 4.6. This lever follows the page. |
| ADV-2026-0805-claude-opus-4-1-retired | https://platform.claude.com/docs/en/about-claude/model-deprecations | The deprecation page names claude-opus-4-8; the 5 Aug release note named Opus 5. This lever follows the page. |
| ADV-2026-0420-claude-3-family-retired | https://platform.claude.com/docs/en/about-claude/model-deprecations | Each id-to-successor row in the Deprecation history tables. |
| ADV-2026-0826-openai-whisper-retires | https://developers.openai.com/api/docs/guides/transcription | Shutdown 26 Feb 2027, announced 26 Aug 2026; prices on the pricing page under Transcription models. |
| ADV-2026-1014-openai-gpt-4o-4-1-retire | https://developers.openai.com/api/docs/deprecations | The page lists dated snapshots only. The bare ids are included because each model page marks them Deprecated with that snapshot as the default. Confirm this reading. |
| ADV-2026-0611-openai-gpt-5-o3-retire | https://developers.openai.com/api/docs/deprecations | Shutdown 11 Dec 2026; gpt-5 $1.25/$10 and gpt-5.6-sol $4/$20 on the pricing page. |
| ADV-2026-0422-openai-legacy-gpt-retired | https://developers.openai.com/api/docs/deprecations | The table says "Access to these models was shut down on October 23, 2026". Note gpt-4-turbo and gpt-3.5-turbo still have rows on the pricing page. |
| ADV-2026-1001-openai-tts-retire | https://developers.openai.com/api/docs/deprecations | Shutdown 6 Jan 2027, replacement gpt-realtime-2.1-mini; audio prices $20 and $12 on the pricing page. |
| ADV-2026-0601-gemini-2-0-shut-down | https://ai.google.dev/gemini-api/docs/deprecations | Deprecations table for the successor, release notes of 1 Jun 2026 for "now shut down". The notes also mention gemini-3.5-flash; the table names gemini-3.6-flash. |
| ADV-2026-1021-anthropic-sampling-params-removed | https://platform.claude.com/docs/en/api/migration-2026-10-21 | Migration guide, "Sampling parameters are removed"; SDK versions in the 21 Oct 2026 release note. |
| ADV-2026-0826-openai-assistants-shut-down | https://developers.openai.com/api/docs/assistants/migration | First paragraph of the migration guide; shutdown row on the deprecations page. |
| ADV-2026-0603-openai-prompts-evals-shut-down | https://developers.openai.com/api/docs/deprecations | Two tables on the deprecations page: 30 Nov 2026 for both, 31 Oct 2026 for read-only evals. |
| ADV-2026-1007-anthropic-prompt-caching | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | Pricing table: Sonnet 5.5 $2 base and $0.10 read; footnotes give 0.05x and 0.025x. The 0.05x date, 7 Oct 2026, is in the release notes. |
| ADV-2026-0709-openai-prompt-caching | https://developers.openai.com/api/docs/guides/prompt-caching | Caching guide: "discounted up to 95%", 1.25x and 2.5x writes, 0.1x and 0.05x reads, 1,024-token minimum. |
| ADV-2026-1101-gemini-implicit-caching | https://ai.google.dev/gemini-api/docs/caching | Caching page minimum-token table; gemini-3.6-flash context caching price $0.075 on the pricing page. |
| ADV-2024-1217-anthropic-message-batches | https://platform.claude.com/docs/en/build-with-claude/batch-processing | 50% discount and limits on the page; available without a beta header since 17 Dec 2024 in the release notes. |
| ADV-2024-0415-openai-batch | https://developers.openai.com/api/docs/guides/batch | "50% cost discount" on the page; batch rows on the pricing page; the changelog dates the release to 15 Apr 2024. |
| ADV-2025-0707-gemini-batch | https://ai.google.dev/gemini-api/docs/batch-api | "50% of the standard cost" and the generateContent note at the top of the page; launch of Batch Mode is 7 Jul 2025 in the release notes. |
| ADV-2026-1027-fastmcp | https://pypi.org/project/fastmcp/ | PyPI shows fastmcp 4.1.4 on 27 Oct 2026; npm shows the MCP SDK at 1.32.2 while the repo README calls v2 the stable line. |
| ADV-2026-1101-mem0 | https://github.com/mem0ai/mem0 | README table "New Memory Algorithm (April 2026)": tokens and latency, and the note that scores reflect the managed platform. |
| ADV-2026-1101-agent-skills-format | https://agentskills.io | The overview page's "Open development" section for the adoption sentence, and the client showcase. The pattern behind it, PAT-own-skill-format, fires in 3 of 39 repos and only one is real, so decide whether it stays live. |

## Also worth a look

- **PAT-retired-model-id** is generated by db/tools/retired-models.ts from the three providers' deprecation pages. Spot-check a few rows of its models list against the pages.
- **Gemini dates** are the earliest possible shutdown, in Google's own words, unless the release notes say a model is already shut down.
- **Anthropic dates** apply to Anthropic-operated platforms. Bedrock and Google-managed Vertex keep their own schedules, so Bedrock-style ids never match.

## Added 2026-11-01, agent-written (P12), source fetched and the quoted text matched by a program

A regex confirmed each quoted string on the page, which is weaker than a person reading it. Eyeball these first:

- ADV-2024-0701-routellm: https://lmsys.org/blog/2024-07-01-routellm/
- ADV-2024-0919-contextual-retrieval: https://www.anthropic.com/news/contextual-retrieval
- ADV-2026-1020-openai-12-hour-cache: https://developers.openai.com/api/docs/guides/prompt-caching
- ADV-2026-1101-anthropic-1-hour-cache: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- ADV-2026-1101-cheaper-tier: https://platform.claude.com/docs/en/about-claude/pricing
- ADV-2026-1101-cloudflare-clef: https://blog.cloudflare.com/clef-decision-models/
- ADV-2026-1101-cohere-rerank: https://docs.cohere.com/docs/rerank-overview
- ADV-2026-1101-letta-memory: https://www.letta.com/blog/benchmarking-ai-agent-memory
- ADV-2026-1101-mcp-github: https://github.com/github/github-mcp-server
- ADV-2026-1101-mcp-linear: https://linear.app/docs/mcp
- ADV-2026-1101-mcp-sentry: https://docs.sentry.io/product/sentry-mcp/
- ADV-2026-1101-mcp-stripe: https://docs.stripe.com/mcp
- ADV-2026-1101-zep-memory: https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/

The gain_model, usage_signal, test_recipe, verify_rule and change_recipe fields on every lever are also agent-written. Input values are null unless read from the source named beside them.
