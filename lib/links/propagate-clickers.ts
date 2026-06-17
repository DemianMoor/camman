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
// Idempotent: one clicker row per (org_id, contact_id, brand_id, offer_id) for
// the tracked source. NOT EXISTS skips contacts already materialized, so the
// pass is safe to run every cron tick. Trusted background context — runs across
// all orgs, carrying each click's org_id straight through.
export const TRACKED_CLICKER_SOURCE = "tracked_click";

export interface PropagateClickersResult {
  inserted: number;
}

export async function propagateTrackedClickers(
  dbc: DbOrTx,
): Promise<PropagateClickersResult> {
  const rows = (await dbc.execute(sql`
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

  return { inserted: Array.isArray(rows) ? rows.length : 0 };
}
