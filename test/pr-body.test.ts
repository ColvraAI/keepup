import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { originRepo, parseGithubRemote } from '../src/git-files.ts';
import { findingKey, renderIssueBody, renderPrBody } from '../src/pr-body.ts';
import { dataDir } from '../src/session.ts';
import type { Finding, LeverValue } from '../src/run-shape.ts';
import { fixtureRepo, git, ROOT } from './helpers.ts';

const roi = {
  money: true,
  options: [{ name: 'Prompt caching', price_text: 'reads at 0.1x', source: 'https://vendor.example/caching', checked: '2026-11-01', line: 'Saves about $32 a month at 10,000 calls · pays back in 10 months [projected]' }],
  assumed: 'Assumed: 10,000 calls a month.',
  formula: 'monthly saving = (cost today − cost after) × calls a month',
  what_to_enter: 'Enter your own calls a month.',
};

const finding: Finding = {
  rank: 1,
  title: 'Cache the long support policy',
  effect: ['cheaper'],
  proof: 'vendor claim',
  effort: 'Hours',
  where: [{ file: 'src/answer.ts', line: 25, text: 'x' }],
  why: 'The same policy goes out on every call.',
  options: [],
  sources: ['https://vendor.example/caching'],
  lever: 'ADV-2026-1007-anthropic-prompt-caching',
  pr: null,
  value: { status: 'priced', roi } as unknown as LeverValue,
} as Finding;

describe('renderPrBody', () => {
  it('carries the why, the place, the ROI with its labels, the proof and the source', () => {
    const body = renderPrBody({ finding, repo: 'acme/bot', commit: 'abc1234', summary: 'Marks the policy for caching.', files: ['src/answer.ts'] });
    assert.match(body, /The same policy goes out on every call/);
    assert.match(body, /\[src\/answer\.ts:25\]\(https:\/\/github\.com\/acme\/bot\/blob\/abc1234\/src\/answer\.ts#L25\)/);
    assert.match(body, /Marks the policy for caching/);
    assert.match(body, /Saves about \$32 a month at 10,000 calls/);
    assert.match(body, /\[projected\]/);
    assert.match(body, /Assumed: 10,000 calls a month/);
    assert.match(body, /monthly saving =/);
    assert.match(body, /vendor claim/);
    assert.match(body, /https:\/\/vendor\.example\/caching/);
  });

  it('calls the scan\'s places Found at, and lists the changed files under Changed as plain names', () => {
    const body = renderPrBody({ finding, summary: 'Marks the policy for caching.', files: ['src/answer.ts', 'src/[x](https://evil.example)`.ts'] });
    assert.match(body, /^\*\*Found at:\*\* src\/answer\.ts:25$/m);
    assert.doesNotMatch(body, /\*\*Where:\*\*/);
    assert.match(body, /^\*\*Changed:\*\* src\/answer\.ts, src\/\\\[x\]\(https:\/\/evil\.example\)\\`\.ts$/m);
    assert.match(body, /^\*\*What this changes:\*\* Marks the policy for caching\.$/m);
    assert.doesNotMatch(body, /Files:/);
  });

  it('leaves Changed out with no files', () => {
    assert.doesNotMatch(renderPrBody({ finding }), /\*\*Changed:/);
    assert.doesNotMatch(renderPrBody({ finding, files: [] }), /\*\*Changed:/);
  });

  it('on a retirement, keeps only the record this change is about', () => {
    const why = 'gemini-2.0-flash-lite was shut down on 1 Jun 2026. Announced on 18 Feb 2026. Named successor: gemini-3.1-flash-lite. gemini-3.1-flash-lite-preview was shut down on 25 May 2026. Announced on 7 May 2026. Named successor: gemini-3.1-flash-lite. gemini-3-pro-image-preview was shut down on 25 Jun 2026. Announced on 28 May 2026. Named successor: gemini-3-pro-image. gemini-3.1-flash-image-preview was shut down on 25 Jun 2026. Announced on 28 May 2026. Named successor: gemini-nano-banana-2.1. deep-research-pro-preview-12-2025 was shut down on 23 Oct 2026. Announced on 8 Oct 2026. Named successor: deep-research-max-preview-04-2026. gemini-omni-flash-preview was due to shut down no earlier than 22 Oct 2026. That date has passed, so it may already be gone. Announced on 27 Aug 2026. Named successor: gemini-omni-1.1-flash. gemini-3.1-flash-lite itself shuts down no earlier than 7 May 2027. Google names gemini-3.5-flash-lite after it. server/utils/AiProviders/gemini/defaultModels.js feeds a picker or a lookup, so a person can still choose these: put the replacement on that list.';
    const body = renderPrBody({ finding: { ...finding, why, reach: 'sent' } });
    assert.match(body, /^\*\*Why it fits your product:\*\* gemini-2\.0-flash-lite was shut down on 1 Jun 2026\.$/m);
    for (const gone of ['flash-lite-preview', 'pro-image', 'flash-image', 'deep-research', 'omni', 'itself shuts down', 'picker']) assert.ok(!body.includes(gone), gone);
  });

  it('keeps a lever\'s whole why, and a retirement\'s one sentence with no full stop', () => {
    const why = 'The same policy goes out on every call. It is long, too.';
    assert.ok(renderPrBody({ finding: { ...finding, why } }).includes(why));
    assert.match(renderPrBody({ finding: { ...finding, why: 'tts-1 shuts down soon', reach: 'undated' } }), /^\*\*Why it fits your product:\*\* tts-1 shuts down soon$/m);
  });

  it('says a person merges, and never claims the tests ran unless told', () => {
    const body = renderPrBody({ finding });
    assert.match(body, /a person merges/);
    assert.match(body, /did not run this repo's tests/);
    assert.match(renderPrBody({ finding, tests: 'npm test: 12 passed' }), /\*\*Tests:\*\* npm test: 12 passed/);
    assert.doesNotMatch(renderPrBody({ finding, tests: 'npm test: 12 passed' }), /did not run/);
  });

  it('prints what could go wrong after the tests, in plain text, and leaves it out when not given', () => {
    const body = renderPrBody({ finding, tests: 'npm test: 12 passed', limits: 'The example prompt may be under the `caching` minimum.' });
    assert.match(body, /\*\*Tests:\*\* npm test: 12 passed\n\n\*\*Before you merge:\*\* The example prompt may be under the \\`caching\\` minimum\.\n\n\*\*Rollback:/);
    assert.doesNotMatch(renderPrBody({ finding }), /Before you merge/);
    assert.doesNotMatch(renderPrBody({ finding, limits: '  ' }), /Before you merge/);
  });

  it('leaves out a link when it has no repo, and the ROI when there is none', () => {
    const body = renderPrBody({ finding: { ...finding, value: undefined } });
    assert.match(body, /src\/answer\.ts:25/);
    assert.doesNotMatch(body, /github\.com/);
    assert.doesNotMatch(body, /ROI/);
  });

  it('says so when there is no money figure', () => {
    const body = renderPrBody({ finding: { ...finding, value: { status: 'no_number', roi: { money: false, statement: 'No money figure: it changes what the product does.' } } as unknown as LeverValue } });
    assert.match(body, /\*\*ROI\.\*\* No money figure/);
  });

  it('ends with a marker a later run can find, which repo text cannot break', () => {
    assert.match(renderPrBody({ finding }), /<!-- keepup:finding=ADV-2026-1007-anthropic-prompt-caching -->$/);
    assert.equal(findingKey({ lever: null, title: 'Move --> off <b>this</b> model' }), 'move-off-b-this-b-model');
  });
});

describe('keepup pr-body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepup-pr-body-'));
  const runFile = join(dir, 'run.json');
  writeFileSync(runFile, JSON.stringify({ repo: 'acme/bot', commit: 'abc1234', findings: [finding] }));
  // The project is a folder with no origin, so these links come from the run file and not from this repo's own remote.
  const keepup = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['bin/keepup.ts', 'pr-body', ...args], { encoding: 'utf8', env: { ...process.env, KEEPUP_PLUGIN: '', CLAUDE_PROJECT_DIR: dir, ...env } });

  it('prints the words for a finding in a run, with the test result it was given', () => {
    const out = keepup(['--finding', '1', '--run', runFile, '--tests', 'npm test: 12 passed']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Saves about \$32 a month/);
    assert.match(out.stdout, /github\.com\/acme\/bot\/blob\/abc1234/);
    assert.match(out.stdout, /npm test: 12 passed/);
  });

  it('a run file says where its own links go, even from inside another clone', () => {
    const out = keepup(['--finding', '1', '--run', runFile], { CLAUDE_PROJECT_DIR: process.cwd() });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /github\.com\/acme\/bot\/blob\/abc1234/);
  });

  it('passes --limits through to the words', () => {
    const out = keepup(['--finding', '1', '--run', runFile, '--limits', 'Nobody tried it on Bedrock.']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^\*\*Before you merge:\*\* Nobody tried it on Bedrock\.$/m);
  });

  it('writes them to a file, so gh can read them', () => {
    const file = join(dir, 'body.md');
    assert.equal(keepup(['--finding', '1', '--run', runFile, '--out', file]).status, 0);
    assert.match(readFileSync(file, 'utf8'), /a person merges/);
  });

  it('reads what a session verified, and refuses another file in a session', () => {
    const session = { KEEPUP_PLUGIN: '1', CLAUDE_PLUGIN_DATA: dir, CLAUDE_PROJECT_DIR: process.cwd() };
    const own = dataDir(dir, { ...process.env, ...session });
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'facts.json'), JSON.stringify({ repo: 'acme/bot', commit: 'abc1234' }));
    writeFileSync(join(own, 'verified.json'), JSON.stringify({ findings: [finding] }));
    const verified = keepup(['--finding', '1', '--dir', dir], session);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Saves about \$32 a month/);
    assert.match(keepup(['--finding', '1', '--run', runFile], session).stderr, /takes no --run/);
  });

  it('says so when there is no such finding, or no number', () => {
    assert.match(keepup(['--finding', '9', '--run', runFile]).stderr, /no finding 9/);
    assert.notEqual(keepup(['--run', runFile]).status, 0);
  });
});

describe('renderIssueBody', () => {
  it('holds the brief word for word, and says a person merges', () => {
    const body = renderIssueBody('Biggest lever: cache the policy\n1. Cache it');
    assert.match(body, /Biggest lever: cache the policy\n1\. Cache it/);
    assert.match(body, /a person merges/);
    assert.match(body, /\/keepup:apply <number>/);
  });

  it('uses a fence the brief cannot close', () => {
    const body = renderIssueBody('a line with \`\`\`\` in it');
    assert.match(body, /^`````$/m);
  });
});

describe('keepup issue-body', () => {
  it('prints the brief this session verified, and says so when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-issue-body-'));
    const session = { ...process.env, KEEPUP_PLUGIN: '1', CLAUDE_PLUGIN_DATA: dir, CLAUDE_PROJECT_DIR: process.cwd() };
    const run = () => spawnSync(process.execPath, ['bin/keepup.ts', 'issue-body', '--dir', dir], { encoding: 'utf8', env: session });
    assert.match(run().stderr, /no brief yet/);
    const own = dataDir(dir, session);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'verified.json'), JSON.stringify({ brief: 'Biggest lever: cache it' }));
    assert.match(run().stdout, /Biggest lever: cache it/);
  });
});

describe('parseGithubRemote', () => {
  const token = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';
  const github: [string, string][] = [
    ['https://github.com/acme/app', 'acme/app'],
    ['https://github.com/acme/app.git', 'acme/app'],
    ['https://github.com/acme/app/', 'acme/app'],
    ['https://GitHub.com/acme/app.github.io.git', 'acme/app.github.io'],
    [`https://x-access-token:${token}@github.com/acme/app.git`, 'acme/app'],
    [`https://${token}@github.com/acme/app`, 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'acme/app'],
    ['ssh://git@ssh.github.com:443/acme/app.git', 'acme/app'],
    ['git@github.com:acme/app.git', 'acme/app'],
    ['git@github.com:/acme/app.git', 'acme/app'],
    ['github.com:acme/app', 'acme/app'],
  ];
  for (const [url, repo] of github) {
    it(`${url.replace(token, '<token>')} is ${repo}`, () => assert.equal(parseGithubRemote(url), repo));
  }

  const notGithub = [
    '',
    'https://gitlab.com/acme/app.git',
    'git@gitlab.com:acme/app.git',
    'https://github.com.evil.example/acme/app',
    'https://evil.example/github.com/acme/app',
    'https://github.com@evil.example/acme/app',
    'https://evil.example#@github.com/acme/app',
    'https://evil.example?@github.com/acme/app',
    'ssh://evil.example#@github.com/acme/app',
    'git://github.com/acme/app.git',
    'file:///github.com/acme/app',
    '/srv/github.com:acme/app',
    './github.com:acme/app',
    'https://github.com/acme',
    'https://github.com/acme/app/tree/main',
    'https://github.com/-R/app',
    'https://github.com/acme/.git',
    'github.com:acme/..',
    'https://github.com/acme/app\u001b]0;pwn\u0007',
    'https://github.com/acme/app\nrepo: other/thing',
    `x-access-token:${token}@github.com:acme/app.git`,
  ];
  for (const url of notGithub) {
    it(`${JSON.stringify(url.replace(token, '<token>'))} is not a GitHub repo`, () => assert.equal(parseGithubRemote(url), null));
  }
});

describe('originRepo', () => {
  it('reads origin, and is null with no origin or outside a repo', () => {
    const repo = fixtureRepo('quiet');
    try {
      assert.equal(originRepo(repo.path), null);
      git(repo.path, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
      assert.equal(originRepo(repo.path), 'acme/app');
      assert.equal(originRepo(tmpdir()), null);
    } finally {
      repo.cleanup();
    }
  });

  it('follows the push: with a push URL set, that is where the branch lands, not the fetch URL', () => {
    const repo = fixtureRepo('quiet');
    try {
      git(repo.path, 'remote', 'add', 'origin', 'https://github.com/upstream/app.git');
      git(repo.path, 'remote', 'set-url', '--push', 'origin', 'git@github.com:me/app.git');
      assert.equal(originRepo(repo.path), 'me/app');
      git(repo.path, 'remote', 'set-url', '--push', 'origin', 'no_push');
      assert.equal(originRepo(repo.path), null);
    } finally {
      repo.cleanup();
    }
  });

  it('gives no answer when origin pushes to more than one place', () => {
    const repo = fixtureRepo('quiet');
    try {
      git(repo.path, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
      git(repo.path, 'remote', 'set-url', '--add', 'origin', 'https://github.com/other/app.git');
      assert.equal(originRepo(repo.path), null);
    } finally {
      repo.cleanup();
    }
  });

  it('takes no URL from a file the repo\'s config includes', () => {
    const repo = fixtureRepo('quiet');
    try {
      writeFileSync(join(repo.path, 'steer.cfg'), '[remote "origin"]\n\turl = https://github.com/steered/app.git\n');
      git(repo.path, 'config', 'include.path', join(repo.path, 'steer.cfg'));
      assert.equal(originRepo(repo.path), null);
    } finally {
      repo.cleanup();
    }
  });
});

describe('--save', () => {
  const token = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';
  const bin = join(ROOT, 'bin', 'keepup.ts');

  function setUp(origin?: string) {
    const repo = fixtureRepo('quiet');
    const data = mkdtempSync(join(tmpdir(), 'keepup-save-'));
    if (origin) git(repo.path, 'remote', 'add', 'origin', origin);
    const env = { ...process.env, KEEPUP_PLUGIN: '1', CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: repo.path };
    const own = dataDir(data, env);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'facts.json'), JSON.stringify({ repo: 'acme/bot', commit: 'abc1234' }));
    writeFileSync(join(own, 'verified.json'), JSON.stringify({ findings: [finding], brief: 'Biggest lever: cache it' }));
    const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args, '--dir', data], { cwd: repo.path, encoding: 'utf8', env });
    return { own, run, cleanup: () => { repo.cleanup(); rmSync(data, { recursive: true, force: true }); } };
  }

  it('pr-body writes to the repo\'s own folder and prints the body and repo lines, and no token', () => {
    const { own, run, cleanup } = setUp(`https://x-access-token:${token}@github.com/acme/app.git`);
    try {
      const out = run('pr-body', '--finding', '1', '--save');
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, `body: ${join(own, 'pr-body.md')}\nrepo: acme/app\n`);
      assert.match(readFileSync(join(own, 'pr-body.md'), 'utf8'), /a person merges/);
      assert.ok(!`${out.stdout}${out.stderr}`.includes(token));
      assert.ok(!readFileSync(join(own, 'pr-body.md'), 'utf8').includes(token));
    } finally {
      cleanup();
    }
  });

  it('names what the branch changed since the run\'s commit, and leaves it out when git can\'t say', () => {
    const repo = fixtureRepo('quiet');
    const data = mkdtempSync(join(tmpdir(), 'keepup-save-'));
    const env = { ...process.env, KEEPUP_PLUGIN: '1', CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: repo.path };
    const own = dataDir(data, env);
    const body = (commit: string | null) => {
      writeFileSync(join(own, 'facts.json'), JSON.stringify({ repo: 'acme/bot', commit }));
      const out = spawnSync(process.execPath, [bin, 'pr-body', '--finding', '1', '--dir', data], { cwd: repo.path, encoding: 'utf8', env });
      assert.equal(out.status, 0, out.stderr);
      return out.stdout;
    };
    try {
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, 'verified.json'), JSON.stringify({ findings: [finding] }));
      writeFileSync(join(repo.path, 'changed.ts'), 'x\n');
      git(repo.path, 'add', 'changed.ts');
      git(repo.path, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'the change');
      assert.match(body(repo.commit), /^\*\*Changed:\*\* changed\.ts$/m);
      assert.doesNotMatch(body(null), /\*\*Changed:/);
      assert.doesNotMatch(body('abc1234'), /\*\*Changed:/);
    } finally {
      repo.cleanup();
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('links to the repo origin pushes to, not the one the brief ran on, and to the run\'s repo with no GitHub origin', () => {
    const fork = setUp('git@github.com:ColvraAI/MiroFish.git');
    const none = setUp();
    try {
      const out = fork.run('pr-body', '--finding', '1');
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /github\.com\/ColvraAI\/MiroFish\/blob\/abc1234\/src\/answer\.ts#L25/);
      assert.doesNotMatch(out.stdout, /github\.com\/acme\/bot/);
      assert.match(none.run('pr-body', '--finding', '1').stdout, /github\.com\/acme\/bot\/blob\/abc1234/);
    } finally {
      fork.cleanup();
      none.cleanup();
    }
  });

  for (const [what, origin] of [['no origin', undefined], ['an origin that is not GitHub', 'https://gitlab.com/acme/app.git']] as const) {
    it(`pr-body says repo: none with ${what}`, () => {
      const { own, run, cleanup } = setUp(origin);
      try {
        const out = run('pr-body', '--finding', '1', '--save');
        assert.equal(out.status, 0, out.stderr);
        assert.equal(out.stdout, `body: ${join(own, 'pr-body.md')}\nrepo: none\n`);
      } finally {
        cleanup();
      }
    });
  }

  it('issue-body writes to the repo\'s own folder and prints only the body line', () => {
    const { own, run, cleanup } = setUp('git@github.com:acme/app.git');
    try {
      const out = run('issue-body', '--save');
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, `body: ${join(own, 'issue.md')}\n`);
      assert.match(readFileSync(join(own, 'issue.md'), 'utf8'), /Biggest lever: cache it/);
    } finally {
      cleanup();
    }
  });

  it('--out with --save is a usage error on both, and writes nothing', () => {
    const { own, run, cleanup } = setUp('git@github.com:acme/app.git');
    try {
      const file = join(own, 'elsewhere.md');
      for (const args of [['pr-body', '--finding', '1'], ['issue-body']]) {
        const out = run(...args, '--save', '--out', file);
        assert.equal(out.status, 2, out.stderr);
        assert.match(out.stderr, /--save.*--out/);
        assert.equal(out.stdout, '');
      }
      assert.ok(!existsSync(file));
      assert.ok(!existsSync(join(own, 'pr-body.md')));
      assert.ok(!existsSync(join(own, 'issue.md')));
    } finally {
      cleanup();
    }
  });

  it('--out still works alone, and says nothing about a repo', () => {
    const { own, run, cleanup } = setUp('git@github.com:acme/app.git');
    try {
      const file = join(own, 'mine.md');
      const out = run('pr-body', '--finding', '1', '--out', file);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, '');
      assert.match(readFileSync(file, 'utf8'), /a person merges/);
    } finally {
      cleanup();
    }
  });
});
