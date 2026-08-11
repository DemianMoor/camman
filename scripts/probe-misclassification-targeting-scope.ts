import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. SCOPE ONLY — no remediation.
//
// Did the datacenter misclassification affect TARGETING, not just reporting?
// Two consumers of clicks.classification sit on the send/audience path:
//
//   T1 lib/campaign-tier.ts  — behavioural lanes. Tier 1 ("Clicked") requires
//      classification NOT IN (bot,prefetch,suspect). A relay click was
//      'suspect', so the contact read as tier 0 (Ignored) and would be routed
//      into the Ignored lane and sent the wrong follow-up.
//   T2 lib/links/propagate-clickers.ts — writes the `clickers` table from
//      classification='human'. `clickers` feeds segment clicker rules
//      (is_clicker_any_brand/_for_brand/_for_offer), the campaign
//      audience-snapshot cl_set, and the clicker export.
//
// The 4,312 rescored suspect->human rows are exactly: asn IN the 7 fixed ASNs
// AND classification='human' AND clicked_at before the backfill (those ASNs had
// ZERO human rows pre-backfill, per the snapshot).
//
// Run: npx tsx scripts/probe-misclassification-targeting-scope.ts

const FIXED_ASNS = sql`(54113, 13335, 36183, 16591, 32307, 27235, 18693)`;
const BACKFILL_AT = sql`'2026-08-11 06:09:00'::timestamp AT TIME ZONE 'America/New_York'`;

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async (query: ReturnType<typeof sql>) => {
    let out: Record<string, unknown>[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as Record<string, unknown>[];
    });
    return out;
  };
  const show = (t: string, r: unknown[]) => { console.log(`\n=== ${t} ===`); console.table(r); };

  // Sanity: the rescored population is identifiable and matches the backfill.
  show("S0 rescored population (expect 4,312)", await q(sql`
    SELECT count(*)::text AS rescored_clicks,
           count(DISTINCT link_id)::text AS links
    FROM clicks
    WHERE asn IN ${FIXED_ASNS} AND classification = 'human' AND clicked_at < ${BACKFILL_AT}
  `));

  // ── T1 ─ do behavioural lane stages exist, and have they SENT? ────────────
  show("T1a lane stages (behavioral_tier IS NOT NULL)", await q(sql`
    SELECT coalesce(behavioral_tier::text, '(none)') AS lane_tier,
           count(*)::text AS stages,
           count(*) FILTER (WHERE sent_at IS NOT NULL)::text AS stages_sent,
           count(*) FILTER (WHERE archived_at IS NOT NULL)::text AS archived
    FROM campaign_stages WHERE behavioral_tier IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `));

  show("T1b messages actually sent through lane stages", await q(sql`
    SELECT cs.behavioral_tier::text AS lane_tier,
           count(*)::text AS stage_sends_rows,
           count(*) FILTER (WHERE ss.status = 'sent')::text AS sent,
           count(DISTINCT ss.contact_id)::text AS distinct_contacts,
           count(*) FILTER (WHERE ss.converted_at IS NOT NULL)::text AS buyers,
           coalesce(sum(ss.sale_revenue), 0)::numeric(12,2) AS revenue
    FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE cs.behavioral_tier IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `));

  // ── T1c ─ contacts whose CAMPAIGN TIER changes because of the fix ─────────
  // tier_before excludes the rescored clicks (they were 'suspect' = dirty);
  // tier_after includes them. Affected = 0 -> 1.
  show("T1c contacts whose campaign tier changes 0 -> 1", await q(sql`
    WITH rescored AS (
      SELECT ck.id, l.campaign_id, l.contact_id
      FROM clicks ck JOIN links l ON l.id = ck.link_id
      WHERE ck.asn IN ${FIXED_ASNS} AND ck.classification = 'human'
        AND ck.clicked_at < ${BACKFILL_AT}
    ),
    cand AS (SELECT DISTINCT campaign_id, contact_id FROM rescored),
    tiers AS (
      SELECT cand.campaign_id, cand.contact_id,
             -- clean click NOT counting the rescored rows = the old tier-1 signal
             EXISTS (
               SELECT 1 FROM links l2 JOIN clicks c2 ON c2.link_id = l2.id
               WHERE l2.campaign_id = cand.campaign_id AND l2.contact_id = cand.contact_id
                 AND c2.classification NOT IN ('bot','prefetch','suspect')
                 AND c2.id NOT IN (SELECT id FROM rescored)
             ) AS had_other_clean_click,
             EXISTS (
               SELECT 1 FROM stage_sends ss
               WHERE ss.campaign_id = cand.campaign_id AND ss.contact_id = cand.contact_id
                 AND (ss.offer_reached_at IS NOT NULL OR ss.sale_status = 'sale')
             ) AS had_higher_tier
      FROM cand
    )
    SELECT count(*)::text AS candidate_contact_campaigns,
           count(*) FILTER (WHERE NOT had_other_clean_click AND NOT had_higher_tier)::text AS tier_0_to_1_AFFECTED,
           count(*) FILTER (WHERE had_other_clean_click)::text AS already_tier1_no_change,
           count(*) FILTER (WHERE had_higher_tier)::text AS already_tier2plus_no_change
    FROM tiers
  `));

  // ── T1d ─ THE HARM: were any affected contacts actually SENT a lane stage? ─
  show("T1d affected contacts sent a lane-stage message (the real harm)", await q(sql`
    WITH rescored AS (
      SELECT ck.id, l.campaign_id, l.contact_id
      FROM clicks ck JOIN links l ON l.id = ck.link_id
      WHERE ck.asn IN ${FIXED_ASNS} AND ck.classification = 'human'
        AND ck.clicked_at < ${BACKFILL_AT}
    ),
    affected AS (
      SELECT DISTINCT r.campaign_id, r.contact_id
      FROM rescored r
      WHERE NOT EXISTS (
        SELECT 1 FROM links l2 JOIN clicks c2 ON c2.link_id = l2.id
        WHERE l2.campaign_id = r.campaign_id AND l2.contact_id = r.contact_id
          AND c2.classification NOT IN ('bot','prefetch','suspect')
          AND c2.id NOT IN (SELECT id FROM rescored)
      )
      AND NOT EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.campaign_id = r.campaign_id AND ss.contact_id = r.contact_id
          AND (ss.offer_reached_at IS NOT NULL OR ss.sale_status = 'sale')
      )
    )
    SELECT coalesce(cs.behavioral_tier::text, 'ordinary stage') AS lane_sent_into,
           count(*)::text AS messages,
           count(DISTINCT ss.contact_id)::text AS contacts,
           count(DISTINCT ss.stage_id)::text AS stages,
           count(*) FILTER (WHERE ss.converted_at IS NOT NULL)::text AS buyers,
           coalesce(sum(ss.sale_revenue), 0)::numeric(12,2) AS revenue
    FROM affected a
    JOIN stage_sends ss ON ss.campaign_id = a.campaign_id AND ss.contact_id = a.contact_id
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.status = 'sent'
    GROUP BY 1 ORDER BY 2 DESC
  `));

  // ── T2 ─ clickers propagation gap ────────────────────────────────────────
  show("T2a propagate-clickers watermark vs the rescored rows' scored_at", await q(sql`
    SELECT (SELECT watermark::text FROM cron_locks WHERE job_name = 'propagate-clickers') AS watermark,
           min(ck.scored_at)::text AS rescored_min_scored_at,
           max(ck.scored_at)::text AS rescored_max_scored_at,
           count(*) FILTER (
             WHERE ck.scored_at <= (SELECT watermark FROM cron_locks WHERE job_name = 'propagate-clickers')
           )::text AS rows_BEHIND_watermark_never_repropagated
    FROM clicks ck
    WHERE ck.asn IN ${FIXED_ASNS} AND ck.classification = 'human' AND ck.clicked_at < ${BACKFILL_AT}
  `));

  show("T2b (contact,brand,offer) combos that SHOULD be clickers but are missing", await q(sql`
    WITH should_be AS (
      SELECT DISTINCT ck.org_id, l.contact_id, ca.brand_id, ca.offer_id
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      JOIN campaigns ca ON ca.id = l.campaign_id
      WHERE ck.asn IN ${FIXED_ASNS} AND ck.classification = 'human'
        AND ck.clicked_at < ${BACKFILL_AT}
    )
    SELECT count(*)::text AS should_be_clicker_combos,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM clickers cx
             WHERE cx.org_id = s.org_id AND cx.contact_id = s.contact_id
               AND cx.brand_id = s.brand_id
               AND cx.offer_id IS NOT DISTINCT FROM s.offer_id
           ))::text AS MISSING_from_clickers_entirely,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM clickers cx
             WHERE cx.org_id = s.org_id AND cx.contact_id = s.contact_id
               AND cx.brand_id = s.brand_id
               AND cx.offer_id IS NOT DISTINCT FROM s.offer_id
           ))::text AS present_via_other_click_or_csv
    FROM should_be s
  `));

  // Revenue exposure of the contacts missing from clickers.
  show("T2c revenue attached to contacts missing from clickers", await q(sql`
    WITH should_be AS (
      SELECT DISTINCT ck.org_id, l.contact_id, ca.brand_id, ca.offer_id
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      JOIN campaigns ca ON ca.id = l.campaign_id
      WHERE ck.asn IN ${FIXED_ASNS} AND ck.classification = 'human'
        AND ck.clicked_at < ${BACKFILL_AT}
    ),
    missing AS (
      SELECT s.* FROM should_be s WHERE NOT EXISTS (
        SELECT 1 FROM clickers cx
        WHERE cx.org_id = s.org_id AND cx.contact_id = s.contact_id
          AND cx.brand_id = s.brand_id AND cx.offer_id IS NOT DISTINCT FROM s.offer_id
      )
    )
    SELECT count(DISTINCT m.contact_id)::text AS distinct_contacts,
           count(*) FILTER (WHERE ss.converted_at IS NOT NULL)::text AS buyers,
           coalesce(sum(ss.sale_revenue), 0)::numeric(12,2) AS revenue
    FROM missing m
    LEFT JOIN stage_sends ss ON ss.contact_id = m.contact_id AND ss.converted_at IS NOT NULL
  `));

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
