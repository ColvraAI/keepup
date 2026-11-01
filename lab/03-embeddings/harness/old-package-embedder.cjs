// The control: all-MiniLM-L6-v2 through @xenova/transformers, as the code at the base commit loaded it, in the
// shape embed.cjs expects. The harness runs it to show what the package change does to retrieval.
const path = require("path");
const { createRequire } = require("module");

const BATCH = 25;
const serverRequire = createRequire("/repo/server/package.json");

class NativeEmbedder {
  constructor() {
    this.model = process.env.EMBEDDING_MODEL_PREF;
    this.embeddingPrefix = "";
    this.queryPrefix = "";
    this.maxConcurrentChunks = BATCH;
    this.cacheDir = path.resolve(process.env.STORAGE_DIR, "models");
    this.extractor = null;
  }

  async embedderClient() {
    if (this.extractor) return this.extractor;
    const { pipeline } = await import(serverRequire.resolve("@xenova/transformers"));
    this.extractor = await pipeline("feature-extraction", this.model, { cache_dir: this.cacheDir });
    return this.extractor;
  }

  async embedChunks(texts) {
    const extractor = await this.embedderClient();
    const vectors = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const output = await extractor(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
      vectors.push(...output.tolist());
    }
    return vectors;
  }

  async embedTextInput(text) {
    return (await this.embedChunks([text]))[0];
  }
}

module.exports = { NativeEmbedder };
