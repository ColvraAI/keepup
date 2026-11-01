import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findingKey, renderIssueBody, renderPrBody } from '../src/pr-body.ts';
import { dataDir } from '../src/session.ts';
import type { Finding, LeverValue } from '../src/run-shape.ts';

const roi = {
  money: true,
  options: [{ name: 'Prompt caching', price_text: 'reads at 0.1x', source: 'https://vendor.example/caching', checked: '2026-11-01', line: 'Saves about $32 a month at 10,000 calls · pays back in 10 months [projected]' }],
  assumed: 'Assumed: 10,000 calls a month.',
  formula: 'monthly saving = (cost today − cost after) × calls a month',
  what_to_enter: 'Enter your own calls a month.',
};

const finding: Finding = {
  rank: 1,
  title: 'Cache the long support policy',
  effect: ['cheaper'],
  proof: 'vendor claim',
  effort: 'Hours',
  where: [{ file: 'src/answer.ts', line: 25, text: 'x' }],
  why: 'The same policy goes out on every call.',
  options: [],
  sources: ['https://vendor.example/caching'],
  lever: 'ADV-2026-1007-anthropic-prompt-caching',
  pr: null,
  value: { status: 'priced', roi } as unknown as LeverValue,
} as Finding;

describe('renderPrBody', () => {
  it('carries the why, the place, the ROI with its labels, the proof and the source', () => {
    const body = renderPrBody({ finding, repo: 'acme/bot', commit: 'abc1234', summary: 'Marks the policy for caching.', files: ['src/answer.ts'] });
    assert.match(body, /The same policy goes out on every call/);
    assert.match(body, /\[src\/answer\.ts:25\]\(https:\/\/github\.com\/acme\/bot\/blob\/abc1234\/src\/answer\.ts#L25\)/);
    assert.match(body, /Marks the policy for caching/);
    assert.match(body, /Saves about \$32 a month at 10,000 calls/);
    assert.match(body, /\[projected\]/);
    assert.match(body, /Assumed: 10,000 calls a month/);
    assert.match(body, /monthly saving =/);
    assert.match(body, /vendor claim/);
    assert.match(body, /https:\/\/vendor\.example\/caching/);
  });

  it('says a person merges, and never claims the tests ran unless told', () => {
    const body = renderPrBody({ finding });
    assert.match(body, /a person merges/);
    assert.match(body, /did not run this repo's tests/);
    assert.match(renderPrBody({ finding, tests: 'npm test: 12 passed' }), /\*\*Tests:\*\* npm test: 12 passed/);
    assert.doesNotMatch(renderPrBody({ finding, tests: 'npm test: 12 passed' }), /did not run/);
  });

  it('leaves out a link when it has no repo, and the ROI when there is none', () => {
    const body = renderPrBody({ finding: { ...finding, value: undefined } });
    assert.match(body, /src\/answer\.ts:25/);
    assert.doesNotMatch(body, /github\.com/);
    assert.doesNotMatch(body, /ROI/);
  });

  it('says so when there is no money figure', () => {
    const body = renderPrBody({ finding: { ...finding, value: { status: 'no_number', roi: { money: false, statement: 'No money figure: it changes what the product does.' } } as unknown as LeverValue } });
    assert.match(body, /\*\*ROI\.\*\* No money figure/);
  });

  it('ends with a marker a later run can find, which repo text cannot break', () => {
    assert.match(renderPrBody({ finding }), /<!-- keepup:finding=ADV-2026-1007-anthropic-prompt-caching -->$/);
    assert.equal(findingKey({ lever: null, title: 'Move --> off <b>this</b> model' }), 'move-off-b-this-b-model');
  });
});

describe('keepup pr-body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-pr-body-'));
  const runFile = join(dir, 'run.json');
  writeFileSync(runFile, JSON.stringify({ repo: 'acme/bot', commit: 'abc1234', findings: [finding] }));
  const keepup = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['bin/keepup.ts', 'pr-body', ...args], { encoding: 'utf8', env: { ...process.env, KEEPUP_PLUGIN: '', ...env } });

  it('prints the words for a finding in a run, with the test result it was given', () => {
    const out = keepup(['--finding', '1', '--run', runFile, '--tests', 'npm test: 12 passed']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Saves about \$32 a month/);
    assert.match(out.stdout, /github\.com\/acme\/bot\/blob\/abc1234/);
    assert.match(out.stdout, /npm test: 12 passed/);
  });

  it('writes them to a file, so gh can read them', () => {
    const file = join(dir, 'body.md');
    assert.equal(keepup(['--finding', '1', '--run', runFile, '--out', file]).status, 0);
    assert.match(readFileSync(file, 'utf8'), /a person merges/);
  });

  it('reads what a session verified, and refuses another file in a session', () => {
    const session = { KEEPUP_PLUGIN: '1', CLAUDE_PLUGIN_DATA: dir, CLAUDE_PROJECT_DIR: process.cwd() };
    const own = dataDir(dir, { ...process.env, ...session });
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'facts.json'), JSON.stringify({ repo: 'acme/bot', commit: 'abc1234' }));
    writeFileSync(join(own, 'verified.json'), JSON.stringify({ findings: [finding] }));
    const verified = keepup(['--finding', '1', '--dir', dir], session);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Saves about \$32 a month/);
    assert.match(keepup(['--finding', '1', '--run', runFile], session).stderr, /takes no --run/);
  });

  it('says so when there is no such finding, or no number', () => {
    assert.match(keepup(['--finding', '9', '--run', runFile]).stderr, /no finding 9/);
    assert.notEqual(keepup(['--run', runFile]).status, 0);
  });
});

describe('renderIssueBody', () => {
  it('holds the brief word for word, and says a person merges', () => {
    const body = renderIssueBody('Biggest lever: cache the policy\n1. Cache it');
    assert.match(body, /Biggest lever: cache the policy\n1\. Cache it/);
    assert.match(body, /a person merges/);
    assert.match(body, /\/keepup:apply <number>/);
  });

  it('uses a fence the brief cannot close', () => {
    const body = renderIssueBody('a line with \`\`\`\` in it');
    assert.match(body, /^`````$/m);
  });
});

describe('keepup issue-body', () => {
  it('prints the brief this session verified, and says so when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-issue-body-'));
    const session = { ...process.env, KEEPUP_PLUGIN: '1', CLAUDE_PLUGIN_DATA: dir, CLAUDE_PROJECT_DIR: process.cwd() };
    const run = () => spawnSync(process.execPath, ['bin/keepup.ts', 'issue-body', '--dir', dir], { encoding: 'utf8', env: session });
    assert.match(run().stderr, /no brief yet/);
    const own = dataDir(dir, session);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'verified.json'), JSON.stringify({ brief: 'Biggest lever: cache it' }));
    assert.match(run().stdout, /Biggest lever: cache it/);
  });
});
