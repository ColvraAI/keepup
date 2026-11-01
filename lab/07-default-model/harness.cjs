// Runs inside the sandbox on Node 18, against the fork's code at --repo. It sends two
// requests through AnythingLLM's own OpenAiLLM, the way a chat does: one naming the model
// that shut down, and one with no model set, so the provider picks its own default. A
// failure is data, so it's recorded and the run goes on. The key is read from the
// environment, and is never printed or saved.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startFakeOpenAi } = require("./fake-openai.cjs");

const KEY_NAME = "OPENAI_API_KEY";
const SYSTEM_PROMPT = "You are a connectivity check.";
const USER_PROMPT = "Reply with the single word: ready.";
const WATCHDOG_MS = 5 * 60 * 1000;
const KEY_SHAPED = /\bsk-[A-Za-z0-9_*-]{8,}/g;

const notUsed = () => {
  throw new Error("this check never embeds");
};
const NO_EMBEDDER = { embedTextInput: notUsed, embedChunks: notUsed };

function parseArgs(argv) {
  const args = { fake: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--fake") args.fake = true;
    else if (argv[i] === "--repo") args.repo = argv[(i += 1)];
    else if (argv[i] === "--out") args.out = argv[(i += 1)];
    else if (argv[i] === "--old-model") args.oldModel = argv[(i += 1)];
    else if (argv[i] === "--new-model") args.newModel = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.repo || !args.out || !args.oldModel || !args.newModel) {
    throw new Error("Needs --repo, --out, --old-model and --new-model.");
  }
  return args;
}

/** AnythingLLM's context-window map would be pulled from GitHub; a dry run stays off the network. */
function seedEmptyContextMap(storage) {
  const dir = path.join(storage, "models", "context-windows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "context-windows.json"), "{}");
  fs.writeFileSync(path.join(dir, ".cached_at"), String(Date.now()));
}

async function setUpProvider(args, storage) {
  process.env.STORAGE_DIR = storage;
  delete process.env.OPEN_MODEL_PREF; // the default is what's under test
  if (!args.fake) {
    if (!process.env[KEY_NAME]) throw new Error(`${KEY_NAME} is missing, so nothing was sent.`);
    delete process.env.OPENAI_BASE_URL;
    process.env.OPEN_AI_KEY = process.env[KEY_NAME];
    return { secret: process.env[KEY_NAME], close: () => undefined };
  }
  const fake = await startFakeOpenAi(args.newModel);
  seedEmptyContextMap(storage);
  process.env.OPENAI_BASE_URL = fake.baseURL;
  process.env.OPEN_AI_KEY = "fake-key";
  return { secret: "fake-key", close: fake.close };
}

/** Records the request, the reply and the API's error as they pass, since the provider keeps only the error's message. */
function tapResponses(llm, seen) {
  const responses = llm.openai.responses;
  const create = responses.create.bind(responses);
  responses.create = (body, options) => {
    seen.body = body;
    return create(body, options).then(
      (reply) => {
        seen.reply = reply;
        return reply;
      },
      (error) => {
        seen.status = error.status ?? null;
        seen.code = error.code ?? null;
        throw error;
      }
    );
  };
}

/** Null when the API didn't report both counts: a number in the table has to be one the API gave. */
function usageFrom(reply) {
  const { input_tokens: input, output_tokens: output } = reply?.usage ?? {};
  return typeof input === "number" && typeof output === "number" ? { input, output } : null;
}

function answeredRow(role, askedFor, seen, reply, elapsedMs) {
  const text = reply?.textResponse ?? null;
  return {
    role,
    askedFor,
    sentModel: seen.body?.model ?? null,
    answered: !!text && text.trim().length > 0,
    echoedModel: seen.reply?.model ?? null,
    latencyMs: Math.round(elapsedMs),
    text,
    usage: usageFrom(seen.reply),
    error: text ? null : "The provider returned no text.",
    errorStatus: null,
    errorCode: null,
    response: seen.reply ?? null,
  };
}

function failedRow(role, askedFor, seen, error) {
  return {
    role,
    askedFor,
    sentModel: seen.body?.model ?? null,
    answered: false,
    echoedModel: null,
    latencyMs: null,
    text: null,
    usage: null,
    error: error.message,
    errorStatus: seen.status ?? null,
    errorCode: seen.code ?? null,
    response: null,
  };
}

async function askOne(OpenAiLLM, role, askedFor) {
  const seen = { body: null, reply: null, status: null, code: null };
  try {
    const llm = new OpenAiLLM(NO_EMBEDDER, askedFor);
    tapResponses(llm, seen);
    const messages = llm.constructPrompt({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: USER_PROMPT,
    });
    const started = performance.now();
    // workspace?.openAiTemp ?? LLMConnector.defaultTemp is what a real chat passes.
    const reply = await llm.getChatCompletion(messages, { temperature: llm.defaultTemp });
    return answeredRow(role, askedFor, seen, reply, performance.now() - started);
  } catch (error) {
    return failedRow(role, askedFor, seen, error);
  }
}

function writeScrubbed(file, value, secret) {
  const text = JSON.stringify(value, null, 2).split(secret).join("[redacted]").replace(KEY_SHAPED, "[redacted]");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "keepup-07-storage-"));
  const provider = await setUpProvider(args, storage);
  const { OpenAiLLM } = require(path.join(path.resolve(args.repo), "server/utils/AiProviders/openAi"));
  const startedAt = new Date().toISOString();
  const runs = [await askOne(OpenAiLLM, "old-default", args.oldModel), await askOne(OpenAiLLM, "new-default", null)];
  const finishedAt = new Date().toISOString();
  writeScrubbed(args.out, { fake: args.fake, startedAt, finishedAt, systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, runs }, provider.secret);
  provider.close();
  fs.rmSync(storage, { recursive: true, force: true });
}

setTimeout(() => {
  console.error(`harness: gave up after ${WATCHDOG_MS} ms`);
  process.exit(4);
}, WATCHDOG_MS).unref();

main().then(
  () => process.exit(0), // AnythingLLM's map pull may still be open, and this run is done
  (error) => {
    console.error(`harness: ${error.message}`);
    process.exit(1);
  }
);
