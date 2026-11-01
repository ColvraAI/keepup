// Trimming copy for the stage. Only ever at a sentence's end, never mid-word: a cut sentence looks like a bug.
const SENTENCE_END = /^(.+?[.;])(?=\s|$)/;

/** The first sentence, skipping the dots inside "gpt-4.1" or "server/x.js". */
export function firstSentence(text: string): string {
  const match = SENTENCE_END.exec(text.trim());
  if (!match) return text.trim();
  return (match[1] ?? text).replace(/;$/, '.');
}

export const withoutEndStop = (text: string): string => text.trim().replace(/[.\s]+$/, '');

/** "needs A; B or C, with D" reads as the first key and how many more, once it's too long for a stage line. */
export function shortNeeds(needs: string): string {
  const names = [...new Set(needs.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [])];
  if (names.length <= 2) return needs;
  return `${names[0]} and ${names.length - 1} more`;
}
