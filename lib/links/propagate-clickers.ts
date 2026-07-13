import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Accept either the top-level `db` or a transaction handle.
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Bridge tracked link clicks → the `clickers` engagement table that segment
// clicker rules (is_clicker_any_brand / _for_brand / _for_offer), the campaign
// audience-snapshot `cl_set`, and the manual clicker export all read.
//
// Clicks land in `clicks` via the public redirect (/r/[code]); the segment
// rules query `clickers`, which historically was ONLY populated by CSV upload.
// That disconnect meant a contact who clicked a real tracked SMS link never
// counted as a clicker in any segment. This pass closes the gap.
//
// "Clicker" = a CLEAN click: classification = 'human' AND scored_at IS NOT NULL
// — the same definition the default ("clean") clicker export uses, so prefetch/
// preview (suspect) and bot noise never pollute a segment. Unscored rows are
// skipped; the scoring cron scores them first, then a later run propagates them.
//
// Attribution is derived from the link's campaign + stage:
//   brand_id / offer_id  ← campaigns (a tracked link only exists for a campaign
//                          that has a tracking_id, which requires both ⇒ non-null)
//   provider_id / provider_phone_id ← campaign_stages
//   phone_number         ← contacts
//   source               = 'tracked_click' (distinguishes from CSV-imported rows)
//
// INCREMENTAL (W1 Task 1c): a high-water mark on clicks.scored_at, stored in
// cron_locks(job_name='propagate-clickers'), bounds each run to
//   scored_at ∈ (watermark, now() - SAFETY_LAG]
// instead of re-deriving ALL-TIME human clicks every 15 min (which was the #1
// DB-time consumer — a full clicks scan + 4-way join, recon §2). The watermark
// advances only AFTER the INSERT commits (same transaction), so a failed run
// reprocesses its window rather than skipping it; the NOT EXISTS guard below
// keeps re-inserts idempotent regardless. First run: watermark is NULL ⇒ one
// final full pass over all history, then it goes incremental.
//
// SAFETY_LAG (5 min): score-pending stamps scored_at = now() as it scores. A
// score-pending run that overlaps this one writes scored_at ≈ now(), which is
// > now() - lag, so it falls OUTSIDE this window and is picked up by a later
// run — a late/concurrent score can never be skipped. now() is stable within
// the transaction, so the window filter and the watermark advance share one
// upper bound.
export const TRACKED_CLICKER_SOURCE = "tracked_click";
export const PROPAGATE_JOB_NAME = "propagate-clickers";

export interface PropagateClickersResult {
  inserted: number;
  watermarkFrom: string | null;
  watermarkTo: string | null;
}

export async function propagateTrackedClickers(
  dbc: DbOrTx,
): Promise<PropagateClickersResult> {
  return await dbc.transaction(async (tx) => {
    // Lock + read (self-creating) the watermark row. ON CONFLICT DO UPDATE takes
    // a row lock, so two overlapping propagate runs serialize here rather than
    // both scanning the same window.
    const wmRows = (await tx.execute(sql`
      INSERT INTO cron_locks (job_name) VALUES (${PROPAGATE_JOB_NAME})
      ON CONFLICT (job_name) DO UPDATE SET job_name = cron_locks.job_name
      RETURNING watermark
    `)) as unknown as { watermark: string | null }[];
    const watermark = wmRows[0]?.watermark ?? null;

    const rows = (await tx.execute(sql`
      INSERT INTO clickers (
        org_id, contact_id, phone_number, brand_id,
        provider_id, provider_phone_id, offer_id, source, created_at
      )
      SELECT DISTINCT ON (src.org_id, src.contact_id, src.brand_id, src.offer_id)
        src.org_id, src.contact_id, src.phone_number, src.brand_id,
        src.provider_id, src.provider_phone_id, src.offer_id,
        ${TRACKED_CLICKER_SOURCE}, src.last_clicked_at
      FROM (
        SELECT
          ck.org_id,
          l.contact_id,
          co.phone_number,
          ca.brand_id,
          st.sms_provider_id AS provider_id,
          st.provider_phone_id,
          ca.offer_id,
          max(ck.clicked_at) AS last_clicked_at
        FROM clicks ck
        JOIN links l ON l.id = ck.link_id
        JOIN campaigns ca ON ca.id = l.campaign_id
        JOIN campaign_stages st ON st.id = l.stage_id
        JOIN contacts co ON co.id = l.contact_id
        WHERE ck.classification = 'human'
          AND ck.scored_at IS NOT NULL
          AND (${watermark}::timestamptz IS NULL OR ck.scored_at > ${watermark}::timestamptz)
          AND ck.scored_at <= now() - interval '5 minutes'
        GROUP BY ck.org_id, l.contact_id, co.phone_number, ca.brand_id,
                 st.sms_provider_id, st.provider_phone_id, ca.offer_id
      ) src
      WHERE NOT EXISTS (
        SELECT 1 FROM clickers cx
        WHERE cx.org_id = src.org_id
          AND cx.contact_id = src.contact_id
          AND cx.brand_id = src.brand_id
          AND cx.source = ${TRACKED_CLICKER_SOURCE}
          AND cx.offer_id IS NOT DISTINCT FROM src.offer_id
      )
      ORDER BY src.org_id, src.contact_id, src.brand_id, src.offer_id,
               src.last_clicked_at DESC
      RETURNING id
    `)) as unknown as { id: number }[];

    // Advance to LEAST(now() - lag, max scored_at over the window). Postgres
    // LEAST ignores NULL, so an empty window advances to now() - lag (the scan
    // window can't regrow), while a non-empty window advances only as far as the
    // greatest scored_at we actually considered — never past what we've seen.
    const updated = (await tx.execute(sql`
      UPDATE cron_locks
      SET watermark = (
        SELECT LEAST(
          now() - interval '5 minutes',
          max(ck.scored_at)
        )
        FROM clicks ck
        WHERE ck.classification = 'human'
          AND ck.scored_at IS NOT NULL
          AND (${watermark}::timestamptz IS NULL OR ck.scored_at > ${watermark}::timestamptz)
          AND ck.scored_at <= now() - interval '5 minutes'
      )
      WHERE job_name = ${PROPAGATE_JOB_NAME}
      RETURNING watermark
    `)) as unknown as { watermark: string | null }[];

    return {
      inserted: Array.isArray(rows) ? rows.length : 0,
      watermarkFrom: watermark,
      watermarkTo: updated[0]?.watermark ?? null,
    };
  });
}
