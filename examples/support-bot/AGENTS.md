# support-bot

Answers support tickets. `src/server.ts` is the API, `src/router.ts` picks the queue, `src/answer.ts` writes the reply, and `src/cron/nightly-summaries.ts` runs once a night.

Run it with `npm run dev`. Keys come from the environment.
