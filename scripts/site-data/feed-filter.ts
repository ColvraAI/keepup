// What may go on a projector in front of founders. A word list plus the traction
// bars in feed.ts: this is about what's fit to show, not about what exists, so
// pulse.json's counts still include everything.
const ADULT = ['porn', 'porno', 'pornographic', 'nsfw', 'xxx', 'sex', 'sexy', 'sexual', 'sexting', 'erotic', 'erotica', 'hentai', 'nude', 'nudes', 'nudity', 'nudify', 'undress', 'deepnude', 'deepfake', 'deepfakes', 'onlyfans', 'fansly', 'lewd', 'waifu', 'milf', 'fetish', 'escort', 'r18', 'adult', 'girlfriend', 'boyfriend', 'uncensored', 'unfiltered', 'abliterated', 'heretic', 'jailbreak', 'jailbroken', 'lora', 'loras'];
const HATE = ['nazi', 'nazis', 'hitler', 'kkk', 'racist', 'racism', 'slur', 'slurs', 'genocide', 'terrorist', 'terrorism', 'isis', 'supremacist'];
const SCAM = ['airdrop', 'airdrops', 'memecoin', 'memecoins', 'pumpfun', 'pump.fun', 'rugpull', 'rug pull', 'sniper', 'sniping', 'get rich', 'casino', 'gambling', 'betting', 'sportsbook', 'polymarket', 'kalshi', 'forex', 'crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'solana', 'web3', 'defi', 'nft', 'nfts', 'blockchain', 'token launch', 'drainer', 'phishing', 'stealer', 'malware', 'ransomware', 'keylogger', 'botnet', 'ddos', 'keygen', 'crack', 'cracked', 'pirated', 'warez', 'bypass', 'undetectable', 'undetected', 'antidetect', 'anti-detect', 'stealth', 'account farm', 'spam', 'spammer', 'mass dm', 'click farm', 'fake reviews', 'fake followers', 'cloaking', 'free money', 'passive income', 'make money', 'trading bot', 'trading signals', 'exploit', 'exploits', '100x', '1000x', 'x402', 'usdg', 'usdc', 'usdt', 'stablecoin', 'evm', 'monad', 'trader', 'cheat engine', 'managed tiktok', 'dark web', 'osint', 'free access to frontier', 'pentest', 'penetration-testing', 'penetration testing', 'attack surface', 'account safety', 'looksmaxxing'];
const PERSONAL = ['doxx', 'doxxing', 'dox', 'stalk', 'stalking', 'stalker', 'people search', 'face search', 'facial recognition', 'my ex', 'ex-partner', 'colleague', 'coworker', 'digital twin of', 'clone yourself', 'clone a person', 'genealogy', 'talking-head', 'digital-human', 'digital human', 'wechat', 'where a photo was taken'];
// Handles of people, seen when this list was last read against the feed. The record stays in the counts.
const PEOPLE = ['jerome-benoit', 'jongleberry', 'schummar', 'jialinyyzz', 'alissonerdx', 'warmbloodaban', 'humanizer', 'oliviarossi', 'minimax-h3_singularity', 'pixai-tagger', 'kesha-antonov', 'code-yeongyu', 'jaredpalmer', 'chinoll', 'shhivv', 'zhengmingyu'];
const POLITICS = ['trump', 'biden', 'putin', 'zelensky', 'netanyahu', 'xi jinping', 'modi', 'gaza', 'palestine', 'israel', 'election', 'elections', 'maga'];

const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNFIT = new RegExp(`(?<![\\p{L}\\p{N}])(${[...ADULT, ...HATE, ...SCAM, ...PERSONAL, ...PEOPLE, ...POLITICS].map(escapeWord).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /\+\d[\d\s().-]{8,}\d/;

export function isUnfit(name: string, description: string): boolean {
  const text = `${name} ${description}`;
  return UNFIT.test(text) || EMAIL.test(text) || PHONE.test(text);
}

const LATIN_SHARE = 0.9;

/** A founder has to be able to read it from the back of a room. */
export function readable(text: string): boolean {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return false;
  return letters.filter((c) => /\p{Script=Latin}/u.test(c)).length / letters.length >= LATIN_SHARE;
}

const ONE_LINE_LIMIT = 180;

export function oneLine(text: string, limit = ONE_LINE_LIMIT): string {
  const clean = text
    .replace(/\p{Extended_Pictographic}\ufe0f?/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#]{1,3}/g, (m, offset: number, whole: string) => (/\w/.test(whole[offset - 1] ?? '') && /\w/.test(whole[offset + m.length] ?? '') ? m : ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.·-]+$/, '')}…`;
}
