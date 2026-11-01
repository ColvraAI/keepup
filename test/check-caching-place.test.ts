// A real session cited the call's system prompt, three lines below its first line, and the check threw out the biggest lever on the repo.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { type Provenance, runJudgeChecks } from '../src/check.ts';
import type { Finding } from '../src/run-shape.ts';

const SOURCE = 'https://vendor.example/caching';
const provenance: Provenance = { allowed: new Set([SOURCE]), textFor: (url) => (url === SOURCE ? '{"name":"Prompt caching","description":"Prompt caching bills repeated text at a tenth."}' : ''), repoText: '' };

const lines = ['const POLICY = "long";', '', 'const reply = await client.messages.create({', '  model: "m",', '  max_tokens: 600,', '  system: POLICY,', '});', ...Array.from({ length: 30 }, () => '// more'), 'const away = 1;'];
const CALL = lines.map((line, index) => ({ line, at: index + 1 }));
const lineWith = (part: string) => CALL.find(({ line }) => line.includes(part))?.at as number;

const finding = (at: number, file = lines): Finding => ({
  title: 'Turn on prompt caching for the policy', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours',
  where: [{ file: 'a.ts', line: at, text: file[at - 1] }], why: 'The same long policy goes out on every call.',
  options: [{ name: 'Prompt caching', what: 'Marks the policy.', needs: 'A block.', source: SOURCE }], sources: [SOURCE], lever: 'ADV-caching', pr: null,
});

const kept = (at: number, file = lines) => runJudgeChecks({ findings: [finding(at, file)], watching: [], held_back: [], files: new Map([['a.ts', file.join('\n')]]), provenance }).findings.length === 1;

describe('prompt caching at a call', () => {
  it('holds at any line inside the call, not only its first', () => {
    assert.ok(kept(lineWith('messages.create')));
    assert.ok(kept(lineWith('system: POLICY')));
  });

  it('still goes at a line that is no part of a call', () => {
    assert.equal(kept(lineWith('const away')), false);
  });

  it('still goes where the call already asks for caching', () => {
    const cached = lines.map((line) => (line.includes('max_tokens') ? '  cache_control: { type: "ephemeral" },' : line));
    assert.equal(kept(lineWith('system: POLICY'), cached), false);
  });
});
