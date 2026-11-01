// Renders testset.md from testset.json, plus the local check of the audio when it has been run.
import { lengthToSeconds, type Recording, type TestSet } from './testset.ts';

export interface LocalCheckRow {
  id: string;
  transcript: string;
  wer: number;
  droppedBefore: string[];
  droppedAfter: string[];
}

export interface LocalCheck {
  checked: string;
  model: string;
  recordings: LocalCheckRow[];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function checkLines(row: LocalCheckRow | undefined): string[] {
  if (!row) return [];
  return [
    `- Local check, word error rate under the lab's rule: ${percent(row.wer)}`,
    `- Local check, words left out before the text: "${row.droppedBefore.join(' ')}"`,
    `- Local check, words left out after the text: "${row.droppedAfter.join(' ')}"`,
  ];
}

function recordingSection(r: Recording, check: LocalCheckRow | undefined): string {
  return [
    `## ${r.title}, by ${r.author}`,
    '',
    `- Reader: ${r.reader}`,
    `- Length: ${r.audioLength} (${lengthToSeconds(r.audioLength)} s, archive.org metadata for this file)`,
    `- LibriVox catalog page: ${r.catalogUrl}`,
    `- Audio licence, from the archive.org item: ${r.audioLicence}`,
    `- archive.org item: ${r.archiveItemUrl}`,
    `- Audio file: ${r.audioUrl}`,
    `- Audio sha1: ${r.audioSha1} (${r.audioBytes} bytes)`,
    `- Published text: ${r.textPageUrl}`,
    `- About the text: ${r.textNote}`,
    ...checkLines(check),
    '',
    'Published text, as compared:',
    '',
    '```text',
    r.text,
    '```',
  ].join('\n');
}

function localCheckIntro(check: LocalCheck | null): string[] {
  if (!check) return [];
  return [
    '## Local check of the audio',
    '',
    `Nobody listened to these files by ear, so on ${check.checked} each one went through ${check.model} on the CPU, in the sandbox, with no API call and no key, cut at its silences into pieces of up to 25 seconds. It's a stand-in for listening: it shows that each file holds the published text, and which words the lab's rule leaves out. Its rates mix that small model's own mistakes with anywhere a reader departs from the printed text, so they say nothing about OpenAI's models and appear in no pull request. Any place a reader does depart from the text raises both models' numbers alike. The full transcripts are in testset-check.json.`,
    '',
  ];
}

export function renderTestSetNotes(testSet: TestSet, check: LocalCheck | null): string {
  const rows = new Map((check?.recordings ?? []).map((row) => [row.id, row]));
  return [
    '# Test set: three short LibriVox recordings',
    '',
    `Built by build-testset.ts from its sources on ${testSet.fetched}. Don't edit this file or testset.json by hand.`,
    '',
    `**How each recording was chosen.** ${testSet.selectionRule} That rule picks the reader, so nobody picked a voice that suits a model.`,
    '',
    `**Licence.** ${testSet.licenceNote}`,
    '',
    "**The spoken preamble and closing.** The files are uploaded whole, the way a user's file would be, so LibriVox's spoken preamble and closing reach the model. The published text doesn't have them. The lab scores the unbroken run of transcript words that fits the whole published text best and leaves out the words on either side of it, for both models alike. Every published word still counts. wer.ts defines this and its tests pin it down.",
    '',
    ...localCheckIntro(check),
    testSet.recordings.map((r) => recordingSection(r, rows.get(r.id))).join('\n\n'),
    '',
  ].join('\n');
}
