// What the Done-when list counts, shared with go and the live read.
export const BRIEF_WEEK = '2026-10-26';
export const FORK_NAMES = ['anything-llm', 'aura'];

/** The key names a lab's "needs" line mentions. */
export const namedKeys = (needs: string | undefined | null): string[] => needs?.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [];
