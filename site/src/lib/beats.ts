// Where each screen is in its beats, kept for the tab: a refresh mid-demo stays on the beat, and ←
// comes back to a screen on its last beat. Storage can throw or come back empty; memory still works.
const KEY = 'keepup.present';

export type StoredBeat = { beat: number | 'last'; scope: string };
type Store = { beats: Readonly<Record<string, StoredBeat>>; repo: string | null; timer: number | null };

const EMPTY: Store = { beats: {}, repo: null, timer: null };
let memory: Store = EMPTY;

function load(): Store {
  try {
    const saved = window.sessionStorage.getItem(KEY);
    return saved ? { ...EMPTY, ...(JSON.parse(saved) as Partial<Store>) } : memory;
  } catch {
    return memory;
  }
}

function save(next: Store): void {
  memory = next;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A private window or blocked storage: this tab still has memory.
  }
}

/** Only a refresh picks up where it was. Opening the demo fresh in the same tab starts it fresh. */
export function startSession(): void {
  const [entry] = window.performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  if (entry?.type !== 'reload') save(EMPTY);
}

export const readBeat = (screen: string): StoredBeat | null => load().beats[screen] ?? null;

export function writeBeat(screen: string, beat: number | 'last', scope = ''): void {
  const store = load();
  save({ ...store, beats: { ...store.beats, [screen]: { beat, scope } } });
}

export function clearBeat(screen: string): void {
  const store = load();
  save({ ...store, beats: Object.fromEntries(Object.entries(store.beats).filter(([key]) => key !== screen)) });
}

export const readRepo = (): string | null => load().repo;
export const writeRepo = (repo: string): void => save({ ...load(), repo });

export const readTimer = (): number | null => load().timer;
export const writeTimer = (timer: number | null): void => save({ ...load(), timer });
