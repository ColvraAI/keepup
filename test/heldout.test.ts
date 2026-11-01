// A second answer key, for two repos the prompts were never tuned against. It was written from reading these repos at
// these commits after the prompts were frozen, and before their judged runs existed. data/briefs/held-out-results.md
// says how the runs did. A row here can only be changed by reading the code again, never to match a run.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Finding, Run } from '../src/run-shape.ts';
import { ROOT } from './helpers.ts';

function loadRun(name: string): Run {
  return JSON.parse(readFileSync(join(ROOT, 'data', 'runs', `${name}.json`), 'utf8')) as Run;
}

function shown(finding: Finding): string {
  return `${finding.title}\n${finding.why}\n${finding.options.map((option) => `${option.name} ${option.what}`).join('\n')}`;
}

describe('stackblitz/bolt.new at eda10b1', () => {
  const run = loadRun('bolt.new');

  it('is a real run at the pinned commit', () => {
    assert.ok(run.commit?.startsWith('eda10b1'));
    assert.ok(run.usage);
  });

  it('must find: the one model it sends, app/lib/.server/llm/model.ts:8, was retired', () => {
    const finding = run.findings.find((item) => item.where.some((place) => place.file === 'app/lib/.server/llm/model.ts' && place.line === 8));
    assert.ok(finding, 'model.ts:8');
    assert.match(finding.title, /claude-3-5-sonnet-20240620/);
    assert.deepEqual(finding.effect, ['keeps working']);
    assert.ok(finding.deadline && finding.deadline < run.as_of, 'already past');
    assert.notEqual(finding.proof, 'measured');
  });

  it('must not: anything for a job it does not have, since it keeps no documents and runs no local models', () => {
    for (const finding of run.findings) {
      assert.ok(!/\b(?:rerank|vector database|re-embed|speech to text|transcrib)/i.test(shown(finding)), finding.title);
    }
  });

  it('must not: age alone. The AI SDK packages are behind, but "behind" is never the whole finding', () => {
    for (const finding of run.findings.filter((item) => /\bbehind\b/.test(item.title))) {
      assert.match(finding.why, /release notes/);
      assert.ok(finding.sources.some((url) => /CHANGELOG/i.test(url)), finding.title);
    }
  });

  it('must not: a library in a language this repo does not use', () => {
    for (const finding of run.findings) for (const option of finding.options) assert.ok(!/pypi\.org|crates\.io/.test(option.source), option.source);
  });
});

describe('rashadphz/farfalle at a9dd493', () => {
  const run = loadRun('farfalle');

  it('is a real run at the pinned commit', () => {
    assert.ok(run.commit?.startsWith('a9dd493'));
    assert.ok(run.usage);
  });

  it('must find: gpt-4o and gpt-4o-mini, its OpenAI models, shut down on 14 Jan 2027', () => {
    const finding = run.findings.find((item) => item.where.some((place) => place.file === 'src/backend/constants.py' && [11, 12, 26, 27].includes(place.line)));
    assert.ok(finding, 'constants.py');
    assert.equal(finding.deadline, '2027-01-14');
    assert.match(finding.why, /gpt-4o/);
    assert.match(shown(finding), /gpt-6-luna/);
    assert.deepEqual(finding.effect.includes('keeps working'), true);
  });

  it('must not: call a model retired that only a gateway serves, or treat the Azure path as OpenAI\'s own', () => {
    for (const finding of run.findings) assert.ok(!/\bllama-3\.1-70b\b|\bcommand-r\b/.test(finding.title), finding.title);
  });

  it('must not: anything for a job it does not have, since it has no embeddings, speech or MCP client', () => {
    for (const finding of run.findings) {
      assert.ok(!/\b(?:re-embed|speech to text|transcrib|MCP server)/i.test(shown(finding)), finding.title);
    }
  });

  it('must not: suggest caching where no caching setting exists', () => {
    for (const finding of run.findings.filter((item) => /prompt cach/i.test(shown(item)))) {
      assert.ok(finding.where.some((place) => /cach/i.test(place.text)), finding.title);
    }
  });
});

describe('the write-up says what the runs say', () => {
  const text = readFileSync(join(ROOT, 'data', 'briefs', 'held-out-results.md'), 'utf8');
  for (const name of ['bolt.new', 'farfalle']) {
    it(`${name}: its numbers are the run's`, () => {
      const run = loadRun(name);
      const row = text.match(new RegExp(`^\\| ${name.replace('.', '\\.')} \\| (\\d+) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\|$`, 'm'));
      assert.ok(row, `a counts row for ${name}`);
      assert.deepEqual(row.slice(1).map(Number), [run.findings.length, run.held_back.length, run.watching.length, run.checks.dropped.length]);
    });

    it(`${name}: every thing it says step 5 dropped was dropped`, () => {
      const run = loadRun(name);
      const section = text.split(`### What step 5 dropped on ${name}`)[1]?.split(/\n#/)[0] ?? '';
      const listed = [...section.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
      assert.deepEqual(listed.sort(), run.checks.dropped.map((item) => item.what).sort());
    });
  }

  it('what it says of caching on bolt.new is what happened', () => {
    const run = loadRun('bolt.new');
    assert.ok(!run.checks.dropped.some((item) => /cach/i.test(item.what)), 'step 5 dropped no caching finding');
    assert.ok(run.held_back.some((row) => /cach/i.test(`${row.thing} ${row.reason}`)), 'the judge held it back itself');
    assert.match(text, /bolt\.new[^\n]*prompt cach[^\n]*the judge held it back itself/i);
  });

  it('what it says of @ai-sdk/anthropic is what happened', () => {
    assert.ok(loadRun('bolt.new').held_back.some((row) => row.thing.startsWith('@ai-sdk/anthropic')));
  });
});

describe('both held-out runs', () => {
  for (const name of ['bolt.new', 'farfalle']) {
    it(`${name}: labels are the only allowed ones, and nothing was measured`, () => {
      for (const finding of loadRun(name).findings) {
        assert.notEqual(finding.proof, 'measured');
        assert.ok(finding.sources.length > 0);
        assert.ok(finding.where.length > 0);
      }
    });
  }
});
