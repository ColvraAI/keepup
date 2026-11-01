// "Off by default" is a promise on screen, so the program proves it. The switch has to be read from the environment, since
// nothing here can see what a config file holds at run time, and with the variable unset the old value has to be what's left.

const JS_ENV = String.raw`(?:process\.env|import\.meta\.env)(?:\.\w+|\[[^\]]+\])`;
const PY_ENV = String.raw`os\.(?:getenv|environ\.get)\([^)]*\)|os\.environ\[[^\]]+\]`;
const COMPARE = String.raw`(?:\s*===?\s*["'][^"']*["'])?`;
const NAMED_SWITCH = new RegExp(`(?:^|\\n)\\s*(?:const\\s+|let\\s+|var\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${JS_ENV}|${PY_ENV})${COMPARE}\\s*;?\\s*(?:\\n|$)`, 'g');
const STRING_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g;

const allLiterals = (text: string): string[] => [...text.matchAll(STRING_LITERAL)].map((match) => match[0].slice(1, -1));

/** Every string the search held is the old path. The change has to keep at least one, and keep it in the default's place. */
const oldValues = (search: string, replace: string): string[] => allLiterals(search).filter((value) => replace.includes(value));

function isDefaultOf(expression: string, then: string, otherwise: string, old: readonly string[]): boolean {
  return Boolean(expression) && old.some((value) => otherwise.includes(value)) && !old.some((value) => then.includes(value));
}

function guardedBy(reads: string, text: string, old: readonly string[]): boolean {
  const ternary = new RegExp(`(${reads})${COMPARE}\\s*\\?\\s*([^:]+?)\\s*:\\s*([^;\\n]+)`).exec(text);
  if (ternary) return isDefaultOf(ternary[1], ternary[2], ternary[3], old);
  const orDefault = new RegExp(`(?:${reads})\\s*(?:\\|\\||\\?\\?|\\bor\\b)\\s*([^;\\n]+)`).exec(text);
  if (orDefault) return old.some((value) => orDefault[1].includes(value));
  const pyInline = new RegExp(`([^=\\n]+?)\\s+if\\s+(${reads})${COMPARE}\\s+else\\s+([^\\n]+)`).exec(text);
  if (pyInline) return isDefaultOf(pyInline[2], pyInline[1], pyInline[3], old);
  const withDefault = /os\.(?:getenv|environ\.get)\(\s*["'][^"']+["']\s*,\s*([^)]+)\)/.exec(text);
  if (withDefault) return old.some((value) => withDefault[1].includes(value));
  const block = new RegExp(`\\bif\\s*\\(?\\s*(?:${reads})${COMPARE}\\s*\\)?\\s*[:{]`).exec(text);
  return block ? old.some((value) => text.slice(0, block.index).includes(value) || /\belse\b/.test(text.slice(block.index)) && text.slice(block.index).split(/\belse\b/)[1].includes(value)) : false;
}

const REASON_NO_SETTING = 'It’s meant to be off by default, but nothing in it reads a setting from the environment, so nothing proves it. Nothing here can see what a config file holds when the product runs.';
const REASON_NOT_DEFAULT = 'It’s meant to be off by default, but with the setting unset the old path isn’t what’s left.';

/** Null when, with the setting unset, every edit still takes today's path. */
export function offByDefaultProblem(edits: readonly { search: string; replace: string }[]): string | null {
  const whole = edits.map((edit) => edit.replace).join('\n');
  const named = [...whole.matchAll(NAMED_SWITCH)].map((match) => match[1]);
  const reads = [JS_ENV, PY_ENV, ...named.map((name) => `\\b${name.replace(/\$/g, '\\$')}\\b`)].join('|');
  if (!new RegExp(`${JS_ENV}|${PY_ENV}`).test(whole)) return REASON_NO_SETTING;
  const guarding = edits.filter((edit) => allLiterals(edit.search).length > 0);
  const proved = guarding.every((edit) => guardedBy(reads, edit.replace, oldValues(edit.search, edit.replace)));
  return guarding.length > 0 && proved ? null : REASON_NOT_DEFAULT;
}
