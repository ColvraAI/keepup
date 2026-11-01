// Runs inside the sandbox on Node 18. A stand-in for listening: it transcribes one test-set
// file on the CPU with the local Whisper library AnythingLLM ships, with no API call and no key.
// Each segment is cut at a silence and transcribed on its own, because the library's own chunk
// merging dropped whole stretches of speech when this was first tried. whisper-small, the app's
// default, held 3 GB and didn't finish one file in 15 minutes here, so this uses a smaller model.
// Nothing here feeds a measured number; local-check.ts turns the output into testset-check.json.
const fs = require("node:fs");
const path = require("node:path");

const MODEL = "Xenova/whisper-base.en";
const CACHE_DIR = "/hf-cache/local-check";
const SAMPLE_RATE = 16000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--repo") args.repo = argv[i + 1];
    else if (argv[i] === "--dir") args.dir = argv[i + 1];
    else if (argv[i] === "--id") args.id = argv[i + 1];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.repo || !args.dir || !args.id) throw new Error("Needs --repo, --dir and --id.");
  return args;
}

function readPcm(file) {
  const bytes = fs.readFileSync(file);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entry = require.resolve("@xenova/transformers", { paths: [path.join(args.repo, "collector")] });
  const { pipeline } = await import(entry);
  const transcriber = await pipeline("automatic-speech-recognition", MODEL, { cache_dir: CACHE_DIR });
  const audio = readPcm(path.join(args.dir, `${args.id}.f32`));
  const cuts = JSON.parse(fs.readFileSync(path.join(args.dir, `${args.id}.cuts.json`), "utf8"));
  const segments = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const slice = audio.subarray(Math.round(cuts[i] * SAMPLE_RATE), Math.round(cuts[i + 1] * SAMPLE_RATE));
    const { text } = await transcriber(slice);
    segments.push({ from: cuts[i], to: cuts[i + 1], text: text.trim() });
  }
  fs.writeFileSync(path.join(args.dir, `${args.id}.json`), JSON.stringify({ id: args.id, model: MODEL, segments }, null, 2));
  console.log(`${args.id}: ${segments.length} segments`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
