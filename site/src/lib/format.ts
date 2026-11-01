const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

export function utc(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

export function shortDate(date: string): string {
  const [, month, day] = date.slice(0, 10).split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

export function longDate(date: string): string {
  return `${shortDate(date)} ${date.slice(0, 4)}`;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function usd(value: number, digits = 2): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function plural(value: number, one: string, many = `${one}s`): string {
  return value === 1 ? one : many;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '';
}

export function repoName(repo: string): string {
  return repo.split('/').at(-1) ?? repo;
}

const FRIENDLY: Record<string, string> = { 'anything-llm': 'AnythingLLM', aura: 'AURA' };

export function friendlyRepo(repo: string): string {
  const name = repoName(repo);
  return FRIENDLY[name] ?? name;
}

/** The week a date's bar belongs to: the demo's weeks start on Monday. */
export function weeklyTotals(days: readonly string[], totals: readonly number[]): { start: string; total: number }[] {
  return days.reduce<{ start: string; total: number }[]>((weeks, day, index) => {
    const isMonday = new Date(utc(day)).getUTCDay() === 1;
    const value = totals[index] ?? 0;
    const last = weeks.at(-1);
    if (!last || isMonday) return [...weeks, { start: day, total: value }];
    return [...weeks.slice(0, -1), { ...last, total: last.total + value }];
  }, []);
}

/** A link only when the data holds a real https address. */
export function safeHttps(url: string | null | undefined): string | null {
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}
