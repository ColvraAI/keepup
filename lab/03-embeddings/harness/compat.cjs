// Runs INSIDE the sandbox on Node 18. It answers what "nothing changes by default" needs:
//   parity:    all-MiniLM-L6-v2 through the old package and through NativeEmbedder give the same vectors,
//              on chunks as long as the product sends, and (reported only) on whole passages
//   old-first / new-first: both onnxruntime-node versions work in one process, in either load order,
//              with the real NativeEmbeddingReranker on the old package and NativeEmbedder on the new one
//   reuse:     files the old package downloaded are enough for the new one, offline
//   batching:  separates batching from the runtime: the same chunks one at a time and in the product's
//              batches, on each package, and the query texts one at a time. Reported, never a gate
//   nomic, e5: the other two models the library move takes with it, loaded for real on both packages, with the
//              prefixes and the batch size the product uses for them
//
//   node compat.cjs --check <parity|old-first|new-first|reuse|batching|nomic|e5> --input <dir> --out <file> --storage <dir>
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const SERVER = "/repo/server";
const MINILM = "Xenova/all-MiniLM-L6-v2";
const NOMIC = "Xenova/nomic-embed-text-v1";
const E5 = "MintplexLabs/multilingual-e5-small";
const PARITY_PASSAGES = 200;
const EXISTING_MODEL_PASSAGES = 50;
const EXISTING_MODEL_QUERIES = 25;
const OLD_BATCH = 25;
const REUSE_TEXTS = 2;
const MODEL_HOSTS = ["huggingface.co", "cdn.anythingllm.com"];
const serverRequire = createRequire(path.join(SERVER, "package.json"));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  for (const needed of ["check", "input", "out", "storage"])
    if (!args[needed]) throw new Error(`--${needed} is required`);
  return args;
}

const quiet = (instance) => {
  instance.log = () => {};
  return instance;
};

function nativeEmbedder(model = MINILM) {
  process.env.EMBEDDING_MODEL_PREF = model;
  const { NativeEmbedder } = require(path.join(SERVER, "utils/EmbeddingEngines/native"));
  const embedder = quiet(new NativeEmbedder());
  if (embedder.model !== model) throw new Error(`the embedder chose ${embedder.model}, not ${model}`);
  return embedder;
}

function reranker() {
  const { NativeEmbeddingReranker } = require(path.join(SERVER, "utils/EmbeddingRerankers/native"));
  return quiet(new NativeEmbeddingReranker());
}

async function oldPackageVectors(texts, cacheDir, batch = OLD_BATCH, model = MINILM) {
  const { pipeline } = await import(serverRequire.resolve("@xenova/transformers"));
  const extractor = await pipeline("feature-extraction", model, { cache_dir: cacheDir });
  const vectors = [];
  for (let i = 0; i < texts.length; i += batch) {
    const output = await extractor(texts.slice(i, i + batch), { pooling: "mean", normalize: true });
    vectors.push(...output.tolist());
  }
  return vectors;
}

async function newPackageAlone(embedder, texts) {
  const vectors = [];
  for (const text of texts) vectors.push(...(await embedder.embedChunks([text])));
  return vectors;
}

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function compare(oldVectors, newVectors) {
  if (oldVectors.length !== newVectors.length) throw new Error("vector counts differ");
  const cosines = oldVectors.map((vector, i) => dot(vector, newVectors[i]) / Math.sqrt(dot(vector, vector) * dot(newVectors[i], newVectors[i])));
  return {
    n: cosines.length,
    oldDim: oldVectors[0].length,
    newDim: newVectors[0].length,
    minCosine: Math.min(...cosines),
    meanCosine: cosines.reduce((sum, c) => sum + c, 0) / cosines.length,
  };
}

function readLines(input, name) {
  return fs.readFileSync(path.join(input, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function readTexts(input, limit) {
  return readLines(input, "passages.jsonl").slice(0, limit).map((row) => row.text);
}

async function parity(args) {
  const whole = readTexts(args.input, PARITY_PASSAGES);
  const embedder = nativeEmbedder();
  const chunks = whole.map((text) => text.slice(0, embedder.embeddingMaxChunkLength));
  const chunkResult = compare(await oldPackageVectors(chunks, embedder.cacheDir), await embedder.embedChunks(chunks));
  const wholeResult = compare(await oldPackageVectors(whole, embedder.cacheDir), await embedder.embedChunks(whole));
  return { ...chunkResult, chunkChars: embedder.embeddingMaxChunkLength, wholePassageMinCosine: wholeResult.minCosine, wholePassageMeanCosine: wholeResult.meanCosine };
}

async function tokenIds(specifier, texts, cacheDir, model) {
  const { AutoTokenizer } = await import(serverRequire.resolve(specifier));
  const tokenizer = await AutoTokenizer.from_pretrained(model, { cache_dir: cacheDir });
  const rows = [];
  for (const text of texts) rows.push(tokenizer(text, { truncation: true }).input_ids.tolist().flat().join(","));
  return rows;
}

/** The same model file and the same token ids leave only what runs them to explain a difference. */
async function tokenDifferences(texts, cacheDir, model = MINILM) {
  const oldIds = await tokenIds("@xenova/transformers", texts, cacheDir, model);
  const newIds = await tokenIds("@huggingface/transformers", texts, cacheDir, model);
  return { texts: texts.length, differing: oldIds.filter((ids, i) => ids !== newIds[i]).length };
}

/** Every comparison on the same chunks, so a move can be put down to batching, to the runtime, or to both. */
async function batching(args) {
  const embedder = nativeEmbedder();
  const chunks = readTexts(args.input, PARITY_PASSAGES).map((text) => text.slice(0, embedder.embeddingMaxChunkLength));
  const oldAlone = await oldPackageVectors(chunks, embedder.cacheDir, 1);
  const oldBatched = await oldPackageVectors(chunks, embedder.cacheDir);
  const newAlone = await newPackageAlone(embedder, chunks);
  const newBatched = await embedder.embedChunks(chunks);
  const queries = readLines(args.input, "queries.jsonl").map((row) => row.text);
  return {
    batch: embedder.maxConcurrentChunks,
    tokens: await tokenDifferences([...chunks, ...queries], embedder.cacheDir),
    runtimeAlone: compare(oldAlone, newAlone),
    runtimeBatched: compare(oldBatched, newBatched),
    batchingOld: compare(oldAlone, oldBatched),
    batchingNew: compare(newAlone, newBatched),
    repeatNew: compare(newBatched, await embedder.embedChunks(chunks)),
    queriesRuntimeAlone: compare(await oldPackageVectors(queries, embedder.cacheDir, 1), await newPackageAlone(embedder, queries)),
  };
}

/** A real load of one more existing model on both packages, sending what the product sends: its prefixes, chunk limit and batch size. */
async function existingModel(args, model) {
  const embedder = nativeEmbedder(model);
  const chunks = readTexts(args.input, EXISTING_MODEL_PASSAGES).map((text) => `${embedder.embeddingPrefix}${text.slice(0, embedder.embeddingMaxChunkLength)}`);
  const queries = readLines(args.input, "queries.jsonl").slice(0, EXISTING_MODEL_QUERIES).map((row) => row.text);
  const prefixedQueries = queries.map((query) => `${embedder.queryPrefix}${query}`);
  const newQueries = [];
  for (const query of queries) newQueries.push(await embedder.embedTextInput(query));
  return {
    model,
    chunkChars: embedder.embeddingMaxChunkLength,
    tokens: await tokenDifferences([...chunks, ...prefixedQueries], embedder.cacheDir, model),
    chunks: compare(await oldPackageVectors(chunks, embedder.cacheDir, embedder.maxConcurrentChunks, model), await embedder.embedChunks(chunks)),
    queries: compare(await oldPackageVectors(prefixedQueries, embedder.cacheDir, 1, model), newQueries),
  };
}

async function useReranker(texts) {
  const docs = texts.map((text) => ({ text }));
  const ranked = await reranker().rerank(texts[0], docs, { topK: 2 });
  if (ranked.length !== 2) throw new Error(`reranker returned ${ranked.length} documents`);
  return ranked.map((doc) => doc.rerank_score);
}

async function bothPackages(args, oldFirst) {
  const texts = readTexts(args.input, 5);
  const embedder = nativeEmbedder();
  const scoresBefore = oldFirst ? await useReranker(texts) : null;
  const first = await embedder.embedChunks(texts);
  const scoresAfter = oldFirst ? null : await useReranker(texts);
  const second = await embedder.embedChunks(texts);
  const scores = scoresBefore ?? scoresAfter;
  return { order: oldFirst ? "old-first" : "new-first", dim: first[0].length, rerankScores: scores, sameVectorsAfter: compare(first, second).minCosine };
}

/** Takes the model hosts away from this container, which goes when the run ends, and checks that they have gone. */
async function blockModelHosts() {
  fs.appendFileSync("/etc/hosts", `127.0.0.1 ${MODEL_HOSTS.join(" ")}\n`);
  return fetch(`https://${MODEL_HOSTS[0]}/`).then(() => false, () => true);
}

/** Only the old package downloads. The new one then has to load with the model hosts unreachable. */
async function reuse(args) {
  const texts = readTexts(args.input, REUSE_TEXTS);
  const embedder = nativeEmbedder();
  fs.rmSync(path.join(embedder.cacheDir, "Xenova"), { recursive: true, force: true });
  const oldVectors = await oldPackageVectors(texts, embedder.cacheDir);
  const childOut = `${args.out}.new.json`;
  const child = spawnSync(process.execPath, [__filename, "--check", "reuse-new", "--input", args.input, "--out", childOut, "--storage", args.storage], { stdio: "inherit" });
  if (child.status !== 0) throw new Error("the new package could not load the old package's download with the model hosts unreachable");
  const { offline, vectors } = JSON.parse(fs.readFileSync(childOut, "utf8"));
  fs.rmSync(childOut);
  return { ...compare(oldVectors, vectors), offline };
}

/** In a process of its own, because this one's open connections to the hosts would outlive the block. */
async function reuseNew(args) {
  const offline = await blockModelHosts();
  return { offline, vectors: await nativeEmbedder().embedChunks(readTexts(args.input, REUSE_TEXTS)) };
}

async function main(argv) {
  const args = parseArgs(argv);
  process.env.STORAGE_DIR = args.storage;
  fs.mkdirSync(args.storage, { recursive: true });
  const checks = {
    parity: () => parity(args),
    "old-first": () => bothPackages(args, true),
    "new-first": () => bothPackages(args, false),
    reuse: () => reuse(args),
    "reuse-new": () => reuseNew(args),
    batching: () => batching(args),
    nomic: () => existingModel(args, NOMIC),
    e5: () => existingModel(args, E5),
  };
  if (!checks[args.check]) throw new Error(`unknown check ${args.check}`);
  const result = await checks[args.check]();
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({ check: args.check, node: process.version, ...result }, null, 2));
  if (args.check !== "reuse-new") console.log(`${args.check}: ${JSON.stringify(result)}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`compat failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
