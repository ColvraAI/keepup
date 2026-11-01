# keepup

**You can't keep up with AI. Your product can.**

keepup reads your product's code, checks it against everything new in AI and tells you the few changes worth making: where in the code, what you'd gain and the proof. When you say yes, it makes the change on a branch for you to review as a pull request.

**Private by default.** The scan runs on your machine with no network calls and no telemetry. It reads your repo only as text, never runs anything from it, and masks anything that looks like a key. In Claude Code, your own Claude judges each hit, so the code it reads goes to Claude, and keepup itself never uploads your code. That Claude has tools, so the skill pre-approves only `keepup` and tells it to treat repo text as data. Whether anything else stops for your approval depends on Claude Code's permission mode, not on keepup: see [What asks you first](#what-asks-you-first). The same steps through `keepup run` go to a model with no tools at all.

## What it finds

Real findings from real repos, each with a file, a line and a source:

- **A model you use is shutting down.** `collector/utils/WhisperProviders/OpenAiWhisper.js:11` sets `whisper-1`, which OpenAI shuts down on 26 Feb 2027.
- **A chat call that only picks a label.** A decision model can do that job, with Jev and OpenAI's Decisions API side by side.
- **New tools for a job you already do,** such as a vendor's own MCP server your agents can't reach yet, or an embedder that runs in your stack.
- **Libraries far behind, when their own release notes name what you'd gain,** such as an MCP client three major versions behind that misses a fix for endless SSE reconnects. Being old isn't enough. This one needs the registries, so it comes from `keepup run`, which asks them. `/keepup` stays offline and says how many dependencies it didn't check.
- **Hand-parsed JSON, prompts sent without caching, parameters a provider has removed.**

It also tells you what it checked and held back, and why: a retired model id inside a test, an upgrade your version range already allows, a competitor. "Checked and held back" lists what reached a check or the judge; things a search never turned up aren't in it. When a full run finds nothing, you get one line:

```
keepup: nothing new applies · 41,785 checked
```

In Claude Code, it says what really ran: `keepup: nothing new applies · 41,785 in the database · 8 searches · 12 read closely · 38 of 40 dependencies not checked (offline)`, and it counts any ids on a model list it didn't recognise. A brief with findings says the same on its second line. With no search behind it, it says only what it looked at: `keepup: exact checks only · 12 model ids · 40 dependencies not checked (offline) · nothing retired`.

## Install

One command. It checks for Node 22.18 or later and Claude Code, shows the two commands it will run, asks, then runs them:

```sh
curl -fsSL https://raw.githubusercontent.com/ColvraAI/keepup/main/install.sh | bash
```

Or run the two commands yourself:

```sh
claude plugin marketplace add ColvraAI/keepup
claude plugin install keepup
```

These work once ColvraAI/keepup is public. Until then, from a checkout of this repo, use its real path:

```sh
claude plugin marketplace add /path/to/keepup
claude plugin install keepup
```

or `KEEPUP_SOURCE=/path/to/keepup ./install.sh`, which does the same. Both commands only change Claude Code's settings, and running them again is safe. To remove it: `claude plugin uninstall keepup`, then `claude plugin marketplace remove keepup`.

Then, in any repo:

```sh
cd your-repo
claude
```

and type `/keepup`, or just ask what's worth changing. `/keepup:keepup` is its full name and works too. You get one screen. Say which finding you want and type `/keepup:apply 1`: that refuses a dirty tree and makes the change on a local branch with one commit. Then it asks, and on your yes it pushes that branch and opens a draft pull request with your `gh` login, with the ROI and the proof in it. You merge. A finding that needs an account or a project gets written steps instead of a code change.

### What asks you first

keepup can't promise you a prompt. Your permission mode decides, and this is what happens in each:

- **Auto, the built-in default for interactive sessions on current Claude Code.** Claude Code's background safety checks decide, and they let `/keepup:apply` edit files, make the branch and commit with no prompt. Typing `/keepup:apply` is your yes to that. It asks again before it pushes, so read the commit first.
- **Manual.** Every edit and every command `/keepup:apply` runs stops and asks first, and nothing changes until you say yes. To start a session that way:

  ```sh
  claude --permission-mode default
  ```

What holds in every mode: the `keepup` commands themselves read only the project and write only to the plugin's data folder, and they refuse `keepup run`. That's enforced by the program. That `/keepup:apply` asks before it pushes, and never merges, is an instruction in the skill, not a lock, so don't rely on it in auto mode.

keepup's "check first" is a text search. It sees what your code sets, not what a library under it sends. So when a successor rejects a setting your code never mentions and an SDK such as `ai` or `langchain` makes the calls, the brief says "Not ruled out", names the SDK and version, offers a bridge model if the provider's page lists one, and `/keepup:apply` makes that smaller move and says the rest isn't verified.

With a local path, Claude Code loads the plugin from your checkout, so keep the folder where it is; changes there apply at your next session. To remove it: `claude plugin uninstall keepup`.

**Run it on your own repos, or ones you trust.** keepup only reads and masks. But Claude Code itself loads a repo's settings, hooks and MCP servers when you start a session inside it, and that happens before keepup is involved.

To try it for one session without installing, from the repo you want checked:

```sh
cd your-repo
claude --plugin-dir /path/to/keepup/plugin
```

The plugin is the `plugin/` folder: the engine, the skills and the database, about 5 MB. A plugin's skills have full names in the form plugin:skill, and the bare skill name also works unless another command already uses it. That's why `/keepup` works, and why `/keepup:apply` stays written in full: a bare `/apply` could clash.

You need **Node 22.18 or later**, because keepup is TypeScript that Node runs directly. There's nothing else to install.

Once a week at most, opening Claude Code in a repo with AI code in it shows one line, such as `keepup: 1 model you use shuts down 30 Nov · /keepup` or `keepup: 2 new changes apply · 9,869 new or updated this week · /keepup`. It compares your repo's model ids and dependencies only: the things in that count aren't checked against your code until you run `/keepup`, and most are registry entries whose date is the newest publish, so it says "new or updated". A repo with no AI code hears nothing.

### Add it to GitHub

This runs keepup each week on your own Claude plan, with no API key and no server of ours, using [Anthropic's own GitHub action](https://code.claude.com/docs/en/github-actions). You connect GitHub once:

1. In Claude Code, in your repo, run `/install-github-app` and choose your Claude subscription. That's Anthropic's setup: it installs their GitHub App and saves your plan's token as a repo secret. keepup never sees the token. You need admin on the repo, and the token lasts a year.
2. Copy [the workflow file](examples/support-bot/.github/workflows/keepup.yml) to `.github/workflows/keepup.yml` in your repo.
3. Run `gh workflow run keepup.yml` once and read the log, then let it run each Monday.

You get one issue with the levers and their ROI, and a draft pull request for the top one, from `claude[bot]`. A person merges every one. For another finding, run `/keepup:apply 2` in Claude Code.

Five things to know. Keep `persist-credentials: false` in that file, or keepup refuses the checkout. It uses your plan's limits, like running `/keepup` yourself, and if a limit stops it, the run fails and says so. A private repo on a free plan gets a normal pull request, because GitHub has no drafts there. A company or shared setup should use an API key instead, which is one changed line in that file. And Anthropic's docs name CI as a use for this token, but they say nothing specific about a third-party plugin running unattended, so read [their rules](https://code.claude.com/docs/en/legal-and-compliance) for your own use.

## What it needs

- **The skill** (`/keepup` and `/keepup:apply`) needs Claude Code and Node 22.18 or later. It uses your own Claude Code, so it needs no key of its own. Opening the pull request needs `gh`, logged in; without it, the skill prints the commands.
- **The weekly GitHub run** needs a Claude plan and `/install-github-app`, or an API key if you'd rather. It needs no account with us.
- **An Anthropic API key,** as `ANTHROPIC_API_KEY`, only for the judge in the command line's `keepup run` and in the dashboard. `scan`, `facts` and the other commands use none.
- **The GitHub App path** (`npm run setup`, `npm run pr`) needs your own setup: you register your own GitHub App on an org you own, with `npm run setup -- --org <your-org>`, and put what it gives you in `.env`. Nothing here gives you a running App.
- **The repo's own commands** (the dashboard, the labs, the tests) need a checkout and `npm ci`. The skill doesn't.

## See it

```sh
npm run dashboard
```

That builds the site if it's out of date and serves it at http://127.0.0.1:4317, on this machine only. Its screens read the runs in `data/runs`, what a replay of the demo weeks did in `data/timeline.json`, and the lab's measured results. No pull request or issue has been opened: the pull requests on those screens are specs, marked ready to open. If you run the App, it records what it opens in `data/github-objects.json`, and the dashboard links to that. To put your own repo on it, run `node bin/keepup.ts run <path> --publish` with `ANTHROPIC_API_KEY` set, then start the dashboard again.

**How a change reaches you.** A person merges every one, whichever way it comes:

- **The Claude Code plugin** answers `/keepup`, and when you say yes, `/keepup:apply` makes a local branch with one commit per finding. On a second yes it pushes and opens a draft pull request.
- **The weekly GitHub run** works in your repo's own CI on your own Claude plan. It keeps one weekly issue with the levers and their ROI, and opens a draft pull request for the top one. Nothing runs on a server of ours. See "Add it to GitHub" above.
- **The dashboard** shows all of it in one place, on your machine.
- **The keepup GitHub App** is how this repo's own demo opens pull requests, on forks in one org and never upstream: `npm run pr` and `npm run brief`. It isn't a hosted service yet.

**Getting newer data.** The database ships inside the plugin, and the plugin has no version number on purpose, so each commit counts as an update. Claude Code only auto-updates official marketplaces by default: turn it on for this one in `/plugin`, under Marketplaces. A line older than two weeks says which day its database is from.

## Skip this if

- Your product doesn't call an AI model from code in a repo.
- You want a news feed. Five sites already do that.
- You want something to change your code without a person reviewing it.

## What it never does

- Upload your code.
- Merge anything. A person merges every change.
- Push or open a pull request without being asked. The plugin asks each time, and the weekly run only runs where a person turned it on.
- Send telemetry.
- Run anything from your repo.
- Print a key it finds.
- State a number nobody measured. Each finding says whether its proof is measured, a vendor's claim, a projection or adoption only.

## The command line

```sh
node bin/keepup.ts scan <path>      # hits for db/patterns, as JSON
node bin/keepup.ts facts <path>     # the repo's inventory, as JSON
node bin/keepup.ts search '<json>'  # search the database
node bin/keepup.ts show <path> <file> <line>       # a masked, numbered window of one file
node bin/keepup.ts prepare <path>   # scan, facts and the exact checks, written to one folder
node bin/keepup.ts get facts.model_ids             # read part of what prepare wrote
node bin/keepup.ts levers <pattern-id>             # a pattern and its levers
node bin/keepup.ts verify <path> <findings.json>   # run the checks over findings someone else judged; --brief prints the brief
node bin/keepup.ts check <path>     # the weekly line
node bin/keepup.ts run <path>       # the whole pipeline, for use without Claude Code
```

`run` is the one command that uses the network. With `ANTHROPIC_API_KEY` set, it sends masked, bounded excerpts of your code to Claude, which can be a whole short file but never a secret, and asks npm, crates.io and PyPI about your dependencies. It stops at `--max-usd` (1.50 by default). `--no-judge` keeps it offline and says only what the exact checks prove. `--provider-only anthropic` means it never suggests another provider's API. It prints one screen; `--full` prints all of it. The run file goes to `~/.keepup/runs`, or the plugin's data folder; `--publish` writes `data/runs`, which the dashboard reads.

`--replay` rebuilds the demo runs from the saved answers in `data/replay`, with no key, no network and no cost. `npm run clones` fetches the four repos at their pinned commits, and `npm run verify` then rebuilds and checks every published run, and fails if a clone is missing. Two fresh runs can differ, because the judge's model takes no temperature setting, and the exact checks always come out the same.

## Licence

The code is Apache-2.0 (LICENSE). The data in `db/` is CC-BY-4.0 (db/LICENSE).

## The dashboard

```
npm run dashboard
```

It serves the built site on http://127.0.0.1:4317, and only there. Press P, or add `?present`, for the two-minute run-through: arrows or space to move, number keys to jump, T for the clock, Esc to leave. Everything on it is read from `site/data`, and "How this is real" says where each part comes from. A static copy of `site/out` works the same, with recorded runs and no live scan.
