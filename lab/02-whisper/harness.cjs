// Runs inside the sandbox on Node 18, against the fork's real code at --repo. It sends each
// recording through AnythingLLM's own OpenAiWhisper, once per model, the way an upload does,
// and saves what came back with how long it took. A call that fails is data, so it's recorded
// and the run goes on. The key is read from the environment, and is never printed or saved.
const fs = require("node:fs");
const path = require("node:path");
const { startFakeOpenAi } = require("./fake-openai.cjs");

const KEY_NAME = "OPENAI_API_KEY";
const WATCHDOG_MS = 10 * 60 * 1000;
const KEY_SHAPED = /\bsk-[A-Za-z0-9_*-]{8,}/g;

function parseArgs(argv) {
  const args = { fake: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--fake") args.fake = true;
    else if (argv[i] === "--repo") args.repo = argv[(i += 1)];
    else if (argv[i] === "--input") args.input = argv[(i += 1)];
    else if (argv[i] === "--out") args.out = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.repo || !args.input || !args.out) throw new Error("Needs --repo, --input and --out.");
  return args;
}

async function setUpProvider(args, input) {
  if (!args.fake) {
    if (!process.env[KEY_NAME]) throw new Error(`${KEY_NAME} is missing, so nothing was sent.`);
    delete process.env.OPENAI_BASE_URL;
    return { key: process.env[KEY_NAME], close: () => undefined };
  }
  const fake = await startFakeOpenAi(input.fakeTranscripts);
  process.env.OPENAI_BASE_URL = fake.baseURL;
  return { key: "fake-key", close: fake.close };
}

/** Records the request and the API's answer as they pass, since processFile only returns the text. */
function tap(whisper) {
  const seen = { request: null, response: null, apiError: null };
  const transcriptions = whisper.openai.audio.transcriptions;
  const create = transcriptions.create.bind(transcriptions);
  transcriptions.create = (params, ...rest) => {
    seen.request = { fields: Object.keys(params).sort(), model: params.model };
    return create(params, ...rest).then(
      (response) => {
        seen.response = { fields: Object.keys(response || {}).sort(), languages: response?.languages ?? null, usage: response?.usage ?? null };
        return response;
      },
      (error) => {
        seen.apiError = { status: error.status ?? null, code: error.code ?? null, param: error.param ?? null, message: error.message };
        throw error;
      }
    );
  };
  return seen;
}

async function transcribe(OpenAiWhisper, key, model, file) {
  const whisper = new OpenAiWhisper({ options: { openAiKey: key, WhisperOpenAiModel: model } });
  const seen = tap(whisper);
  const started = process.hrtime.bigint();
  const { content, error } = await whisper.processFile(file);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { model, ms, content, error, ...seen };
}

/** Each recording goes through both models, and the order flips each time so neither always goes first. */
async function runAll(OpenAiWhisper, key, input) {
  const runs = [];
  for (const [index, recording] of input.recordings.entries()) {
    const models = index % 2 === 0 ? input.models : [...input.models].reverse();
    for (const model of models) {
      runs.push({ recording: recording.id, ...(await transcribe(OpenAiWhisper, key, model, recording.path)) });
    }
  }
  return runs;
}

async function checkUnknownModel(OpenAiWhisper, key, input) {
  const run = await transcribe(OpenAiWhisper, key, input.unknownModel, input.recordings[0].path);
  return {
    model: input.unknownModel,
    content: run.content,
    error: run.error,
    apiStatus: run.apiError?.status ?? null,
    apiCode: run.apiError?.code ?? null,
    apiMessage: run.apiError?.message ?? null,
  };
}

function sdkVersion(repo) {
  const file = path.join(repo, "collector", "node_modules", "openai", "package.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).version : null;
}

function clean(text, key) {
  return text.split(key).join("[scrubbed]").replace(KEY_SHAPED, "[scrubbed]");
}

async function main() {
  setTimeout(() => {
    console.error(`The run was still going after ${WATCHDOG_MS} ms, so it was stopped.`);
    process.exit(1);
  }, WATCHDOG_MS).unref();
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const { OpenAiWhisper } = require(path.join(args.repo, "collector", "utils", "WhisperProviders", "OpenAiWhisper.js"));
  const provider = await setUpProvider(args, input);
  const startedAt = new Date().toISOString();
  const runs = await runAll(OpenAiWhisper, provider.key, input);
  const unknownModel = await checkUnknownModel(OpenAiWhisper, provider.key, input);
  await provider.close();
  const raw = { schema: 1, fake: args.fake, startedAt, finishedAt: new Date().toISOString(), nodeVersion: process.version, sdkVersion: sdkVersion(args.repo), runs, unknownModel };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, clean(JSON.stringify(raw, null, 2), provider.key));
}

main().catch((error) => {
  console.error(clean(error.message, process.env[KEY_NAME] || "[no key]"));
  process.exit(1);
});
