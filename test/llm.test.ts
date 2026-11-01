import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BudgetExceededError, buildRequestBody, createLlm, DEFAULT_MODEL, LlmRefusalError, modelPrice, type LlmRequest, type ModelPrice } from '../src/llm.ts';

const KEY = 'sk-ant-test-THIS-KEY-MUST-NEVER-APPEAR';
const PRICE: ModelPrice = { model: 'm', input: 2, output: 10, cache_write: 2.5, cache_read: 0.1, source: 'https://example.com/price' };
const REQUEST: LlmRequest = {
  purpose: 'test',
  system: 'be good',
  prefix: 'the stable prefix',
  prompt: 'the question',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  maxTokens: 1000,
  effort: 'medium',
};

interface Scripted { readonly status?: number; readonly body: unknown; readonly headers?: Record<string, string> }

const usage = (input: number, output: number, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
const okReply = (json: unknown, u = usage(100, 10)): Scripted => ({ body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(json) }], usage: u } });

describe('the Anthropic client', () => {
  let server: Server;
  let baseUrl = '';
  let script: Scripted[] = [];
  let seen: { body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen = [...seen, { body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers }];
        const next = script[0] ?? okReply({ ok: true });
        script = script.slice(1);
        res.writeHead(next.status ?? 200, { 'content-type': 'application/json', ...next.headers });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
  });
  after(() => server.close());
  beforeEach(() => { script = []; seen = []; });

  const client = (extra: Partial<Parameters<typeof createLlm>[0]> = {}) => createLlm({ apiKey: KEY, baseUrl, price: PRICE, model: 'm', sleep: async () => {}, ...extra });

  it('sends the key as a header only, with no tools and no removed parameters', async () => {
    const reply = await client().ask<{ ok: boolean }>(REQUEST);
    assert.deepEqual(reply, { ok: true });
    const { body, headers } = seen[0];
    assert.equal(headers['x-api-key'], KEY);
    assert.ok(!JSON.stringify(body).includes(KEY));
    for (const removed of ['tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(removed in body), removed);
    assert.equal(headers['anthropic-version'], '2023-06-01');
  });

  it('puts cache_control on the stable prefix and the schema in output_config', () => {
    const body = buildRequestBody(REQUEST, 'm', 1000);
    const system = body.system as { cache_control?: unknown }[];
    assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
    const user = (body.messages as { content: { text: string; cache_control?: unknown }[] }[])[0].content;
    assert.equal(user[0].text, 'the stable prefix');
    assert.deepEqual(user[0].cache_control, { type: 'ephemeral' });
    assert.equal(user[1].text, 'the question');
    assert.equal(user[1].cache_control, undefined);
    const config = body.output_config as { effort: string; format: { type: string; schema: unknown } };
    assert.equal(config.effort, 'medium');
    assert.equal(config.format.type, 'json_schema');
    assert.deepEqual(config.format.schema, REQUEST.schema);
  });

  it('counts tokens and dollars, cache reads and writes at their own prices', async () => {
    script = [okReply({ ok: true }, usage(1_000_000, 100_000, 1_000_000, 1_000_000))];
    const llm = client({ maxUsd: 100 });
    await llm.ask(REQUEST);
    const seenUsage = llm.usage();
    assert.equal(seenUsage.model, 'm');
    assert.equal(seenUsage.input_tokens, 1_000_000);
    assert.equal(seenUsage.output_tokens, 100_000);
    assert.equal(seenUsage.cache_read_input_tokens, 1_000_000);
    assert.equal(seenUsage.cache_creation_input_tokens, 1_000_000);
    assert.equal(seenUsage.usd, 2 + 1 + 0.1 + 2.5);
    assert.equal(seenUsage.price_source, 'https://example.com/price');
  });

  it('stops at the cap without making the call', async () => {
    script = [okReply({ ok: true }, usage(100_000, 79_990))];
    const llm = client({ maxUsd: 1 });
    await llm.ask(REQUEST);
    assert.equal(seen.length, 1);
    assert.ok(llm.usage().usd >= 0.9);
    await assert.rejects(llm.ask(REQUEST), BudgetExceededError);
    assert.equal(seen.length, 1);
    assert.ok(llm.usage().usd <= 1);
  });

  it('lowers max_tokens to what the cap can still pay for', async () => {
    script = [okReply({ ok: true })];
    await client({ maxUsd: 0.006 }).ask({ ...REQUEST, maxTokens: 16_000 });
    assert.ok((seen[0].body.max_tokens as number) < 1000);
    assert.ok((seen[0].body.max_tokens as number) >= 200);
  });

  it('retries overload and rate limits, not bad requests', async () => {
    script = [{ status: 529, body: { error: { message: 'overloaded' } } }, { status: 429, body: { error: { message: 'slow' } }, headers: { 'retry-after': '0' } }, okReply({ ok: true })];
    await client().ask(REQUEST);
    assert.equal(seen.length, 3);
    seen = [];
    script = [{ status: 400, body: { error: { message: 'temperature is not allowed' } } }];
    await assert.rejects(client().ask(REQUEST), /400.*temperature is not allowed/);
    assert.equal(seen.length, 1);
  });

  it('never puts a key in an error message', async () => {
    script = [{ status: 401, body: { error: { message: `bad key ${KEY}` } } }];
    await assert.rejects(client().ask(REQUEST), (error: Error) => !error.message.includes(KEY));
  });

  it('turns a refusal into its own error, still counting the tokens', async () => {
    script = [{ body: { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: usage(100, 0) } }];
    const llm = client();
    await assert.rejects(llm.ask(REQUEST), LlmRefusalError);
    assert.equal(llm.usage().input_tokens, 100);
  });

  it('fails plainly on a truncated or non-JSON reply', async () => {
    script = [{ body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":' }], usage: usage(1, 1) } }];
    await assert.rejects(client().ask(REQUEST), /max_tokens/);
    script = [{ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: usage(1, 1) } }];
    await assert.rejects(client().ask(REQUEST), /JSON/);
  });

  it('replays an identical request from its cache at no cost, and keeps a ledger of real spend', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'keepup-llm-'));
    try {
      script = [okReply({ ok: 1 }, usage(1000, 100))];
      const first = client({ cacheDir });
      assert.deepEqual(await first.ask(REQUEST), { ok: 1 });
      const second = client({ cacheDir });
      assert.deepEqual(await second.ask(REQUEST), { ok: 1 });
      assert.equal(seen.length, 1);
      assert.equal(second.usage().usd, 0);
      assert.equal(second.usage().calls, 0);
      assert.equal(second.usage().replayed_calls, 1);
      assert.ok(second.usage().replayed_usd > 0);
      const ledger = readFileSync(join(cacheDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
      assert.equal(ledger.length, 1);
      assert.ok(!ledger[0].includes(KEY));
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('the price', () => {
  it('comes from the database, with its source', () => {
    const price = modelPrice(DEFAULT_MODEL);
    assert.equal(DEFAULT_MODEL, 'claude-sonnet-5-5');
    assert.equal(price.input, 2);
    assert.equal(price.output, 10);
    assert.equal(price.cache_read, 0.1);
    assert.equal(price.cache_write, 2.5);
    assert.match(price.source, /^https:\/\/openrouter\.ai\/anthropic\/claude-sonnet-5\.5/);
  });

  it('throws rather than guessing', () => {
    assert.throws(() => modelPrice('claude-made-up-1-0'), /no price/i);
  });
});
