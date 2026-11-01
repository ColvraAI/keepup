import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { buildLogs, buildSpans, LATE_ERRORS, sendAll, SERVICE } from './send-signoz-telemetry.ts';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR_MS = 3_600_000;

type Record_ = { timeUnixNano: string; severityText: string; body: { stringValue: string } };

const logRecords = (): Record_[] => buildLogs(NOW).resourceLogs[0].scopeLogs[0].logRecords as Record_[];
const toMs = (nanos: string) => Number(BigInt(nanos) / 1_000_000n);

test('errors are rare for most of the hour and spike in the last part of it', () => {
  const errors = logRecords().filter((r) => r.severityText === 'ERROR');
  const recent = errors.filter((r) => toMs(r.timeUnixNano) >= NOW - 15 * 60_000);
  assert.equal(recent.length, LATE_ERRORS);
  assert.ok(recent.length > (errors.length - recent.length) * 3, 'the spike stands out');
});

test('every record is inside the last hour, on the same service, and names a cause to find', () => {
  for (const record of logRecords()) {
    const at = toMs(record.timeUnixNano);
    assert.ok(at <= NOW && at >= NOW - HOUR_MS);
  }
  const body = buildLogs(NOW);
  assert.deepEqual(body.resourceLogs[0].resource.attributes[0], { key: 'service.name', value: { stringValue: SERVICE } });
  const spike = logRecords().filter((r) => r.severityText === 'ERROR' && toMs(r.timeUnixNano) >= NOW - 15 * 60_000);
  assert.ok(spike.every((r) => r.body.stringValue.includes('payment gateway')));
});

test('spans use OTLP ids and mark the failing ones with an error status', () => {
  const spans = buildSpans(NOW).resourceSpans[0].scopeSpans[0].spans as { traceId: string; spanId: string; status: { code: number } }[];
  assert.ok(spans.every((s) => /^[0-9a-f]{32}$/.test(s.traceId) && /^[0-9a-f]{16}$/.test(s.spanId)));
  assert.equal(spans.filter((s) => s.status.code === 2).length, LATE_ERRORS);
});

test('sendAll posts logs and traces as JSON to the OTLP paths and fails on a refusal', async () => {
  const seen: { path?: string; type?: string; body: string }[] = [];
  let answer = 200;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += String(d); });
    req.on('end', () => {
      seen.push({ path: req.url, type: req.headers['content-type'], body });
      res.writeHead(answer).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await sendAll(base, NOW);
    assert.deepEqual(seen.map((s) => s.path), ['/v1/logs', '/v1/traces']);
    assert.ok(seen.every((s) => s.type === 'application/json' && JSON.parse(s.body)));
    answer = 503;
    await assert.rejects(sendAll(base, NOW), /503/);
  } finally {
    server.close();
  }
});
