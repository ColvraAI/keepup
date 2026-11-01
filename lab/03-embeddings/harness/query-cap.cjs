// Runs INSIDE the sandbox. One long text through the real NativeEmbedder.embedTextInput, the path a chat message
// takes to the model, in a fresh process. It's the evidence for the query cap; result.md doesn't use it.
//   STORAGE_DIR=/hf-cache/anything-llm node query-cap.cjs <chars> <en|zh>
const fs = require("fs");

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
const SAMPLES = {
  en: "The quick brown fox studies protein folding in mitochondria near the river. ",
  zh: "线粒体中的蛋白质折叠研究表明，细胞在压力下会改变其代谢途径，并影响基因的表达。",
};
const peakMb = () => Math.round(fs.readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)[1] / 1024);

async function main([charsArg, language]) {
  const chars = Number(charsArg);
  if (!SAMPLES[language] || !chars) throw new Error("usage: query-cap.cjs <chars> <en|zh>");
  process.env.EMBEDDING_MODEL_PREF = MODEL;
  const { NativeEmbedder } = require("/repo/server/utils/EmbeddingEngines/native");
  const embedder = new NativeEmbedder();
  embedder.log = () => {};
  if (embedder.model !== MODEL) throw new Error(`embedder chose ${embedder.model}, not ${MODEL}`);
  const text = SAMPLES[language].repeat(Math.ceil(chars / SAMPLES[language].length)).slice(0, chars);
  const pipeline = await embedder.embedderClient();
  const tokenizerLimit = pipeline.tokenizer.model_max_length;
  const loadedMb = peakMb();

  // Printed before the model runs, so a run that dies still says what reached it.
  const embedChunks = embedder.embedChunks.bind(embedder);
  embedder.embedChunks = (chunks) => {
    const tokens = pipeline.tokenizer(chunks, { padding: true, truncation: true }).input_ids.dims[1];
    console.log(JSON.stringify({ language, chars, sentChars: chunks[0].length, tokens, tokenizerLimit }));
    return embedChunks(chunks);
  };

  const start = Date.now();
  const vector = await embedder.embedTextInput(text);
  console.log(JSON.stringify({ language, chars, dims: vector.length, ms: Date.now() - start, loadedMb, peakMb: peakMb() }));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});
