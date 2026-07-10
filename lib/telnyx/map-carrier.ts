import type { CarrierNorm } from "./types";

// The six user-facing buckets (excludes the internal 'Unmapped'/'Unknown' states).
export const CARRIER_BUCKETS: readonly CarrierNorm[] = [
  "AT&T",
  "T-Mobile",
  "Verizon",
  "Other Mobile",
  "VoIP",
  "Unknown",
] as const;

// Canonical form for matching a raw carrier string against carrier_mappings,
// regardless of the exact casing/spacing Telnyx returns. Keep this stable — both
// the map keys (built from carrier_mappings.raw_name) and the incoming raw string
// go through it, so a change here must be applied to both sides at once.
export function normalizeCarrierName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

// Resolve a raw carrier string to a bucket using a normalized lookup map
// (normalizeCarrierName(raw_name) -> carrier_norm), built from carrier_mappings.
//
//   - empty / no carrier info        -> 'Unknown'  (we have nothing to map)
//   - matched in the mapping table   -> the mapped bucket
//   - present but unmapped           -> 'Unmapped' (surfaces in the admin queue)
//
// 'Unmapped' behaves identically to 'Unknown' in all filter logic; it's tracked
// separately only so the admin unmapped queue works.
export function resolveCarrierNorm(
  rawName: string | null | undefined,
  mappings: Map<string, CarrierNorm>,
): CarrierNorm {
  if (!rawName || !rawName.trim()) return "Unknown";
  const key = normalizeCarrierName(rawName);
  return mappings.get(key) ?? "Unmapped";
}
