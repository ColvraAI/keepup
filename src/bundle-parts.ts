// A session reads a bundle as a Bash result, and Claude Code hands the model at most 30,000 characters of one and a preview of anything longer.
// So a long bundle becomes several, each printed whole. The API pipeline sends its prompts as they are and never comes through here.
import { PRINT_CHARS } from './repo-text.ts';

const CLOSE = '</untrusted>';
const isOpen = (line: string): boolean => line.startsWith('<untrusted kind="');

interface Filling {
  readonly done: readonly string[];
  readonly lines: readonly string[];
  readonly size: number;
  readonly open: string | null;
}

/** A line a part couldn't hold, in pieces it can, with room left for the fence around them. */
function pieces(line: string, most: number): string[] {
  if (line.length <= most) return [line];
  return Array.from({ length: Math.ceil(line.length / most) }, (_, index) => line.slice(index * most, (index + 1) * most));
}

/** Text from a repo is only safe inside a fence, so a fence still open at the end of a part closes there and opens again on the next. */
function nextPart(state: Filling): Filling {
  const closed = state.open ? [...state.lines, CLOSE] : state.lines;
  const reopened = state.open ? [state.open] : [];
  return { ...state, done: [...state.done, closed.join('\n')], lines: reopened, size: reopened.join('\n').length };
}

function addLine(state: Filling, line: string, budget: number): Filling {
  const over = state.size + line.length + CLOSE.length + 2 > budget;
  const base = over && line !== CLOSE ? nextPart(state) : state;
  const open = line === CLOSE ? null : isOpen(line) ? line : base.open;
  return { ...base, lines: [...base.lines, line], size: base.size + line.length + 1, open };
}

/** Whole lines, in order, with nothing lost. untrustedBlock breaks any fence in the text it holds, so a line that looks like one is one. */
export function promptParts(prompt: string, budget = PRINT_CHARS): string[] {
  if (prompt.length <= budget) return [prompt];
  const lines = prompt.split('\n').flatMap((line) => pieces(line, Math.floor(budget / 2)));
  const filled = lines.reduce<Filling>((state, line) => addLine(state, line, budget), { done: [], lines: [], size: 0, open: null });
  return [...filled.done, filled.lines.join('\n')];
}
