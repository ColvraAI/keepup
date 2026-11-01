import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Candidate } from '../src/candidates.ts';
import { withCards } from '../src/cards.ts';
import { jobBundle } from '../src/judge-bundles.ts';

const model = (name: string, downloads: number): Candidate => ({ job: 'Embed', score: 1, record: { source: 'huggingface', name, url: `https://huggingface.co/${name}`, description: 'feature-extraction', downloads } });

describe('withCards', () => {
  it('reads the strongest models\' cards, masked and bounded, and caches them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-cards-'));
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(`A card with 8K context. key sk-ant-api03-FAKEFAKEFAKEFAKE ${'x'.repeat(9000)}`);
    }) as unknown as typeof fetch;
    const others = Array.from({ length: 5 }, (_, index) => model(`org/m${index}`, index));
    try {
      const out = await withCards([model('org/top', 100), ...others, { job: 'Other', score: 1, record: { source: 'npm', name: 'tool' } }], { fetchImpl, cacheDir: dir });
      assert.equal(asked.length, 4);
      assert.equal(asked[0], 'https://huggingface.co/org/top/raw/main/README.md');
      assert.match(out[0].card ?? '', /8K context/);
      assert.ok(!(out[0].card ?? '').includes('FAKEFAKE'));
      assert.ok((out[0].card ?? '').length <= 3500);
      assert.equal(out.at(-1)?.card, undefined);
      await withCards([model('org/top', 100)], { fetchImpl, cacheDir: dir });
      assert.equal(asked.length, 4, 'the second read comes from the cache');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a card that fails is simply not there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-cards-'));
    const fetchImpl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    try {
      const out = await withCards([model('org/top', 100)], { fetchImpl, cacheDir: dir });
      assert.equal(out[0].card, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the card reaches the judge inside the untrusted fence, and the checks can read numbers from it', () => {
    const bundle = jobBundle({ job: 'Embed', how: 'h', where: [] }, [{ ...model('org/top', 100), card: 'It reads 8192 tokens.' }], new Map());
    assert.ok(bundle);
    assert.match(bundle.urls[0].text, /8192 tokens/);
    const start = bundle.prompt.indexOf('8192');
    assert.ok(bundle.prompt.lastIndexOf('<untrusted', start) !== -1 && bundle.prompt.indexOf('</untrusted>', start) !== -1);
  });
});
