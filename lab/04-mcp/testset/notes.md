# lab/04-mcp: what the test set is and how to run it

The test set is one prompt, in `prompt.txt`, the one the spec names. The lab starts each server the way its example does, so the examples themselves are the rest of the input.

## Part one: no accounts

`npm run lab -- 04` starts the SigNoz and Dynatrace Managed servers with the placeholders in `servers.ts`, lists their tools with the official MCP SDK inside the sandbox, asks AURA's `/aura/info` what it discovered, and records in `out/offered-*.json` which tools AURA really offers the agent: it runs the example against `fake/fake-provider.ts`, which answers without calling a tool, reads the first request and measures the definitions. Listing tools talks to no backend, so neither needs an account. Sentry's row needs `SENTRY_ACCESS_TOKEN`. Without it the row is absent and the lab is `partial`.

The sandbox has no Docker, on purpose. The SigNoz example runs `docker run -i ...`, so the `docker` on the sandbox's PATH (`harness/bin/docker`) hands that exact command line to `lib/bridge.ts` on the host, which runs it with real Docker and pipes stdin and stdout. The bridge allows only commands found in the examples.

## Part two: the investigation

It needs `OPENAI_API_KEY` (the examples' own model) or `ANTHROPIC_API_KEY` (the llm block is swapped in a copy, and the table says so), and both backends below with something to find, each reaching the investigation by setting its variables in `.env`. The title's "tested" takes an answered investigation of Sentry and of SigNoz, each with at least one working call to a tool on that server's `readsBackend` list in `servers.ts`. Sentry's `execute_sentry_tool` counts only when the tool it runs is on the list. Any other working call doesn't count, because some tools work with no good credentials: `search_sentry_tools` on a junk token, and SigNoz's docs tools with no backend. `lib/fixtures/` holds the real streams and calls that show it. A run costs what the model charges for the tokens in `out/investigation-*.json`.

Dynatrace Managed stays out of the investigation unless `DT_ENVIRONMENT_CONFIGS` points at a real cluster, because a Managed cluster isn't something a free account gives you. So the title says how many servers were tested and names Dynatrace Managed as listed but not tested, and `result.md` prints a line saying nothing ran against a cluster whenever that's so. Its `readsBackend` list is empty even with a cluster: `lib/fixtures/no-credentials-calls-dynatrace_managed.json` shows every tool it lists answering without an error when the cluster can't be reached, so a working call shows nothing.

The data in both backends is ours, not production data, and `result.md` says so under the investigation table, with the planted cause. Send the data below and no other, or that line stops being true.

### SigNoz, running locally

SigNoz's Docker Compose files under `deploy/` are deprecated since v0.130.0. Its docs now install it with Foundry (https://signoz.io/docs/install/docker/), and ask for at least 4 GB of memory allocated to Docker, which is more than this machine's Docker VM had when this was written, so raise it first.

```bash
curl -fsSL https://signoz.io/foundry.sh | bash
cat > casting.yaml <<'YAML'
apiVersion: v1alpha1
kind: Installation
metadata:
  name: signoz
spec:
  deployment:
    flavor: compose
    mode: docker
YAML
foundryctl cast -f casting.yaml
```

Then:

1. Open http://localhost:8080, make the admin account, and create an API key (Settings → Service Accounts in the current docs; the MCP server's README says Settings → API Keys).
2. Send the test data: `node lab/04-mcp/testset/send-signoz-telemetry.ts`. It writes an hour of logs and spans for a `checkout` service with one findable cause, so send it just before the run. It is data we made up on purpose, and the answer to expect is a payment gateway timing out for the last fifteen minutes. SigNoz also offers OpenTelemetry Demo Lite (https://github.com/SigNoz/opentelemetry-demo-lite) if you'd rather have busier data, but that has no spike to find.
3. In `.env`: `SIGNOZ_URL=http://host.docker.internal:8080` and `SIGNOZ_API_KEY=...`. The URL is read from inside the MCP server's container, so `localhost` won't reach SigNoz.

### Sentry, with a free account

1. Create a free account and a small demo project at https://sentry.io.
2. Send it a few errors. With its DSN and `sentry-cli`:

   ```bash
   export SENTRY_DSN='https://<key>@o<orgId>.ingest.sentry.io/<projectId>'
   for i in 1 2 3 4 5; do sentry-cli send-event -m "payment gateway timeout: charge failed"; done
   ```

3. Create a user auth token (https://sentry.io/settings/account/api/auth-tokens/) with `org:read`, `project:read`, `team:read` and `event:read`, the scopes the read-only tools list in the server's tool definitions, and put it in `.env` as `SENTRY_ACCESS_TOKEN`.

## Which AURA runs

The lab runs `v0.2.18-nightly.9`, the tag upstream put on the base commit, and a test holds the tag against the repo's history. `lib/aura-image.ts` pulls the image upstream published for that tag, pinned by digest in `servers.ts`, and copies out `/app/aura` with its libraries using `docker create` and `docker cp`, so nothing from it starts on the host. The binary needs a newer glibc than the sandbox's bookworm, so inside the sandbox it runs through the image's own loader. `out/aura-image.json` records the tag, image and the binary's checksum.

It isn't a build made here, and `result.md` says that too. The patches change only the README and the examples, so no code differs from the base. This replaces D39, which ran the v0.2.18 release and said no release matched the base: that test filtered out the nightly tags.

## Names the lab reads

These go in `.env`. Each is empty until you need it, and a run with `--no-keys` reads none of them.

- `OPENAI_API_KEY`: the investigation, on the examples' own model.
- `ANTHROPIC_API_KEY`: the investigation when there's no OpenAI key, with the llm block swapped in a copy.
- `SENTRY_ACCESS_TOKEN`: Sentry's row and its investigation.
- `SIGNOZ_URL` and `SIGNOZ_API_KEY`: a running SigNoz for the investigation. Without them the server lists its tools on placeholders.
- `DT_ENVIRONMENT_CONFIGS`: a real Dynatrace Managed cluster, as the JSON list the example shows. Without it the server lists its tools on placeholders. It holds a token, and `lib/scrub.ts` removes that token from the raw outputs.
- `PAGERDUTY_API_TOKEN`: PagerDuty, which every example keeps. Nothing in the lab needs it, and the examples start with it empty.

The lab makes `BRIDGE_ADDR` and `BRIDGE_TOKEN` for each run. They never go in `.env`.

## Rerunning

Once `result.md` is `measured`, a run missing any of those keys or backends starts nothing, exits 3 and changes nothing. A run with all of them that comes back weaker leaves `out/` and `result.md` as they are, and exits 1. In any state, a run with only placeholders for a server keeps that server's real records in `out/`.

## Dry runs

- `npm run lab -- 04 --dry-run` needs no Docker. It runs the harness on this host against `fake/fake-mcp-server.ts` and `fake/fake-aura.ts` and writes only under `lab/.work/04-mcp/dry-run/`.
- `npm run lab -- 04 --dry-run --sandbox` runs the real MCP client, the real SigNoz and Dynatrace Managed servers and the real AURA binary in the sandbox, against `fake/fake-provider.ts` instead of a model. It also writes only under `lab/.work/04-mcp/dry-run/`, and `fake-provider-saw.json` there shows exactly which tools AURA offered the model. The stand-in model asks for the calls in `DRY_RUN_CALLS`, and `no-credentials-calls-*.json` records what every tool the server lists did with no good credentials behind it.
- Adding `--junk-sentry-token` also sends hosted Sentry a token that can't be good. That's where `lib/fixtures/sentry-junk-token.sse` comes from.
