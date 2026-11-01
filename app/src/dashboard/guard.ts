// Who may talk to the local dashboard, and which repo names reach a command line.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?!-)){0,38}$/;
const NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,99})$/;

/** Returns the slug when it's exactly GitHub's owner/name, and null otherwise. */
export function parseSlug(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 140) return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const [owner = '', name = ''] = parts;
  if (!OWNER.test(owner) || owner.endsWith('-')) return null;
  if (!NAME.test(name) || name.endsWith('.git')) return null;
  return value;
}

export type RequestCheck = { ok: true } | { ok: false; reason: string };

/**
 * The Host check stops DNS rebinding: the browser sends the attacker's name there. The Origin
 * check stops any website from posting here: the browser sends the page's own origin.
 */
export function checkRequest(headers: { host?: string; origin?: string }, port: number): RequestCheck {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!headers.host || !hosts.includes(headers.host)) return { ok: false, reason: 'This server only answers on its own address.' };
  if (headers.origin !== undefined && !hosts.some((host) => headers.origin === `http://${host}`)) {
    return { ok: false, reason: 'This server only answers its own pages.' };
  }
  return { ok: true };
}
