import type { ScreenId } from './routes';
import type { NoteSection } from './types';

/** The presenter's script's timed sections: a bold "0:00 · The pulse" heading, then lines. Tonight's run only: the ## section after it is for later. */
export function parseNotes(markdown: string): NoteSection[] {
  const heading = /^\*\*(\d+:\d\d) · (.+?)\*\*\s*$/;
  const [tonight = ''] = markdown.split(/^## /m);
  return tonight.split('\n').reduce<NoteSection[]>((sections, raw) => {
    const line = raw.trim();
    const match = heading.exec(line);
    if (match) return [...sections, { time: match[1] ?? '', title: match[2] ?? '', lines: [] }];
    const last = sections.at(-1);
    if (!last || !line || line.startsWith('Backup:')) return sections;
    return [...sections.slice(0, -1), { ...last, lines: [...last.lines, line] }];
  }, []);
}

const SECTION_FOR: Partial<Record<ScreenId, string>> = {
  pulse: 'The pulse',
  connect: 'Connect and understand',
  understood: 'Connect and understand',
  replay: 'The replay',
  pr: 'The pull request',
  'keeps-up': 'It keeps up',
  monday: 'Monday',
};

export function notesFor(notes: readonly NoteSection[], screen: ScreenId): NoteSection | null {
  const title = SECTION_FOR[screen];
  return notes.find((section) => section.title === title) ?? null;
}
