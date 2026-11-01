// The shapes an independent review showed getting through, and the timing inputs that hung the scan.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cardText } from '../src/cards.ts';
import { rustTestBlocks } from '../src/code-context.ts';
import { maskText, maskValue } from '../src/mask.ts';

const PREFIXES: readonly string[] = [
  'hf_FAKEfakeFAKEfakeFAKEfakeFAKEfake01',
  'gsk_FAKEfakeFAKEfakeFAKEfakeFAKEfake01',
  'r8_FAKEfakeFAKEfakeFAKEfakeFAKEfake01',
  'pplx-fakefakefakefakefakefakefake0123',
  'xai-FAKEfakeFAKEfakeFAKEfakeFAKEfake01',
  'npm_FAKEfakeFAKEfakeFAKEfakeFAKEfake01',
  'glpat-FAKEfakeFAKEfake0123',
  'SG.FAKEfakeFAKEfake0123.FAKEfakeFAKEfake0123',
  'dop_v1_0123456789abcdef0123456789abcdef',
  'whsec_FAKEfakeFAKEfake0123456789',
  'ya29.FAKEfakeFAKEfake0123456789',
  'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
];

const SECRET_PART = /FAKE|fakefake|0123456789|XXXXXXXX|hunter2|p4ss|sw0rdfish|dGVzdA|tok9f8/;

/** A review's table of fake keys: every line reached a prompt, a run file and stdout before. */
const REVIEW_TABLE: readonly string[] = [
  'C1 = "shpat_FAKE0123456789abcdef0123456789ab"', 'C2 = "sq0atp-FAKE0123456789abcdefgh"', 'C3 = "lin_api_FAKE0123456789abcdef0123456789abcdef"',
  'C4 = "ntn_FAKE0123456789abcdef0123456789abcdef"', 'C5 = "secret_FAKE0123456789abcdef0123456789abcdef"', 'C6 = "sbp_FAKE0123456789abcdef0123456789abcdef"',
  'C7 = "fw_FAKE0123456789abcdef0123"', 'C8 = "vercel_FAKE0123456789abcdef0123"', 'C9 = "dapiFAKE0123456789abcdef0123456789ab"',
  'D1 = "ATATT3xFfGF0FAKE0123456789abcdef"', 'D2 = "GOCSPX-FAKE0123456789abcdefghijklmn"', 'D3 = "PMAK-FAKE0123456789abcdef-0123456789"',
  'D4 = "pypi-AgEIcHlwaS5vcmcFAKE0123456789abcdef"', 'D5 = "ABIAFAKEFAKEFAKE0024"', 'D6 = "AROAFAKEFAKEFAKE0025"',
  'D7 = "1234567890:AAFAKE0123456789abcdefghijklmnopqrstu"', 'D8 = "MTAxFAKEFAKEFAKEFAKEFAKE.GaBcDe.FAKE0123456789abcdefghijklmnopqrst"', 'D9 = "ACFAKE0123456789abcdef0123456789ab"',
  'E1 = "key-FAKE0123456789abcdef0123456789ab"', 'E2 = "tvly-FAKE0123456789abcdefghijklmnop"', 'E3 = "pa-FAKE0123456789abcdefghijklmnopqrstuvwxyzABCD"',
  'E4 = "pcsk_FAKE0123_FAKEabcdefghijklmnopqrstuvwxyz"', 'E5 = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKE0031KEY"',
  'F1_API_KEY = "abcdefghijklmnopqrstuvwxyzFAKEabc"', 'F2_DB_PASS = "hunter2FAKE0033"', 'F3_PASSWORD = "correct horse FAKE0034 staple"',
  'F4_PASSWORD = "abc,FAKE0035def"', 'F5_PASSWORD = "abc(FAKE0036def"', 'F6_PASSWORD = "xenv.FAKE0037"',
  'os.environ.setdefault("OPENAI_API_KEY", "FAKE0038abcdefghijklmnopqrstuvwxyz")', 'client = OpenAI(api_key="FAKE0039abcdefghijklmnopqrstuvwxyz")',
  'conn = connect(password="FAKE0040hunter")', 'headers = {"Authorization": "token FAKE0042abcdefghijklmnopqrstuvwxyz"}', 'headers2 = {"X-Api-Key": "FAKE0043abcdefghijklmnopqrstuvwxyz"}',
  'url1 = "mongodb+srv://user:p@ssFAKE0044@cluster.mongodb.net/x"', 'url2 = "https://example.com/x?sig=FAKE0045abcdefghijklmnopqrstuvwxyz&sv=2022"',
  'url3 = "https://api.telegram.org/bot1234567890:AAFAKE0046abcdefghijklmnopqrstuvwxyz/getMe"', 'cmd = "curl -u admin:FAKE0047hunter https://x"',
  'cmd2 = "sshpass -p FAKE0048hunter ssh root@h"', 'cmd3 = "mysql -uroot -pFAKE0049hunter db"', "define('DB_PASSWORD', 'FAKE0050hunter');", "define('AUTH_KEY', 'FAKE0051abcdefghijklmnopqrstuvwxyz');",
  'props.setPassword("FAKE0052hunter")', 'export MYSQL_PWD=FAKE0053hunter', 'PGPASSWORD=FAKE0054hunter psql', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKE0055KEY',
  'AccountKey=FAKE0056abcdefghijklmnopqrstuvwxyz0123456789+/==', '"client_secret": "FAKE0057abcdefghijklmnopqrstuvwxyz"', 'b64 = "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tFAKE0059"',
  'export API_KEY=FAKEreadme0001hunter2', 'mysql -h db -u root -pFAKEhunter2',
];

describe('maskText: a review\'s table of fake keys', () => {
  for (const line of REVIEW_TABLE) {
    it(line.slice(0, 40), () => {
      const out = maskText(line);
      assert.ok(!SECRET_PART.test(out), `${line} -> ${out}`);
      assert.ok(out.includes('[masked]'), line);
    });
  }

  it('a password with an @ in a url goes whole, up to the host', () => {
    const out = maskText('mongodb+srv://user:p@ssFAKE0044@cluster.mongodb.net/x');
    assert.equal(out, 'mongodb+srv://[masked]@cluster.mongodb.net/x');
  });

  it('leaves what only looks like one', () => {
    for (const line of [
      'rig-core = { git = "https://github.com/mezmo/rig.git", rev = "097d08d6188c76debabedddd2ac65ca5bffd2863", default-features = false }',
      'const id = "550e8400-e29b-41d4-a716-446655440000";',
      'sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
      'integrity sha512-abcDEF0123abcDEF0123abcDEF0123abcDEF0123abcDEF0123==',
      'import x from "@huggingface/transformers/dist/Module123Name.js";',
      'const key = "server/utils/AiProviders/gemini/defaultModels.js";',
      'model: "claude-sonnet-4-5-20250929",',
      'const name = "AnthropicProviderConfigurationHandler2";',
      'process.env.GEMINI_LLM_MODEL_PREF || "gemini-2.0-flash-lite",',
      'password = env.DB_PASSWORD',
      'password: process.env.DB_PASSWORD,',
      'authorization_code = "authorization_code"',
      'token_type = "Bearer"',
      'mysql -u root -p mydb',
      'sshpass -p "$PASS" ssh root@host',
      'curl -u "$USER:$PASS" https://x',
      'https://example.com/x?token=$TOKEN',
      'getToken("openai")',
      'getApiKey("anthropic")',
      'bypass = "enabled"',
      'passThrough: "yes"',
      'compass = "north-west"',
      'env.get("API_KEY", "")',
      'os.environ.setdefault("OPENAI_API_KEY", "your-key-here")',
    ]) assert.equal(maskText(line), line);
  });
});

describe('maskText: more shapes', () => {
  for (const key of PREFIXES) {
    it(`hides ${key.slice(0, 8)}...`, () => {
      const out = maskText(`const a = "${key}"; // or ${key}`);
      assert.ok(!SECRET_PART.test(out), out);
      assert.ok(out.includes('[masked]'));
    });
  }

  it('a prefix glued on with an underscore does not hide a key', () => {
    const out = maskText('x = token_sk-ant-api03-FAKEfakeFAKEfake0123456789');
    assert.ok(!SECRET_PART.test(out), out);
    assert.ok(!maskText('task-ant-api03-is-a-word-not-a-key-at-all').includes('[masked]'));
  });

  it('hides a password in a url, for any scheme', () => {
    for (const line of ['postgres://admin:hunter2@db.internal:5432/app', 'redis://:hunter2@cache:6379/0', 'git+https://bot:hunter2@github.com/acme/x.git', 'pip install --index-url https://user:hunter2@pypi.acme.dev/simple pkg', '"dep": "git+https://ghp_FAKEfakeFAKEfakeFAKEfake0123@github.com/a/b.git"']) {
      const out = maskText(line);
      assert.ok(!SECRET_PART.test(out), out);
      assert.ok(out.includes('[masked]'), line);
    }
    for (const line of ['http://localhost:3000/foo@bar', 'ssh://git@github.com/acme/x.git', 'https://github.com/acme/x']) assert.equal(maskText(line), line);
  });

  it('hides Bearer and Basic in any case', () => {
    for (const line of ['bearer FAKEfakeFAKEfake0123456789', 'Authorization: BEARER FAKEfakeFAKEfake0123456789', 'Authorization: Basic dGVzdDpGQUtFZmFrZUZBS0U=']) {
      const out = maskText(line);
      assert.ok(!SECRET_PART.test(out), out);
    }
    for (const line of ['Use a bearer token here', 'Basic authentication is off', 'Bearer ${token}']) assert.equal(maskText(line), line);
  });

  it('names with a suffix or a short name still count as secret names', () => {
    for (const line of ['OPENAI_KEY_PROD=FAKEfakeFAKEfake0123456789', 'API_KEY_2=FAKEfakeFAKEfake0123456789', 'pwd=sw0rdfish', 'auth=FAKEfakeFAKEfake0123456789', 'password: "hunter2"', 'SMTP_PASSWORD=hunter2', 'DB_PASSWORD=hunter2', 'secret = "p4ss"', 'password=<p4ssw0rd', 'token: "abc<FAKEfakeFAKEfake0123456789"']) {
      const out = maskText(line);
      assert.ok(!SECRET_PART.test(out), `${line} -> ${out}`);
      assert.ok(out.includes('[masked]'), line);
    }
  });

  it('leaves code that only looks like it alone', () => {
    for (const line of ['password: string', 'password = getPassword()', 'const password = req.body.password;', 'password: ${{ secrets.DB_PASSWORD }}', 'token_count = 4000', 'key: "value"', 'password = <your password>', 'api_key = "your-api-key"', 'MAX_TOKENS=4000', 'password=', 'auth: true']) {
      assert.equal(maskText(line), line);
    }
  });

  it('hides a PGP key body past its Version header, and an unterminated PEM', () => {
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v1\n\nlQOYBFAKEfakeFAKEfake01\nanotherFAKEline0123==\n-----END PGP PRIVATE KEY BLOCK-----\nnext';
    const out = maskText(pgp);
    assert.ok(!/lQOY|anotherFAKE/.test(out), out);
    assert.equal(out.split('\n').length, pgp.split('\n').length);
    assert.equal(out.split('\n').at(-1), 'next');
    const open = maskText('-----BEGIN RSA PRIVATE KEY-----\nMIIEFAKEfakeFAKE0123\n\ncode = 1');
    assert.ok(!open.includes('MIIEFAKE'));
    assert.ok(open.includes('code = 1'), 'masking stops where it stops looking like a key');
  });

  it('a long line becomes a marker, and the line count holds', () => {
    const text = `a\n${'x'.repeat(30_000)}\nb`;
    const out = maskText(text);
    assert.equal(out.split('\n').length, 3);
    assert.ok(out.split('\n')[1].length < 100);
    assert.equal(out.split('\n')[2], 'b');
  });

  it('maskValue walks a whole object and leaves the input alone', () => {
    const input = { a: 'sk-ant-api03-FAKEfakeFAKEfake0123456789', b: [{ c: 'password: "hunter2"' }], d: 1, e: null };
    const copy = JSON.parse(JSON.stringify(input));
    const out = maskValue(input);
    assert.ok(!SECRET_PART.test(JSON.stringify(out)));
    assert.deepEqual(input, copy);
    assert.equal((out as typeof input).d, 1);
  });
});

function fast(work: () => unknown, ms: number, label: string): void {
  const started = performance.now();
  work();
  const took = performance.now() - started;
  assert.ok(took < ms, `${label} took ${Math.round(took)} ms`);
}

describe('hostile input stays fast', () => {
  const BUDGET_MS = 1500;
  /** The largest file keepup reads is 2 MB. The quadratic version took over a minute on this. */
  const BIG_FILE_BUDGET_MS = 5000;
  it('the JWT shape', () => {
    fast(() => maskText('eyJ-'.repeat(50_000)), BUDGET_MS, '200 KB of eyJ-');
    fast(() => maskText(`${'eyJ-'.repeat(450_000)}${'\n'.repeat(7000)}`), BUDGET_MS, '1.8 MB of eyJ-');
    fast(() => maskText('eyJ-'.repeat(4000)), BUDGET_MS, 'a line just under the cap');
    fast(() => maskText(Array.from({ length: 133 }, () => 'eyJ-.'.repeat(3000)).join('\n')), BIG_FILE_BUDGET_MS, 'a 2 MB file of lines near the cap');
  });
  it('the PEM shape', () => {
    fast(() => maskText(`-----BEGIN PRIVATE KEY-----${'PRIVATE KEY '.repeat(16_000)}`), BUDGET_MS, 'a PEM header');
    fast(() => maskText(Array.from({ length: 2000 }, () => '-----BEGIN PRIVATE KEY-----').join('\n')), BUDGET_MS, 'many PEM headers');
  });
  it('urls and assignments', () => {
    fast(() => maskText('a'.repeat(19_000)), BUDGET_MS, 'a long word');
    fast(() => maskText('a://'.repeat(4000)), BUDGET_MS, 'many schemes');
    fast(() => maskText(Array.from({ length: 2000 }, () => `key${' '.repeat(4000)}=`).join('\n')), BUDGET_MS, 'spaces after a name');
  });
  it('rust test blocks', () => {
    fast(() => rustTestBlocks('#[test]\n'.repeat(250_000)), BUDGET_MS, '250,000 attributes');
    fast(() => rustTestBlocks(`#[cfg(test)]\nmod t {\n${'"'.repeat(200_000)}`), BUDGET_MS, 'an open string');
  });
  it('rust test blocks still finds real ones', () => {
    assert.deepEqual(rustTestBlocks('fn a() {}\n#[cfg(test)]\nmod t {\n  fn b() {}\n}\nfn c() {}\n'), [{ start: 2, end: 5 }]);
  });
  it('a model card', () => {
    for (const raw of ['['.repeat(200_000), '<'.repeat(200_000), '[a]('.repeat(50_000), `---\n${'a\n'.repeat(100_000)}`]) fast(() => cardText(raw), BUDGET_MS, raw.slice(0, 4));
    assert.equal(cardText('---\nlicense: x\n---\n<b>hi</b> [docs](https://x.example) ![p](y.png)\n\n\nend'), 'hi docs p\nend');
  });
});

describe('maskText: named keys that read like slugs, and more prefixes', () => {
  const HEX = '8285aca9f3b14c6e9d2a7b01c4e5f678';
  const NAMED: readonly string[] = [
    `apiKey: "sk_${HEX}"`, 'apiKey: "f47ac10b-58cc-4372-a567-559b3e085297"', `E2B_API_KEY=e2b_${HEX}`, `FIRECRAWL_API_KEY="fc-${HEX}"`, `LANGSMITH_API_KEY=lsv2_pt_${HEX}_a1b2c3d4e5`,
    `SHOPIFY_SECRET="shpss_${HEX}"`, `shopify_token: "shpca_${HEX}"`, `DOPPLER_TOKEN=dp.st.dev.${HEX}`, 'SECRET_KEY = "9F86D081884C7D659A2FEAA0C55AD015"', 'auth_token: "abc1-def2-ghi3-jkl4-mno5"', 'credential = "a1b2c3d4-e5f6-a7b8-c9d0"',
  ];
  for (const line of NAMED) {
    it(line.slice(0, 44), () => {
      const out = maskText(line);
      assert.ok(out.includes('[masked]'), `${line} -> ${out}`);
      assert.ok(!out.includes(HEX) && !/f47ac10b|9F86D081|abc1-def2|a1b2c3d4-e5f6/.test(out), `${line} -> ${out}`);
    });
  }

  for (const key of [`sk_${HEX}`, `lsv2_pt_${HEX}_a1b2c3d4e5`, `lsv2_sk_${HEX}`, `e2b_${HEX}`, `fc-${HEX}`, `shpss_${HEX}`, `shpca_${HEX}`, `shppa_${HEX}`, `tgp_v1_${HEX}`, `csk-${HEX}`, `phx_${HEX}`, `gldt-${HEX}`, `glrt-${HEX}`, `dp.st.dev.${HEX}`]) {
    it(`a bare ${key.slice(0, 8)}... goes on its shape alone`, () => {
      const out = maskText(`see ${key} here`);
      assert.equal(out, 'see [masked] here', out);
    });
  }

  it('a key in a dependency url goes', () => {
    const out = maskText(`"x": "https://npm.acme.dev/sk_${HEX}/x.tgz"`);
    assert.ok(!out.includes(HEX), out);
  });

  it('discord and Teams webhooks go whole', () => {
    for (const url of ['https://discord.com/api/webhooks/1234567890/abcDEF_ghi-JKL', 'https://discordapp.com/api/webhooks/1234567890/abcDEF_ghi-JKL', 'https://acme.webhook.office.com/webhookb2/abc-123@def/IncomingWebhook/0a1b2c/d3e4f5', 'https://outlook.office.com/webhook/abc-123/IncomingWebhook/0a1b2c/d3e4f5']) {
      const out = maskText(`hook = "${url}"`);
      assert.ok(out.includes('[masked]') && !/abcDEF|0a1b2c/.test(out), out);
    }
  });

  it('a key on the line after its name goes', () => {
    for (const [first, second] of [['const apiKey =', `  "${HEX}"`], ['  api_key:', `    "${HEX}",`], ['SECRET_TOKEN =', `    '${HEX}'`], ['password =', '  "hunter2hunter2"']]) {
      const out = maskText(`${first}\n${second}\nnext = 1`);
      assert.ok(!out.includes(HEX) && !out.includes('hunter2'), out);
      assert.equal(out.split('\n').length, 3);
      assert.equal(out.split('\n')[2], 'next = 1');
    }
  });

  it('leaves what a slug-shaped value really is', () => {
    for (const line of [
      'key: "gemini-2-5-flash-preview-05-20"',
      'token_type: "text-embedding-3-small"',
      'key: "claude-sonnet-4-5-20250929"',
      'key_name: "my-prod-key-2024-west-coast"',
      'tokenizer = "bert-base-uncased-2023-tokenizer"',
      'keywords: "ai-tools-2026-roundup-list"',
      'API_KEY_NAME = "OPENAI_API_KEY_2_BACKUP"',
      'const key = `settings.section-2.title`;',
      'authType = "oauth2-client-credentials"',
      'key: "feature-flag-2024-rollout"',
      'next = "value"',
    ]) assert.equal(maskText(line), line);
  });
});

describe('maskText: a private key body, whatever dresses it', () => {
  const BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'FAKEbodyline2FAKEbodyline2FAKEbodyline2FAKEbodyline2', 'lastBODYshort=='];
  const LEAKS = /MIIEvQ|FAKEbodyline|lastBODY/;
  const wrap = (lines: readonly string[]) => ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----'].join('\n');
  const DRESSED: readonly (readonly [string, readonly string[]])[] = [
    ['a # comment', BODY.map((line) => `# ${line}`)],
    ['a // comment', BODY.map((line) => `// ${line}`)],
    ['JS concatenation', BODY.map((line) => `'${line}\\n' +`)],
    ['a markdown quote', BODY.map((line) => `> ${line}`)],
    ['a JS array', BODY.map((line) => `  "${line}",`)],
    ['plain', BODY],
    ['a YAML block', BODY.map((line) => `    ${line}`)],
  ];
  for (const [label, lines] of DRESSED) {
    it(label, () => {
      const out = maskText(`before\n${wrap(lines)}\nafter = 1`);
      assert.ok(!LEAKS.test(out), out);
      assert.equal(out.split('\n').length, lines.length + 4, 'line numbers hold');
      assert.equal(out.split('\n')[0], 'before');
      assert.equal(out.split('\n').at(-1), 'after = 1');
    });
  }

  it('a line unlike base64 inside the block is masked too, and the END still closes it', () => {
    const out = maskText(`${wrap([BODY[0], 'note: this looks like prose', BODY[1]])}\ncode = 2`);
    assert.ok(!/MIIEvQ|FAKEbodyline|prose/.test(out), out);
    assert.ok(out.includes('code = 2'));
  });

  it('with no END, dressed base64 goes and masking stops at the first line of anything else', () => {
    const out = maskText(`-----BEGIN RSA PRIVATE KEY-----\n# ${BODY[0]}\n# ${BODY[1]}\nconst code = 1;`);
    assert.ok(!LEAKS.test(out), out);
    assert.ok(out.includes('const code = 1;'));
  });

  it('an END too far away closes nothing, so a repo can\'t blank a whole file', () => {
    const far = Array.from({ length: 2000 }, (_, index) => `const line${index} = ${index};`);
    const out = maskText(['-----BEGIN PRIVATE KEY-----', ...far, '-----END PRIVATE KEY-----'].join('\n'));
    assert.ok(out.includes('const line1500 = 1500;'));
  });
});

describe('the mask holds its time on the inputs that stalled a scan', () => {
  const BIG = 2 * 1024 * 1024;
  const BUDGET_MS = 3000;
  it('a file of nothing but newlines', () => fast(() => maskText('\n'.repeat(BIG)), BUDGET_MS, '2 MB of newlines'));
  it('a file of very short lines', () => fast(() => maskText('ab\n'.repeat(BIG / 3)), BUDGET_MS, '2 MB of short lines'));
  it('one long line of a name with no value', () => {
    fast(() => maskText(`("${'pass'.repeat(5000)}`), 200, 'NAME_THEN_VALUE');
    fast(() => maskText(`set${'pwd'.repeat(6600)}`), 200, 'SETTER_CALL');
  });
  it('a file of those lines', () => fast(() => maskText(Array.from({ length: 100 }, () => `("${'pass'.repeat(5000)}`).join('\n')), BUDGET_MS, '2 MB of NAME_THEN_VALUE lines'));
  it('a PEM header and spaces', () => {
    fast(() => maskText(`-----BEGIN PRIVATE KEY-----\n${' '.repeat(19_000)}!`), 200, 'PEM body line');
    fast(() => maskText(`-----BEGIN PRIVATE KEY-----\n${Array.from({ length: 100 }, () => `${' '.repeat(19_000)}!`).join('\n')}`), BUDGET_MS, '2 MB of PEM body lines');
  });
  it('a line after a name, over and over', () => fast(() => maskText('key =\n"x"\n'.repeat(BIG / 10)), BUDGET_MS, '2 MB of name lines'));

  it('masking the same text twice costs nothing the second time', () => {
    const text = Array.from({ length: 40_000 }, (_, index) => `const value${index} = "abc";`).join('\n');
    const first = maskText(text);
    const started = performance.now();
    assert.equal(maskText(text), first);
    assert.ok(performance.now() - started < 50, 'a repeat mask of one file is a lookup');
  });
});
