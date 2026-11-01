export type ScreenId =
  | 'overview'
  | 'repo'
  | 'pulse'
  | 'connect'
  | 'understood'
  | 'replay'
  | 'pr'
  | 'keeps-up'
  | 'monday'
  | 'moonshot'
  | 'real';

export type Route = { screen: ScreenId; arg: string | null };

/** The order the demo runs in. Number keys jump here. */
export const PRESENT_ORDER: readonly ScreenId[] = [
  'pulse',
  'connect',
  'understood',
  'replay',
  'pr',
  'keeps-up',
  'monday',
  'moonshot',
];

const BONUS_SCREEN: ScreenId = 'moonshot';

export const SCREEN_LABEL: Readonly<Record<ScreenId, string>> = {
  overview: 'Your repos',
  repo: 'Repo',
  pulse: 'The pulse',
  connect: 'Connect',
  understood: 'What we understood',
  replay: 'The replay',
  pr: 'The pull request',
  'keeps-up': 'It keeps up',
  monday: 'Monday',
  moonshot: 'Moonshot',
  real: 'How this is real',
};

export type RailItem = {
  label: string;
  screen: ScreenId;
  children?: readonly { label: string; screen: ScreenId }[];
};

export const RAIL: readonly RailItem[] = [
  { label: 'Your repos', screen: 'overview', children: [] },
  {
    label: 'The 60-day replay',
    screen: 'replay',
    children: [
      { label: 'The replay', screen: 'replay' },
      { label: 'Everything new', screen: 'pulse' },
      { label: 'What we understood', screen: 'understood' },
      { label: 'Connect', screen: 'connect' },
      { label: 'Pull requests', screen: 'pr' },
      { label: 'It keeps up', screen: 'keeps-up' },
      { label: 'Monday', screen: 'monday' },
      { label: 'Moonshot', screen: 'moonshot' },
      { label: 'How this is real', screen: 'real' },
    ],
  },
];

const KNOWN = new Set<string>(Object.keys(SCREEN_LABEL));

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [screen, ...rest] = clean.split('/');
  if (screen && KNOWN.has(screen)) {
    return { screen: screen as ScreenId, arg: rest.length > 0 ? decodeURIComponent(rest.join('/')) : null };
  }
  return { screen: 'overview', arg: null };
}

export function hashFor(screen: ScreenId, arg?: string | null): string {
  return arg ? `#${screen}/${encodeURIComponent(arg)}` : `#${screen}`;
}

/** The next or previous screen in the demo, and null past either end. */
export function stepScreen(current: ScreenId, delta: 1 | -1): ScreenId | null {
  const index = PRESENT_ORDER.indexOf(current);
  if (index === -1) return PRESENT_ORDER[0] ?? null;
  const next = PRESENT_ORDER[index + delta] ?? null;
  // The story ends on the tagline. One stray press mustn't replace it: the bonus is reached only by its number.
  return delta === 1 && next === BONUS_SCREEN ? null : next;
}
