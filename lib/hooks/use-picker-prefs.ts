"use client";

import { useCallback, useEffect, useState } from "react";

// Per-browser preferences for numeric-id pickers: pinned ids + a short MRU
// of recently-selected ones, namespaced so different pickers don't collide.
// localStorage-backed; SSR-safe (returns empties on first render, hydrates
// after mount).
//
// Tech debt: this is per-browser, not per-user. Migrate to a server-side
// user_preferences table when user management ships and we want these to
// follow operators across devices.

const RECENT_MAX = 10;

function readIds(key: string): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is number => typeof x === "number" && Number.isFinite(x),
    );
  } catch {
    return [];
  }
}

function writeIds(key: string, ids: number[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // quota / private mode — ignore
  }
}

// `namespace` keys the localStorage entries, e.g. "segments" → "segments.pinned"
// / "segments.recent". Keep it stable per picker.
export function usePickerPrefs(namespace: string) {
  const pinnedKey = `${namespace}.pinned`;
  const recentKey = `${namespace}.recent`;
  const [pinnedIds, setPinnedIds] = useState<number[]>([]);
  const [recentIds, setRecentIds] = useState<number[]>([]);

  useEffect(() => {
    setPinnedIds(readIds(pinnedKey));
    setRecentIds(readIds(recentKey));
  }, [pinnedKey, recentKey]);

  const togglePin = useCallback(
    (id: number) => {
      setPinnedIds((prev) => {
        const next = prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id];
        writeIds(pinnedKey, next);
        return next;
      });
    },
    [pinnedKey],
  );

  const pushRecent = useCallback(
    (id: number) => {
      setRecentIds((prev) => {
        const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_MAX);
        writeIds(recentKey, next);
        return next;
      });
    },
    [recentKey],
  );

  return { pinnedIds, recentIds, togglePin, pushRecent };
}
