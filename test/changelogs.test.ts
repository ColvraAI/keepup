import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseChangelog, yearBlindWindowCount } from '../src/changelogs.ts';
import { extractRetirements, findRetirement } from '../src/retirements.ts';
import { changelogEntries } from '../src/db.ts';

const OPENAI_PAGE = `SOURCE https://developers.openai.com/api/docs/changelog
 nav
 Changelog
 Upcoming deprecations can be found on the deprecations page .
 October, 2026
 Oct 22
 Update 
 gpt-6-luna
 v1/decisions
 The Decisions API is now generally available.
 September, 2025
 Sep 3
 Feature 
 An old entry.
 Ask AI 
Docs agent
`;

const ANTHROPIC_PAGE = `SOURCE https://platform.claude.com/docs/en/release-notes/overview
 nav
 October 30, 2026  
 We have shipped a thing.
 May 30th, 2024  
 An old format.
 Was this page helpful?
 October 30, 2026 
 May 30th, 2024 
`;

const GEMINI_PAGE = `SOURCE https://ai.google.dev/gemini-api/docs/changelog
 nav
 This page documents updates to the Gemini API.
 October 30, 2026
 Computer Use generally available :
wrapped line.
 September 30, 2026.
 Last updated 2026-10-30 UTC.
 footer
`;

describe('parseChangelog', () => {
  it('OpenAI: takes the year from the month heading, and separates kind and tags from the text', () => {
    const entries = parseChangelog('openai', OPENAI_PAGE);
    assert.deepEqual(entries.map((e) => e.date), ['2026-10-22', '2025-09-03']);
    assert.equal(entries[0].url, 'https://developers.openai.com/api/docs/changelog');
    assert.deepEqual(entries[0].tags, ['gpt-6-luna', 'v1/decisions']);
    assert.equal(entries[0].change, 'Update');
    assert.equal(entries[0].text, 'The Decisions API is now generally available.');
  });

  it('Anthropic: strips the icon character, and ignores the date list after the page body', () => {
    const entries = parseChangelog('anthropic', ANTHROPIC_PAGE);
    assert.deepEqual(entries.map((e) => [e.date, e.text]), [['2026-10-30', 'We have shipped a thing.'], ['2024-05-30', 'An old format.']]);
  });

  it('Gemini: joins wrapped lines, and a date inside a sentence is no heading', () => {
    const entries = parseChangelog('gemini', GEMINI_PAGE);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].date, '2026-10-30');
    assert.match(entries[0].text, /Computer Use generally available : wrapped line\. September 30, 2026\./);
  });
});

describe('the real changelogs', () => {
  const entries = changelogEntries();
  const inWindow = (provider: string) => entries.filter((e) => e.provider === provider && e.date >= '2026-09-01' && e.date <= '2026-10-31').length;

  it('parse every dated entry in the window, by provider', () => {
    assert.equal(inWindow('openai'), 31);
    assert.equal(inWindow('anthropic'), 26);
    assert.equal(inWindow('gemini'), 13);
  });

  it('explain the 84 in the kit: 14 of OpenAI\'s Sep and Oct entries are from 2023 to 2025', () => {
    const openai = entries.filter((e) => e.provider === 'openai' && /-(09|10)-/.test(e.date) && e.date < '2026-01-01');
    assert.equal(openai.length, 14);
    assert.equal(yearBlindWindowCount(entries), 84);
  });
});

describe('extractRetirements', () => {
  const retirements = extractRetirements(changelogEntries());

  it('whisper-1: shutdown date, announcement date and both named successors', () => {
    const r = findRetirement('whisper-1', retirements);
    assert.equal(r?.effective, '2027-02-26');
    assert.equal(r?.announced, '2026-08-26');
    assert.deepEqual(r?.successors, ['gpt-live-transcribe', 'gpt-transcribe']);
    assert.equal(r?.source, 'https://developers.openai.com/api/docs/changelog');
    assert.equal(r?.status, 'retiring');
  });

  it('claude-sonnet-4-5-20250929: announced 30 Sep, retires 30 Nov, successor named', () => {
    const r = findRetirement('claude-sonnet-4-5-20250929', retirements);
    assert.equal(r?.announced, '2026-09-30');
    assert.equal(r?.effective, '2026-11-30');
    assert.deepEqual(r?.successors, ['Claude Sonnet 5.5']);
  });

  it('claude-sonnet-4-20250514: retired on 15 Jun, with its own successor and not Opus\'s', () => {
    const r = findRetirement('claude-sonnet-4-20250514', retirements);
    assert.equal(r?.status, 'retired');
    assert.equal(r?.effective, '2026-06-15');
    assert.deepEqual(r?.successors, ['Claude Sonnet 4.6']);
    assert.deepEqual(findRetirement('claude-opus-4-20250514', retirements)?.successors, ['Claude Opus 4.8']);
  });

  it('claude-3-sonnet-20240229 matches by display name, since that entry names no id', () => {
    const r = findRetirement('claude-3-sonnet-20240229', retirements);
    assert.equal(r?.status, 'retired');
    assert.match(r?.sentence ?? '', /Claude Sonnet 3 models/);
    assert.equal(findRetirement('claude-3-5-sonnet-20241022', retirements)?.status, 'retired');
  });

  it('a feature\'s retirement is not its model\'s', () => {
    assert.equal(findRetirement('claude-opus-4-8', retirements), null);
    assert.equal(findRetirement('claude-sonnet-5-5', retirements), null);
    assert.equal(findRetirement('claude-sonnet-4-6', retirements), null);
  });

  it('a successor is not a retirement', () => {
    assert.equal(findRetirement('gpt-transcribe', retirements), null);
    assert.equal(findRetirement('gpt-live-transcribe', retirements), null);
    assert.equal(findRetirement('gpt-image-2', retirements), null);
  });

  it('reads Gemini\'s list form and dated shutdowns', () => {
    assert.equal(findRetirement('imagen-4.0-generate-001', retirements)?.effective, '2026-08-17');
    assert.equal(findRetirement('gemini-robotics-er-1.6-preview', retirements)?.effective, '2026-08-31');
    assert.equal(findRetirement('dall-e-3', retirements)?.effective, '2026-05-12');
    assert.equal(findRetirement('dall-e-3', retirements)?.status, 'retired');
  });

  it('a deprecation with no date stays dated by its announcement only', () => {
    const r = findRetirement('gpt-4.5-preview', retirements);
    assert.equal(r?.status, 'deprecated');
    assert.equal(r?.effective, null);
  });
});
