// Hides anything that looks like a key before any text leaves the scanner. It works one line at a time, and a line
// over the limit becomes a marker, so hostile input stays linear and line numbers still point at the real file.

const MASK = '[masked]';
export const LONG_LINE_MARKER = '[line too long]';
export const MAX_MASK_LINE = 20_000;

/** A key's prefix can follow an underscore or a dash, so only a letter or digit before it rules it out. */
const NOT_AFTER_WORD = '(?<![A-Za-z0-9])';
const shape = (body: string, flags = 'g') => new RegExp(`${NOT_AFTER_WORD}${body}`, flags);

/** Keys recognisable by their shape alone. Each runs to the end of its characters, so none of them can backtrack far. */
const TOKEN_SHAPES: readonly RegExp[] = [
  shape('sk-ant-[A-Za-z0-9_-]{8,}'),
  shape('sk-[A-Za-z0-9_-]{20,}'),
  shape('[sr]k_(?:live|test)_[A-Za-z0-9]{16,}'),
  shape('gh[pousr]_[A-Za-z0-9]{20,}'),
  shape('github_pat_[A-Za-z0-9_]{20,}'),
  shape('xox[a-z]-[A-Za-z0-9-]{10,}'),
  shape('AIza[0-9A-Za-z_-]{20,}'),
  shape('(?:AKIA|ASIA)[0-9A-Z]{12,}'),
  shape('hf_[A-Za-z0-9]{16,}'),
  shape('gsk_[A-Za-z0-9]{16,}'),
  shape('r8_[A-Za-z0-9]{16,}'),
  shape('pplx-[A-Za-z0-9]{16,}'),
  shape('xai-[A-Za-z0-9]{16,}'),
  shape('npm_[A-Za-z0-9]{16,}'),
  shape('glpat-[A-Za-z0-9_-]{16,}'),
  shape('SG\\.[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{12,}'),
  shape('dop_v1_[a-f0-9]{16,}'),
  shape('whsec_[A-Za-z0-9+/=]{16,}'),
  shape('ya29\\.[A-Za-z0-9_-]{16,}'),
  shape('shpat_[A-Za-z0-9]{16,}'),
  shape('sq0[a-z]{3}-[A-Za-z0-9_-]{16,}'),
  shape('lin_api_[A-Za-z0-9]{16,}'),
  shape('ntn_[A-Za-z0-9]{16,}'),
  shape('secret_[A-Za-z0-9]{16,}'),
  shape('sbp_[A-Za-z0-9]{16,}'),
  shape('fw_[A-Za-z0-9]{16,}'),
  shape('vercel_[A-Za-z0-9]{16,}'),
  shape('dapi[A-Za-z0-9]{16,}'),
  shape('ATATT[A-Za-z0-9_=-]{16,}'),
  shape('GOCSPX-[A-Za-z0-9_-]{16,}'),
  shape('PMAK-[A-Za-z0-9-]{16,}'),
  shape('pypi-[A-Za-z0-9_-]{16,}'),
  shape('(?:ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{12,}'),
  /(?<!\d)\d{8,12}:AA[A-Za-z0-9_-]{20,}/g,
  shape('[MN][A-Za-z0-9]{20,}\\.[A-Za-z0-9_-]{5,8}\\.[A-Za-z0-9_-]{20,}'),
  shape('AC[A-Za-z0-9]{30,}'),
  shape('key-[A-Za-z0-9]{24,}'),
  shape('tvly-[A-Za-z0-9_-]{16,}'),
  shape('pa-[A-Za-z0-9_-]{32,}'),
  shape('pcsk_[A-Za-z0-9_-]{16,}'),
  shape('lsv2_[a-z]{2}_[A-Za-z0-9_]{16,}'),
  shape('sk_[A-Za-z0-9]{16,}'),
  shape('e2b_[A-Za-z0-9]{16,}'),
  shape('fc-[A-Za-z0-9]{24,}'),
  shape('shp(?:ss|ca|pa)_[A-Za-z0-9]{16,}'),
  shape('tgp_v1_[A-Za-z0-9_-]{16,}'),
  shape('csk-[A-Za-z0-9]{16,}'),
  shape('phx_[A-Za-z0-9]{16,}'),
  shape('gl(?:dt|rt)-[A-Za-z0-9_-]{16,}'),
  shape('dp\\.(?:st|pt|sa|ct|scim|audit)(?:\\.[A-Za-z0-9_-]{1,40})?\\.[A-Za-z0-9_-]{16,}'),
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{16,}/g,
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]{8,}/g,
  /https:\/\/[A-Za-z0-9-]{1,63}\.webhook\.office\.com\/[A-Za-z0-9/_@-]{8,}/g,
  /https:\/\/outlook\.office(?:365)?\.com\/webhook\/[A-Za-z0-9/_@-]{8,}/g,
];

/** Whether any shape above could match a line, in one pass, because most lines hold no key and a pass per shape is most of a mask's work. Every shape's start has to be here: the tests of each shape would fail otherwise. */
const SHAPE_GATE = /sk-|[srp]k_|gh[pousr]_|github_pat_|xox[a-z]-|AIza|AKIA|ASIA|hf_|gsk_|r8_|pplx-|xai-|npm_|glpat-|SG\.|dop_v1_|whsec_|ya29\.|shp|sq0|lin_api_|ntn_|secret_|sbp_|fw_|vercel_|dapi|ATATT|GOCSPX-|PMAK-|pypi-|A[BCGINR][A-Z0-9]{2}|\d:AA|[MN][A-Za-z0-9]{20}|AC[A-Za-z0-9]{30}|key-|tvly-|pa-|pcsk_|lsv2_|e2b_|fc-|tgp_v1_|csk-|phx_|gl[dr]t-|dp\.|https:\/\//;

/** scheme://user:password@host, or scheme://long-token@host, up to the last @ before the host, since a password can hold one. A short bare user such as git@ is left alone. */
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s/?#'"`]{1,800})@/gi;
const MIN_BARE_URL_TOKEN = 20;
const AUTH_HEADER = /(["']?authorization["']?[ \t]{0,4}[:=][ \t]{0,4}["']?(?:token|bearer|basic)[ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi;
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const BASIC = /\b(Basic\s+)([A-Za-z0-9+/=]{8,})/g;

/** A run of token characters with at least two dots, found once per run, so a dotless run can't be rescanned. */
const DOTTED_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}/g;
const MIN_JWT_PART = 8;

const SECRET_NAME = /(?:passw(?:or)?d|pwd|pass(?:phrase)?(?![a-z])|secret)/i;
/** A secret-like name with any suffix, then a value, quoted or bare. A quoted value is judged whole, spaces and all. */
const ASSIGNMENT = /((?:key|token|secret|passw(?:or)?d|pwd|(?<![a-z])pass(?:phrase)?(?![a-z])|credential|auth)[A-Za-z0-9_-]{0,32}["']?[ \t]{0,8}[:=][ \t]{0,8})(?:(")([^"\n]{1,512})"|(')([^'\n]{1,512})'|(`)([^`\n]{1,512})`|([^\s"'`,;)}]{1,512}))/gi;
/** A literal handed to a setter, or the value that follows a secret's name in a call: define('DB_PASSWORD', 'x'). */
const SETTER_CALL = /(\b(?:set|with|use)[A-Za-z0-9_]{0,64}(?:passw(?:or)?d|pwd|secret|token|api_?key|credential)[A-Za-z0-9_]{0,64}\s{0,8}\(\s{0,8})(["'`])([^"'`\n]{1,512})\2/gi;
const NAME_THEN_VALUE = /(\(\s{0,8}(["'`])[\w.-]{0,64}(?:pass(?:w(?:or)?d)?|pwd|secret|token|api_?key|auth_?key|credential|private_?key)[\w.-]{0,64}\2\s{0,8},\s{0,8})(["'`])([^"'`\n]{1,512})\3/gi;
const SECRET_QUERY = /([?&](?:sig|signature|token|access_token|api_?key|apikey|key|secret|password|auth)=)([^&\s"'`#]{8,})/gi;
const CURL_USER = /(\b(?:curl|wget)\b[^\n]{0,200}?\s(?:-u|--user)[ =])(["']?)([^\s:"'$]{1,128}:[^\s"'$]{1,256})\2/gi;
const SSHPASS = /(\bsshpass\s+-p\s*)(["']?)([^\s"'$]{1,256})\2/g;
const MYSQL_PASSWORD = /(\b(?:mysql|mysqldump|mariadb)\b[^\n]{0,200}?\s-p)([^\s"'$]{1,256})/g;
/** A long mixed-case literal with no name to go on. A hash, a path, a uuid or an id with separators isn't one of these. */
const QUOTED_LITERAL = /(["'`])([A-Za-z0-9+/=_-]{20,512})\1/g;
/** The first argument to a client constructor is its key: a long literal there needs no name to go on. A URL, a repo id or a plain name isn't one. */
const CLIENT_LITERAL = /(\b(?:[A-Za-z_]\w{0,40}\.)?(?:[A-Za-z_]\w{0,40}Client|Client|OpenAI|AsyncOpenAI|Anthropic|AsyncAnthropic|Cohere|Groq|Mistral|Together|Replicate|Pinecone|GoogleGenerativeAI)\s{0,8}\(\s{0,8})(["'`])([A-Za-z0-9_+=-]{20,512})\2/g;
const NOT_OPAQUE = /^(?:[0-9a-f]{7,128}|[0-9A-F]{7,128}|sha\d+-.*)$|^[A-Za-z]+$|^[\w@-]*\/[\w@/-]*[A-Za-z]\.?[a-z]*$|^(?:[a-z]+[-_])+[a-z0-9]+$|^(?:[A-Z0-9]+_)+[A-Z0-9]+$/;
/** About the length of an AWS secret, which can hold slashes and so looks like a path. */
const AWS_SECRET_SHAPE = /^[A-Za-z0-9/+=]{38,44}$/;
const OPAQUE_MIN_ENTROPY = 4;
const OPAQUE_MIN_DIGITS = 2;

const TEMPLATE_VALUE = /\{\{|\$\{|^\$[A-Za-z_{(]|^<[^>]*>$|^<your|^(?:claude|gpt|gemini|whisper|text-embedding|o\d)[-.]|^(?:\.\.?\/|\/)/i;
/** Only a bare value can be code. A quoted one is a string, whatever it holds. */
const CODE_VALUE = /\(\)?|^\{|^process\.env|^os\.environ|^(?:[\w.]*\.)?env\.|^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/i;
const PLAIN_WORDS = /^(?:string|str|number|int|integer|float|bool|boolean|bytes|null|none|nil|true|false|undefined|any|void|object|required|optional|function|class|self|this|your|example|changeme|placeholder|xxx+|\*+|password|passwd|secret|token|apikey|api_key|value|type|enabled|disabled|yes|no|bearer)$/i;
/** Prose or a dotted key: what a config writes when the value isn't a key. */
const NOT_A_KEY = /\s|\.|^[a-z]+$/;
/** A value of one case with separators, or all capitals: a slug or an env name unless the name above it says it's a key. */
const SLUG_OR_ENV = /^[A-Z0-9_]+$|^(?:[a-z0-9]+[-_])+[a-z0-9]+$/;
/** ENV_NAME or ENV_NAME_2: whole words with underscores, which name a key rather than being one. */
const ENV_NAME = /^[A-Z][A-Z]+(?:_[A-Z0-9]+)+$/;
/** The name says it's the key itself. key_name, token_type and keywords are about one, or about something else. */
const NAMES_THE_KEY = /^(?:key|token|secret|credential|auth(?:_?token|_?key)?)s?(?:[-_](?:\d+|prod\w*|dev\w*|test\w*|live|staging|old|new|backup|value))*["']?[ \t]*[:=]/i;
const MIN_OPAQUE_PART = 3;
const MIN_OPAQUE_PARTS = 3;
const MIN_OPAQUE_RUN = 8;
const MIN_ENTROPY_BITS = 3;
const MIN_KEY_LENGTH = 16;
const MIN_PASSWORD_LENGTH = 3;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A key that happens to be one case: it has a long run of letters and digits together, or many short ones, as a UUID does. */
function slugHoldsKey(value: string): boolean {
  const parts = value.split(/[-_]/).filter((part) => part.length >= MIN_OPAQUE_PART && /[0-9]/.test(part) && /[A-Za-z]/.test(part));
  return parts.some((part) => part.length >= MIN_OPAQUE_RUN) || parts.length >= MIN_OPAQUE_PARTS;
}

/** A quoted value needs only to look opaque. A bare one could be a variable, so it has to hold a digit too. */
function looksLikeKey(value: string, quoted: boolean, nameSaysKey: boolean): boolean {
  if (value.length < MIN_KEY_LENGTH || TEMPLATE_VALUE.test(value) || NOT_A_KEY.test(value)) return false;
  if (SLUG_OR_ENV.test(value) && (!nameSaysKey || ENV_NAME.test(value) || !slugHoldsKey(value))) return false;
  if (!quoted && (CODE_VALUE.test(value) || !/[0-9]/.test(value))) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  return shannonEntropy(value) >= MIN_ENTROPY_BITS;
}

/** A password needs no digit and no length: only code-shaped values and placeholders are left alone. */
function looksLikePassword(value: string, quoted: boolean): boolean {
  if (value.length < MIN_PASSWORD_LENGTH || TEMPLATE_VALUE.test(value) || PLAIN_WORDS.test(value)) return false;
  if (!quoted && CODE_VALUE.test(value)) return false;
  if (/^your[-_ ]/i.test(value) || /^[\w-]+[-_](?:key|token|secret|password)$/i.test(value)) return false;
  return quoted || !/[.[\]]/.test(value);
}

function isOpaque(value: string): boolean {
  if (!AWS_SECRET_SHAPE.test(value) && NOT_OPAQUE.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  return (value.match(/\d/g) ?? []).length >= OPAQUE_MIN_DIGITS && shannonEntropy(value) >= OPAQUE_MIN_ENTROPY;
}

function maskAssignment(whole: string, lead: string, ...parts: string[]): string {
  const [dq, dqValue, sq, sqValue, bq, bqValue, bare] = parts;
  const quote = dq ?? sq ?? bq ?? '';
  const value = dqValue ?? sqValue ?? bqValue ?? bare;
  const name = lead.replace(/["']?[ \t]*[:=][ \t]*$/, '');
  if (name === 'pass' && !quote && lead.includes(':')) return whole;
  const isSecret = SECRET_NAME.test(name) ? looksLikePassword(value, quote !== '') : looksLikeKey(value, quote !== '', NAMES_THE_KEY.test(lead));
  return isSecret ? `${lead}${quote}${MASK}${quote}` : whole;
}

function maskUserInfo(whole: string, scheme: string, info: string): string {
  return info.includes(':') || info.length >= MIN_BARE_URL_TOKEN ? `${scheme}${MASK}@` : whole;
}

function maskCallValue(whole: string, lead: string, quote: string, value: string): string {
  return looksLikePassword(value, true) ? `${lead}${quote}${MASK}${quote}` : whole;
}

function maskNameThenValue(whole: string, lead: string, _nameQuote: string, quote: string, value: string): string {
  return looksLikePassword(value, true) ? `${lead}${quote}${MASK}${quote}` : whole;
}

function maskBearer(whole: string, lead: string, value: string): string {
  return value.length >= MIN_KEY_LENGTH || /\d/.test(value) ? `${lead}${MASK}` : whole;
}

function maskBasic(whole: string, lead: string, value: string): string {
  return /[0-9=A-Z]/.test(value.slice(1)) ? `${lead}${MASK}` : whole;
}

/** eyJ... with three long parts, wherever in a dotted run it starts. Parsed by hand, because a regex over this shape is quadratic. */
function maskDottedRun(run: string): string {
  const parts = run.split('.');
  const start = parts[0].lastIndexOf('eyJ');
  if (start === -1 || (start > 0 && /[A-Za-z0-9]/.test(parts[0][start - 1]))) return run;
  const header = parts[0].slice(start);
  if (header.length < MIN_JWT_PART + 3 || parts[1].length < MIN_JWT_PART || parts[2].length < MIN_JWT_PART) return run;
  return [`${parts[0].slice(0, start)}${MASK}`, ...parts.slice(3)].join('.');
}

/** Nothing shorter can hold a name and a value, so a file of blank lines costs one length check per line. */
const MIN_LINE_TO_MASK = 7;

const LONG_SPACES = /[ \t]{16,}/g;

/** A long run of spaces holds no key, so a line that's mostly spaces is first tried without them: only one that changes pays for a full pass. */
function maskLine(line: string): string {
  if (line.length < MIN_LINE_TO_MASK) return line;
  if (line.length > MAX_MASK_LINE) return LONG_LINE_MARKER;
  if (line.includes('                ') || line.includes('\t\t\t\t\t\t\t\t')) {
    const probe = line.replace(LONG_SPACES, '  ');
    if (maskWholeLine(probe) === probe) return line;
  }
  return maskWholeLine(line);
}

function maskWholeLine(line: string): string {
  const withoutShapes = SHAPE_GATE.test(line) ? TOKEN_SHAPES.reduce((out, re) => out.replace(re, MASK), line) : line;
  return withoutShapes
    .replace(DOTTED_RUN, maskDottedRun)
    .replace(URL_USERINFO, maskUserInfo)
    .replace(AUTH_HEADER, `$1${MASK}`)
    .replace(BEARER, maskBearer)
    .replace(BASIC, maskBasic)
    .replace(SECRET_QUERY, `$1${MASK}`)
    .replace(CURL_USER, `$1$2${MASK}$2`)
    .replace(SSHPASS, `$1$2${MASK}$2`)
    .replace(MYSQL_PASSWORD, `$1${MASK}`)
    .replace(SETTER_CALL, maskCallValue)
    .replace(NAME_THEN_VALUE, maskNameThenValue)
    .replace(ASSIGNMENT, maskAssignment)
    .replace(CLIENT_LITERAL, (whole, lead: string, quote: string, value: string) => (/\d/.test(value) ? `${lead}${quote}${MASK}${quote}` : whole))
    .replace(QUOTED_LITERAL, (whole, quote: string, value: string) => (isOpaque(value) ? `${quote}${MASK}${quote}` : whole));
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z0-9 ]{0,20}-----/;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z0-9 ]{0,20}-----/;
const PEM_HEADER_LINE = /^[A-Za-z][A-Za-z-]{0,40}: /;
/** What a key line can wear in a comment, a string or a quote. */
const PEM_DRESSING = /^(?:[#*>/\s'"`,+[\]()-]|\\n){0,16}|(?:[\s'"`,;+[\]()]|\\n){0,16}$/g;
const PEM_BASE64 = /^[A-Za-z0-9+/=]*$/;
/** More than any key in a text file. An END further off than this closes nothing, so a repo can't blank a whole file. */
const PEM_MAX_LINES = 400;

/** Where the next END is, for each line, worked out once from the bottom so any number of BEGINs stays linear. */
function nextPemEnds(lines: readonly string[]): number[] {
  const ends: number[] = new Array(lines.length);
  let next = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.length <= MAX_MASK_LINE && line.includes('-----END') && PEM_END.test(line)) next = index;
    ends[index] = next;
  }
  return ends;
}

/** With no END to go by: bare key material, however it's dressed, and a PGP block's Version header. */
function looksLikeBody(line: string): boolean {
  return PEM_HEADER_LINE.test(line.trim()) || PEM_BASE64.test(line.replace(PEM_DRESSING, ''));
}

/** A key block, line by line: everything through its END when one is in reach, or else for as long as it looks like key material. */
function maskPemBlocks(lines: readonly string[]): string[] {
  const ends = nextPemEnds(lines);
  let closesAt = -1;
  let open = false;
  return lines.map((line, index) => {
    if (line.length > MAX_MASK_LINE) return LONG_LINE_MARKER;
    if (index <= closesAt) return line.trim() ? MASK : line;
    if (open && looksLikeBody(line)) return line.trim() ? MASK : line;
    open = false;
    if (!line.includes('-----BEGIN') || !PEM_BEGIN.test(line)) return line;
    const end = ends[index];
    if (end !== -1 && end - index <= PEM_MAX_LINES) closesAt = end;
    else open = true;
    return MASK;
  });
}

const NAME_AT_LINE_END = /((?:key|token|secret|passw(?:or)?d|pwd|credential)[A-Za-z0-9_-]{0,32}["']?[ \t]{0,8}[:=])[ \t]{0,8}$/i;
/** One unbroken ASCII token on its own line. A sentence there is a label, whatever the name above it says. */
const LONE_LITERAL = /^(\s{0,64})(["'`])([\x21\x23-\x26\x28-\x5f\x61-\x7e]{1,512})\2([,;]?\s{0,8})$/;

/** const apiKey =\n  "abc...": a formatter puts the value on its own line. */
function maskNextLineValue(line: string, previous: string | undefined): string {
  if (previous === undefined || line.length > MAX_MASK_LINE || previous.length > MAX_MASK_LINE) return line;
  const last = previous.trimEnd().at(-1);
  if (last !== '=' && last !== ':') return line;
  const name = previous.slice(-64).match(NAME_AT_LINE_END)?.[1];
  const literal = name ? line.match(LONE_LITERAL) : null;
  if (!literal || !name) return line;
  const isSecret = SECRET_NAME.test(name) ? looksLikePassword(literal[3], true) : looksLikeKey(literal[3], true, NAMES_THE_KEY.test(name));
  return isSecret ? `${literal[1]}${literal[2]}${MASK}${literal[2]}${literal[4]}` : line;
}

function maskUncached(text: string): string {
  const lines = maskPemBlocks(text.split('\n'));
  return lines.map((line, index) => maskLine(maskNextLineValue(line, lines[index - 1]))).join('\n');
}

/** One file is read many times in a run, and masking is pure, so the second time is a lookup. Small strings aren't worth keeping. */
const MEMO_MIN_CHARS = 256;
const MEMO_MAX_CHARS = 512 * 1024 * 1024;
const memo = new Map<string, string>();
let memoChars = 0;

export function maskText(text: string): string {
  if (text.length < MEMO_MIN_CHARS) return maskUncached(text);
  const known = memo.get(text);
  if (known !== undefined) return known;
  const masked = maskUncached(text);
  if (memoChars + text.length <= MEMO_MAX_CHARS) {
    memo.set(text, masked);
    memo.set(masked, masked);
    memoChars += text.length;
  }
  return masked;
}

/** For the regular-expression tests: what runs on a whole line of repo text. */
export const MASK_REGEXES: Readonly<Record<string, RegExp>> = {
  URL_USERINFO, AUTH_HEADER, BEARER, BASIC, DOTTED_RUN, ASSIGNMENT, SETTER_CALL, NAME_THEN_VALUE, SECRET_QUERY, CURL_USER, SSHPASS, MYSQL_PASSWORD, QUOTED_LITERAL, CLIENT_LITERAL,
  PEM_BEGIN, PEM_END, PEM_HEADER_LINE, PEM_DRESSING, PEM_BASE64, NAME_AT_LINE_END, LONE_LITERAL, NAMES_THE_KEY, SLUG_OR_ENV, SHAPE_GATE, ...Object.fromEntries(TOKEN_SHAPES.map((re, index) => [`TOKEN_SHAPE_${index}`, re])),
};

/** A copy of any JSON-shaped value with every string masked. */
export function maskValue<T>(value: T): T {
  if (typeof value === 'string') return maskText(value) as T;
  if (Array.isArray(value)) return value.map((item) => maskValue(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item)])) as T;
  return value;
}
