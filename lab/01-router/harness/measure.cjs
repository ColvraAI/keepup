// The measuring loop, with no AnythingLLM code in it, so it can be tested on the host.
// Node 18 inside the sandbox.

/** Runs one classifier on one message and keeps every provider call it caused. */
async function measureOne({ path, message, classify, calls, drainLogs }) {
  const firstCall = calls.length;
  const startedAt = performance.now();
  const outcome = await classify(message.text).then(
    (rule) => ({ predicted: rule ? rule.title : "none", thrown: null }),
    (error) => ({ predicted: null, thrown: error.message })
  );
  return {
    type: "record",
    id: message.id,
    path,
    expected: message.expected,
    ...outcome,
    ms: performance.now() - startedAt,
    calls: calls.slice(firstCall),
    logs: drainLogs(),
  };
}

/**
 * Both paths on every message, one call at a time. The order flips on each message,
 * so a slowdown during the run doesn't land on one path only.
 */
async function measureAll({ messages, classifiers, calls, drainLogs, onRecord }) {
  const order = ["before", "after"];
  for (const [index, message] of messages.entries()) {
    const paths = index % 2 === 0 ? order : [...order].reverse();
    for (const path of paths) {
      onRecord(await measureOne({ path, message, classify: classifiers[path], calls, drainLogs }));
    }
  }
}

/** The first candidate the provider still serves, with what the lookups returned. */
async function firstAvailableModel(candidates, lookup) {
  const tried = [];
  for (const model of candidates) {
    const status = await lookup(model);
    tried.push({ model, status });
    if (status === 200) return { model, tried };
  }
  return { model: null, tried };
}

/**
 * Every message through the cached form of the request, one at a time, on a list long
 * enough for it. It scores that form against the labels, and shows what the cache read.
 */
async function longFormCheck({ messages, classify, calls, drainLogs }) {
  const records = [];
  for (const message of messages) {
    records.push(await measureOne({ path: "after", message, classify, calls, drainLogs }));
  }
  return { type: "long_form_check", records };
}

module.exports = { measureOne, measureAll, firstAvailableModel, longFormCheck };
