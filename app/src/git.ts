// git over HTTPS as the App, on a local blobless clone in tmp/forks/<fork>.
// The token reaches git through the environment of each command (GIT_CONFIG_*), the
// same header actions/checkout uses. So it isn't in .git/config, argv, a URL or a log.
import { spawn } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { assertDemoRepo, assertPushRef, GuardError } from './guard.ts';
import { redact, registerSecret } from './secrets.ts';
import type { Env } from './config.ts';
import { notCoveredLine, type BotIdentity } from './github.ts';

export class GitError extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = 'GitError';
  }
}

export interface GitContext {
  root: string;
  org: string;
  fork: string;
  gitBaseUrl: string;
  env: Env;
  token: () => Promise<string>;
  /** The spec's branch and base branch. pushRef refuses anything else. */
  allowedRefs: readonly string[];
}

const NO_TOKEN = null;
/** All git sees of the caller's environment, so no key in it can reach a child process or a hook. */
const PASS_THROUGH = ['PATH', 'TMPDIR', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO'];

function passThrough(): NodeJS.ProcessEnv {
  return Object.fromEntries(PASS_THROUGH.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
}

function gitEnv(token: string | null, baseUrl: string | null): NodeJS.ProcessEnv {
  const settings: [string, string][] = [
    ['core.hooksPath', '/dev/null'],
    ['core.autocrlf', 'false'],
    ['commit.gpgsign', 'false'],
    // Without this the person's own keychain could answer, and the push would be theirs instead of the bot's.
    ['credential.helper', ''],
    ['advice.detachedHead', 'false'],
  ];
  if (token && baseUrl) {
    registerSecret(token);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    registerSecret(basic);
    settings.push([`http.${baseUrl}.extraheader`, `Authorization: Basic ${basic}`]);
  }
  const numbered = settings.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]]);
  return {
    ...passThrough(),
    HOME: tmpdir(),
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(numbered),
  };
}

interface RunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdinFile?: string;
  what: string;
}

function run(args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd, env: opts.env, stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (opts.stdinFile && child.stdin) createReadStream(opts.stdinFile).pipe(child.stdin);
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', (e) => reject(new GitError(`${opts.what}: couldn't run git (${e.message}).`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new GitError(`${opts.what} failed: ${err.trim() || `git exited with ${code}`}`));
    });
  });
}

async function authedEnv(ctx: GitContext): Promise<NodeJS.ProcessEnv> {
  return gitEnv(await ctx.token(), ctx.gitBaseUrl);
}

function remoteUrl(ctx: GitContext): string {
  return `${ctx.gitBaseUrl}${ctx.org}/${ctx.fork}.git`;
}

/** The blobless clone, made once. A half-finished clone never takes the real name. */
export async function ensureClone(ctx: GitContext): Promise<string> {
  const dir = join(ctx.root, 'tmp', 'forks', ctx.fork);
  if (existsSync(join(dir, '.git', 'HEAD'))) {
    await run(['remote', 'set-url', 'origin', remoteUrl(ctx)], { cwd: dir, env: gitEnv(NO_TOKEN, null), what: 'Pointing the clone at the fork' });
    return dir;
  }
  mkdirSync(dirname(dir), { recursive: true });
  const temp = `${dir}.cloning-${process.pid}`;
  rmSync(temp, { recursive: true, force: true });
  await run(['clone', '-q', '--filter=blob:none', '--no-checkout', remoteUrl(ctx), temp], { env: await authedEnv(ctx), what: `Cloning ${ctx.org}/${ctx.fork}` });
  renameSync(temp, dir);
  return dir;
}

export async function fetchBranch(ctx: GitContext, dir: string, branch: string): Promise<void> {
  await run(['fetch', '-q', '--no-tags', '--filter=blob:none', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: dir, env: await authedEnv(ctx), what: `Fetching ${branch}` });
}

async function checkoutAt(ctx: GitContext, dir: string, sha: string): Promise<NodeJS.ProcessEnv> {
  const env = await authedEnv(ctx);
  await run(['checkout', '-q', '--detach', '--force', sha], { cwd: dir, env, what: `Checking out ${sha}` });
  await run(['clean', '-fdxq'], { cwd: dir, env, what: 'Cleaning the clone' });
  return env;
}

function commitEnv(env: NodeJS.ProcessEnv, identity: BotIdentity, date: string): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email, GIT_COMMITTER_DATE: date,
  };
}

function withTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-git-'));
  return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export interface PatchMessage { subject: string; body: string }

/** The patch's own subject and body, as git itself reads them. */
export function readPatchMessage(patchFile: string): Promise<PatchMessage> {
  return withTempDir(async (dir) => {
    const info = await run(['mailinfo', '--encoding=UTF-8', join(dir, 'msg'), join(dir, 'patch')], {
      env: gitEnv(NO_TOKEN, null), stdinFile: patchFile, what: `Reading ${basename(patchFile)}`, cwd: dir,
    });
    const subject = info.split('\n').find((l) => l.startsWith('Subject: '))?.slice('Subject: '.length).trim();
    if (!subject) throw new GitError(`${basename(patchFile)} has no subject, so it isn't git format-patch output.`);
    return { subject, body: readFileSync(join(dir, 'msg'), 'utf8').trim() };
  });
}

export interface ApplyRequest {
  tip: string;
  /** Patches to apply, each with its position in the stage: the position sets its minute. */
  patches: { file: string; index: number }[];
  date: string;
  identity: BotIdentity;
}

function patchDate(date: string, index: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + index * 60_000).toISOString().replace('.000Z', 'Z');
}

/** Applies each patch with git apply --index and commits it as the bot. Returns the new tip. */
export async function applyPatches(ctx: GitContext, dir: string, req: ApplyRequest): Promise<string> {
  const env = await checkoutAt(ctx, dir, req.tip);
  for (const patch of req.patches) {
    const { subject, body } = await readPatchMessage(patch.file);
    await run(['apply', '--index', '--whitespace=nowarn', patch.file], { cwd: dir, env, what: `Applying ${basename(patch.file)}` });
    await withTempDir(async (temp) => {
      const msg = join(temp, 'msg');
      writeFileSync(msg, body ? `${subject}\n\n${body}\n` : `${subject}\n`);
      await run(['commit', '-q', '--no-verify', '-F', msg], { cwd: dir, env: commitEnv(env, req.identity, patchDate(req.date, patch.index)), what: `Committing ${basename(patch.file)}` });
    });
  }
  return run(['rev-parse', 'HEAD'], { cwd: dir, env, what: 'Reading the new tip' });
}

export interface CommitFileRequest {
  tip: string;
  source: string;
  target: string;
  /** Files to delete in the same commit. */
  remove?: readonly string[];
  message: string;
  identity: BotIdentity;
  date: string;
}

/** The CI commit on the base branch: its file in, the listed ones out. Nothing else ever commits outside a patch. */
export async function commitFile(ctx: GitContext, dir: string, req: CommitFileRequest): Promise<string> {
  const env = await checkoutAt(ctx, dir, req.tip);
  const target = join(dir, req.target);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(req.source, target);
  await run(['add', '--', req.target], { cwd: dir, env, what: `Adding ${req.target}` });
  if (req.remove?.length) await run(['rm', '-q', '--ignore-unmatch', '--', ...req.remove], { cwd: dir, env, what: 'Removing the other workflow files' });
  await withTempDir(async (temp) => {
    const msg = join(temp, 'msg');
    writeFileSync(msg, `${req.message}\n`);
    await run(['commit', '-q', '--no-verify', '-F', msg], { cwd: dir, env: commitEnv(env, req.identity, req.date), what: `Committing ${req.target}` });
  });
  return run(['rev-parse', 'HEAD'], { cwd: dir, env, what: 'Reading the new tip' });
}

export interface RemoveFilesRequest {
  tip: string;
  remove: readonly string[];
  message: string;
  identity: BotIdentity;
  date: string;
}

/** One commit that only deletes the named files. Used on a fork's default branch, so it can't carry anything else. */
export async function removeFiles(ctx: GitContext, dir: string, req: RemoveFilesRequest): Promise<string> {
  const env = await checkoutAt(ctx, dir, req.tip);
  await run(['rm', '-q', '--', ...req.remove], { cwd: dir, env, what: 'Removing the workflow files' });
  await withTempDir(async (temp) => {
    const msg = join(temp, 'msg');
    writeFileSync(msg, `${req.message}\n`);
    await run(['commit', '-q', '--no-verify', '-F', msg], { cwd: dir, env: commitEnv(env, req.identity, req.date), what: 'Committing the removal' });
  });
  return run(['rev-parse', 'HEAD'], { cwd: dir, env, what: 'Reading the new tip' });
}

function firstWord(output: string): string {
  return output.split(/\s+/)[0] ?? '';
}

/** What a patch changes, ignoring where in the file and which commit it sits on. */
export async function patchIdOfFile(dir: string, patchFile: string): Promise<string> {
  return firstWord(await run(['patch-id', '--stable'], { cwd: dir, env: gitEnv(NO_TOKEN, null), stdinFile: patchFile, what: `Reading ${basename(patchFile)}` }));
}

/** The same for a commit. Its blobs may still be on the server, so this one needs the token. */
export async function patchIdOfCommit(ctx: GitContext, dir: string, sha: string): Promise<string> {
  const diff = await run(['show', '--binary', '--format=', sha], { cwd: dir, env: await authedEnv(ctx), what: `Reading commit ${sha}` });
  return withTempDir(async (temp) => {
    const file = join(temp, 'diff');
    writeFileSync(file, `${diff}\n`);
    return patchIdOfFile(dir, file);
  });
}

function explainPush(e: unknown, ctx: GitContext): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (/refusing to allow a GitHub App/.test(message)) {
    return new GitError(`${message}\nThe App needs the workflows: write permission to add the CI file. An org owner accepts it on the installation's settings page.`);
  }
  if (/returned error: 403|Permission to .* denied/i.test(message)) {
    return new GitError(`${message}\n${notCoveredLine(ctx.org, ctx.fork, ctx.env.GITHUB_APP_INSTALLATION_ID)}`);
  }
  return e instanceof Error ? e : new GitError(message);
}

/** Pushes a commit to one of the two allowed refs. There is no force option, here or anywhere. */
export async function pushRef(ctx: GitContext, dir: string, sha: string, ref: string): Promise<void> {
  assertPushRef(ref, ctx.allowedRefs);
  assertDemoRepo(ctx.org, ctx.fork, ctx.env);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GuardError(`Refusing to push ${sha}: not a full commit id.`);
  const env = await authedEnv(ctx);
  await run(['push', '-q', remoteUrl(ctx), `${sha}:refs/heads/${ref}`], { cwd: dir, env, what: `Pushing ${ref}` }).catch((e: unknown) => {
    throw explainPush(e, ctx);
  });
}
