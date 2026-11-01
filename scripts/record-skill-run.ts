// Writes data/recorded/skill-runs/<repo>.md from the raw events of real sessions (scripts/skill-session.sh), so what a founder is shown is what ran.
//   node scripts/record-skill-run.ts <recording.json>
// The recording names the repo, its upstream commit and each session's events file. Everything printed goes through the same masking as keepup itself.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskText } from '../src/mask.ts';

interface Session {
  readonly title: string;
  readonly events: string;
  readonly diff?: string;
  readonly note?: string;
}

interface Recording {
  readonly repo: string;
  readonly url: string;
  readonly commit: string;
  readonly date: string;
  readonly out: string;
  readonly sessions: readonly Session[];
}

interface ResultEvent {
  readonly type: string;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly permission_denials?: readonly unknown[];
  readonly num_turns?: number;
  readonly model?: string;
}

function resultOf(path: string): { readonly result: ResultEvent; readonly model: string } {
  const events = readFileSync(path, 'utf8').trim().split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as ResultEvent];
    } catch {
      return [];
    }
  });
  const result = events.findLast((event) => event.type === 'result');
  if (!result) throw new Error(`${path} has no final result: that session never finished.`);
  return { result, model: events.find((event) => event.model)?.model ?? 'unknown' };
}

export function sessionSection(session: Session): { readonly text: string; readonly cost: number } {
  const { result, model } = resultOf(session.events);
  const cost = result.total_cost_usd ?? 0;
  const lines = [
    `## ${session.title}`,
    '',
    `Model ${model} · USD ${cost.toFixed(4)} · ${result.num_turns} turns · ${result.permission_denials?.length ?? 0} permission denials`,
    ...(session.note ? ['', session.note] : []),
    '',
    'The final output, as it reached the screen:',
    '',
    '````',
    (result.result ?? '').trim(),
    '````',
    ...(session.diff ? ['', 'The diff it committed:', '', '```diff', readFileSync(session.diff, 'utf8').trim(), '```'] : []),
    '',
  ];
  return { text: maskText(lines.join('\n')), cost };
}

export function recordingText(recording: Recording): string {
  const sections = recording.sessions.map(sessionSection);
  const total = sections.reduce((sum, section) => sum + section.cost, 0);
  return [
    `# keepup on ${recording.repo}`,
    '',
    `Repo: ${recording.url}`,
    `Commit: ${recording.commit}`,
    `Date: ${recording.date}`,
    `Cost: USD ${total.toFixed(4)}`,
    '',
    'A real Claude Code session, run in a container on a sanitised copy of the tracked files (scripts/skill-session.sh). Nothing in the repo was executed. The commit in the header of a brief is the copy\'s own first commit; the one above is upstream. Secrets are masked.',
    '',
    ...sections.map((section) => section.text),
  ].join('\n');
}

if (import.meta.main ?? process.argv[1]?.endsWith('record-skill-run.ts')) {
  const recording = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Recording;
  mkdirSync(dirname(recording.out), { recursive: true });
  writeFileSync(recording.out, recordingText(recording));
  process.stdout.write(`${recording.out}\n`);
}
