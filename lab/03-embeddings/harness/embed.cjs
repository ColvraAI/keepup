// Runs INSIDE the sandbox, on Node 18, against the fork's real NativeEmbedder.
// One process embeds one model, so its peak memory is its own. Every segment is
// flushed to disk before it counts as done, so a crash resumes where it stopped.
//
//   node embed.cjs --model <id> --input <dir> --out <dir> [--segment 100]
//                  [--budget-min 30] [--embedder /repo/server/utils/EmbeddingEngines/native]
//
// Exit code 75 means the time budget ran out and running it again continues. After its first segment, a
// session won't start one that the last one's duration says won't fit, to stay clear of the sandbox lock's 40 minutes.
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXIT_CONTINUE = 75;
const QUERY_SEGMENT = 10;
// A batch is padded to its longest text, and the product never sends chunks this long: its
// splitter cuts them first. The few passages above this go alone, so one can't take a whole
// batch's memory with it. See testset-notes.md.
const LONG_PASSAGE_CHARS = 4000;

function parseArgs(argv) {
  const args = {
    segment: 100,
    budgetMin: 30,
    embedder: "/repo/server/utils/EmbeddingEngines/native",
    package: "/repo/server/node_modules/@huggingface/transformers/package.json",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase());
    args[name] = argv[i + 1];
  }
  for (const needed of ["model", "input", "out"])
    if (!args[needed]) throw new Error(`--${needed} is required`);
  return { ...args, segment: Number(args.segment), budgetMin: Number(args.budgetMin) };
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Highest memory this process has held, in kB. VmHWM on Linux, getrusage elsewhere. */
function peakRssKb() {
  try {
    const match = fs.readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+) kB/);
    if (match) return Number(match[1]);
  } catch {
    // Not Linux: fall through.
  }
  return process.resourceUsage().maxRSS;
}

function readProgress(file) {
  if (!fs.existsSync(file))
    return { passages: 0, queries: 0, dim: null, segmentMs: [], queryMs: 0, loadMs: [], peakRssKb: 0, sessions: 0 };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeProgress(file, progress) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2));
  fs.renameSync(tmp, file);
}

/** Appends vectors, cutting off anything written after the last recorded checkpoint. */
function appendVectors(file, doneRows, vectors, dim) {
  const bytes = doneRows * dim * 4;
  if (fs.existsSync(file) && fs.statSync(file).size > bytes) fs.truncateSync(file, bytes);
  const out = Buffer.alloc(vectors.length * dim * 4);
  vectors.forEach((vector, row) => {
    if (vector.length !== dim) throw new Error(`vector of ${vector.length} dimensions, expected ${dim}`);
    vector.forEach((value, i) => out.writeFloatLE(value, (row * dim + i) * 4));
  });
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, out);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function loadEmbedder(args) {
  process.env.EMBEDDING_MODEL_PREF = args.model;
  const { NativeEmbedder } = require(args.embedder);
  const embedder = new NativeEmbedder();
  // The embedder silently falls back to its default on an unknown id, which would measure the wrong model.
  if (embedder.model !== args.model) throw new Error(`embedder chose ${embedder.model}, not ${args.model}`);
  embedder.log = () => {};
  return embedder;
}

/** Runs of normal texts, in order, with each long text in a run of its own. */
function splitLongTexts(texts, limit = LONG_PASSAGE_CHARS) {
  const runs = [];
  for (const text of texts) {
    const last = runs[runs.length - 1];
    if (text.length > limit || !last || last[0].length > limit) runs.push([text]);
    else last.push(text);
  }
  return runs;
}

async function embedInRuns(embedder, texts) {
  const vectors = [];
  for (const run of splitLongTexts(texts)) {
    const part = await embedder.embedChunks(run);
    if (part?.length !== run.length) throw new Error(`asked for ${run.length} vectors, got ${part?.length}`);
    vectors.push(...part);
  }
  return vectors;
}

/** Whether one more segment as long as the last still fits in this session's budget. */
function segmentFits(state) {
  const last = state.progress.segmentMs[state.progress.segmentMs.length - 1];
  return Date.now() + (last ? last.ms : 0) <= state.deadline;
}

async function embedPassages(embedder, passages, args, state) {
  // The first segment of a session always runs, or one slow segment would stop every session after it.
  for (let done = 0; state.progress.passages < passages.length; done += 1) {
    if (done > 0 && !segmentFits(state)) return false;
    const from = state.progress.passages;
    const texts = passages.slice(from, from + args.segment).map((p) => `${embedder.embeddingPrefix}${p.text}`);
    const start = process.hrtime.bigint();
    const vectors = await embedInRuns(embedder, texts);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const dim = state.progress.dim ?? vectors[0].length;
    appendVectors(state.passageFile, from, vectors, dim);
    state.progress = {
      ...state.progress,
      dim,
      passages: from + texts.length,
      segmentMs: [...state.progress.segmentMs, { passages: texts.length, ms }],
      peakRssKb: Math.max(state.progress.peakRssKb, peakRssKb()),
    };
    writeProgress(state.progressFile, state.progress);
    console.log(`${args.model}: ${state.progress.passages}/${passages.length} passages`);
  }
  return true;
}

async function embedQueries(embedder, queries, args, state) {
  while (state.progress.queries < queries.length) {
    if (Date.now() > state.deadline) return false;
    const from = state.progress.queries;
    const start = process.hrtime.bigint();
    const vectors = [];
    for (const query of queries.slice(from, from + QUERY_SEGMENT)) vectors.push(await embedder.embedTextInput(query.text));
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    appendVectors(state.queryFile, from, vectors, state.progress.dim);
    state.progress = {
      ...state.progress,
      queries: from + vectors.length,
      queryMs: state.progress.queryMs + ms,
      peakRssKb: Math.max(state.progress.peakRssKb, peakRssKb()),
    };
    writeProgress(state.progressFile, state.progress);
  }
  return true;
}

function machine(args) {
  const pkg = fs.existsSync(args.package) ? JSON.parse(fs.readFileSync(args.package, "utf8")).version : null;
  return { node: process.version, arch: process.arch, cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1048576), transformers: pkg };
}

async function main(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.out, { recursive: true });
  const progressFile = path.join(args.out, "progress.json");
  const state = {
    progressFile,
    passageFile: path.join(args.out, "passages.f32"),
    queryFile: path.join(args.out, "queries.f32"),
    deadline: Date.now() + args.budgetMin * 60_000,
    progress: readProgress(progressFile),
  };
  const passages = readLines(path.join(args.input, "passages.jsonl"));
  const queries = readLines(path.join(args.input, "queries.jsonl"));
  const embedder = loadEmbedder(args);
  const start = process.hrtime.bigint();
  await embedder.embedderClient();
  state.progress = {
    ...state.progress,
    model: args.model,
    sessions: state.progress.sessions + 1,
    machine: machine(args),
    loadMs: [...state.progress.loadMs, Number(process.hrtime.bigint() - start) / 1e6],
    prefixes: { passage: embedder.embeddingPrefix, query: embedder.queryPrefix },
    batch: embedder.maxConcurrentChunks,
    chunkChars: embedder.embeddingMaxChunkLength,
  };
  writeProgress(progressFile, state.progress);
  const finished = (await embedPassages(embedder, passages, args, state)) && (await embedQueries(embedder, queries, args, state));
  if (!finished) {
    console.log(`${args.model}: time budget used, run again to continue`);
    process.exitCode = EXIT_CONTINUE;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`embed failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { splitLongTexts };
