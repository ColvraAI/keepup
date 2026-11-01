// A stand-in for the fork's NativeEmbedder, used only by run.test.ts on the host, so the
// harness's checkpointing is tested without running upstream code. Vectors are a hash of the text.
const CRASH_AFTER = Number(process.env.FAKE_EMBEDDER_CRASH_AFTER ?? 0);
const DELAY_MS = Number(process.env.FAKE_EMBEDDER_DELAY_MS ?? 0);
const DIM = 4;

function vectorFor(text) {
  const seed = [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 9973, 7);
  return Array.from({ length: DIM }, (_, i) => ((seed * (i + 3)) % 97) / 97 + 0.01);
}

class NativeEmbedder {
  constructor() {
    this.model = process.env.EMBEDDING_MODEL_PREF;
    this.embeddingPrefix = "doc: ";
    this.queryPrefix = "query: ";
    this.maxConcurrentChunks = 2;
    this.embeddingMaxChunkLength = 1000;
    this.embedded = 0;
  }

  async embedderClient() {}

  async embedChunks(texts) {
    if (DELAY_MS) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    this.embedded += texts.length;
    if (CRASH_AFTER && this.embedded > CRASH_AFTER) throw new Error("fake crash");
    return texts.map(vectorFor);
  }

  async embedTextInput(text) {
    return vectorFor(`${this.queryPrefix}${text}`);
  }
}

module.exports = { NativeEmbedder };
