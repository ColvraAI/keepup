// The number a person says yes to is the brief's number. A reviewer showed `/keepup:apply 1` picking another finding, with no ROI in its pull request.
import { strict as assert } from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { renderPrBody } from '../src/pr-body.ts';
import type { Finding } from '../src/run-shape.ts';
import { verifyFindings } from '../src/verify.ts';
import { fixtureRepo } from './helpers.ts';

const ANSWER = readFileSync('examples/support-bot/src/answer.ts', 'utf8');
const EXTRACT = readFileSync('examples/support-bot/src/extract.ts', 'utf8');
const CACHING = 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching';
const STRUCTURED = 'https://platform.claude.com/docs/en/build-with-claude/structured-outputs';

const lineOf = (text: string, part: string) => text.split('\n').findIndex((line) => line.includes(part)) + 1;
const textAt = (text: string, line: number) => text.split('\n')[line - 1];

const callLine = lineOf(ANSWER, 'messages.create');
const parseLine = lineOf(EXTRACT, 'JSON.parse');

const structured = {
  title: 'Ticket details come back in the shape the code expects', effect: ['better answers'], proof: 'vendor claim', effort: 'Hours',
  where: [{ file: 'extract.ts', line: parseLine, text: textAt(EXTRACT, parseLine) }], why: 'The code parses the model text by hand.',
  options: [{ name: "Claude's structured outputs", what: 'The reply follows a schema.', needs: 'A schema.', source: STRUCTURED }], sources: [STRUCTURED], lever: 'ADV-2026-0129-anthropic-structured-outputs',
} as unknown as Finding;

const caching = {
  title: 'Cache the long policy', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours',
  where: [{ file: 'answer.ts', line: callLine, text: textAt(ANSWER, callLine) }], why: 'The same long policy goes out on every call.',
  options: [{ name: "Claude's prompt caching", what: 'Marks the policy for caching.', needs: 'One cache_control block.', source: CACHING }], sources: [CACHING], lever: 'ADV-2026-1007-anthropic-prompt-caching',
} as unknown as Finding;

describe('keepup verify', () => {
  it('saves the findings in the order and with the numbers the brief prints, each with its ROI', async () => {
    const repo = fixtureRepo('quiet', { 'answer.ts': ANSWER, 'extract.ts': EXTRACT });
    try {
      const out = await verifyFindings(repo.path, { findings: [structured, caching], watching: [], held_back: [], jobs: ['Write replies'] }, { log: { searches: 2, reads: 2 } });
      assert.deepEqual(out.findings.map((finding) => finding.lever), [caching.lever, structured.lever], JSON.stringify(out.dropped));
      assert.deepEqual(out.findings.map((finding) => finding.rank), [1, 2]);
      assert.ok(out.findings[0].value?.roi, 'the first finding carries its ROI');
      assert.match(out.brief ?? '', /Biggest lever: Cache the long policy/);
      assert.match(renderPrBody({ finding: out.findings[0] }), /Saves about \$/);
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });
});
