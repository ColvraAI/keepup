// A small local server that every provider call in the harness goes through. It keeps
// the real status, timing, usage and body of each call, so tokens come from the actual
// responses and are never estimated. Request headers, which hold the keys, are forwarded
// but never kept. Runs on Node 18 inside the sandbox, and on the host in tests.
const http = require("node:http");

const FORWARDED_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "content-type", "accept"];

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sseEvents(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => parseJson(line.slice(5).trim()))
    .filter(Boolean);
}

/** Pulls the provider's own usage object out of a JSON body or an event stream. */
function rawUsage(text) {
  const json = parseJson(text);
  if (json) return json.usage ?? null;
  const events = sseEvents(text);
  const completed = events.find((event) => event.type === "response.completed");
  if (completed) return completed.response?.usage ?? null;
  const start = events.find((event) => event.type === "message_start");
  if (!start) return null;
  const deltas = events.filter((event) => event.type === "message_delta" && event.usage);
  const last = deltas.length ? deltas[deltas.length - 1].usage : {};
  return { ...start.message?.usage, ...last };
}

/**
 * One shape for all three providers. `input` is every input token, cached ones included.
 * OpenAI already counts cache reads and writes inside input_tokens; Anthropic doesn't.
 */
function normalizeUsage(usage) {
  if (!usage) return null;
  const details = usage.input_tokens_details ?? {};
  const anthropicRead = usage.cache_read_input_tokens ?? 0;
  const anthropicWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    input: (usage.input_tokens ?? 0) + anthropicRead + anthropicWrite,
    cached: (details.cached_tokens ?? 0) + anthropicRead,
    cacheWrite: (details.cache_write_tokens ?? 0) + anthropicWrite,
    output: usage.output_tokens ?? 0,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function recordOf(req, status, bodyText, responseText, ms) {
  return {
    method: req.method,
    path: req.url,
    status,
    ms,
    request: parseJson(bodyText),
    usage: normalizeUsage(rawUsage(responseText)),
    response: responseText,
  };
}

/** Starts the server. `respond` gets { method, path, headers, body } and returns { status, contentType, body }. */
async function startRecorder(respond) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    const startedAt = performance.now();
    const answer = await respond({ method: req.method, path: req.url, headers: req.headers, body: bodyText }).catch((error) => ({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: `recorder could not reach the provider: ${error.message}` } }),
    }));
    calls.push(recordOf(req, answer.status, bodyText, answer.body, performance.now() - startedAt));
    res.writeHead(answer.status, { "content-type": answer.contentType });
    res.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function pickUpstream(path, upstreams) {
  if (path.startsWith("/v1/messages") || path.startsWith("/v1/models/claude")) return upstreams.anthropic;
  if (path.startsWith("/v1/systemone")) return upstreams.typesafe;
  return upstreams.openai;
}

/** The real run: sends each call on to the provider it was meant for. */
function forwardTo(upstreams, fetchImpl) {
  return async ({ method, path, headers, body }) => {
    const kept = Object.fromEntries(FORWARDED_HEADERS.filter((name) => headers[name]).map((name) => [name, headers[name]]));
    const response = await fetchImpl(`${pickUpstream(path, upstreams)}${path}`, {
      method,
      headers: kept,
      body: method === "GET" ? undefined : body,
    });
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() };
  };
}

module.exports = { startRecorder, forwardTo, normalizeUsage, rawUsage, sseEvents };
