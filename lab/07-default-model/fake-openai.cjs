// A stand-in for OpenAI's Responses API, used only by --dry-run. It refuses the model
// that has shut down and answers the one that replaced it, so a dry run fails if the
// fork's default is still the old model. Its words are its own, not OpenAI's: the real
// error is only known from a real run.
const http = require("node:http");

const FAKE_ANSWER = "ready (fake provider)";

function errorReply(status, message, code) {
  return {
    status,
    json: { error: { message, type: "invalid_request_error", param: null, code } },
  };
}

function successReply(body) {
  const message = {
    type: "message",
    id: "msg_fake",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: FAKE_ANSWER, annotations: [] }],
  };
  const input = JSON.stringify(body.input ?? "").length;
  return {
    status: 200,
    json: {
      id: "resp_fake",
      object: "response",
      status: "completed",
      model: body.model,
      output: [message],
      usage: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 },
    },
  };
}

function respond(body, answering) {
  if (body.model !== answering)
    return errorReply(404, `Fake provider: no model ${body.model}.`, "model_not_found");
  return successReply(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function handle(request, response, answering) {
  const body = JSON.parse(await readBody(request));
  const known = request.method === "POST" && request.url === "/v1/responses";
  const reply = known ? respond(body, answering) : errorReply(404, "Unknown route.", "not_found");
  response.writeHead(reply.status, { "content-type": "application/json" });
  response.end(JSON.stringify(reply.json));
}

/** Listens on a free local port and resolves to the base URL the OpenAI client should use. */
function startFakeOpenAi(answering) {
  const server = http.createServer((request, response) => {
    handle(request, response, answering).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { respond, startFakeOpenAi };
