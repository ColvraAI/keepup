// data/briefs/README.md: "must find at least these findings for these two repos at these commits, or say why not.
// They also must not show anything from the Checked and held back tables." It reads the saved runs, so npm test
// stays offline. The commits are pinned, and every assertion is by file, lever, model id or source: a judge can move a
// citation by a line and be right. test/replay.test.ts proves the runs themselves come from the real pipeline.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { droppedCategory } from '../src/brief.ts';
import { listRepoFiles } from '../src/git-files.ts';
import { maskText } from '../src/mask.ts';
import { rankFindings } from '../src/rank.ts';
import type { Finding, Run } from '../src/run-shape.ts';
import { EFFECT_WORDS, PROOF_LABELS } from '../src/run-shape.ts';
import { KEY, keyViolations, rowPlaces } from './answer-key.ts';
import { assertCloneThere, ROOT, skipWithoutClone } from './helpers.ts';
import { knownSource, misstatedModelDates, unreadableNumbers } from './run-provenance.ts';

const COMMITS: Readonly<Record<string, { commit: string; clone: string }>> = {
  'anything-llm': { commit: '9caf2b4', clone: 'tmp/anything-llm' },
  aura: { commit: '5efb4e8', clone: 'tmp/aura' },
};

function loadRun(name: string): Run {
  return JSON.parse(readFileSync(join(ROOT, 'data', 'runs', `${name}.json`), 'utf8')) as Run;
}

function at(run: Run, file: string, line?: number): Finding | undefined {
  return run.findings.find((finding) => finding.where.some((place) => place.file === file && (line === undefined || place.line === line)));
}

function linksOf(finding: Finding): string[] {
  return [...finding.sources, ...finding.options.map((option) => option.source)];
}

function shownText(run: Run): string[] {
  return [
    ...run.findings.flatMap((finding) => [finding.title, finding.why, ...finding.options.flatMap((option) => [option.name, option.what, option.needs]), ...linksOf(finding)]),
    ...run.watching.flatMap((item) => [item.thing, item.why, item.source]),
  ];
}

/** Every sentence a founder reads, held-back rows included. */
function allProse(run: Run): string[] {
  return [...shownText(run), ...run.held_back.flatMap((row) => [row.thing, row.reason])];
}

function heldNamed(run: Run, name: RegExp): Run['held_back'][number] | undefined {
  return run.held_back.find((row) => name.test(row.thing));
}

function assertNotShown(run: Run, wrong: RegExp): void {
  const hit = shownText(run).find((text) => wrong.test(text));
  assert.equal(hit, undefined, `${wrong} is in the "held back" table but was shown: ${hit}`);
}

function assertNotAt(run: Run, file: string, line?: number): void {
  const finding = at(run, file, line);
  assert.equal(finding, undefined, `${file}:${line ?? ''} should be held back, but is in "${finding?.title}"`);
}

describe('both real runs', () => {
  for (const [name, { commit, clone }] of Object.entries(COMMITS)) {
    const run = loadRun(name);

    it(`${name} is a real, complete, judged run at the pinned commit`, () => {
      assert.equal(run.version, 1);
      assert.ok(run.commit?.startsWith(commit), `commit ${run.commit}`);
      assert.equal(run.as_of, '2026-10-31');
      assert.ok(run.profile, 'it has a profile');
      assert.ok(run.profile.jobs.length >= 3);
      assert.ok(run.usage, 'Claude was really used');
      assert.equal(run.usage.model, 'claude-sonnet-5-5');
      assert.ok(run.usage.usd + (run.usage.replayed_usd ?? 0) > 0);
      assert.equal(run.incomplete, undefined);
      assert.ok(run.candidates_considered > 50);
      assert.deepEqual(run.ran, { search: true, judge: true, online: true });
    });

    it(`${name}: ranked in the stated order, from 1, with no finding or place repeated`, () => {
      const reranked = rankFindings(run.findings, run.as_of).findings.map((finding) => finding.title);
      assert.deepEqual(run.findings.map((finding) => finding.title), reranked);
      assert.deepEqual(run.findings.map((finding) => finding.rank), run.findings.map((_, index) => index + 1));
      assert.equal(new Set(run.findings.map((finding) => finding.title)).size, run.findings.length);
      for (const finding of run.findings) {
        const places = finding.where.map((place) => `${place.file}:${place.line}`);
        assert.equal(new Set(places).size, places.length, finding.title);
      }
    });

    it(`${name}: a founder never reads keepup's insides, or a first person`, () => {
      for (const text of allProse(run)) {
        assert.ok(!/\blevers?\b/i.test(text), text);
        assert.ok(!/\b(?:the|this|its) records?\b/i.test(text), text);
        assert.ok(!/\bI\b|\bI'm\b|\bwe\b/.test(text), text);
        assert.ok(!/switched off by default/i.test(text), text);
      }
    });

    it(`${name}: nothing from an answer key was dropped, and what was dropped says why in a category`, () => {
      for (const dropped of run.checks.dropped) {
        assert.notEqual(droppedCategory(dropped), 'a check failed', `${dropped.what}: ${dropped.why}`);
        assert.ok(!/whisper|rmcp|sentry|embeddinggemma|SKILL\.md|prompt_caching/i.test(dropped.what) || /wish to drop|claim that nothing sends|judge's note/.test(dropped.what), dropped.what);
      }
    });

    it(`${name}: every finding has the five effect words, a proof label, a source and a place`, () => {
      assert.ok(run.findings.length >= 4);
      for (const finding of run.findings) {
        assert.ok(finding.effect.length > 0);
        for (const word of finding.effect) assert.ok((EFFECT_WORDS as readonly string[]).includes(word), word);
        assert.ok(PROOF_LABELS.includes(finding.proof));
        assert.notEqual(finding.proof, 'measured', 'the judge measures nothing');
        assert.ok(finding.sources.length > 0);
        assert.ok(finding.where.length > 0);
      }
    });

    it(`${name}: every date, price and multiplier a founder reads is behind that finding, and every source is known`, () => {
      for (const finding of run.findings) {
        assert.deepEqual(unreadableNumbers(run, finding), [], finding.title);
        assert.deepEqual(misstatedModelDates(run, finding), [], finding.title);
        for (const url of linksOf(finding)) assert.ok(knownSource(url), `${finding.title}: ${url}`);
      }
      for (const item of run.watching) assert.ok(knownSource(item.source), item.thing);
      for (const row of run.held_back) if (row.source) assert.ok(knownSource(row.source), row.thing);
    });

    it(`${name}: nothing the program proved went missing: every model code sends is on a finding, or a row or a judge's checked call says why not`, () => {
      const placed = new Set(run.findings.flatMap((finding) => finding.where.map((place) => `${place.file}:${place.line}`)));
      const said = [...run.held_back.map((row) => row.thing), ...run.checks.dropped.map((item) => item.where ?? '')].join('\n');
      for (const check of run.exact) {
        if (check.kind !== 'model' || check.routed_to) continue;
        for (const place of check.live_places) assert.ok(placed.has(`${place.file}:${place.line}`) || said.includes(`${place.file}:${place.line}`), `${check.model} at ${place.file}:${place.line}`);
      }
    });

    it(`${name}: nothing says it was measured when it wasn't, or that a registry marked anything`, () => {
      for (const text of allProse(run)) {
        assert.ok(!/\b(?:independently measured|we measured|measured on your)\b/i.test(text), text);
        assert.ok(!/\bregistry (?:marks?|says?|calls?)\b|\bmarked official\b/i.test(text), text);
      }
    });

    it(`${name}: a thing is watched or held back, never both, and a watching row names the job and what blocks it`, () => {
      const family = (text: string) => text.toLowerCase().split('/').pop()?.split(/[^a-z0-9]+/)[0] ?? '';
      const watched = new Set(run.watching.map((item) => family(item.thing)));
      for (const row of run.held_back) assert.ok(!watched.has(family(row.thing)), row.thing);
      for (const item of run.watching) assert.ok(item.why.length >= 40 && !/^It fits a job this product has/.test(item.why), item.why);
    });

    it(`${name}: every profile citation and finding place is really on that line at the commit`, { skip: skipWithoutClone(clone) }, () => {
      assertCloneThere(clone);
      const { files } = listRepoFiles(join(ROOT, clone), { commit });
      const masked = new Map(files.map((file) => [file.path, maskText(file.text).split('\n')]));
      for (const finding of run.findings) {
        for (const place of finding.where) {
          const line = masked.get(place.file)?.[place.line - 1];
          assert.ok(line?.includes(place.text.trim()), `${place.file}:${place.line} should say ${place.text}`);
        }
      }
      for (const job of run.profile?.jobs ?? []) {
        assert.equal(job.cited?.length, job.where.length, job.job);
        for (const place of job.cited ?? []) {
          const line = masked.get(place.file)?.[place.line - 1] ?? '';
          const manifest = place.text.match(/^(@?[^@\s]+)@(.+)$/);
          assert.ok(manifest ? line.includes(manifest[1]) && line.includes(manifest[2]) : line.includes(place.text), `${place.file}:${place.line} should say ${place.text}`);
        }
      }
    });
  }
});

describe('the key, finding by finding', () => {
  for (const name of Object.keys(KEY)) {
    it(`${name}: exactly the key's findings, each with its exact proof, effect, successors and options; the database and profile it says it had`, () => {
      assert.deepEqual(keyViolations(name, loadRun(name)), []);
    });
  }
});

describe('a held-back row\'s file and line', () => {
  const CLONES: Readonly<Record<string, { commit: string; clone: string }>> = {
    ...COMMITS,
    'anything-llm-claude-only': COMMITS['anything-llm'],
    'bolt.new': { commit: 'HEAD', clone: 'tmp/full/bolt.new' },
    farfalle: { commit: 'HEAD', clone: 'tmp/full/farfalle' },
  };
  for (const [name, { commit, clone }] of Object.entries(CLONES)) {
    it(`${name}: is really there at the commit`, { skip: skipWithoutClone(clone) }, () => {
      assertCloneThere(clone);
      const { files } = listRepoFiles(join(ROOT, clone), { commit });
      const masked = new Map(files.map((file) => [file.path, maskText(file.text).split('\n')]));
      const run = loadRun(name);
      assert.ok(rowPlaces(run).length > 0 || name === 'farfalle' || name === 'bolt.new', 'rows with places');
      for (const place of rowPlaces(run)) {
        const line = masked.get(place.file)?.[place.line - 1];
        assert.notEqual(line, undefined, `${place.thing}: ${place.file}:${place.line}`);
        const id = place.thing.match(/^([\w.-]+), a /)?.[1];
        if (id) assert.ok(line?.includes(id), `${place.file}:${place.line} should hold ${id}: ${line}`);
      }
    });
  }
});

describe('Mintplex-Labs/anything-llm at 9caf2b4 finds', () => {
  const run = loadRun('anything-llm');
  const gemini = at(run, 'server/models/systemSettings.js', 919);

  it('0. the Gemini default was shut down on 1 Jun, and it is never the headline: the router leads', () => {
    assert.ok(gemini, 'systemSettings.js:919');
    assert.ok((gemini.rank as number) > (at(run, 'server/utils/agents/aibitat/plugins/router-classifier.js', 71)?.rank ?? 99));
    assert.deepEqual(gemini.effect, ['keeps working']);
    assert.equal(gemini.proof, 'vendor claim');
    assert.ok(gemini.locked);
    assert.equal(gemini.deadline, '2026-06-01');
    assert.match(gemini.title, /gemini-2\.0-flash-lite was shut down on 1 Jun 2026/);
    assert.match(gemini.why, /^gemini-2\.0-flash-lite was shut down on 1 Jun 2026\./, 'it opens on the live default');
    for (const [file, line] of [['server/utils/AiProviders/gemini/index.js', 53], ['server/utils/agents/aibitat/providers/gemini.js', 17], ['server/utils/agents/index.js', 388]] as const) assert.ok(at(run, file, line) === gemini, `${file}:${line}`);
  });

  it('0. it names Google\'s literal successor for each model, and a chain only as its own note', () => {
    assert.ok(gemini);
    assert.match(gemini.why, /gemini-2\.0-flash-lite was shut down on 1 Jun 2026\. Announced on 18 Feb 2026\. Named successor: gemini-3\.1-flash-lite\./);
    assert.match(gemini.why, /gemini-3\.1-flash-lite-preview was shut down[^.]*\.[^N]*Named successor: gemini-3\.1-flash-lite\./);
    assert.match(gemini.why, /gemini-3\.1-flash-lite itself shuts down no earlier than 7 May 2027\. Google names gemini-3\.5-flash-lite after it\./);
    assert.ok(!/gemini-3\.6-flash,? should be the default|replacement, gemini-3\.6-flash/.test(gemini.why), 'not the wrong replacement');
  });

  it('0. it keeps Google\'s words: an earliest date is one, "deprecated on" isn\'t a shutdown, and auto-routing is no outage', () => {
    assert.ok(gemini);
    assert.match(gemini.why, /gemini-omni-flash-preview was due to shut down no earlier than 22 Oct 2026/);
    assert.ok(!/gemini-omni-flash-preview was shut down|30 Sep/.test(gemini.why));
    assert.ok(!/gemini-3\.5-flash/.test(gemini.title));
    assert.ok(!gemini.where.some((place) => place.text.includes('"gemini-3.5-flash"')));
    assert.match(heldNamed(run, /^gemini-3\.5-flash, a deprecated model/)?.reason ?? '', /automatically routed to gemini-3\.6-flash/);
    const later = at(run, 'server/utils/AiProviders/gemini/defaultModels.js', 11);
    assert.ok(later, 'the later Google models');
    assert.match(later.why, /gemini-3\.1-flash-lite shuts down no earlier than 7 May 2027/);
    assert.match(later.why, /gemini-2\.5-flash-image shuts down no earlier than 15 Mar 2027/);
    assert.ok(!/shuts down on (?:7 May|15 Mar)/.test(`${later.title} ${later.why}`));
  });

  it('0. the agent fallback at agents/index.js:388 is never called a picker', () => {
    assert.ok(gemini);
    assert.match(gemini.why, /defaultModels\.js feeds a picker/);
    assert.ok(!/agents\/index\.js feeds?/.test(gemini.why) && !/, server\/utils\/agents\/index\.js feed/.test(gemini.why));
    const check = run.exact.find((item) => item.kind === 'model' && item.model === 'gemini-2.0-flash-lite');
    assert.ok(check?.kind === 'model' && check.live_places.every((place) => !place.catalog));
  });

  it('example scripts nothing loads are a row, never a finding, and they\'d never outrank a live break', () => {
    assert.ok(!run.findings.some((finding) => finding.where.some((place) => place.file.includes('aibitat/example/'))));
    assert.match(heldNamed(run, /^gpt-4o, a retiring model/)?.reason ?? '', /example script that nothing in the app loads/);
  });

  it('the order leads with levers: the router, then the other gains, and only then what retires, a list\'s choices last', () => {
    const rank = (file: string, line: number) => at(run, file, line)?.rank ?? 99;
    const router = rank('server/utils/agents/aibitat/plugins/router-classifier.js', 71);
    const whisper = rank('collector/utils/WhisperProviders/OpenAiWhisper.js', 11);
    const tts = rank('server/utils/TextToSpeech/openAi/index.js', 15);
    const embedder = rank('server/utils/EmbeddingEngines/native/index.js', 8);
    const skills = at(run, 'server/utils/agents/imported.js')?.rank ?? 99;
    assert.equal(router, 1);
    const levers = Math.max(embedder, skills);
    assert.ok(router < levers);
    for (const retiring of [gemini?.rank ?? 99, whisper, tts]) assert.ok(retiring > levers, String(retiring));
    for (const finding of run.findings.filter((item) => item.reach === 'picker' || item.reach === 'undated')) assert.ok(finding.rank as number > tts, finding.title);
  });

  it('1. the model router can use a decision model, both options side by side', () => {
    const finding = at(run, 'server/utils/agents/aibitat/plugins/router-classifier.js', 71);
    assert.ok(finding, 'router-classifier.js:71');
    assert.deepEqual([...finding.effect].sort(), ['cheaper', 'faster']);
    assert.equal(finding.proof, 'vendor claim');
    assert.equal(finding.effort, 'A day');
    const links = linksOf(finding).join(' ');
    assert.match(links, /developers\.openai\.com\/api\/docs\/guides\/decisions/);
    assert.match(links, /typesafe\.ai/);
    assert.ok(finding.options.length >= 2);
    assert.match(finding.why, /fallback/, 'today\'s call stays as the fallback');
  });

  it("2. OpenAI's whisper-1 shuts down on 26 Feb 2027, wherever it's sent or offered", () => {
    const finding = at(run, 'collector/utils/WhisperProviders/OpenAiWhisper.js', 11);
    assert.ok(finding, 'OpenAiWhisper.js:11');
    assert.deepEqual(finding.effect, ['keeps working']);
    assert.equal(finding.proof, 'vendor claim');
    assert.equal(finding.deadline, '2027-02-26');
    assert.match(finding.title, /whisper-1/);
    assert.match(finding.why, /gpt-transcribe/);
    assert.match(finding.why, /gpt-live-transcribe/);
    assert.ok(finding.locked, 'no judge can drop it');
    assert.ok(finding.where.some((place) => place.file === 'server/utils/SpeechToText/openAi/index.js' && place.line === 8));
    assert.ok(finding.where.some((place) => place.file === 'server/utils/helpers/customModels.js'), 'the picker\'s fallback list, with the two siblings that shut down the same day');
    assert.match(finding.why, /customModels\.js feeds a picker/);
    assert.ok(!finding.where.some((place) => /lemonade|openAiGeneric/i.test(place.file)), 'a server that is not OpenAI is not on this');
    assert.ok(!finding.where.some((place) => /console\.\w+\(/.test(place.text)), 'nor is a log line');
    assert.ok(!heldNamed(run, /customModels\.js/), 'and no row calls that list dead');
  });

  it('3. a newer on-device embedder, named for what it adds and what moving takes', () => {
    const finding = run.findings.find((item) => /embeddinggemma-2/.test(linksOf(item).join(' ')));
    assert.ok(finding, 'a finding with the EmbeddingGemma 2 source');
    assert.ok(finding.where.some((place) => place.file === 'server/utils/EmbeddingEngines/native/index.js' && place.line === 8), 'the default it replaces');
    assert.match(finding.why, /@huggingface\/transformers 4\.3\.1 or later/, 'the floor');
    assert.match(finding.why, /these files load the old package and move with it:/, 'the listed files move too');
    assert.ok(!/\b(?:probably|likely)\b/.test(finding.why), 'the move is a requirement');
    assert.ok(!/@huggingface\/transformers, which is also used by/.test(finding.why));
    assert.ok(finding.sources.some((url) => url === 'https://www.npmjs.com/package/@huggingface/transformers'));
    assert.deepEqual(finding.effect, ['better answers'], 'the table it cites already offers a 100+ language model, so this is not a capability it lacked');
    assert.equal(finding.proof, 'vendor claim');
    assert.ok(!/\binstead of the English-only\b/.test(finding.title));
    assert.match(finding.why, /re-embed/i);
    assert.match(finding.why, /@huggingface\/transformers/);
    assert.match(finding.why, /Rerankers\/native/, 'the reranker moves too');
    assert.match(finding.why, /localWhisper/, 'and local Whisper');
    for (const [file, line] of [['server/package.json', 41], ['collector/package.json', 20]] as const) assert.ok(at(run, file, line) === finding, `${file}:${line}`);
    assert.ok(!heldNamed(run, /@xenova\/transformers/), 'a row can\'t call it fine while this needs it moved');
  });

  it('4. load skills in the open Agent Skills format', () => {
    const finding = at(run, 'server/utils/agents/imported.js');
    assert.ok(finding, 'imported.js');
    assert.ok(finding.effect.includes('new capability'));
    assert.equal(finding.proof, 'adoption only');
    assert.match(linksOf(finding).join(' '), /agentskills\.io/);
    assert.match(finding.title, /SKILL\.md/);
    assert.match(finding.why, /SKILL\.md/);
  });

  it('also: text to speech stops working on 6 Jan 2027, and the fix is a code change', () => {
    const finding = at(run, 'server/utils/TextToSpeech/openAi/index.js', 15);
    assert.ok(finding, 'openAi/index.js:15');
    assert.equal(finding.deadline, '2027-01-06');
    assert.deepEqual(finding.effect, ['keeps working']);
    assert.match(finding.why, /gpt-realtime-2\.1-mini/);
  });

  it('the image generator\'s default goes to the replacement Google names for it, and to no other', () => {
    const finding = at(run, 'server/utils/ImageGenerators/gemini/index.js', 4);
    assert.ok(finding, 'ImageGenerators/gemini/index.js:4');
    assert.notEqual(finding.reach, 'picker', 'it is a default code sends, not only a choice on a list');
    const check = run.exact.find((item) => item.kind === 'model' && item.model === 'gemini-3.1-flash-image');
    assert.ok(check?.kind === 'model');
    assert.deepEqual(check.successors, ['gemini-nano-banana-2.1'], 'tmp/vendor-docs/gemini-deprecations.md: the replacement column, on a row with no shutdown date');
    assert.equal(check.effective, null);
    const option = finding.options.find((item) => item.name === 'gemini-nano-banana-2.1');
    assert.match(option?.what ?? '', /replacement for gemini-3\.1-flash-image\.$/);
    assert.match(option?.needs ?? '', /gemini-3\.1-flash-image to it at server\/utils\/ImageGenerators\/gemini\/index\.js:4/);
    assert.ok(!/gemini-3\.1-flash-image[^.]*(?:gemini-3\.1-flash-lite-image|gemini-3\.5-flash-lite)[^.]*\bsuccessors?\b/.test(finding.why.split('put the replacement on that list.')[1] ?? ''));
    assert.match(finding.why.split('put the replacement on that list.')[1] ?? '', /gemini-nano-banana-2\.1/, 'the judge reads the right successor too');
  });

  it('watching holds Indra and OXR, because they fit a job and can\'t run here yet', () => {
    assert.ok(run.watching.some((item) => /indra/i.test(item.thing)));
    const oxr = run.watching.find((item) => item.thing === 'OXR');
    assert.ok(oxr, 'OXR');
    assert.match(oxr.source, /SoMarkAI\/OXR/);
    assert.match(oxr.why, /Python/);
    assert.match(oxr.why, /no independent results/);
    assert.ok(!run.watching.some((item) => /StartLux/.test(item.thing)), 'it names the engines that run it, so its language label says nothing');
    assert.ok(!heldNamed(run, /^indra\b/i), 'watching or held back, not both');
  });
});

describe('Mintplex-Labs/anything-llm at 9caf2b4 holds back', () => {
  const run = loadRun('anything-llm');

  it('Claude Haiku 5.5 and temperature: already handled', () => {
    assertNotAt(run, 'server/utils/AiProviders/anthropic/index.js');
    assertNotShown(run, /haiku[ -]5/i);
  });
  it('GPT-6 Astra and the Responses API: already handled', () => {
    assertNotAt(run, 'server/utils/agents/aibitat/providers/openai.js');
    assertNotShown(run, /astra/i);
  });
  it('Nemotron 3.5 Rerank 8B and CLM v0.1 8B: too large for a CPU reranker, and it says so', () => {
    assertNotShown(run, /nemotron|clm[- ]v?0\.1/i);
    const row = heldNamed(run, /nemotron.*rerank/i);
    assert.ok(row, 'a held-back row');
    assert.match(row.reason, /load|ONNX/);
  });
  it('MCP TypeScript SDK 1.32.2: the range allows it, the lockfile doesn\'t have it, and that\'s a person\'s call', () => {
    assertNotAt(run, 'server/package.json', 36);
    assertNotShown(run, /modelcontextprotocol\/sdk/);
    const row = heldNamed(run, /@modelcontextprotocol\/sdk 1\.32\.2/);
    assert.match(row?.reason ?? '', /allows it, but server\/yarn\.lock:864 installs 1\.24\.3/);
    assert.match(row?.reason ?? '', /\(1\.32\.0\)/, 'it names the release between them');
    assert.match(row?.reason ?? '', /person's call/);
  });
  it('a row is true of every place: a menu label isn\'t a gateway, and "nothing sends it" never covers a gateway default', () => {
    for (const row of run.held_back.filter((item) => /AzureAiOptions/.test(item.thing))) assert.ok(!/gateway/i.test(row.reason), row.thing);
    assert.match(heldNamed(run, /^gpt-3\.5-turbo, a retired model/)?.reason ?? '', /label on a token-limit choice/);
    const mini = heldNamed(run, /^gpt-5-mini, a retiring model/);
    assert.match(mini?.reason ?? '', /^Sent through CometAPI\. OpenAI retires this id on 11 Dec 2026, and keepup can't see CometAPI's plan, so check with them\./);
    assert.ok(!/nothing sends it|your platform|keeps its own schedule/.test(mini?.reason ?? ''), 'nothing read says what CometAPI will do, and it is not the founder\'s platform');
  });
  it('prompt caching for Claude: a product choice, behind a setting', () => {
    assert.ok(!run.findings.some((finding) => finding.lever === 'ADV-2026-1007-anthropic-prompt-caching'));
    assertNotAt(run, 'server/utils/agents/aibitat/providers/ai-provider.js');
  });
  it('a table of sizes, and retired ids in tests and comments, are rows with the true reason', () => {
    assert.match(heldNamed(run, /model ids in server\/utils\/AiProviders\/modelMap\/legacy\.js/)?.reason ?? '', /table of model sizes/);
    assert.match(heldNamed(run, /text-embedding-004/)?.reason ?? '', /comment/);
    assert.match(heldNamed(run, /claude-3-5-sonnet, a retired model/)?.reason ?? '', /in a test/);
  });
  it('the list of models agents refuse is not a list of models it sends', () => {
    assertNotAt(run, 'frontend/src/pages/WorkspaceSettings/AgentConfig/AgentModelSelection/index.jsx');
    assertNotAt(run, 'server/utils/helpers/tiktoken.js');
  });
});

describe('Mintplex-Labs/anything-llm with --provider-only anthropic', () => {
  const run = loadRun('anything-llm-claude-only');

  it('keeps every retirement the code really sends, the same way for all of them', () => {
    assert.equal(run.provider_only, 'anthropic');
    for (const [file, line] of [['collector/utils/WhisperProviders/OpenAiWhisper.js', 11], ['server/utils/TextToSpeech/openAi/index.js', 15], ['server/models/systemSettings.js', 919]] as const) {
      const finding = at(run, file, line);
      assert.ok(finding?.locked, `${file}:${line}`);
    }
  });

  it('never says a retirement on file has no notice', () => {
    for (const row of run.held_back) assert.ok(!/\b(?:tts-1|gpt-5-mini|gpt-5\.1)\b.*\bno (?:\w+ )?(?:notice|record|date)\b/i.test(`${row.thing} ${row.reason}`), row.thing);
  });

  it('never suggests another provider\'s API, and a neutral one still shows', () => {
    const router = at(run, 'server/utils/agents/aibitat/plugins/router-classifier.js', 71);
    assert.ok(router);
    assert.ok(!linksOf(router).some((url) => /developers\.openai\.com/.test(url)));
    assert.match(linksOf(router).join(' '), /typesafe\.ai/);
  });
});

describe('mezmo/aura at 5efb4e8 finds', () => {
  const run = loadRun('aura');

  it('1. vendors\' own MCP servers for incident tools it can\'t reach yet: Sentry, SigNoz and Dynatrace', () => {
    const finding = run.findings.find((item) => /getsentry\/sentry-mcp/.test(linksOf(item).join(' ')));
    assert.ok(finding, 'a finding with the Sentry server');
    const links = linksOf(finding).join(' ');
    assert.match(links, /SigNoz\/signoz-mcp-server/);
    assert.match(links, /dynatrace-oss\/dynatrace-managed-mcp/);
    assert.ok(finding.effect.includes('new capability'));
    assert.equal(finding.options.length, 3);
    assert.equal(finding.effort, 'Hours');
    const words = [finding.title, finding.why, ...finding.options.flatMap((option) => [option.name, option.what, option.needs])].join('\n');
    assert.ok(!/\bofficial\b/i.test(words), 'keepup\'s own name match is not a fact about a server, and Dynatrace\'s README says community-supported');
    assert.ok(!/registry marks/i.test(words));
  });

  it('2. two example configs use Claude models that are retired or retiring, and it says what to check before switching', () => {
    const retired = at(run, 'examples/minimal/anthropic.toml', 14);
    assert.ok(retired, 'anthropic.toml:14');
    assert.match(retired.where.find((place) => place.file.endsWith('anthropic.toml'))?.text ?? '', /claude-sonnet-4-20250514/);
    const retiring = at(run, 'examples/complete/reasoning-models.toml', 61);
    assert.ok(retiring, 'reasoning-models.toml:61');
    assert.match(retiring.where.find((place) => place.file.endsWith('reasoning-models.toml'))?.text ?? '', /claude-sonnet-4-5-20250929/);
    assert.match(retiring.why, /30 Nov 2026/);
    assert.deepEqual(retired.effect, ['keeps working']);
    assert.ok(retired.locked);
    assert.match(retiring.why, /tool_choice[^.]*returns a 400 error/, 'forced tool use breaks on the successor');
    assert.match(retiring.why, /tool_choice isn't anywhere in this repo's code/, 'and the program looked');
    assert.match(retiring.why, /This repo sets budget_tokens at examples\/complete\/reasoning-models\.toml:71 and temperature at examples\/complete\/reasoning-models\.toml:63/, 'the one thing that breaks the swap');
    assert.ok(!/computer_20251124/.test(retiring.why), 'a tool the repo doesn\'t use is noise');
    assert.match(retired.why, /Named successor: claude-sonnet-5-5/);
    assert.ok(retired.where.some((place) => place.file === 'examples/minimal/openrouter.toml' && place.line === 22), 'the same model through a gateway');
    assert.match(retired.why, /examples\/minimal\/openrouter\.toml:22 asks OpenRouter for anthropic\/claude-sonnet-4, the same model, and OpenRouter's model list no longer has it/);
    assert.match(retiring.why, /Sonnet 5\.5|sonnet-5-5/);
    assert.ok(!/Named successor: Claude Sonnet 4\.[56]/.test(`${retired.why} ${retiring.why}`), 'one successor, the current one');
  });

  it('3. the MCP client library is three major versions behind, and its own release notes say what that costs', () => {
    const finding = at(run, 'Cargo.toml', 49);
    assert.ok(finding, 'Cargo.toml:49');
    assert.match(finding.title, /rmcp/);
    assert.match(finding.why, /3\.8\.0/);
    assert.equal(finding.effort, 'A project');
    assert.equal(finding.proof, 'vendor claim');
    assert.deepEqual(finding.effect, ['keeps working']);
    assert.ok(finding.locked, 'a judge can\'t drop it on a whim');
    assert.match(finding.title, /stop SSE reconnects/, 'it leads with what this code gains');
    assert.ok(!/\bcancel/i.test(finding.title));
    assert.match(finding.why, /Its release notes list: stop SSE reconnects[^;.]*\(3\.8\.0\)/);
    assert.match(finding.why, /2026-07-28 \(3\.0\.0\)/, 'the spec gap');
    const gains = finding.why.match(/Its release notes list: ([^.]*)\./)?.[1] ?? '';
    assert.ok(!/cancel an abandoned/.test(gains), 'the key: not a gain as written');
    assert.match(finding.why, /Not a gain here, as written: cancel an abandoned tools\/call[^.]*\(3\.6\.0\)/);
    assert.ok(!/\bbrings cancellation\b/i.test(finding.why));
    assert.ok(!/OIDC/.test(gains), 'nothing shows AURA uses enterprise exchange');
    assert.ok(finding.where.some((place) => place.file === 'Cargo.toml' && place.line === 40), 'the rig fork carries it, so this is a project');
    assert.match(finding.why, /Cargo\.toml:40 also carries its own rmcp feature/);
    assert.ok(finding.sources.some((url) => /CHANGELOG\.md$/.test(url)), 'the changelog itself is cited');
    assert.ok(!/Check the release notes/.test(finding.why));
  });

  it('4. Claude prompt caching is opt-in', () => {
    const finding = at(run, 'examples/reference.toml', 234);
    assert.ok(finding, 'reference.toml:234');
    assert.ok(finding.where.some((place) => place.file === 'crates/aura-config/src/config.rs' && place.line === 102));
    assert.ok(finding.effect.includes('cheaper'));
    assert.equal(finding.proof, 'vendor claim');
    assert.equal(finding.effort, 'Hours');
  });
});

describe('mezmo/aura at 5efb4e8 holds back', () => {
  const run = loadRun('aura');

  it('the retired model in a test fixture, writer.rs:225', () => {
    assertNotAt(run, 'crates/aura-config/src/writer.rs');
    const row = run.held_back.find((item) => /claude-3-sonnet-20240229/.test(item.thing));
    assert.ok(row);
    assert.match(row.reason, /#\[cfg\(test\)\]/);
  });
  it('gpt-5.1 in test configs: on the deprecations page, and truly not sent from here', () => {
    const row = heldNamed(run, /gpt-5\.1/);
    assert.ok(row, 'a row');
    assert.match(row.reason, /test/);
    assert.ok(!/not named/.test(row.reason));
    assert.equal(row.date, '2027-04-01');
    assert.ok(!run.findings.some((finding) => finding.where.some((place) => /integration-|test_support|test_fixtures/.test(place.file))), 'test configs and helpers are never where a finding points');
  });
  it('Grafana MCP: already integrated', () => assertNotShown(run, /grafana/i));
  it('the community observability gateway', () => assertNotShown(run, /observability[- ]gateway|thotischner/i));
  it('Rust AI gateways', () => assertNotShown(run, /\bgateway\b|antirion|respan/i));
  it('new open-source SRE agent platforms: a competitor is never a lever', () => assertNotShown(run, /aegisops/i));
});
