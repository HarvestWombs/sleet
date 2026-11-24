import type { TabNav } from "../types";

const MAX_ENTRIES = 50;

/**
 * Folds an observed address into a tab's saved history. Moving to the
 * neighbouring entry counts as back/forward; anything else is a new visit that
 * drops the forward entries, like a browser's own history.
 */
export function recordVisit(nav: TabNav | undefined, current: string, url: string): TabNav {
  const base = nav && nav.stack.length > 0 ? nav : { stack: [current], index: 0 };
  const { stack, index } = base;
  if (stack[index] === url) return base;
  if (stack[index - 1] === url) return { stack, index: index - 1 };
  if (stack[index + 1] === url) return { stack, index: index + 1 };
  const next = [...stack.slice(0, index + 1), url].slice(-MAX_ENTRIES);
  return { stack: next, index: next.length - 1 };
}

/** Entry one step back or forward, or `null` at either end. */
export function neighbour(nav: TabNav | undefined, back: boolean): { url: string; index: number } | null {
  if (!nav) return null;
  const index = nav.index + (back ? -1 : 1);
  const url = nav.stack[index];
  return url ? { url, index } : null;
}
