import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

import { pgArray } from "./pg-array";

export interface SyncResult {
  contactsUpdated: number;
  pendingSendsCancelled: number;
  poolRemoved: number;
}

// Sync contacts from the global phone_lookups cache for a set of just-written
// phones. Copies line_type + carrier_norm down (across ALL orgs — the cache is
// global), replacing 'Unidentified' with the real value (the trigger then derives
// messaging_status). For landlines: cancel PENDING stage_sends ONLY (never
// 'sending' — mid-flight, the HTTP call may already be out; deleting can't unsend
// and would break the DLR match) and remove the contact from campaign_audience_pool
// so it won't re-materialize. Sent history is untouched.
export async function syncContactsForPhones(phones: string[]): Promise<SyncResult> {
  if (phones.length === 0) {
    return { contactsUpdated: 0, pendingSendsCancelled: 0, poolRemoved: 0 };
  }
  return db.transaction(async (tx) => {
    // 1. Copy line_type + carrier_norm from cache -> contacts. IS DISTINCT FROM
    //    guard skips no-op rewrites; setting line_type fires the messaging_status
    //    trigger.
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE contacts c
      SET line_type = pl.line_type, carrier_norm = pl.carrier_norm, updated_at = now()
      FROM phone_lookups pl
      WHERE pl.phone = c.phone_number
        AND pl.phone = ANY(${pgArray(phones, "text")})
        AND (c.line_type IS DISTINCT FROM pl.line_type
             OR c.carrier_norm IS DISTINCT FROM pl.carrier_norm)
      RETURNING c.id
    `);

    // 2. Landline cleanup — cancel PENDING sends only (not 'sending').
    const cancelled = await tx.execute<{ id: string }>(sql`
      UPDATE stage_sends ss
      SET status = 'filtered', last_error = 'landline_not_applicable'
      FROM contacts c
      WHERE ss.contact_id = c.id
        AND c.phone_number = ANY(${pgArray(phones, "text")})
        AND c.line_type = 'landline'
        AND ss.status = 'pending'
      RETURNING ss.id
    `);

    // 3. Remove landline contacts from frozen audience pools (won't re-materialize).
    const pool = await tx.execute<{ contact_id: string }>(sql`
      DELETE FROM campaign_audience_pool cap
      USING contacts c
      WHERE cap.contact_id = c.id
        AND c.phone_number = ANY(${pgArray(phones, "text")})
        AND c.line_type = 'landline'
      RETURNING cap.contact_id
    `);

    return {
      contactsUpdated: updated.length,
      pendingSendsCancelled: cancelled.length,
      poolRemoved: pool.length,
    };
  });
}
