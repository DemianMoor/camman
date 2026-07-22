"use client";

import { usePickerPrefs } from "@/lib/hooks/use-picker-prefs";

// Per-browser preferences for the segment picker: pinned segments + a short
// MRU of recently-selected ones. Thin wrapper over the generic usePickerPrefs
// under the "segments" namespace (localStorage keys segments.pinned /
// segments.recent), preserved so existing callers don't change.
export function useSegmentPrefs() {
  return usePickerPrefs("segments");
}

// Detect a timestamp-suffixed auto-generated segment name like
// "Rules Seg 1778838118710" or "Rules SegB 1778838118710".
export function isAutoNamedSegment(name: string): boolean {
  return /^Rules\s+Seg\S*\s+\d{10,}$/i.test(name.trim());
}
