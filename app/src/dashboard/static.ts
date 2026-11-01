// Maps a request path to a file inside site/out, or to nothing.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function decode(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The real path must stay under the root, so neither ".." nor a symlink can leave it. */
function insideRoot(root: string, path: string): string | null {
  const realRoot = realpathSync(root);
  const real = realpathSync(path);
  return real === realRoot || real.startsWith(`${realRoot}${sep}`) ? path : null;
}

export function resolveStatic(root: string, urlPath: string): string | null {
  const decoded = decode(urlPath);
  if (decoded === null || decoded.includes('\0') || decoded.includes('\\') || decoded.startsWith('//')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return null;
  const candidates = segments.length === 0
    ? [join(root, 'index.html')]
    : [join(root, ...segments), join(root, ...segments, 'index.html'), `${join(root, ...segments)}.html`];
  const found = candidates.find(isFile);
  return found ? insideRoot(root, found) : null;
}

export function contentType(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
}
