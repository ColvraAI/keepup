# app: the GitHub App and the local dashboard server

Every GitHub write goes through src/guard.ts: forks in DEMO_ORG only, never upstream. Only setup uses a person's token.
Tests use app/test's fake GitHub and local bare remotes. No real pull request has been opened yet, so expect surprises on first contact.
No upstream issue or PR references in any body: they notify maintainers.
