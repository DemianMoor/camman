"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Generic filter persistence keyed by storageKey (typically a route).
// SSR-safe: returns defaults on first render, hydrates from localStorage after mount.
// Corrupted/missing storage falls back to defaults silently.
export function usePersistedFilters<T extends Record<string, unknown>>(
  storageKey: string,
  defaults: T,
): [T, (next: Partial<T>) => void, () => void] {
  // Stash defaults in a ref so the reset function doesn't depend on a fresh
  // reference each render.
  const defaultsRef = useRef(defaults);
  const [filters, setFilters] = useState<T>(defaultsRef.current);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setFilters({ ...defaultsRef.current, ...(parsed as Partial<T>) });
      }
    } catch {
      // Ignore parse / storage access errors.
    }
  }, [storageKey]);

  const update = useCallback(
    (next: Partial<T>) => {
      setFilters((prev) => {
        const merged = { ...prev, ...next };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(merged));
        } catch {
          // Ignore storage write errors (quota, private mode, etc.).
        }
        return merged;
      });
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Ignore.
    }
    setFilters(defaultsRef.current);
  }, [storageKey]);

  return [filters, update, reset];
}
