// A lever is the product. One sentence the checks can't prove costs that sentence, not the lever, and what's left must still pass every check.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { type Provenance, runJudgeChecks } from '../src/check.ts';
import type { Finding } from '../src/run-shape.ts';

const FILES = new Map([['src/route.ts', ['const prompt = "You are a router";', 'const label = await client.messages.create({', '  model: "claude-sonnet-5-5",', '});'].join('\n')]]);
const RECORD = 'https://www.npmjs.com/package/real-tool';
const RECORD_TEXT = '{"name":"real-tool","version":"2.4.0","description":"Decides routes 4x faster, says its maker."}';
const provenance: Provenance = { allowed: new Set([RECORD]), textFor: (url) => (url === RECORD ? RECORD_TEXT : ''), repoText: '', leverNames: new Map([['ADV-real-tool', 'real-tool for routes']]) };

const lever: Finding = {
  title: 'Your router can pick routes with real-tool',
  effect: ['faster'],
  proof: 'vendor claim',
  effort: 'A day',
  where: [{ file: 'src/route.ts', line: 2, text: 'client.messages.create' }],
  why: 'real-tool is a router library. Its makers say it decides routes 4x faster.',
  options: [{ name: 'real-tool', what: 'A router library.', needs: 'A key.', source: RECORD }],
  sources: [RECORD],
  lever: 'ADV-real-tool',
  pr: null,
};

const check = (finding: Finding, extra: Partial<Provenance> = {}) => runJudgeChecks({ findings: [finding], watching: [], held_back: [], files: FILES, provenance: { ...provenance, ...extra } });

describe('a lever finding with one bad sentence', () => {
  it('loses that sentence, keeps the lever, and says what it cut', () => {
    const out = check({ ...lever, why: `${lever.why} Moving to evilpkg costs nothing.` });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].why, lever.why);
    assert.equal(out.findings[0].lever, 'ADV-real-tool');
    assert.equal(out.checks.dropped.length, 1);
    assert.match(out.checks.dropped[0].what, /A sentence in/);
    assert.match(out.checks.dropped[0].why, /evilpkg/);
  });

  it('still goes when every sentence is bad, or the title is', () => {
    assert.equal(check({ ...lever, why: 'Moving to evilpkg costs nothing.' }).findings.length, 0);
    assert.equal(check({ ...lever, title: 'Switch to evilpkg' }).findings.length, 0);
  });

  it('is only for a lever: a finding with no lever goes whole, as before', () => {
    assert.equal(check({ ...lever, lever: null, why: `${lever.why} Moving to evilpkg costs nothing.` }).findings.length, 0);
  });
});

describe('a model id the scan found in this repo', () => {
  it('may be named, even off the cited line', () => {
    const why = `${lever.why} Today this call runs on claude-sonnet-5-5.`;
    const out = check({ ...lever, why }, { knownIds: new Set(['claude-sonnet-5-5']) });
    assert.equal(out.findings[0]?.why, why);
    assert.deepEqual(out.checks.dropped, []);
  });

  it('but one that is neither in the repo nor a source still is not', () => {
    const out = check({ ...lever, why: `${lever.why} Today this call runs on claude-opus-9-9.` }, { knownIds: new Set(['claude-sonnet-5-5']) });
    assert.equal(out.findings[0]?.why, lever.why);
    assert.match(out.checks.dropped[0].why, /claude-opus-9-9/);
  });
});
