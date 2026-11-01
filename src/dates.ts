// Date spellings. Everything internal is an ISO date; the brief reads "26 Feb 2027".

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2027-02-26" to "26 Feb 2027". Anything else comes back as it was. */
export function humanDate(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return iso;
  return `${Number(match[3])} ${SHORT_MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** "2026-09-01" to "1 Sep". */
export function humanDayMonth(iso: string): string {
  return humanDate(iso).replace(/ \d{4}$/, '');
}

export function monthNumber(name: string): number {
  return SHORT_MONTHS.indexOf(name.slice(0, 3)) + 1;
}

/** A month's name or its first three letters, a day and a year, as an ISO date. */
export function isoDate(month: string, day: string | number, year: string | number): string {
  return `${year}-${String(monthNumber(month)).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "February 26, 2027" anywhere in a sentence. Groups: month, day, year. */
export const LONG_DATE_SOURCE = '\\b(January|February|March|April|May|June|July|August|September|October|November|December) (\\d{1,2}),\\s*(20\\d\\d)\\b';

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}
