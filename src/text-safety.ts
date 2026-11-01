// Repo text and model text are both untrusted, so nothing reaches a terminal, a brief or a prompt with
// control characters, a live link or markup still in it. Every function here is pure and linear.

/** C0 and C1 controls and DEL, except tab, newline and carriage return, which keep line numbers true. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;
const URL = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s)\]}"'`<>|]{1,2000}/gi;

export function stripControl(text: string): string {
  return text.replace(CONTROL, '');
}

/** One line of display text: no controls of any kind. */
export function oneLine(text: string): string {
  return text.replace(CONTROL_ALL, ' ');
}

/** A link nobody can click: https://evil.example.com becomes hxxps://evil[.]example[.]com. */
export function defang(text: string): string {
  return oneLine(text)
    .replace(URL, (url) => url.replace(/^http/i, 'hxxp').replace(/\./g, '[.]'))
    .replace(/(?<![\w[])((?:[a-z0-9-]+\.)+)(com|net|org|io|ai|dev|co|app|xyz)\b/gi, (_, host: string, tld: string) => `${host.replace(/\./g, '[.]')}${tld}`);
}

/** Text for a markdown cell or sentence: it can't open a link, a tag or a code span. */
export function plainText(text: string): string {
  return oneLine(text).replace(/\\/g, '\\\\').replace(/[`<>]/g, (char) => `\\${char}`).replace(/\[(?=[^\]]*\]\()/g, '\\[');
}

/** A repo line inside a code span: it can't break out of the backticks, and a url in it isn't a link. */
export function codeSpan(text: string, limit = 120): string {
  const clean = oneLine(text).trim().replace(URL, '[link]').replace(/`/g, "'");
  return `\`${clean.length > limit ? `${clean.slice(0, limit)}...` : clean}\``;
}
