// A stand-in for OpenAI's Responses API, used only by --dry-run. It follows the one
// rule that matters here, from OpenAI's GPT-6 guide: "When reasoning effort is not
// `none`, remove `temperature`". So a dry run fails if the fork's provider still sends it.
// https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters
const http = require("node:http");

const FAKE_ANSWER = "ready (fake provider)";

function errorReply(status, message, code) {
  return {
    status,
    json: { error: { message, type: "invalid_request_error", param: null, code } },
  };
}

function rejectsTemperature(body) {
  const sent = body.temperature !== undefined && body.temperature !== null;
  const effort = body.reasoning && body.reasoning.effort;
  return String(body.model).startsWith("gpt-6") && sent && effort !== "none";
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

function respond(body, models) {
  if (!models.includes(body.model))
    return errorReply(404, `The model ${body.model} does not exist.`, "model_not_found");
  if (rejectsTemperature(body))
    return errorReply(400, "Unsupported parameter: 'temperature'.", "unsupported_parameter");
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

async function handle(request, response, models) {
  const body = JSON.parse(await readBody(request));
  const known = request.method === "POST" && request.url === "/v1/responses";
  const reply = known ? respond(body, models) : errorReply(404, "Unknown route.", "not_found");
  response.writeHead(reply.status, { "content-type": "application/json" });
  response.end(JSON.stringify(reply.json));
}

/** Listens on a free local port and resolves to the base URL the OpenAI client should use. */
function startFakeOpenAi(models) {
  const server = http.createServer((request, response) => {
    handle(request, response, models).catch((error) => {
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
