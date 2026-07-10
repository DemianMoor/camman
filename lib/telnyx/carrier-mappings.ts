import "server-only";

import { db } from "@/db/client";
import { carrier_mappings } from "@/db/schema";

import { normalizeCarrierName } from "./map-carrier";
import type { CarrierNorm } from "./types";

// Load carrier_mappings into a normalized lookup map for resolveCarrierNorm.
// Keyed on normalizeCarrierName(raw_name) so matching is case/spacing-insensitive.
// The table is small (seed + admin assignments); the worker loads it once per run.
export async function loadCarrierMappings(): Promise<Map<string, CarrierNorm>> {
  const rows = await db
    .select({
      raw_name: carrier_mappings.raw_name,
      carrier_norm: carrier_mappings.carrier_norm,
    })
    .from(carrier_mappings);

  const map = new Map<string, CarrierNorm>();
  for (const r of rows) {
    map.set(normalizeCarrierName(r.raw_name), r.carrier_norm as CarrierNorm);
  }
  return map;
}
