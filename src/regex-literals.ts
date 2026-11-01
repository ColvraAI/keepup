// A speed-up with one promise: if a regex can match a string, that string contains at least one of
// the regex's required literals. So a file or line holding none of them can skip the regex.
// Anything this parser can't read gives no literals, which means no shortcut and nothing lost.

/** A set of strings where every match of the regex contains at least one. */
type Required = readonly string[] | null;

const MIN_LITERAL = 2;
const SAFE_FLAGS = /^[ims]*$/;
const CLASS_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S', 'b', 'B', 'n', 'r', 't', 'f', 'v', '0']);
const QUANTIFIER_BRACE = /^\{(\d+)(?:,\d*)?\}/;
const ASCII_LITERAL = /^[\x20-\x7e]$/;

class Unreadable extends Error {}

function better(a: Required, b: Required): Required {
  if (!a) return b;
  if (!b) return a;
  const score = (set: readonly string[]) => Math.min(...set.map((s) => s.length));
  if (score(a) !== score(b)) return score(a) > score(b) ? a : b;
  return a.length <= b.length ? a : b;
}

class Reader {
  private i = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  read(): Required {
    const out = this.alternation();
    if (this.i !== this.source.length) throw new Unreadable();
    return out;
  }

  /** Every alternative must have literals, or the alternation can match without any. */
  private alternation(): Required {
    const alternatives: Required[] = [this.sequence()];
    while (this.source[this.i] === '|') {
      this.i += 1;
      alternatives.push(this.sequence());
    }
    if (alternatives.some((alternative) => alternative === null)) return null;
    return [...new Set(alternatives.flatMap((alternative) => alternative as readonly string[]))];
  }

  /** Any one required part of a sequence is enough, so it keeps the most selective. */
  private sequence(): Required {
    let best: Required = null;
    let run = '';
    const flush = () => {
      if (run.length >= MIN_LITERAL) best = better(best, [run]);
      run = '';
    };
    while (this.i < this.source.length && this.source[this.i] !== '|' && this.source[this.i] !== ')') {
      const atom = this.atom();
      const required = this.quantifier();
      if (atom.char !== null) {
        if (required === 'optional') { flush(); continue; }
        run += atom.char;
        if (required === 'repeated') flush();
      } else {
        flush();
        if (required !== 'optional') best = better(best, atom.set);
      }
    }
    flush();
    return best;
  }

  private atom(): { char: string | null; set: Required } {
    const char = this.source[this.i];
    if (char === '(') return { char: null, set: this.group() };
    if (char === '[') { this.skipClass(); return { char: null, set: null }; }
    if (char === '\\') return { char: this.escape(), set: null };
    if (char === '*' || char === '+' || char === '?') throw new Unreadable();
    this.i += 1;
    if (char === '.' || char === '^' || char === '$') return { char: null, set: null };
    if (!ASCII_LITERAL.test(char)) throw new Unreadable();
    return { char, set: null };
  }

  private group(): Required {
    const rest = this.source.slice(this.i);
    const opening = rest.match(/^\((?:\?:|\?=|\?!|\?<=|\?<!|\?<[A-Za-z_$][\w$]*>|(?!\?))/);
    if (!opening) throw new Unreadable();
    this.i += opening[0].length;
    const inner = this.alternation();
    if (this.source[this.i] !== ')') throw new Unreadable();
    this.i += 1;
    return /^\(\?(?:=|!|<=|<!)/.test(opening[0]) ? null : inner;
  }

  private skipClass(): void {
    this.i += 1;
    while (this.i < this.source.length && this.source[this.i] !== ']') {
      this.i += this.source[this.i] === '\\' ? 2 : 1;
    }
    if (this.i >= this.source.length) throw new Unreadable();
    this.i += 1;
  }

  /** The literal character an escape stands for, or null when it's a class, an anchor or a code. */
  private escape(): string | null {
    const next = this.source[this.i + 1];
    if (next === undefined) throw new Unreadable();
    this.i += 2;
    if (CLASS_ESCAPES.has(next)) return null;
    if (/[1-9]/.test(next)) { this.skipWhile(/\d/); return null; }
    if (next === 'x') return this.codeEscape(/^[0-9a-fA-F]{2}/);
    if (next === 'u') return this.codeEscape(/^[0-9a-fA-F]{4}/);
    if (next === 'c') return this.codeEscape(/^[A-Za-z]/);
    if (next === 'k') return this.codeEscape(/^<[A-Za-z_$][\w$]*>/);
    if (next === 'p' || next === 'P') throw new Unreadable();
    if (!ASCII_LITERAL.test(next)) throw new Unreadable();
    return next;
  }

  /** With its full body this is a code, not a literal. Without one it's a plain letter, and that isn't worth guessing at. */
  private codeEscape(body: RegExp): null {
    const match = this.source.slice(this.i).match(body);
    if (!match) throw new Unreadable();
    this.i += match[0].length;
    return null;
  }

  private skipWhile(re: RegExp): void {
    while (this.i < this.source.length && re.test(this.source[this.i])) this.i += 1;
  }

  /** Reads a quantifier, if one follows. */
  private quantifier(): 'once' | 'repeated' | 'optional' {
    const char = this.source[this.i];
    const brace = char === '{' ? this.source.slice(this.i).match(QUANTIFIER_BRACE) : null;
    if (char !== '*' && char !== '+' && char !== '?' && !brace) return 'once';
    this.i += brace ? brace[0].length : 1;
    if (this.source[this.i] === '?') this.i += 1;
    if (brace) return Number(brace[1]) === 0 ? 'optional' : 'repeated';
    return char === '+' ? 'repeated' : 'optional';
  }
}

export function requiredLiterals(re: RegExp): readonly string[] | null {
  if (!SAFE_FLAGS.test(re.flags)) return null;
  try {
    const found = new Reader(re.source).read();
    if (!found || found.length === 0) return null;
    return re.flags.includes('i') ? [...new Set(found.map((literal) => literal.toLowerCase()))] : found;
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

/** One regex for "holds any of the literals", with the same case rule as the regex it stands in front of. */
export interface LiteralGate {
  readonly any: RegExp | null;
}

export const OPEN_GATE: LiteralGate = { any: null };

function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function literalGate(re: RegExp): LiteralGate {
  const literals = requiredLiterals(re);
  if (!literals) return OPEN_GATE;
  return { any: new RegExp(literals.map(escapeLiteral).join('|'), re.flags.includes('i') ? 'i' : '') };
}

export interface GatedRegex {
  readonly re: RegExp;
  readonly gate: LiteralGate;
}

export function gated(re: RegExp): GatedRegex {
  return { re, gate: literalGate(re) };
}

/** False only when the regex can't match this text. */
export function mayMatch(gate: LiteralGate, text: string): boolean {
  return gate.any === null || gate.any.test(text);
}
