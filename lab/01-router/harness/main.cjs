// Runs inside the sandbox on Node 18, against the fork's code at --repo. Both paths go
// through the fork's own classifyMessage(), switched by ROUTER_CLASSIFIER as a person
// would switch it. Keys are read from the environment and never printed or saved.
//   node main.cjs --config <config.json> --repo /repo --out <raw.jsonl> [--real]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startRecorder, forwardTo } = require("./recorder.cjs");
const { fakeProvider } = require("./fake-provider.cjs");
const { measureAll, firstAvailableModel, longFormCheck } = require("./measure.cjs");

const UPSTREAMS = { openai: "https://api.openai.com", anthropic: "https://api.anthropic.com", typesafe: "https://api.typesafe.ai" };
const FAKE_KEY = "dry-run-not-a-key";
const WATCHDOG_MS = 20 * 60 * 1000;
const CLASSIFIER_LOG = "[RouterClassifier]";

function parseArgs(argv) {
  const args = { real: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--real") args.real = true;
    else if (argv[i] === "--config") args.config = argv[(i += 1)];
    else if (argv[i] === "--repo") args.repo = argv[(i += 1)];
    else if (argv[i] === "--out") args.out = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.config || !args.repo || !args.out) throw new Error("Needs --config, --repo and --out.");
  return args;
}

function setProviderEnv(recorderUrl, real) {
  process.env.OPENAI_BASE_URL = `${recorderUrl}/v1`;
  process.env.ANTHROPIC_BASE_URL = recorderUrl;
  process.env.OPEN_AI_KEY = real ? process.env.OPENAI_API_KEY ?? "" : FAKE_KEY;
  if (!real) process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  if (!real) process.env.TYPESAFE_API_KEY = FAKE_KEY;
  process.env.DISABLE_TELEMETRY = "true";
  process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "router-lab-"));
}

/** classifyWithJev calls TypeSafe with fetch, so that's where it joins the recording. */
function routeTypeSafeThroughRecorder(recorderUrl) {
  const realFetch = global.fetch;
  global.fetch = (url, options) => realFetch(String(url).replace(UPSTREAMS.typesafe, recorderUrl), options);
  return realFetch;
}

/** The classifier's own log lines are evidence, the agent framework's are noise. */
function captureLogs() {
  const lines = [];
  const keep = (...args) => {
    const line = args.join(" ");
    if (line.includes(CLASSIFIER_LOG)) lines.push(line);
  };
  console.log = keep;
  console.error = keep;
  console.info = () => {};
  console.warn = () => {};
  return () => lines.splice(0, lines.length);
}

function agentRouter(config, model) {
  return { name: "lab", fallback_provider: config.agent.provider, fallback_model: model };
}

function modelLookup(recorderUrl, config, real) {
  const anthropic = config.agent.provider === "anthropic";
  const key = real ? (anthropic ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) : FAKE_KEY;
  const headers = anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
  return async (model) => (await fetch(`${recorderUrl}/v1/models/${encodeURIComponent(model)}`, { headers })).status;
}

function loadRules(rules) {
  return rules.map((rule, priority) => ({ ...rule, type: "llm", enabled: true, priority, route_provider: "lab", route_model: "lab" }));
}

async function run(args) {
  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const realFetch = global.fetch;
  const respond = args.real ? forwardTo(UPSTREAMS, realFetch) : fakeProvider({ retired: config.fakeRetired ?? [] });
  const recorder = await startRecorder(respond);
  setProviderEnv(recorder.url, args.real);
  routeTypeSafeThroughRecorder(recorder.url);
  const stdout = process.stdout;
  const write = (record) => fs.appendFileSync(args.out, `${JSON.stringify(record)}\n`);
  fs.writeFileSync(args.out, "");

  const { model, tried } = await firstAvailableModel(config.agent.candidates, modelLookup(recorder.url, config, args.real));
  write({ type: "meta", real: args.real, variant: config.variant, agentProvider: config.agent.provider, agentModel: model, tried, node: process.version, startedAt: new Date().toISOString() });
  recorder.calls.length = 0;
  if (!model) throw new Error(`no agent model is available: ${JSON.stringify(tried)}`);

  const drainLogs = captureLogs();
  const classifier = require(path.join(args.repo, "server/utils/agents/aibitat/plugins/router-classifier.js"));
  const rules = loadRules(config.rules);
  const router = agentRouter(config, model);
  const classifyWith = (setting, ruleList = rules) => (text) => {
    process.env.ROUTER_CLASSIFIER = setting;
    return classifier.classifyMessage(ruleList, text, router);
  };
  await measureAll({
    messages: config.messages,
    classifiers: { before: classifyWith("agent"), after: classifyWith(config.afterSetting) },
    calls: recorder.calls,
    drainLogs,
    onRecord: write,
  });
  if (config.longRules.length) write(await longFormCheck({ messages: config.messages, classify: classifyWith(config.afterSetting, loadRules(config.longRules)), calls: recorder.calls, drainLogs }));
  await recorder.close();
  stdout.write(`measured ${config.messages.length} messages on both paths\n`);
}

const watchdog = setTimeout(() => {
  process.stderr.write("harness: gave up after the watchdog limit\n");
  process.exit(1);
}, WATCHDOG_MS);

run(parseArgs(process.argv.slice(2))).then(
  () => {
    clearTimeout(watchdog);
    process.exit(0);
  },
  (error) => {
    process.stderr.write(`harness: ${error.message}\n`);
    process.exit(1);
  }
);
