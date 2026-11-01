// Runs INSIDE the sandbox on Node 18, through the pull request's real code. What happens when Hugging Face can't be
// reached, or fails partway, with the product's mirror still up:
//   crash:         picks EmbeddingGemma 2 through the real updateENV, with a document in the real database
//   transient:     EmbeddingGemma 2 fails to load with Hugging Face down, then loads again once it's back
//   after-minilm:  MiniLM falls back to the mirror, then EmbeddingGemma 2 loads with Hugging Face back
//   external-data: only the .onnx_data download fails: does the load reject, or never settle?
//   external-data-server: the same failure through the real updateENV: does the server stay up?
//
//   [TRANSFORMERS_DIR=<an unpacked other version>] node hf-unreachable.cjs --scenario <name> --out <file>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SERVER = "/repo/server";
const MINILM = "Xenova/all-MiniLM-L6-v2";
const GEMMA = "onnx-community/embeddinggemma-2-ONNX";
const HOSTS = "/etc/hosts";
const BLOCK_LINE = "127.0.0.1 huggingface.co\n";
const CRASH_WAIT_MS = 30_000;
const EXTERNAL_DATA_WAIT_MS = 90_000;
const LOAD_TIMEOUT_MS = 120_000;
const TAIL_CHARS = 1500;
const OTHER_VERSION = process.env.TRANSFORMERS_DIR ?? null;

/** Loads this process's embedder from another version of the package, leaving the node_modules volume alone. */
function nativeEmbedderClass() {
  const { NativeEmbedder } = require(path.join(SERVER, "utils/EmbeddingEngines/native"));
  if (OTHER_VERSION) NativeEmbedder._loadTransformers = () => import(path.join(OTHER_VERSION, "dist/transformers.node.mjs"));
  return NativeEmbedder;
}

function packageVersion() {
  const dir = OTHER_VERSION ?? `${SERVER}/node_modules/@huggingface/transformers`;
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
}

const hostsBefore = fs.readFileSync(HOSTS, "utf8");
// Written in place, because /etc/hosts is a bind mount in the container.
const blockHuggingFace = () => fs.writeFileSync(HOSTS, hostsBefore + BLOCK_LINE);
const unblockHuggingFace = () => fs.writeFileSync(HOSTS, hostsBefore);

function freshStorage() {
  process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-unreachable-"));
}

function recordRequests() {
  const seen = [];
  const real = global.fetch;
  global.fetch = async (url, options) => {
    const where = String(url?.url ?? url);
    try {
      const response = await real(url, options);
      seen.push(`${where} -> ${response.status}`);
      return response;
    } catch (error) {
      seen.push(`${where} -> ${error.message}`);
      throw error;
    }
  };
  return seen;
}

function embedderFor(model) {
  process.env.EMBEDDING_MODEL_PREF = model;
  const NativeEmbedder = nativeEmbedderClass();
  const embedder = new NativeEmbedder();
  embedder.log = () => {};
  return embedder;
}

/** Settles as loaded, rejected or never: a load that never settles is the thing being looked for. */
async function attemptLoad(model) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ outcome: "never settled", waitedMs: LOAD_TIMEOUT_MS }), LOAD_TIMEOUT_MS).unref());
  const load = embedderFor(model).embedderClient().then(
    () => ({ outcome: "loaded" }),
    (error) => ({ outcome: "rejected", message: error.message })
  );
  return { model, ...(await Promise.race([load, timeout])) };
}

async function transient() {
  freshStorage();
  const requests = recordRequests();
  blockHuggingFace();
  const whileDown = await attemptLoad(GEMMA);
  unblockHuggingFace();
  const afterBack = await attemptLoad(GEMMA);
  return { whileDown, afterBack, requests };
}

async function afterMiniLM() {
  freshStorage();
  const requests = recordRequests();
  blockHuggingFace();
  const minilm = await attemptLoad(MINILM);
  unblockHuggingFace();
  const gemma = await attemptLoad(GEMMA);
  return { minilm, gemma, requests };
}

function failExternalData() {
  const real = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url?.url ?? url).includes(".onnx_data")) throw new Error("simulated failure of the external data download");
    return real(url, options);
  };
}

async function externalData() {
  freshStorage();
  const requests = recordRequests();
  failExternalData();
  return { load: await attemptLoad(GEMMA), requests };
}

async function crashChild(waitMs = CRASH_WAIT_MS) {
  freshStorage();
  nativeEmbedderClass();
  process.env.EMBEDDING_ENGINE = "native";
  process.env.EMBEDDING_MODEL_PREF = MINILM;
  process.env.VECTOR_DB = "lancedb";
  const prisma = require(path.join(SERVER, "utils/prisma"));
  const workspace = await prisma.workspaces.create({ data: { name: "hf-unreachable", slug: `hf-unreachable-${Date.now()}` } });
  await prisma.workspace_documents.create({
    data: { docId: `doc-${Date.now()}`, filename: "probe.json", docpath: "custom-documents/probe.json", workspaceId: workspace.id },
  });
  console.log(`DOCUMENTS_BEFORE=${await prisma.workspace_documents.count()}`);
  const { updateENV } = require(path.join(SERVER, "utils/helpers/updateENV"));
  const { error } = await updateENV({ EmbeddingModelPref: GEMMA });
  console.log(`UPDATE_ERROR=${error}`);
  console.log(`DOCUMENTS_AFTER=${await prisma.workspace_documents.count()}`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  console.log("SERVER_STILL_UP=true");
}

async function externalDataServerChild() {
  failExternalData();
  await crashChild(EXTERNAL_DATA_WAIT_MS);
}

function crash() {
  blockHuggingFace();
  const child = spawnSync(process.execPath, [__filename, "--scenario", "crash-child"], { encoding: "utf8", cwd: SERVER });
  unblockHuggingFace();
  return serverOutcome(child);
}

function externalDataServer() {
  return serverOutcome(spawnSync(process.execPath, [__filename, "--scenario", "external-data-server-child"], { encoding: "utf8", cwd: SERVER }));
}

function serverOutcome(child) {
  const read = (name) => child.stdout.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? null;
  return {
    exitCode: child.status,
    signal: child.signal,
    documentsBefore: read("DOCUMENTS_BEFORE"),
    documentsAfter: read("DOCUMENTS_AFTER"),
    updateError: read("UPDATE_ERROR"),
    serverStillUp: read("SERVER_STILL_UP") === "true",
    stdoutTail: child.stdout.slice(-TAIL_CHARS),
    stderrTail: child.stderr.slice(-TAIL_CHARS),
  };
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  const scenarios = { crash, "crash-child": crashChild, transient, "after-minilm": afterMiniLM, "external-data": externalData, "external-data-server": externalDataServer, "external-data-server-child": externalDataServerChild };
  if (!scenarios[args.scenario]) throw new Error(`unknown scenario ${args.scenario}`);
  const result = await scenarios[args.scenario]();
  if (args.scenario.endsWith("-child")) return;
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({ scenario: args.scenario, node: process.version, transformers: packageVersion(), ...result }, null, 2));
  console.log(`${args.scenario}: ${JSON.stringify(result, null, 2)}`);
}

main(process.argv.slice(2)).then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    unblockHuggingFace();
    console.error(`hf-unreachable failed: ${error.stack || error.message}`);
    process.exit(1);
  }
);
