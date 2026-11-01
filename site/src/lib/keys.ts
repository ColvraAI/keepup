// One forward key: arrow, space and a clicker's PageDown all mean "next", and a key only counts
// when nobody is typing and no control has focus.
const TEXT_INPUTS = /^(text|search|url|email|password|tel)$/;

export function isForwardKey(key: string): boolean {
  return key === 'ArrowRight' || key === ' ' || key === 'PageDown';
}

export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  if (element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true;
  return element.tagName === 'INPUT' && TEXT_INPUTS.test((element as HTMLInputElement).type);
}

/** Enter and Space belong to a focused link, button or switch. */
export function isOnControl(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('a[href], button, input, select, textarea, summary, label'));
}

export function hasModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

export const isPresentNow = (): boolean => document.documentElement.classList.contains('is-present');
