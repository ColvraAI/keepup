// The dry run's stand-in for OpenAI, Anthropic and TypeSafe. It answers with the shapes
// their docs show (tmp/vendor-docs/decisions.md, the Decisions reference, the TypeSafe
// API reference), picks a category with a few keywords, and makes up its token counts.
// Nothing it returns is a measurement, and nothing from it reaches result.md.

const KEYWORDS = {
  coding: /python|bash|code|sql|regex|git |react|function|bug|dockerfile|unit test|awk|cli|class /i,
  billing: /invoice|charge|refund|subscription|payment|billing|plan|money|bill /i,
  summarize_document: /summar|tl;dr|condense|shorten|key points|takeaways|gist|recap|boil|too long|one paragraph|short version/i,
  chit_chat: /^(hi|hey|good morning|thanks|how's|haha|happy|you're|ok cool|that fixed|ugh|just saying)/i,
};
const CONFIDENT = 0.93;
const UNSURE = 0.55;

const estimateTokens = (text) => Math.ceil(String(text).length / 4);

function checksum(text) {
  return [...String(text)].reduce((sum, char) => (sum + char.charCodeAt(0)) % 997, 0);
}

function pickCategory(text, values) {
  const hit = values.find((value) => KEYWORDS[value]?.test(text));
  return hit ?? (values.includes("none") ? "none" : values[0]);
}

function json(status, value) {
  return { status, contentType: "application/json", body: JSON.stringify(value) };
}

function sse(events) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return { status: 200, contentType: "text/event-stream", body };
}

function decisionText(input) {
  if (typeof input === "string") return input;
  const user = input.filter((item) => item.role === "user").pop();
  return typeof user?.content === "string" ? user.content : "";
}

function sharedPrefix(input) {
  if (typeof input === "string") return null;
  const part = input.find((item) => item.role === "developer")?.content?.[0];
  return part?.prompt_cache_breakpoint ? part.text : null;
}

function distribution(values, choice, probability) {
  const rest = (1 - probability) / (values.length - 1);
  return values.map((value) => ({ value, probability: value === choice ? probability : rest }));
}

function decisionUsage(body, seenPrefixes) {
  const prefix = sharedPrefix(body.input);
  const prefixTokens = prefix ? estimateTokens(prefix) : 0;
  const cached = prefix && seenPrefixes.has(prefix) ? prefixTokens : 0;
  if (prefix) seenPrefixes.add(prefix);
  const input = estimateTokens(JSON.stringify(body));
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: prefixTokens - cached },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input,
  };
}

/** Most messages get a confident answer. A few are unsure, refused or fail, so each fall back runs. */
function decisions(body, seenPrefixes) {
  const text = decisionText(body.input);
  const question = body.questions[0];
  const values = question.choices.map((choice) => choice.value);
  const choice = pickCategory(text, values);
  const roll = checksum(text) % 15;
  if (roll === 1) return json(503, { error: { message: "fake provider: overloaded", type: "server_error" } });
  if (roll === 2) return json(200, { model: body.model, answers: [{ type: "refusal", name: question.name }], usage: decisionUsage(body, seenPrefixes) });
  const probability = roll === 0 ? UNSURE : CONFIDENT;
  const answer = { type: "choice", name: question.name, choice, probabilities: distribution(values, choice, probability), confidence: probability };
  return json(200, { model: body.model, answers: [answer], usage: decisionUsage(body, seenPrefixes) });
}

function lastUserText(input) {
  const user = input.filter((item) => item.role === "user").pop();
  const content = user?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join(" ");
}

function responsesStream(body) {
  const tool = body.tools[0];
  const category = pickCategory(lastUserText(body.input), tool.parameters.properties.category.enum);
  const item = { type: "function_call", name: tool.name, call_id: `call_${checksum(category)}`, arguments: "" };
  const usage = { input_tokens: estimateTokens(JSON.stringify(body)), input_tokens_details: { cached_tokens: 0 }, output_tokens: 18, total_tokens: 0 };
  return sse([
    { type: "response.created", response: { id: "resp_fake", status: "in_progress" } },
    { type: "response.output_item.added", item },
    { type: "response.function_call_arguments.delta", delta: JSON.stringify({ category }) },
    { type: "response.completed", response: { id: "resp_fake", status: "completed", usage } },
  ]);
}

function anthropicStream(body) {
  const tool = body.tools[0];
  const category = pickCategory(lastUserText(body.messages), tool.input_schema.properties.category.enum);
  const usage = { input_tokens: estimateTokens(JSON.stringify(body)), output_tokens: 1 };
  return sse([
    { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", content: [], model: body.model, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fake", name: tool.name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ category }) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 22 } },
    { type: "message_stop" },
  ]);
}

function systemOne(body) {
  const [name, question] = Object.entries(body.questions)[0];
  const values = Object.keys(question.criteria);
  const choice = pickCategory(String(body.state), values);
  const roll = checksum(body.state) % 15;
  if (roll === 1) return json(529, { detail: "fake provider: overloaded" });
  const probability = roll === 0 ? UNSURE : CONFIDENT;
  const probabilities = Object.fromEntries(distribution(values, choice, probability).map((option) => [option.value, option.probability]));
  const answer = { type: "choice", choice, confidence: probability, probabilities };
  return json(200, { model: "jev-1.14.0", answers: { [name]: answer }, usage: { input_tokens: estimateTokens(JSON.stringify(body)), output_tokens: 12 } });
}

function modelLookup(path, retired) {
  const id = decodeURIComponent(path.split("/").pop());
  if (retired.includes(id)) return json(404, { error: { code: "model_not_found", message: `The model ${id} does not exist.` } });
  return json(200, { id, object: "model" });
}

/** A respond function for the recorder. `retired` lists models the lookup says are gone. */
function fakeProvider({ retired = [] } = {}) {
  const seenPrefixes = new Set();
  return async ({ method, path, body }) => {
    if (method === "GET" && path.startsWith("/v1/models/")) return modelLookup(path, retired);
    const parsed = JSON.parse(body);
    if (path.startsWith("/v1/decisions")) return decisions(parsed, seenPrefixes);
    if (path.startsWith("/v1/responses")) return responsesStream(parsed);
    if (path.startsWith("/v1/messages")) return anthropicStream(parsed);
    if (path.startsWith("/v1/systemone")) return systemOne(parsed);
    return json(404, { error: { message: `fake provider has no route for ${path}` } });
  };
}

module.exports = { fakeProvider, pickCategory };
