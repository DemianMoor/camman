import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { carrier_mappings } from "@/db/schema";

// The six assignable buckets (subset of CarrierNorm; excludes Unmapped/Unidentified).
export type CarrierBucket = "AT&T" | "T-Mobile" | "Verizon" | "Other Mobile" | "VoIP" | "Unknown";

export interface AssignMappingResult {
  lookups_updated: number;
  contacts_updated: number;
}

// Assign a raw carrier string to a bucket, then RETROACTIVELY reclassify every
// phone_lookups row + contact currently sitting at 'Unmapped' for that string. This
// is the "assign from the unmapped queue" action (the Phase-6 admin UI will call it;
// used now as the interim path). Idempotent. Only rows still 'Unmapped' are touched,
// so a later, more specific mapping never clobbers a manually-corrected value.
export async function assignCarrierMapping(
  rawName: string,
  bucket: CarrierBucket,
  mappedBy = "admin",
): Promise<AssignMappingResult> {
  return db.transaction(async (tx) => {
    await tx
      .insert(carrier_mappings)
      .values({ raw_name: rawName, carrier_norm: bucket, mapped_by: mappedBy })
      .onConflictDoUpdate({
        target: carrier_mappings.raw_name,
        set: { carrier_norm: bucket, mapped_by: mappedBy },
      });

    const pl = await tx.execute<{ phone: string }>(sql`
      UPDATE phone_lookups SET carrier_norm = ${bucket}, updated_at = now()
      WHERE carrier_raw = ${rawName} AND carrier_norm = 'Unmapped'
      RETURNING phone`);

    // Sync the denormalized contacts. carrier_norm isn't in the messaging_status
    // trigger's column list, so this doesn't disturb line_type/messaging_status.
    const c = await tx.execute<{ id: string }>(sql`
      UPDATE contacts c SET carrier_norm = ${bucket}, updated_at = now()
      FROM phone_lookups pl
      WHERE pl.phone = c.phone_number
        AND pl.carrier_raw = ${rawName}
        AND c.carrier_norm = 'Unmapped'
      RETURNING c.id`);

    return { lookups_updated: pl.length, contacts_updated: c.length };
  });
}

export const ASSIGNABLE_BUCKETS: readonly CarrierBucket[] = [
  "AT&T",
  "T-Mobile",
  "Verizon",
  "Other Mobile",
  "VoIP",
  "Unknown",
];
