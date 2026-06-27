// Session-scoped, in-memory sticky state for per-tab filters.
//
// Why a module-level Map (not localStorage/sessionStorage): the user wants tab
// filters remembered while moving between tabs WITHIN a session, but RESET on a
// page refresh / closing the link. A module variable is exactly that — it survives
// SPA tab switches (views unmount/remount, but this module stays loaded) and is
// wiped on a full page reload (the JS re-evaluates). Nothing is persisted to disk,
// so it only ever affects the current browser tab's session.
import { useState, useCallback } from 'react';

const store = new Map();

export const readSticky = (key, fallback) => (store.has(key) ? store.get(key) : fallback);
export const writeSticky = (key, value) => { store.set(key, value); };

// Drop-in replacement for useState whose value is remembered (in-memory) under `key`
// across view unmount/remount. Same call signature/semantics as useState, including
// functional updates: setX(prev => next).
export function useStickyState(key, initial) {
  const [val, setVal] = useState(() => readSticky(key, initial));
  const set = useCallback((next) => {
    setVal((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      writeSticky(key, resolved);
      return resolved;
    });
  }, [key]);
  return [val, set];
}
