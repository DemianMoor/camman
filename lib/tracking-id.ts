import { sql } from "drizzle-orm";
import type { db } from "@/db/client";

import { formatInCampaignTimezone } from "@/lib/campaign-timezone";

// No `"server-only"` import: this module is used by API routes AND by
// scripts/backfill-tracking-ids.ts (a plain Node entry point). The module
// holds no secrets — it composes integer FK ids and a date — so there's
// nothing to leak into a client bundle. If the client ever imports it,
// the imported `db` type is type-only and erased at runtime.

// =============================================================================
// Tracking IDs (Phase 9)
//
// Two structured, immutable identifiers built from existing FK ids so they
// can be embedded in external analytics URLs without exposing internal UUIDs.
//
//   campaign tracking_id: `<brand_id>_<offer_id>_<MMDDYY>_<seq>`
//                          e.g. "5_14296_051526_1"
//
//   stage tracking_id:    `<campaign_tracking_id>_s<stage_number>_c<creative_id>`
//                          e.g. "5_14296_051526_1_s2_c42"
//
// Date segment is the campaign's `created_at` rendered in America/New_York
// (the project-wide CAMPAIGN_TIMEZONE). MMDDYY is acceptable for v1 — the
// counter, not the date, enforces uniqueness, and the year wraps in 2100.
// IDs are NOT string-sortable across year boundaries; always order by
// `created_at` if you need chronology.
//
// Both IDs are write-once. The PATCH endpoints (and the validators)
// reject any payload that attempts to mutate them. Mutating brand_id,
// offer_id, creative_id, etc. on an entity that already has a non-NULL
// tracking_id does NOT regenerate the ID — the historical reference is
// preserved by design.
// =============================================================================

// Drizzle's `db.transaction(tx => ...)` callback parameter type. We accept
// either the top-level `db` object or a transaction handle so callers can
// pick whichever fits the route's existing structure.
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

interface GenerateCampaignTrackingIdInput {
  orgId: string;
  brandId: number;
  offerId: number;
  createdAt: Date | string;
}

// Atomically allocate the next sequence number for (org, brand, offer, day)
// and return the fully-formatted campaign tracking_id. MUST run inside the
// same transaction that creates / updates the campaign so a rollback also
// releases the sequence number (the row stays but `next_seq` is unchanged
// since the row never committed).
export async function generateCampaignTrackingId(
  tx: DbOrTx,
  { orgId, brandId, offerId, createdAt }: GenerateCampaignTrackingIdInput,
): Promise<string> {
  const dateForId = formatInCampaignTimezone(createdAt, "MMddyy");
  const dateEtSql = formatInCampaignTimezone(createdAt, "yyyy-MM-dd");

  // INSERT ... ON CONFLICT DO UPDATE ... RETURNING returns the newly
  // observed value of next_seq AFTER the update applied, so we subtract 1
  // to get the sequence number this call just claimed.
  //
  // - First insert for a given key: VALUES sets next_seq = 2, the row is
  //   inserted as-is, RETURNING gives 2 - 1 = 1.
  // - Subsequent inserts: ON CONFLICT increments by 1; if the prior value
  //   was 2 we now return 3 - 1 = 2.
  const rows = (await tx.execute(sql`
    INSERT INTO campaign_tracking_counters
      (org_id, brand_id, offer_id, date_et, next_seq)
    VALUES (${orgId}, ${brandId}, ${offerId}, ${dateEtSql}, 2)
    ON CONFLICT (org_id, brand_id, offer_id, date_et)
    DO UPDATE SET next_seq = campaign_tracking_counters.next_seq + 1
    RETURNING (next_seq - 1) AS allocated_seq
  `)) as unknown as { allocated_seq: number }[];

  const row = rows[0];
  if (!row) {
    throw new Error(
      "generateCampaignTrackingId: counter allocation returned no row",
    );
  }
  const seq = Number(row.allocated_seq);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(
      `generateCampaignTrackingId: invalid allocated_seq ${row.allocated_seq}`,
    );
  }

  return `${brandId}_${offerId}_${dateForId}_${seq}`;
}

interface GenerateStageTrackingIdInput {
  campaignTrackingId: string;
  stageNumber: number;
  creativeId: number;
}

// Pure string composition — stage tracking IDs don't need their own counter.
// `(campaign_tracking_id, stage_number)` is unique by construction
// (stage_number is per-campaign and never reused), so suffixing with the
// creative id is for analytics readability, not uniqueness.
export function generateStageTrackingId({
  campaignTrackingId,
  stageNumber,
  creativeId,
}: GenerateStageTrackingIdInput): string {
  return `${campaignTrackingId}_s${stageNumber}_c${creativeId}`;
}
