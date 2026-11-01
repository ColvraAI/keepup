// The investigation's test data for a local SigNoz: an hour of one service's logs and
// spans, written so "why did errors spike in the last hour?" has one findable answer,
// a payment gateway failing for the last fifteen minutes. These are inputs we made up on
// purpose (see notes.md), not measurements.
//   node lab/04-mcp/testset/send-signoz-telemetry.ts [otlp http url, default http://localhost:4318]

export const SERVICE = 'checkout';
export const LATE_ERRORS = 24;
export const SPIKE_MINUTES = 15;
/** What notes.md has a person send to the Sentry demo project, so both backends hold the same planted cause. */
export const SENTRY_EVENT_MESSAGE = 'payment gateway timeout: charge failed';

const MINUTE_MS = 60_000;
const SCOPE = { name: 'keepup-lab-04' };
const RESOURCE = { attributes: [{ key: 'service.name', value: { stringValue: SERVICE } }] };
const EARLY_ERROR_MINUTES = [52, 31];

const nanos = (ms: number): string => `${BigInt(ms) * 1_000_000n}`;
const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0');

function earlyErrorTimes(now: number): number[] {
  return EARLY_ERROR_MINUTES.map((minutes) => now - minutes * MINUTE_MS);
}

function spikeTimes(now: number): number[] {
  return Array.from({ length: LATE_ERRORS }, (_, i) => now - ((i + 1) * SPIKE_MINUTES * MINUTE_MS) / (LATE_ERRORS + 1));
}

function logRecord(at: number, severityNumber: number, severityText: string, body: string): Record<string, unknown> {
  return { timeUnixNano: nanos(at), severityNumber, severityText, body: { stringValue: body } };
}

export function buildLogs(now: number) {
  const info = Array.from({ length: 60 }, (_, i) => logRecord(now - i * MINUTE_MS, 9, 'INFO', 'order placed'));
  const early = earlyErrorTimes(now).map((at) => logRecord(at, 17, 'ERROR', 'inventory cache miss retried'));
  const spike = spikeTimes(now).map((at) => logRecord(at, 17, 'ERROR', 'payment gateway timeout after 30s: charge failed'));
  return { resourceLogs: [{ resource: RESOURCE, scopeLogs: [{ scope: SCOPE, logRecords: [...info, ...early, ...spike] }] }] };
}

function span(at: number, index: number, failed: boolean): Record<string, unknown> {
  const status = failed ? { code: 2, message: 'payment gateway timeout' } : { code: 1 };
  return { traceId: hex(index + 1, 32), spanId: hex(index + 1, 16), name: 'POST /checkout', kind: 2, startTimeUnixNano: nanos(at - 200), endTimeUnixNano: nanos(at), status };
}

export function buildSpans(now: number) {
  const ok = Array.from({ length: 60 }, (_, i) => span(now - i * MINUTE_MS, i, false));
  const failed = spikeTimes(now).map((at, i) => span(at, 100 + i, true));
  return { resourceSpans: [{ resource: RESOURCE, scopeSpans: [{ scope: SCOPE, spans: [...ok, ...failed] }] }] };
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
}

export async function sendAll(base: string, now: number): Promise<void> {
  await post(`${base}/v1/logs`, buildLogs(now));
  await post(`${base}/v1/traces`, buildSpans(now));
}

if (import.meta.main) {
  const base = process.argv[2] ?? 'http://localhost:4318';
  sendAll(base, Date.now()).then(() => process.stdout.write(`Sent an hour of logs and spans to ${base}.\n`), (error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
