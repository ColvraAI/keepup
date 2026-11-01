import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { runPipeline } from '../src/pipeline.ts';
import type { JudgeInput } from '../src/pipeline.ts';
import { fixtureRepo, PATTERNS } from './helpers.ts';

describe('runPipeline with no model', () => {
  it('has the run shape, with no profile and no usage, and finds what the exact checks prove', async () => {
    const repo = fixtureRepo('manifests/js');
    try {
      const run = await runPipeline(repo.path, { commit: repo.commit, patternsDir: PATTERNS, now: '2026-11-01T00:00:00.000Z' });
      assert.equal(run.version, 1);
      assert.equal(run.commit, repo.commit);
      assert.equal(run.scanned_at, '2026-11-01T00:00:00.000Z');
      assert.equal(run.as_of, '2026-10-31');
      assert.equal(run.profile, null);
      assert.equal(run.usage, null);
      assert.ok(run.findings.some((f) => /whisper-1/.test(f.title)));
      assert.equal(run.findings[0].rank, 1);
      assert.ok(run.steps.some((s) => s.name === 'Check every claim'));
      assert.deepEqual(run.checks.dropped, []);
      assert.ok(run.held_back.some((h) => /Bedrock/.test(h.reason)));
      assert.ok(run.held_back.some((h) => /keepup can't see/.test(h.reason)), 'a gateway\'s row says only what was read');
      assert.ok(run.held_back.some((h) => /@modelcontextprotocol\/sdk 1\.32\.2/.test(h.thing)));
    } finally {
      repo.cleanup();
    }
  });
});

describe('the seams', () => {
  it('calls profile, then candidates, then judge, and runs the checks over what the judge says', async () => {
    const repo = fixtureRepo('manifests/js');
    const calls: string[] = [];
    try {
      const run = await runPipeline(repo.path, { commit: repo.commit, patternsDir: PATTERNS }, {
        profile: async () => { calls.push('profile'); return { one_liner: 'x', stack: [], jobs: [], stack_lock: [] }; },
        candidates: async (_context, _profile, search) => { calls.push('candidates'); return search({ sources: ['huggingface'], limit: 2 }); },
        judge: async (input: JudgeInput) => {
          calls.push('judge');
          assert.equal(input.candidates.length, 2);
          assert.ok(input.floor.findings.length > 0);
          assert.ok(input.context.files.has('server/whisper.js'));
          return {
            findings: [
              ...input.floor.findings,
              { title: 'A made-up place', effect: ['faster'], proof: 'projected', effort: 'Hours', where: [{ file: 'server/whisper.js', line: 999, text: 'x' }], why: 'y', options: [], sources: ['https://example.com/a'], lever: null, pr: null },
              { title: 'A made-up number', effect: ['faster'], proof: 'projected', effort: 'Hours', where: [{ file: 'server/whisper.js', line: 3, text: 'whisper-1' }], why: 'It is 37x faster.', options: [], sources: ['https://example.com/a'], lever: null, pr: null },
            ],
            watching: [],
            held_back: [],
            usage: { model: 'm', input_tokens: 1, output_tokens: 2, usd: 0.5, price_source: 'https://example.com/p' },
          };
        },
      });
      assert.deepEqual(calls, ['profile', 'candidates', 'judge']);
      assert.equal(run.profile?.one_liner, 'x');
      assert.equal(run.usage?.usd, 0.5);
      assert.deepEqual(run.checks.dropped.map((d) => d.what), ['A made-up place', 'A made-up number']);
      assert.ok(!run.findings.some((f) => f.title.startsWith('A made-up')));
      assert.ok(run.candidates_considered >= 2);
    } finally {
      repo.cleanup();
    }
  });

  it('gives a judge only masked text', async () => {
    const repo = fixtureRepo('fake-key');
    try {
      await runPipeline(repo.path, { commit: repo.commit, patternsDir: PATTERNS }, {
        judge: async (input: JudgeInput) => {
          assert.ok(!JSON.stringify([...input.context.files]).includes('sk-FAKE'));
          return { findings: [], watching: [], held_back: [] };
        },
      });
    } finally {
      repo.cleanup();
    }
  });
});
