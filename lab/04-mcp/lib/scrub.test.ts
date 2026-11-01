import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveRaw, scrub, secretsFrom } from './scrub.ts';

test('secretsFrom takes the key values by name and the tokens inside a Dynatrace config', () => {
  const secrets = secretsFrom({
    OPENAI_API_KEY: 'sk-test-openai-value',
    SENTRY_ACCESS_TOKEN: 'sntrys_value_123456',
    SIGNOZ_API_KEY: 'signoz-value-123456',
    DT_ENVIRONMENT_CONFIGS: JSON.stringify([{ apiEndpointUrl: 'https://x/', environmentId: 'e', alias: 'a', apiToken: 'dt0s01.ABC.DEF' }]),
    SIGNOZ_URL: 'https://not-a-secret.example.com',
    EMPTY: undefined,
  });
  assert.ok(secrets.includes('sk-test-openai-value'));
  assert.ok(secrets.includes('sntrys_value_123456'));
  assert.ok(secrets.includes('signoz-value-123456'));
  assert.ok(secrets.includes('dt0s01.ABC.DEF'));
  assert.ok(!secrets.includes('https://not-a-secret.example.com'));
});

test('scrub removes a known value, in plain text and in JSON-escaped form', () => {
  const value = 'abc"def\\ghi-long-enough';
  const escaped = JSON.stringify(value).slice(1, -1);
  const out = scrub(`plain ${value} json ${escaped} end`, [value]);
  assert.equal(out, 'plain [scrubbed] json [scrubbed] end');
});

test('scrub removes the shapes of keys it was never told about', () => {
  const dirty = [
    'sk-proj-abcdefghijklmnop0123',
    'sk-ant-api03-abcdefghijklmnop',
    'sntrys_eyJpYXQiOjE3MDAwMDAwMDB9_abcdef',
    'dt0s01.ABCDEFGHIJK0123.ABCDEFGHIJK0123',
    'Authorization: Sentry-Bearer sometokenvalue',
    'Authorization: Token ptokenvalue',
    '"Authorization":"Bearer sometokenvalue"',
    '"apiToken":"anything-at-all"',
    'SIGNOZ-API-KEY: signoztokenvalue',
  ].join('\n');
  const out = scrub(dirty, []);
  for (const leak of ['abcdefghijklmnop0123', 'api03-abcdefghijklmnop', 'eyJpYXQiOjE3', 'ABCDEFGHIJK0123', 'sometokenvalue', 'ptokenvalue', 'anything-at-all', 'signoztokenvalue']) {
    assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  }
});

test('scrub leaves ordinary output alone, and never trips over a very short value', () => {
  const text = 'signoz_list_services listed 46 tools from http://signoz.invalid:8080 with token placeholder. Token counts and a Bearer scheme are prose.';
  assert.equal(scrub(text, ['']), text);
  assert.equal(scrub(text, ['46']), text);
});

test('saveRaw writes scrubbed text and scrubbed JSON, and makes the folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-raw-'));
  const secret = 'sk-test-this-is-a-fake-key';
  const textFile = join(dir, 'a', 'b.txt');
  const jsonFile = join(dir, 'a', 'c.json');
  saveRaw(textFile, `the key is ${secret}`, [secret]);
  saveRaw(jsonFile, { note: `the key is ${secret}`, nested: { list: [secret] } }, [secret]);
  assert.ok(!readFileSync(textFile, 'utf8').includes(secret));
  const parsed = JSON.parse(readFileSync(jsonFile, 'utf8'));
  assert.deepEqual(parsed, { note: 'the key is [scrubbed]', nested: { list: ['[scrubbed]'] } });
});
