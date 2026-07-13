import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { carrier_mappings, carrier_patterns } from "@/db/schema";

import { normalizeCarrierName } from "../telnyx/map-carrier";
import { loadLookupSettings } from "../telnyx/settings";
import type { CarrierNorm } from "../telnyx/types";
import type { ClassifierContext, CompiledPattern } from "./classify";
import { normalizeCarrierKey } from "./normalize-key";

// DB-backed loader for the shared classifier context. Split from ./classify (which
// is kept pure/unit-testable) so importing the resolver logic doesn't drag in the
// db client + server-only guard.
//
// Loads mappings (+ patterns when v2) and the resolver-mode flag once per run. The
// mapping key fn matches the active mode: v2 keys on the aggressive normalizeCarrierKey
// (route-suffix stripping); v1 keys on normalizeCarrierName (the legacy behaviour).
export async function loadClassifierContext(
  forceV2 = false,
): Promise<ClassifierContext> {
  const settings = await loadLookupSettings();
  const v2 = forceV2 || settings.carrier_resolver_v2;
  const keyFn = v2 ? normalizeCarrierKey : normalizeCarrierName;

  const mapRows = await db
    .select({
      raw_name: carrier_mappings.raw_name,
      carrier_norm: carrier_mappings.carrier_norm,
    })
    .from(carrier_mappings);
  const mappings = new Map<string, CarrierNorm>();
  for (const r of mapRows) {
    mappings.set(keyFn(r.raw_name), r.carrier_norm as CarrierNorm);
  }

  let patterns: CompiledPattern[] = [];
  if (v2) {
    const patRows = await db
      .select({
        pattern: carrier_patterns.pattern,
        brand: carrier_patterns.brand,
        priority: carrier_patterns.priority,
      })
      .from(carrier_patterns)
      .where(eq(carrier_patterns.is_active, true));
    patterns = patRows
      .map((p) => ({
        brand: p.brand as CarrierNorm,
        re: safeRegExp(p.pattern),
        priority: p.priority,
      }))
      .filter((p): p is CompiledPattern => p.re !== null)
      .sort((a, b) => a.priority - b.priority);
  }

  return { v2, mappings, patterns };
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    // A malformed human-authored pattern must never crash classification.
    return null;
  }
}
