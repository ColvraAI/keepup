// node lab/02-whisper/local-check.ts <worktree>     transcribe and score
// node lab/02-whisper/local-check.ts --rescore      score the saved transcripts again
// A stand-in for listening to the test set, run by hand: host ffmpeg decodes each file and finds
// its silences, local-check.cjs transcribes it inside the sandbox with no key, and this scores
// the result under the lab's rule and writes testset-check.json. It measures no OpenAI model.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureAudio } from './audio.ts';
import { type LocalCheck, type LocalCheckRow } from './testset-notes.ts';
import { parseTestSet, type Recording } from './testset.ts';
import { scoreTranscript } from './wer.ts';

const LAB_DIR = import.meta.dirname;
const ROOT = join(LAB_DIR, '..', '..');
const WORK = join(ROOT, 'lab', '.work', '02-whisper');
const CHECK_DIR = join(WORK, 'local-check');
const MODEL = 'Xenova/whisper-base.en';
const SECONDS_PER_FILE = 300;
const LONGEST_SEGMENT_S = 25;
const SAMPLE_RATE = 16000;

/** Where to cut: the last silence before each segment would grow too long, or at the limit when there is none. */
export function cutPoints(silences: readonly number[], total: number, longest: number = LONGEST_SEGMENT_S): number[] {
  const cuts = [0];
  while (total - cuts[cuts.length - 1] > longest) {
    const from = cuts[cuts.length - 1];
    const inReach = silences.filter((s) => s > from + 1 && s <= from + longest);
    cuts.push(inReach.length ? inReach[inReach.length - 1] : from + longest);
  }
  return [...cuts, total];
}

function silencesIn(mp3: string): number[] {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-i', mp3, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ffmpeg could not read ${mp3}`);
  const ends = [...run.stderr.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)];
  return ends.map((match) => Number(match[1]) - Number(match[2]) / 2);
}

async function decode(recording: Recording): Promise<void> {
  const mp3 = await ensureAudio(recording, join(WORK, 'audio'));
  const pcm = join(CHECK_DIR, `${recording.id}.f32`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp3, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', pcm], { stdio: 'inherit' });
  const total = readFileSync(pcm).length / 4 / SAMPLE_RATE;
  writeFileSync(join(CHECK_DIR, `${recording.id}.cuts.json`), JSON.stringify(cutPoints(silencesIn(mp3), total)));
}

function runSandbox(worktree: string, ids: readonly string[]): void {
  const script = (id: string) => `timeout ${SECONDS_PER_FILE} node /lab/02-whisper/local-check.cjs --repo /repo --dir /lab-work/02-whisper/local-check --id ${id} 2>&1 | grep -v onnxruntime`;
  const run = spawnSync(join(ROOT, 'scripts', 'sandbox.sh'), ['anything-llm', worktree, ids.map(script).join('; ')], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`the sandbox run failed (exit ${run.status})`);
}

function rowFor(recording: Recording, transcript: string): LocalCheckRow {
  const score = scoreTranscript(recording.text, transcript);
  return { id: recording.id, transcript, wer: score.wer, droppedBefore: score.droppedBefore, droppedAfter: score.droppedAfter };
}

function transcriptOf(recording: Recording): string {
  const { segments } = JSON.parse(readFileSync(join(CHECK_DIR, `${recording.id}.json`), 'utf8')) as { segments: { text: string }[] };
  return segments.map((s) => s.text).join(' ');
}

function save(check: LocalCheck): void {
  writeFileSync(join(LAB_DIR, 'testset-check.json'), `${JSON.stringify(check, null, 2)}\n`);
  for (const row of check.recordings) console.log(`${row.id}: ${(row.wer * 100).toFixed(1)}%\n  ${row.transcript}\n  before: ${row.droppedBefore.join(' ')}\n  after: ${row.droppedAfter.join(' ')}`);
}

function rescore(): void {
  const testSet = parseTestSet(readFileSync(join(LAB_DIR, 'testset.json'), 'utf8'));
  const saved = JSON.parse(readFileSync(join(LAB_DIR, 'testset-check.json'), 'utf8')) as LocalCheck;
  const transcripts = new Map(saved.recordings.map((row) => [row.id, row.transcript]));
  save({ ...saved, recordings: testSet.recordings.map((r) => rowFor(r, transcripts.get(r.id) ?? '')) });
}

async function main(worktree: string): Promise<void> {
  const testSet = parseTestSet(readFileSync(join(LAB_DIR, 'testset.json'), 'utf8'));
  rmSync(CHECK_DIR, { recursive: true, force: true });
  mkdirSync(CHECK_DIR, { recursive: true });
  for (const recording of testSet.recordings) await decode(recording);
  runSandbox(worktree, testSet.recordings.map((r) => r.id));
  save({
    checked: new Date().toISOString().slice(0, 10),
    model: MODEL,
    recordings: testSet.recordings.map((r) => rowFor(r, transcriptOf(r))),
  });
  rmSync(CHECK_DIR, { recursive: true, force: true });
}

if (import.meta.main) {
  const [target] = process.argv.slice(2);
  if (!target) {
    console.error('Usage: node lab/02-whisper/local-check.ts <worktree> | --rescore');
    process.exit(2);
  }
  (target === '--rescore' ? Promise.resolve().then(rescore) : main(resolve(target))).catch((error: unknown) => {
    console.error(`local-check: ${(error as Error).message}`);
    process.exit(1);
  });
}
