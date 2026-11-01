# keepup brief: acme/support-bot

Commit 9caf2b4 (30 Oct 2026). Database as of 31 Oct 2026.

## What we understood

**The product.** A support chatbot with a router in front of its model.

**The stack.** TypeScript, OpenAI

**The AI jobs in the code:**

| Job | How it's done today | Where |
| --- | --- | --- |
| Route tickets | A chat call picks a label | src/router.ts:41 |
| Answer | A chat call with retrieved passages | src/answer.ts:12, src/rag.ts:7 |

**Stack lock.** keepup only considers:
- Node packages
- APIs and MCP servers

## Biggest lever: Your router can use a decision model

## Compared with 41,785 new or updated things from 3 sources, fetched 31 Oct 2026. 1 fit.

Order: anything that breaks within 30 days first, then the biggest proven gain per hour of work.

### 2. Your router can use a decision model · cheaper, faster

**Where:**
- src/router.ts:41 `x`
- src/router2.ts:7 `y`

**Why it fits.** This job is one answer from a fixed list.

**The options:**

| Option | What it is | Needs |
| --- | --- | --- |
| OpenAI Decisions API | Typed answers | An OpenAI key |
| TypeSafe Jev \| fast | No one provider | A new vendor |

**Proof.** Projected.

**Effort.** A day.

**Sources:**
- https://developers.openai.com/api/docs/changelog
- https://example.com/jev

**Pull request.** 01

Also: 1 retired or retiring model finding · src/voice.ts:11 · want the change?

## Watching

These fit a job you have, but aren't ready to recommend.

- **Indra OCR.** It ships as a Python package, and your collector is Node. Source: https://huggingface.co/datalab-to/indra-ocr

## Checked and held back

| Thing | Date | Why it's held back |
| --- | --- | --- |
| MCP TypeScript SDK 1.32.2 | 23 Oct 2026 | Your range ^1.24.3 (server/package.json:36) already allows it. |
| Prompt caching | — | It's your call: a product choice. |

## Dropped by the checks

- its place in the code didn't hold up
