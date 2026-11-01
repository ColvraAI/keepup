// Runs INSIDE the sandbox. Peak memory and time of one EmbeddingGemma 2 batch, in a fresh process, by batch
// size and chunk length. It's the evidence for the entry's embeddingMaxChunkLength; result.md doesn't use it.
//   STORAGE_DIR=/hf-cache/anything-llm node memory-probe.cjs <batch> <chars> <en|zh>
const fs = require("fs");

const SAMPLES = {
  en: "The quick brown fox studies protein folding in mitochondria near the river. ",
  zh: "线粒体中的蛋白质折叠研究表明，细胞在压力下会改变其代谢途径，并影响基因的表达。",
};
const peakMb = () => Math.round(fs.readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)[1] / 1024);

async function main([batchArg, charsArg, language]) {
  const batch = Number(batchArg);
  const chars = Number(charsArg);
  if (!SAMPLES[language] || !batch || !chars) throw new Error("usage: memory-probe.cjs <batch> <chars> <en|zh>");
  process.env.EMBEDDING_MODEL_PREF = "onnx-community/embeddinggemma-2-ONNX";
  const { NativeEmbedder } = require("/repo/server/utils/EmbeddingEngines/native");
  const embedder = new NativeEmbedder();
  embedder.log = () => {};
  const text = SAMPLES[language].repeat(Math.ceil(chars / SAMPLES[language].length)).slice(0, chars);
  const pipeline = await embedder.embedderClient();
  const tokens = pipeline.tokenizer([text], { padding: true, truncation: true }).input_ids.dims[1];
  const loadedMb = peakMb();
  const start = Date.now();
  const output = await pipeline(new Array(batch).fill(text), { pooling: "mean", normalize: true });
  console.log(JSON.stringify({ language, batch, chars, tokens, dims: output.dims, ms: Date.now() - start, loadedMb, peakMb: peakMb() }));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});
