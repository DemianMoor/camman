"use client";

import { useCallback, useEffect, useState } from "react";

// Per-browser preferences for the segment picker: pinned segments + a
// short MRU of recently-selected ones. localStorage-backed; SSR-safe
// (returns empties on first render, hydrates after mount).
//
// Tech debt: this is per-browser, not per-user. Migrate to a server-side
// user_preferences table when user management ships and we want these
// to follow operators across devices.

const PINNED_KEY = "segments.pinned";
const RECENT_KEY = "segments.recent";
const RECENT_MAX = 10;

function readIds(key: string): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
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

export function useSegmentPrefs() {
  const [pinnedIds, setPinnedIds] = useState<number[]>([]);
  const [recentIds, setRecentIds] = useState<number[]>([]);

  useEffect(() => {
    setPinnedIds(readIds(PINNED_KEY));
    setRecentIds(readIds(RECENT_KEY));
  }, []);

  const togglePin = useCallback((id: number) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      writeIds(PINNED_KEY, next);
      return next;
    });
  }, []);

  const pushRecent = useCallback((id: number) => {
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_MAX);
      writeIds(RECENT_KEY, next);
      return next;
    });
  }, []);

  return { pinnedIds, recentIds, togglePin, pushRecent };
}

// Detect a timestamp-suffixed auto-generated segment name like
// "Rules Seg 1778838118710" or "Rules SegB 1778838118710".
export function isAutoNamedSegment(name: string): boolean {
  return /^Rules\s+Seg\S*\s+\d{10,}$/i.test(name.trim());
}
