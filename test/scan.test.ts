import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { loadPatterns, scanFiles, scanRepo } from '../src/scan.ts';
import { type FixtureRepo, FIXTURES, fixtureRepo, PATTERNS, ROOT } from './helpers.ts';

const scanned = (name: string, extra?: Record<string, string>) => {
  const repo = fixtureRepo(name, extra);
  try {
    return { repo, out: scanRepo(repo.path, { commit: repo.commit, patternsDir: PATTERNS }) };
  } finally {
    repo.cleanup();
  }
};

describe('scan: must match', () => {
  it('finds every hand-parsed JSON call with file and line from 1', () => {
    const { repo, out } = scanned('must-match-json');
    assert.deepEqual(out.hits.map((h) => [h.file, h.line, h.pattern]), [
      ['src/far.ts', 22, 'PAT-hand-parsed-json'],
      ['src/reply.py', 3, 'PAT-hand-parsed-json'],
      ['src/reply.ts', 5, 'PAT-hand-parsed-json'],
    ]);
    assert.equal(out.hits[2].text, '  return JSON.parse(res.choices[0].message.content);');
    assert.equal(out.version, 1);
    assert.equal(out.commit, repo.commit);
  });

  it('honours each pattern\'s own files, and (?i) and flags in the find', () => {
    const { out } = scanned('must-match-label');
    assert.deepEqual(out.hits.map((h) => [h.file, h.line]), [
      ['router.ts', 1],
      ['router.ts', 2],
      ['src/deep/route.py', 1],
    ]);
  });
});

describe('scan: printed output', () => {
  it('matches the expected file exactly', () => {
    const { repo, out } = scanned('must-match-json');
    const expected = readFileSync(join(ROOT, 'test', 'golden', 'scan-must-match-json.json'), 'utf8');
    const printed = JSON.stringify({ ...out, repo: 'must-match-json', commit: out.commit === repo.commit ? 'COMMIT' : out.commit }, null, 1);
    assert.equal(`${printed}\n`, expected);
  });
});

describe('scan: must not match', () => {
  it('drops a hit when a skip_if_near sign is within 20 lines', () => {
    assert.deepEqual(scanned('must-not-match-json').out.hits, []);
  });

  it('gives nothing when the sign is near a label picker or the prompt is open text', () => {
    assert.deepEqual(scanned('must-not-match-label').out.hits, []);
  });

  it('gives nothing on a repo with no AI at all', () => {
    const { out } = scanned('quiet');
    assert.deepEqual(out.hits, []);
    assert.equal(out.checked.files, 1);
  });
});

describe('scan: skipped files', () => {
  it('reports only the real file, not node_modules, dist, minified, generated or binary ones', () => {
    const { out } = scanned('with-node-modules');
    assert.deepEqual(out.hits.map((h) => h.file), ['src/app.ts']);
  });
});

describe('scan: secrets', () => {
  it('never shows a fake key in a hit', () => {
    const { out } = scanned('fake-key');
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0].text, 'reply = json.loads(res.content)  # [masked]');
    assert.ok(!JSON.stringify(out).includes('sk-FAKE'));
  });
});

describe('optional pattern fields', () => {
  const SKIP_PATTERNS = join(FIXTURES, 'patterns-skip');
  let repo: FixtureRepo;
  let hitsOf: (pattern: string) => string[];
  let out: ReturnType<typeof scanRepo>;
  before(() => {
    repo = fixtureRepo('skip-fields');
    out = scanRepo(repo.path, { commit: repo.commit, patternsDir: SKIP_PATTERNS });
    hitsOf = (pattern) => out.hits.filter((h) => h.pattern === pattern).map((h) => `${h.file}:${h.line}`);
  });
  after(() => repo.cleanup());

  it('skip_files drops a matching file before the pattern runs', () => {
    assert.deepEqual(hitsOf('PAT-model-with-skip-files'), ['server/app.js:1', 'server/cached.js:33']);
  });

  it('skip_if_in_file drops all of that pattern\'s hits in a file, however far the sign is', () => {
    assert.deepEqual(hitsOf('PAT-call-with-skip-in-file'), ['server/app.js:2']);
  });

  it('skip_if_in_file reads (?i), like every other regex in a pattern', () => {
    assert.ok(!hitsOf('PAT-call-with-skip-in-file').includes('server/mixed-case-sign.js:2'));
  });

  it('a pattern without them is unchanged', () => {
    assert.deepEqual(hitsOf('PAT-model-plain'), ['server/__tests__/helper.js:1', 'server/app.js:1', 'server/app.test.js:1', 'server/cached.js:33']);
    assert.deepEqual(hitsOf('PAT-call-plain'), ['server/app.js:2', 'server/cached.js:32', 'server/mixed-case-sign.js:2']);
  });

  it('a dropped file or sign touches only its own pattern', () => {
    // cached.js holds the sign that drops the call pattern, and the model pattern still fires there.
    assert.ok(hitsOf('PAT-model-with-skip-files').includes('server/cached.js:33'));
    // __tests__ is skipped by one pattern and still read by the plain one.
    assert.ok(hitsOf('PAT-model-plain').includes('server/__tests__/helper.js:1'));
  });

  it('a file every pattern skips isn\'t counted as checked', () => {
    const patterns = loadPatterns(SKIP_PATTERNS).filter((p) => p.id.endsWith('with-skip-files'));
    const files = [{ path: 'server/__tests__/a.js', text: 'old-model-1\n' }, { path: 'server/a.js', text: 'x\n' }];
    assert.deepEqual(scanFiles(files, patterns).checked, { files: 1, lines: 2 });
  });

  it('holds for a plain in-memory scan too', () => {
    const patterns = loadPatterns(SKIP_PATTERNS);
    const { hits } = scanFiles([{ path: 'a.js', text: 'CACHE_CONTROL\nclient.messages.create()\n' }], patterns);
    assert.deepEqual(hits.map((h) => h.pattern), ['PAT-call-plain']);
  });

  describe('a broken field fails loudly and names the file', () => {
    let dir: string;
    const write = (fields: object) => writeFileSync(join(dir, 'PAT-bad.json'), JSON.stringify({
      id: 'PAT-bad', name: 'x', find: [{ regex: 'a' }], skip_if_near: [], files: ['*.ts'], why: 'x', status: 'live', effect: [], live_from: 'v0.1', ...fields,
    }));
    before(() => { dir = mkdtempSync(join(tmpdir(), 'keepup-bad-')); });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('a bad regex in skip_if_in_file', () => {
      write({ skip_if_in_file: ['('] });
      assert.throws(() => loadPatterns(dir), /PAT-bad/);
    });

    it('skip_files that is not a list of globs', () => {
      write({ skip_files: '**/__tests__/**' });
      assert.throws(() => loadPatterns(dir), /PAT-bad.*skip_files/);
    });

    it('skip_if_in_file that is not a list of regexes', () => {
      write({ skip_if_in_file: [{ regex: 'a' }] });
      assert.throws(() => loadPatterns(dir), /PAT-bad.*skip_if_in_file/);
    });
  });
});

describe('patterns are data', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'keepup-patterns-'));
    cpSync(PATTERNS, dir, { recursive: true });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => rmSync(join(dir, 'PAT-bad.json'), { force: true }));

  it('a new pattern file needs no code change', () => {
    writeFileSync(join(dir, 'PAT-add.json'), JSON.stringify({
      id: 'PAT-add', name: 'Adds', find: [{ regex: 'a \\+ b' }], skip_if_near: [], files: ['*.ts'], why: 'x', status: 'info', effect: ['faster'], live_from: 'v0.1',
    }));
    const repo = fixtureRepo('quiet');
    try {
      const out = scanRepo(repo.path, { patternsDir: dir });
      assert.deepEqual(out.hits.map((h) => h.pattern), ['PAT-add']);
    } finally {
      repo.cleanup();
    }
    rmSync(join(dir, 'PAT-add.json'));
  });

  it('a broken pattern file fails loudly and names itself', () => {
    writeFileSync(join(dir, 'PAT-bad.json'), JSON.stringify({ id: 'PAT-bad', name: 'x', find: [{ regex: '(' }], skip_if_near: [], files: ['*.ts'], why: 'x', status: 'live', effect: [], live_from: 'v0.1' }));
    assert.throws(() => loadPatterns(dir), /PAT-bad/);
  });

  it('a find entry with no regex fails loudly', () => {
    writeFileSync(join(dir, 'PAT-bad.json'), JSON.stringify({ id: 'PAT-bad', name: 'x', find: [{ note: 'no regex' }], skip_if_near: [], files: ['*.ts'], why: 'x', status: 'live', effect: [], live_from: 'v0.1' }));
    assert.throws(() => loadPatterns(dir), /PAT-bad.*regex/);
  });

  it('a pattern file missing a field fails loudly', () => {
    writeFileSync(join(dir, 'PAT-bad.json'), JSON.stringify({ id: 'PAT-bad' }));
    assert.throws(() => loadPatterns(dir), /PAT-bad.*(find|name)/);
  });

  it('an absent patterns folder means no patterns, not a crash', () => {
    assert.deepEqual(loadPatterns(join(dir, 'nope')), []);
  });
});

describe('long lines', () => {
  it('treats a line over the limit as data, and still scans the rest of the file', () => {
    const patterns = loadPatterns(PATTERNS);
    const long = `const blob = "${'x'.repeat(30_000)}"; JSON.parse(res.choices[0]);`;
    const out = scanFiles([{ path: 'a.ts', text: `${long}\nJSON.parse(res.choices[0]);\n` }], patterns);
    assert.deepEqual(out.hits.map((h) => h.line), [2]);
  });
});

describe('a sign on an over-long line is data too', () => {
  const SKIP_PATTERNS = join(FIXTURES, 'patterns-skip');
  const blob = (sign: string) => `// ${'x'.repeat(30_000)} ${sign}`;

  it('skip_if_in_file ignores it', () => {
    const { hits } = scanFiles([{ path: 'a.js', text: `${blob('CACHE_CONTROL')}\nclient.messages.create()\n` }], loadPatterns(SKIP_PATTERNS));
    assert.ok(hits.some((h) => h.pattern === 'PAT-call-with-skip-in-file'));
  });

  it('skip_if_near ignores it', () => {
    const { hits } = scanFiles([{ path: 'a.ts', text: `${blob('json_schema')}\nJSON.parse(res.choices[0]);\n` }], loadPatterns(PATTERNS));
    assert.deepEqual(hits.map((h) => h.line), [2]);
  });
});

describe('scanFiles', () => {
  it('scans a plain in-memory iterable of {path, text}', () => {
    const patterns = loadPatterns(PATTERNS);
    const out = scanFiles([{ path: 'a.ts', text: 'x\nJSON.parse(res.choices[0])\n' }, { path: 'b.md', text: 'JSON.parse(res.choices[0])' }], patterns);
    assert.deepEqual(out.hits.map((h) => [h.file, h.line]), [['a.ts', 2]]);
    assert.deepEqual(out.checked, { files: 1, lines: 3 });
  });

  it('makes no network calls', () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('the scan must stay offline'); };
    try {
      const repo = fixtureRepo('must-match-json');
      try {
        assert.equal(scanRepo(repo.path, { patternsDir: PATTERNS }).hits.length, 3);
      } finally {
        repo.cleanup();
      }
    } finally {
      globalThis.fetch = real;
    }
  });
});
