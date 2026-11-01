// A stand-in for POST /v1/audio/transcriptions, for --dry-run only. It parses the real
// multipart upload, so the provider's request is exercised for real. The success shapes are
// the ones OpenAI's API reference documents. The refusal is modelled on the SDK's NotFoundError;
// what the real API says for an unknown model is recorded by the real run.
const http = require("node:http");

const CONTENT_DISPOSITION = /name="([^"]+)"(?:; filename="([^"]*)")?/;

function parseMultipart(body, contentType) {
  const boundary = (contentType || "").match(/boundary=(.+)$/)?.[1];
  if (!boundary) throw new Error("the request is not multipart");
  const parts = body.toString("latin1").split(`--${boundary}`).slice(1, -1);
  return parts.reduce(
    (form, part) => {
      const split = part.indexOf("\r\n\r\n");
      const value = part.slice(split + 4, -2);
      const [, name, fileName] = part.slice(0, split).match(CONTENT_DISPOSITION) || [];
      if (fileName !== undefined) return { ...form, fileName, fileBytes: value.length };
      return { ...form, fields: { ...form.fields, [name]: value } };
    },
    { fields: {}, fileName: null, fileBytes: 0 }
  );
}

function answerFor(model, text) {
  if (model !== "gpt-transcribe") return { text };
  return { text, languages: [{ code: "en" }], usage: { type: "duration", seconds: 60 } };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "fake" });
  res.end(JSON.stringify(body));
}

function refuse(res, status, message, code = null) {
  send(res, status, { error: { message, type: "invalid_request_error", param: null, code } });
}

function respond(req, res, body, transcripts) {
  if (!(req.headers.authorization || "").startsWith("Bearer ")) return refuse(res, 401, "No API key provided.");
  if (req.url !== "/v1/audio/transcriptions") return refuse(res, 404, `Unknown path ${req.url}`);
  const form = parseMultipart(body, req.headers["content-type"]);
  if (!form.fileName || !form.fileBytes) return refuse(res, 400, "No audio file was uploaded.");
  const text = transcripts[form.fileName]?.[form.fields.model];
  if (text === undefined) {
    return refuse(res, 404, `The model \`${form.fields.model}\` does not exist or you do not have access to it.`, "model_not_found");
  }
  return send(res, 200, answerFor(form.fields.model, text));
}

/** Starts on a free local port. transcripts is { [fileName]: { [model]: text } }. */
function startFakeOpenAi(transcripts) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        respond(req, res, Buffer.concat(chunks), transcripts);
      } catch (error) {
        refuse(res, 400, error.message);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startFakeOpenAi };
