// Nothing that reaches stdout, stderr or a thrown message may carry a secret.
// Every value the App learns at runtime is registered here, and every line the
// App prints or rethrows passes through redact().
import { maskText } from '../../src/mask.ts';

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)$/;
const NOT_SECRET = new Set(['GITHUB_APP_PRIVATE_KEY_PATH']);
const known = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) known.add(value);
}

/** Registers every secret-looking variable, so the lab's keys are covered too. */
export function registerEnvSecrets(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && !NOT_SECRET.has(name)) registerSecret(value);
  }
}

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9_]{6,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bre_[A-Za-z0-9_]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(authorization:\s*)(basic|bearer|token)\s+\S+/gi,
];

export function redact(text: string): string {
  const byValue = [...known].sort((a, b) => b.length - a.length).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
  return SHAPES.reduce((out, shape) => out.replace(shape, '[redacted]'), byValue);
}

/** True when the text holds a registered secret or something shaped like one. */
export function holdsSecret(text: string): boolean {
  return redact(text) !== text;
}

export class PublicTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicTextError';
  }
}

/** The last look at anything leaving for a public repo. It says what, and never the value. */
export function assertPublicSafe(text: string, what: string): void {
  if (holdsSecret(text) || maskText(text) !== text) throw new PublicTextError(`${what} holds a secret, or something shaped like one, so it wasn't sent. Remove it and run this again; if it's a real key, rotate it.`);
}

/** The message of anything thrown, safe to print. Never the object: it can hold headers. */
export function safeMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
