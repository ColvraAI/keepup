// The provider's table is the literal answer for a successor. The changelog knows what's really gone, and its wording
// has to be kept: "will be deprecated on" isn't "shut down on".
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { retirements } from '../src/db.ts';
import { checkModels } from '../src/exact-checks.ts';
import { findRetirement, withPageRows, extractRetirements } from '../src/retirements.ts';
import { findingsFromExact } from '../src/findings.ts';
import { unloadedExampleLookup } from '../src/catalog-use.ts';

const WINDOW = { since: '2026-09-01', until: '2026-10-31' };
const AS_OF = '2026-10-31';
const place = (over: object = {}) => ({ file: 'a.js', line: 1, text: 'x', context: 'code' as const, commented: false, route: 'direct' as const, ...over });
const modelId = (id: string, places: object[] = [{}]) => ({ id, provider: 'google' as const, places: places.map(place) });

describe('real Gemini facts', () => {
  const all = retirements();

  it('gemini-2.0-flash-lite names the table\'s successor, gemini-3.1-flash-lite, not a chain', () => {
    assert.deepEqual(findRetirement('gemini-2.0-flash-lite', all)?.successors, ['gemini-3.1-flash-lite']);
    assert.deepEqual(findRetirement('gemini-2.0-flash', all)?.successors, ['gemini-3.6-flash']);
    assert.deepEqual(findRetirement('gemini-3.1-flash-lite-preview', all)?.successors, ['gemini-3.1-flash-lite']);
  });

  it('"will be deprecated on 30 Sep" is not a shutdown; the table\'s date and successor stand', () => {
    const row = findRetirement('gemini-omni-flash-preview', all);
    assert.equal(row?.effective, '2026-10-22');
    assert.equal(row?.earliest, true);
    assert.deepEqual(row?.successors, ['gemini-omni-1.1-flash']);
    const [check] = checkModels([modelId('gemini-omni-flash-preview')], all, AS_OF);
    assert.equal(check.effective, null, 'an earliest date that has passed is not a shutdown');
    assert.equal(check.earliest_date, '2026-10-22');
  });

  it('a date the changelog says plainly stays firm, and "now shut down" stays retired', () => {
    assert.equal(findRetirement('gemini-3.1-flash-image-preview', all)?.earliest, undefined);
    assert.equal(findRetirement('gemini-2.0-flash-lite', all)?.status, 'retired');
    assert.equal(findRetirement('gemini-2.0-flash-lite', all)?.earliest, undefined);
  });

  it('carries Google\'s auto-routing', () => {
    const row = findRetirement('gemini-3.5-flash', all);
    assert.equal(row?.routed_to, 'gemini-3.6-flash');
    assert.match(row?.routed_sentence ?? '', /automatically routed to gemini-3\.6-flash/);
  });

  it('Anthropic\'s page beats the release note\'s older successor', () => {
    assert.deepEqual(findRetirement('claude-sonnet-4-20250514', all)?.successors, ['claude-sonnet-5-5']);
    assert.equal(findRetirement('whisper-1', all)?.source, 'https://developers.openai.com/api/docs/changelog');
    assert.deepEqual([...(findRetirement('whisper-1', all)?.successors ?? [])].sort(), ['gpt-live-transcribe', 'gpt-transcribe']);
  });
});

describe('extractRetirements wording', () => {
  const entry = (text: string) => ({ provider: 'gemini' as const, date: '2026-08-27', url: 'https://x.example', change: null, tags: [], text });

  it('a date with no shutdown word is only a deprecation', () => {
    const [row] = extractRetirements([entry('The existing gemini-omni-flash-preview endpoint will be deprecated on September 30, 2026.')]);
    assert.equal(row.status, 'deprecated');
    assert.equal(row.effective, null);
  });

  it('a date with a shutdown word is one', () => {
    const [row] = extractRetirements([entry('The gemini-3-pro-image-preview model is deprecated and will be shut down on June 25, 2026.')]);
    assert.equal(row.status, 'retiring');
    assert.equal(row.effective, '2026-06-25');
  });

  it('withPageRows: a page row can\'t turn a firm "shut down" into an earliest date', () => {
    const rows = [{ id: 'gemini-2.0-x', provider: 'google', date: '2026-06-01', successors: ['gemini-y'], earliest: true, note: 'n', source: 'https://page.example' }];
    const found = extractRetirements([{ ...entry('The following models are now shut down : gemini-2.0-x'), date: '2026-06-01' }]);
    const [merged] = withPageRows(found, rows);
    assert.equal(merged.status, 'retired');
    assert.equal(merged.earliest, undefined);
    assert.deepEqual(merged.successors, ['gemini-y']);
    assert.equal(merged.page_source, 'https://page.example');
  });
});

describe('earliest dates are said as "no earlier than"', () => {
  const retiring = { provider: 'gemini' as const, id: 'gemini-a', name: null, status: 'retiring' as const, announced: null, effective: '2027-03-15', successors: ['gemini-b'], source: 'https://p.example', sentence: 's', earliest: true };

  it('in the why and the title', () => {
    const [check] = checkModels([modelId('gemini-a')], [retiring], AS_OF);
    assert.equal(check.earliest, true);
    const { findings } = findingsFromExact([check], { lineText: () => 'x', window: WINDOW });
    assert.match(findings[0].why, /shuts down no earlier than 15 Mar 2027/);
    assert.match(findings[0].title, /no earlier than 15 Mar 2027/);
    assert.ok(!/shuts down on/.test(`${findings[0].title} ${findings[0].why}`));
  });

  it('a group of them too', () => {
    const second = { ...retiring, id: 'gemini-c', effective: '2027-05-07' };
    const checks = checkModels([modelId('gemini-a'), modelId('gemini-c')], [retiring, second], AS_OF);
    const { findings } = findingsFromExact(checks, { lineText: () => 'x', window: WINDOW });
    assert.match(findings[0].title, /no earlier than 15 Mar 2027/);
  });
});

describe('what a line does, whatever its file holds', () => {
  const retired = { provider: 'gemini' as const, id: 'gemini-a', name: null, status: 'retired' as const, announced: null, effective: '2026-06-01', successors: [], source: 'https://p.example', sentence: 's' };
  const many = (text: string) => Array.from({ length: 9 }, (_, index) => ({ id: index === 0 ? 'gemini-a' : `gemini-${index}`, provider: 'google' as const, places: [place({ file: 'server/agents/index.js', line: index + 1, text: index === 0 ? text : '"x",' })] }));

  it('a ?? or || fallback in a file naming many models is a default that is sent, not a picker entry', () => {
    const [fallback] = checkModels(many('return process.env.PREF ?? "gemini-a";'), [retired], AS_OF, { catalogUse: () => 'picker' });
    assert.equal(fallback.live_places[0].catalog, undefined);
    const [or] = checkModels(many('process.env.PREF || "gemini-a",'), [retired], AS_OF, { catalogUse: () => 'picker' });
    assert.equal(or.live_places[0].catalog, undefined);
    const [entry] = checkModels(many('"gemini-a",'), [retired], AS_OF, { catalogUse: () => 'picker' });
    assert.equal(entry.live_places[0].catalog, true);
  });

  it('the live default leads the title, and the why opens on it', () => {
    const entry = { ...retired, id: 'deep-research-a', effective: '2026-10-23' };
    const checks = checkModels([
      modelId('deep-research-a', [{ file: 'list.js', text: '"deep-research-a",' }]),
      modelId('gemini-a', [{ file: 'b.js', text: 'env.PREF || "gemini-a",' }]),
    ], [entry, retired], AS_OF);
    const { findings } = findingsFromExact(checks, { lineText: () => 'x', window: WINDOW });
    assert.equal(findings[0].title, 'Your default gemini-a was shut down on 1 Jun 2026, and 1 more Google model is retired');
    assert.match(findings[0].why, /^gemini-a was shut down/);
    assert.equal(findings[0].deadline, '2026-06-01');
  });

  it('a label on a numeric menu choice says so', () => {
    const [check] = checkModels([modelId('gemini-a', [{ file: 'frontend/AzureAiOptions/index.jsx', text: '<option value={4096}>4,096 (gemini-a)</option>' }])], [retired], AS_OF);
    assert.equal(check.not_live[0].why, 'label');
    const { held_back } = findingsFromExact([check], { lineText: () => 'x', window: WINDOW });
    assert.match(held_back[0].reason, /label on a token-limit choice/);
    assert.ok(!/gateway/i.test(held_back[0].reason));
  });
});

describe('a held-back row is true of every place', () => {
  const gpt = { provider: 'openai' as const, id: 'gpt-5-mini', name: null, status: 'retiring' as const, announced: null, effective: '2027-01-01', successors: [], source: 'https://p.example', sentence: 's' };

  it('never says "nothing sends it" when a gateway default does, and names the gateway', () => {
    const [check] = checkModels([{ id: 'gpt-5-mini', provider: 'openai', places: [
      place({ file: 'docker/.env.example', text: '# X=gpt-5-mini', commented: true }),
      place({ file: 'server/utils/AiProviders/cometapi/index.js', line: 42, text: 'this.model = "gpt-5-mini";' }),
    ] }], [gpt], AS_OF);
    const { held_back } = findingsFromExact([check], { lineText: () => 'x', window: WINDOW });
    assert.match(held_back[0].thing, /cometapi\/index\.js:42/);
    assert.match(held_back[0].reason, /^Sent through CometAPI\. OpenAI retires this id on 1 Jan 2027, and keepup can't see CometAPI's plan, so check with them\./);
    assert.ok(!/your platform|keeps its own schedule/.test(held_back[0].reason));
    assert.match(held_back[0].reason, /comment/);
    assert.ok(!/nothing sends it/.test(held_back[0].reason));
  });
});

describe('an example nothing loads', () => {
  const files = new Map([
    ['server/utils/agents/aibitat/example/beginner.js', 'const m = "gpt-4o";'],
    ['server/utils/agents/aibitat/example/helper.js', 'require("./beginner");'],
    ['server/utils/agents/used/example/loaded.js', 'x'],
    ['server/app.js', 'require("./utils/agents/used/example/loaded");'],
    ['examples/minimal/run.js', 'x'],
    ['examples/minimal/openai.toml', 'model = "gpt-4o"'],
  ]);
  const unloaded = unloadedExampleLookup(files);

  it('a script deep in a source tree, loaded only from its own folder, sends nothing', () => {
    assert.equal(unloaded('server/utils/agents/aibitat/example/beginner.js'), true);
  });
  it('one the app imports does', () => assert.equal(unloaded('server/utils/agents/used/example/loaded.js'), false));
  it('a top-level examples folder is what users copy, so it counts', () => {
    assert.equal(unloaded('examples/minimal/run.js'), false);
    assert.equal(unloaded('examples/minimal/openai.toml'), false);
  });
});
