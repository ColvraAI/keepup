// The AURA this lab runs: the binary from the image upstream published for its tag on the
// base commit. `docker create` never starts the image and `docker cp` only copies files out
// of it, so nothing from it runs on the host. In the sandbox the binary runs through the
// image's own loader and libraries, because it needs a newer glibc than bookworm has.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AuraInstall { image: string; binarySha256: string; binary: string; libDir: string; loader: string }
export interface AuraImageOptions { binDir: string; arch: string; image: string; name: string }
/** Runs the docker command with these arguments and returns what it printed. */
export type Docker = (args: readonly string[]) => string;

const BINARY_IN_IMAGE = '/app/aura';
const MARKER = 'image.json';
/** Where Debian keeps them. The image is on Debian's trixie; only arm64 has been run here. */
const LAYOUTS: Readonly<Record<string, { libDir: string; loader: string }>> = {
  arm64: { libDir: '/usr/lib/aarch64-linux-gnu', loader: 'ld-linux-aarch64.so.1' },
  amd64: { libDir: '/usr/lib/x86_64-linux-gnu', loader: 'ld-linux-x86-64.so.2' },
};

const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function installAt(dir: string, image: string, binarySha256: string, loader: string): AuraInstall {
  return { image, binarySha256, binary: join(dir, 'aura'), libDir: join(dir, 'lib'), loader: join(dir, 'lib', loader) };
}

/** A copy counts only if it came from this image and its binary hasn't changed since. */
function reusable(dir: string, image: string, loader: string): AuraInstall | null {
  const marker = join(dir, MARKER);
  if (!existsSync(marker)) return null;
  const saved = JSON.parse(readFileSync(marker, 'utf8')) as { image: string; binarySha256: string };
  const install = installAt(dir, saved.image, saved.binarySha256, loader);
  const intact = saved.image === image && existsSync(install.binary) && existsSync(install.loader) && sha256File(install.binary) === saved.binarySha256;
  return intact ? install : null;
}

function copyOut(image: string, platform: string, libDir: string, dest: string, docker: Docker): void {
  docker(['pull', '--quiet', '--platform', platform, image]);
  const container = docker(['create', '--platform', platform, image]).trim();
  try {
    docker(['cp', `${container}:${BINARY_IN_IMAGE}`, join(dest, 'aura')]);
    docker(['cp', `${container}:${libDir}`, join(dest, 'lib')]);
  } finally {
    docker(['rm', container]);
  }
}

/** Returns the copy from this image, making it if it isn't there. A copy that fails partway never takes the final name. */
export function ensureAuraFromImage(options: AuraImageOptions, docker: Docker): AuraInstall {
  const layout = LAYOUTS[options.arch];
  if (!layout) throw new Error(`no known place for AURA's libraries on architecture ${options.arch}`);
  const dir = join(options.binDir, `${options.name}-${options.arch}`);
  const kept = reusable(dir, options.image, layout.loader);
  if (kept) return kept;
  const temp = `${dir}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    copyOut(options.image, `linux/${options.arch}`, layout.libDir, temp, docker);
    const binarySha256 = sha256File(join(temp, 'aura'));
    writeFileSync(join(temp, MARKER), `${JSON.stringify({ image: options.image, binarySha256 }, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(temp, dir);
    return installAt(dir, options.image, binarySha256, layout.loader);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** The command the sandbox starts AURA with. `toSandbox` turns a host path into the path the sandbox sees. */
export function auraCommandFor(install: AuraInstall, toSandbox: (hostPath: string) => string): string[] {
  return [toSandbox(install.loader), '--library-path', toSandbox(install.libDir), toSandbox(install.binary)];
}
