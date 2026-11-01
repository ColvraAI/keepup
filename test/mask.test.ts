import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { maskText } from '../src/mask.ts';

const FAKES: Record<string, string> = {
  'sk-': 'sk-FAKEfakeFAKEfakeFAKEfake0123456789',
  'sk-ant-': 'sk-ant-api03-FAKEfakeFAKEfake0123456789',
  'ghp_': 'ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake0123',
  'gho_': 'gho_FAKEfakeFAKEfakeFAKEfakeFAKEfake0123',
  'github_pat_': 'github_pat_FAKEfake0123_FAKEfakeFAKEfakeFAKEfake',
  'xox': 'xoxb-FAKE-FAKE-fakefakefake',
  'AIza': 'AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake012',
  'AKIA': 'AKIAIOSFODNN7EXAMPLE',
};

describe('maskText', () => {
  for (const [name, key] of Object.entries(FAKES)) {
    it(`hides a ${name} key wherever it appears`, () => {
      const out = maskText(`const a = "${key}"; // or ${key}`);
      assert.ok(!out.includes(key), out);
      assert.ok(out.includes('[masked]'));
    });
  }

  it('hides a PEM block and keeps the line count, so line numbers stay true', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nRkFLRWZha2U=\nc2Vjb25k\n-----END RSA PRIVATE KEY-----\nnext';
    const out = maskText(pem);
    assert.ok(!out.includes('RkFLRWZha2U'));
    assert.ok(!out.includes('c2Vjb25k'));
    assert.equal(out.split('\n').length, pem.split('\n').length);
    assert.equal(out.split('\n')[4], 'next');
  });

  it('hides high-entropy assignments to names like *_KEY, *_TOKEN and *_SECRET', () => {
    for (const line of [
      'PAYMENT_SECRET = "c2VjcmV0LXZhbHVlLWZha2UtMDEyMzQ1"',
      'SERVICE_TOKEN=tok9f8a7b6c5d4e3f2a1b0c',
      'apiKey: "9f8a7b6c5d4e3f2a1b0c9f8a"',
      '"internal_key": "9f8a7b6c5d4e3f2a1b0c9f8a"',
    ]) {
      const out = maskText(line);
      assert.ok(out.includes('[masked]'), line);
      assert.ok(!/9f8a7b6c|c2VjcmV0/.test(out), out);
    }
  });

  it('leaves ordinary code, placeholders and model ids alone', () => {
    for (const line of [
      'MAX_TOKENS=4000',
      'PLACEHOLDER_TOKEN={{ env.PLACEHOLDER_TOKEN }}',
      'api_key = "{{ env.ANTHROPIC_API_KEY }}"',
      'const key = process.env.OPENAI_API_KEY;',
      'model = "claude-sonnet-4-20250514"',
      'model_key = "claude-sonnet-4-20250514"',
      'const task-list = "risk-assessment-for-desk-work-2026";',
      'token = getTokenFromEnvironment()',
    ]) {
      assert.equal(maskText(line), line);
    }
  });

  it('never changes the number of lines', () => {
    const text = 'a\nOPENAI_API_KEY=sk-FAKEfakeFAKEfakeFAKEfake0123456789\n\nb\n';
    assert.equal(maskText(text).split('\n').length, text.split('\n').length);
  });
});
