import { useCallback, useState } from "react";

/**
 * `[size, setSize]` tuple persisted to localStorage under `storageKey`.
 *
 * Reads on mount (lazy initializer); writes on every setSize. Falls back
 * to in-memory state if localStorage is unavailable or throws (privacy mode,
 * quota exceeded, etc.).
 */
export function usePersistedSize(
  storageKey: string,
  defaultSize: number,
): [number, (next: number) => void] {
  const [size, setSizeState] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return defaultSize;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSize;
    } catch {
      return defaultSize;
    }
  });

  const setSize = useCallback((next: number) => {
    setSizeState(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // Silently fall through to in-memory state.
    }
  }, [storageKey]);

  return [size, setSize];
}
