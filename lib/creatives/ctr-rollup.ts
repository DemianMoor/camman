import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbOrTx } from "@/lib/audience/pools";

// Per-creative CTR — counted clickers ÷ messages sent — over the last 7 days,
// the last 30 days and all time. Stored in operator_rollups and refreshed hourly
// by /api/cron/refresh-creative-lifetime; read by lib/creatives/metrics-cache.ts
// for the creatives list and the stage creative picker.
//
// WHY NOT campaign_stages.delivered_count (the old denominator). Only CSV result
// imports and manual results write it; API sends never do. On 2026-09-14 it was
// 0 on all 915 stages of the last 30 days (1,706,771 messages sent), so CTR
// rendered "—" for every creative. sms_count is 0 on API stages for the same
// reason.
//
// WHY A SNAPSHOT. The denominator is stage_sends rows with status = 'sent' (the
// platform's one definition of "was messaged"), and counting them per creative
// is a full pass over the table. Measured on prod 2026-09-14: 11.5s all time
// (parallel seq scan), 12.2s for 30 days through the (org_id, sent_at) index,
// 4.3s even as an index-only count that cannot see status. A list read can't pay
// that.
//
// WHY CLICKS ARE IN THE SNAPSHOT TOO. A live numerator over an hourly
// denominator climbs between refreshes and snaps back on each one, which reads
// as a real trend. Both sides come from the same statement.
//
// Grain: the STAGE's creative on both sides. Windows: sends by
// stage_sends.sent_at, clickers by counted_clickers.first_click_at, a contact
// counted once per creative per window. Manual-mode stages write no stage_sends,
// so their sends are sms_count and their clicks the Keitaro click_count, dated by
// the stage's sent_at — the same rule as lib/reporting/grading.ts.

export const CREATIVE_CTR_ROLLUP_KEY = "creative_ctr";

export interface CreativeCtrRow {
  creative_id: number;
  sent_7d: number;
  clicks_7d: number;
  sent_30d: number;
  clicks_30d: number;
  sent_lifetime: number;
  clicks_lifetime: number;
}

export async function computeCreativeCtr(exec: DbOrTx, orgId: string): Promise<CreativeCtrRow[]> {
  const rows = (await exec.execute(sql`
    WITH st AS (
      SELECT cs.id, cs.creative_id, cs.sent_at, cs.sms_count, cs.click_count,
             (c.link_mode = 'tracked') AS tracked
        FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id
       WHERE cs.org_id = ${orgId}::uuid AND cs.creative_id IS NOT NULL
    ),
    sends AS (
      SELECT st.creative_id,
             count(*) FILTER (WHERE ss.sent_at >= now() - interval '7 days') AS sent_7d,
             count(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days') AS sent_30d,
             count(*) AS sent_lifetime
        FROM stage_sends ss
        JOIN st ON st.id = ss.stage_id AND st.tracked
       WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
       GROUP BY st.creative_id
    ),
    clicks AS (
      SELECT st.creative_id,
             count(DISTINCT cc.contact_id) FILTER (WHERE cc.first_click_at >= now() - interval '7 days') AS clicks_7d,
             count(DISTINCT cc.contact_id) FILTER (WHERE cc.first_click_at >= now() - interval '30 days') AS clicks_30d,
             count(DISTINCT cc.contact_id) AS clicks_lifetime
        FROM counted_clickers cc
        JOIN st ON st.id = cc.stage_id
       WHERE cc.org_id = ${orgId}::uuid
       GROUP BY st.creative_id
    ),
    manual AS (
      SELECT creative_id,
             coalesce(sum(sms_count) FILTER (WHERE sent_at >= now() - interval '7 days'), 0) AS sent_7d,
             coalesce(sum(click_count) FILTER (WHERE sent_at >= now() - interval '7 days'), 0) AS clicks_7d,
             coalesce(sum(sms_count) FILTER (WHERE sent_at >= now() - interval '30 days'), 0) AS sent_30d,
             coalesce(sum(click_count) FILTER (WHERE sent_at >= now() - interval '30 days'), 0) AS clicks_30d,
             coalesce(sum(sms_count), 0) AS sent_lifetime,
             coalesce(sum(click_count), 0) AS clicks_lifetime
        FROM st
       WHERE NOT st.tracked
       GROUP BY creative_id
    )
    SELECT ids.creative_id,
           (coalesce(s.sent_7d, 0) + coalesce(m.sent_7d, 0))::int AS sent_7d,
           (coalesce(k.clicks_7d, 0) + coalesce(m.clicks_7d, 0))::int AS clicks_7d,
           (coalesce(s.sent_30d, 0) + coalesce(m.sent_30d, 0))::int AS sent_30d,
           (coalesce(k.clicks_30d, 0) + coalesce(m.clicks_30d, 0))::int AS clicks_30d,
           (coalesce(s.sent_lifetime, 0) + coalesce(m.sent_lifetime, 0))::int AS sent_lifetime,
           (coalesce(k.clicks_lifetime, 0) + coalesce(m.clicks_lifetime, 0))::int AS clicks_lifetime
      FROM (SELECT creative_id FROM sends
            UNION SELECT creative_id FROM clicks
            UNION SELECT creative_id FROM manual) ids
      LEFT JOIN sends s ON s.creative_id = ids.creative_id
      LEFT JOIN clicks k ON k.creative_id = ids.creative_id
      LEFT JOIN manual m ON m.creative_id = ids.creative_id
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    creative_id: Number(r.creative_id),
    sent_7d: Number(r.sent_7d),
    clicks_7d: Number(r.clicks_7d),
    sent_30d: Number(r.sent_30d),
    clicks_30d: Number(r.clicks_30d),
    sent_lifetime: Number(r.sent_lifetime),
    clicks_lifetime: Number(r.clicks_lifetime),
  }));
}

/** Recompute and store one org's CTR rows. */
export async function refreshCreativeCtr(orgId: string): Promise<{ durationMs: number }> {
  const startedAt = Date.now();
  const rows = await computeCreativeCtr(db, orgId);
  const durationMs = Date.now() - startedAt;
  await db.execute(sql`
    INSERT INTO operator_rollups (org_id, rollup_key, data, computed_at, duration_ms, updated_at)
    VALUES (${orgId}::uuid, ${CREATIVE_CTR_ROLLUP_KEY}, ${JSON.stringify({ rows })}::jsonb,
            now(), ${durationMs}, now())
    ON CONFLICT (org_id, rollup_key) DO UPDATE
      SET data = EXCLUDED.data,
          computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms,
          updated_at = now()
  `);
  return { durationMs };
}

/** The stored rows; empty until the first refresh, so CTR renders "—", never 0%. */
export async function readCreativeCtr(orgId: string): Promise<CreativeCtrRow[]> {
  const rows = (await db.execute(sql`
    SELECT data->'rows' AS rows
    FROM operator_rollups
    WHERE org_id = ${orgId}::uuid AND rollup_key = ${CREATIVE_CTR_ROLLUP_KEY} AND data IS NOT NULL
  `)) as unknown as { rows: CreativeCtrRow[] | null }[];
  return rows[0]?.rows ?? [];
}
