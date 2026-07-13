// The single shared carrier classifier (brief §6). Every path — the lookup worker,
// CSV import, manual upload, and backfill — resolves carrier_norm through
// classifyCarrier(). There is deliberately no second classifier anywhere.
//
// This module is PURE (no db, no server-only) so it can be unit-tested directly;
// the DB-backed context loader lives in ./classify-context.
//
// Resolution chain (v2, first hit wins):
//   1. Telnyx normalized_carrier   2. learned carrier_mappings (exact, normalized key)
//   3. carrier_patterns (regex)    4. Unmapped -> caller enqueues for AI triage
//
// Gated by lookup_settings.carrier_resolver_v2. When off, classifyCarrier falls
// back to the exact prior behaviour (resolveCarrierNorm on carrier_name), so the
// two paths stay byte-identical to v1 until the flag is flipped.

import { CARRIER_BUCKETS, resolveCarrierNorm } from "../telnyx/map-carrier";
import type { CarrierNorm } from "../telnyx/types";
import { normalizeCarrierKey } from "./normalize-key";

export type CarrierSource =
  | "telnyx_norm"
  | "mapping"
  | "pattern"
  | "unresolved"
  | "v1";

export interface CompiledPattern {
  brand: CarrierNorm;
  re: RegExp;
  priority: number;
}

export interface ClassifierContext {
  v2: boolean;
  // v2: keyed by normalizeCarrierKey. v1: keyed by normalizeCarrierName. The loader
  // builds it with the key fn matching the active mode.
  mappings: Map<string, CarrierNorm>;
  patterns: CompiledPattern[];
}

export interface CarrierInput {
  telnyxNormalized?: string | null;
  carrierName?: string | null;
}

export interface CarrierResult {
  carrier_norm: CarrierNorm;
  source: CarrierSource;
}

// Resolve one carrier string to a real bucket via direct-bucket -> mapping ->
// pattern. Returns null when nothing matches. Used for BOTH the telnyx_normalized
// string and the raw carrier_name, so a Telnyx-normalized value like
// "Verizon Wireless" (not itself a bucket) still resolves through the same layers.
function resolveString(
  str: string,
  ctx: ClassifierContext,
): { brand: CarrierNorm; via: "mapping" | "pattern" } | null {
  const key = normalizeCarrierKey(str);
  if (!key) return null;

  // Direct bucket: telnyxNormalized may already be "T-Mobile" / "Verizon".
  for (const b of CARRIER_BUCKETS) {
    if (b !== "Unknown" && normalizeCarrierKey(b) === key) {
      return { brand: b, via: "mapping" };
    }
  }
  const mapped = ctx.mappings.get(key);
  if (mapped) return { brand: mapped, via: "mapping" };

  for (const p of ctx.patterns) {
    if (p.re.test(key)) return { brand: p.brand, via: "pattern" };
  }
  return null;
}

export function classifyCarrier(
  input: CarrierInput,
  ctx: ClassifierContext,
): CarrierResult {
  if (!ctx.v2) {
    // v1 fallback — exact prior behaviour (map keyed by normalizeCarrierName).
    return {
      carrier_norm: resolveCarrierNorm(input.carrierName, ctx.mappings),
      source: "v1",
    };
  }

  // 1. Telnyx normalized_carrier — trust it, resolved through the same layers.
  if (input.telnyxNormalized && input.telnyxNormalized.trim()) {
    const r = resolveString(input.telnyxNormalized, ctx);
    if (r) return { carrier_norm: r.brand, source: "telnyx_norm" };
  }

  // 2 + 3. carrier_name via exact mapping then pattern.
  if (!input.carrierName || !input.carrierName.trim()) {
    return { carrier_norm: "Unknown", source: "unresolved" };
  }
  const r = resolveString(input.carrierName, ctx);
  if (r) {
    return { carrier_norm: r.brand, source: r.via };
  }

  // 4. Unmapped — the caller enqueues the normalized key for async AI triage.
  return { carrier_norm: "Unmapped", source: "unresolved" };
}
