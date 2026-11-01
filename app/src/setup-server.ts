// The local page and redirect for the manifest flow: 127.0.0.1 only, a random port, a random state.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const START_PATH = '/start';
const MANIFEST_DONE = '/manifest-done';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font:16px/1.5 sans-serif;max-width:40em;margin:4em auto">${body}</body></html>`;
}

export function formPage(action: string, manifest: string): string {
  return page('keepup setup', `<p>Sending you to GitHub to create the keepup App…</p><form method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(manifest)}"><noscript><button type="submit">Create the keepup App on GitHub</button></noscript></form><script>document.forms[0].submit()</script>`);
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface LocalServer {
  url: string;
  state: string;
  redirectUrl: string;
  /** The address the server really listens on: this machine only. */
  boundAddress: string;
  /** Sets the form the start page shows. */
  setForm: (html: string) => void;
  code: () => Promise<string>;
  close: () => Promise<void>;
}

export async function startLocalServer(): Promise<LocalServer> {
  const state = randomBytes(16).toString('hex');
  const code = deferred<string>();
  let form = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const respond = (status: number, title: string, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(title, `<p>${esc(body)}</p>`));
    };
    if (url.pathname === START_PATH) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(form);
      return;
    }
    if (url.pathname === MANIFEST_DONE) {
      if (url.searchParams.get('state') !== state) {
        code.reject(new Error("The state value from GitHub's redirect didn't match this run, so nothing was exchanged. Run npm run setup again."));
        respond(400, 'keepup setup', "The state value didn't match. Go back to the terminal.");
        return;
      }
      code.resolve(url.searchParams.get('code') ?? '');
      respond(200, 'keepup setup', 'The App is created. You can close this tab; setup carries on in the terminal.');
      return;
    }
    respond(404, 'keepup setup', 'Nothing here.');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port, address } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base, state,
    redirectUrl: `${base}${MANIFEST_DONE}`,
    boundAddress: address,
    setForm: (html) => { form = html; },
    code: () => code.promise,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
