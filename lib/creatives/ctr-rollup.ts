import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbOrTx } from "@/lib/audience/pools";
import { TRACKING_GAP_MATURITY_HOURS } from "@/lib/reporting/tracking-gap-rules";

// Per-creative CTR — clickers ÷ messages sent — over the last 7 days,
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
// CLICKERS ARE THE OVERVIEW TAB'S (2026-10-12): per stage, Keitaro's clean
// landing visits (keitaro_stage_results.visit_clicks_clean), summed over stages
// — with CamMan's counted clickers standing in for a tracked stage Keitaro has
// no visits for at all, once it is past the tracking-gap maturity gate. That is
// shouldSubstituteClickers() in lib/reporting/tracking-gap-rules.ts, expressed
// in SQL by overviewStageClickersSql() below. Until then this was CamMan's
// counted clickers alone, which read ~1.35x higher than Overview's column.
//
// Grain: the STAGE's creative on both sides. Windows are the last 7 / 30 ET
// calendar days including today, like an Overview date range: sends by
// stage_sends.sent_at, Keitaro visits by stat_date, substitute clickers by
// first_click_at. Manual-mode stages write no stage_sends,
// so their sends are sms_count and their clicks the Keitaro click_count, dated by
// the stage's sent_at — the same rule as lib/reporting/grading.ts.

export const CREATIVE_CTR_ROLLUP_KEY = "creative_ctr";

/**
 * One stage's clicker count as the Overview tab shows it: Keitaro clean visits,
 * or CamMan's counted clickers when Keitaro recorded no visits (raw AND clean
 * zero) on a stage sent at least TRACKING_GAP_MATURITY_HOURS ago. SQL twin of
 * shouldSubstituteClickers(); callers apply it to tracked stages only (manual
 * campaigns mint no links). Args are SQL expressions; NULLs read as 0.
 */
export function overviewStageClickersSql(a: {
  visitsRaw: string;
  visitsClean: string;
  counted: string;
  sentAt: string;
}) {
  return sql.raw(`CASE
      WHEN coalesce(${a.visitsRaw}, 0) = 0 AND coalesce(${a.visitsClean}, 0) = 0
       AND ${a.sentAt} <= now() - interval '${TRACKING_GAP_MATURITY_HOURS} hours'
      THEN coalesce(${a.counted}, 0)
      ELSE coalesce(${a.visitsClean}, 0)
    END`);
}

// ET day boundary for the Keitaro windows: stat_date is an ET calendar day.
const ET_TODAY = `(now() AT TIME ZONE 'America/New_York')::date`;
// Start of the window of the last n ET days including today, as a timestamptz —
// so sends and clicks use the same calendar-day windows as stat_date (and as
// the Overview tab's date range).
const ET_WINDOW_START = (n: number) =>
  sql.raw(`((${ET_TODAY} - ${n - 1})::timestamp AT TIME ZONE 'America/New_York')`);

export interface CreativeCtrRow {
  creative_id: number;
  // null = all offers; a number = only stages whose campaign ran that offer.
  // Same GROUPING SETS split as lib/creatives/metrics-cache.ts. Snapshots
  // written before this field existed carry totals only and read as null.
  offer_id: number | null;
  sent_7d: number;
  clicks_7d: number;
  sent_30d: number;
  clicks_30d: number;
  sent_lifetime: number;
  clicks_lifetime: number;
}

// Offer key: -1 = the all-offers row, the offer id otherwise, 0 = a campaign
// with no offer (dropped). Mirrors lib/creatives/metrics-cache.ts.
const OK_SELECT = sql.raw(
  `CASE WHEN GROUPING(st.offer_key) = 1 THEN -1 ELSE st.offer_key END AS ok`,
);
const GROUP_BY = sql.raw(
  `GROUP BY GROUPING SETS ((st.creative_id), (st.creative_id, st.offer_key))`,
);

export async function computeCreativeCtr(exec: DbOrTx, orgId: string): Promise<CreativeCtrRow[]> {
  const rows = (await exec.execute(sql`
    WITH st AS (
      SELECT cs.id, cs.creative_id, cs.sent_at, cs.sms_count, cs.click_count,
             (c.link_mode = 'tracked') AS tracked,
             coalesce(c.offer_id, 0) AS offer_key
        FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id
       WHERE cs.org_id = ${orgId}::uuid AND cs.creative_id IS NOT NULL
    ),
    sends AS (
      SELECT st.creative_id, ${OK_SELECT},
             count(*) FILTER (WHERE ss.sent_at >= ${ET_WINDOW_START(7)}) AS sent_7d,
             count(*) FILTER (WHERE ss.sent_at >= ${ET_WINDOW_START(30)}) AS sent_30d,
             count(*) AS sent_lifetime
        FROM stage_sends ss
        JOIN st ON st.id = ss.stage_id AND st.tracked
       WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
       ${GROUP_BY}
    ),
    -- Keitaro visits per stage and window (stat_date = ET day).
    kv AS (
      SELECT stage_id,
             sum(visit_clicks_raw)   FILTER (WHERE stat_date > ${sql.raw(ET_TODAY)} - 7)  AS raw_7d,
             sum(visit_clicks_clean) FILTER (WHERE stat_date > ${sql.raw(ET_TODAY)} - 7)  AS clean_7d,
             sum(visit_clicks_raw)   FILTER (WHERE stat_date > ${sql.raw(ET_TODAY)} - 30) AS raw_30d,
             sum(visit_clicks_clean) FILTER (WHERE stat_date > ${sql.raw(ET_TODAY)} - 30) AS clean_30d,
             sum(visit_clicks_raw)   AS raw_life,
             sum(visit_clicks_clean) AS clean_life
        FROM keitaro_stage_results
       WHERE org_id = ${orgId}::uuid
       GROUP BY stage_id
    ),
    -- CamMan counted clickers per stage and window: the substitute only.
    -- (stage_id, contact_id) is the table's PK, so count(*) is distinct.
    ccs AS (
      SELECT stage_id,
             count(*) FILTER (WHERE first_click_at >= ${ET_WINDOW_START(7)})  AS n_7d,
             count(*) FILTER (WHERE first_click_at >= ${ET_WINDOW_START(30)}) AS n_30d,
             count(*) AS n_life
        FROM counted_clickers
       WHERE org_id = ${orgId}::uuid
       GROUP BY stage_id
    ),
    clicks AS (
      SELECT st.creative_id, ${OK_SELECT},
             sum(${overviewStageClickersSql({ visitsRaw: "kv.raw_7d", visitsClean: "kv.clean_7d", counted: "ccs.n_7d", sentAt: "st.sent_at" })}) AS clicks_7d,
             sum(${overviewStageClickersSql({ visitsRaw: "kv.raw_30d", visitsClean: "kv.clean_30d", counted: "ccs.n_30d", sentAt: "st.sent_at" })}) AS clicks_30d,
             sum(${overviewStageClickersSql({ visitsRaw: "kv.raw_life", visitsClean: "kv.clean_life", counted: "ccs.n_life", sentAt: "st.sent_at" })}) AS clicks_lifetime
        FROM st
        LEFT JOIN kv ON kv.stage_id = st.id
        LEFT JOIN ccs ON ccs.stage_id = st.id
       WHERE st.tracked AND (kv.stage_id IS NOT NULL OR ccs.stage_id IS NOT NULL)
       ${GROUP_BY}
    ),
    manual AS (
      SELECT st.creative_id, ${OK_SELECT},
             coalesce(sum(sms_count) FILTER (WHERE sent_at >= ${ET_WINDOW_START(7)}), 0) AS sent_7d,
             coalesce(sum(click_count) FILTER (WHERE sent_at >= ${ET_WINDOW_START(7)}), 0) AS clicks_7d,
             coalesce(sum(sms_count) FILTER (WHERE sent_at >= ${ET_WINDOW_START(30)}), 0) AS sent_30d,
             coalesce(sum(click_count) FILTER (WHERE sent_at >= ${ET_WINDOW_START(30)}), 0) AS clicks_30d,
             coalesce(sum(sms_count), 0) AS sent_lifetime,
             coalesce(sum(click_count), 0) AS clicks_lifetime
        FROM st
       WHERE NOT st.tracked
       ${GROUP_BY}
    )
    SELECT ids.creative_id, ids.ok,
           (coalesce(s.sent_7d, 0) + coalesce(m.sent_7d, 0))::int AS sent_7d,
           (coalesce(k.clicks_7d, 0) + coalesce(m.clicks_7d, 0))::int AS clicks_7d,
           (coalesce(s.sent_30d, 0) + coalesce(m.sent_30d, 0))::int AS sent_30d,
           (coalesce(k.clicks_30d, 0) + coalesce(m.clicks_30d, 0))::int AS clicks_30d,
           (coalesce(s.sent_lifetime, 0) + coalesce(m.sent_lifetime, 0))::int AS sent_lifetime,
           (coalesce(k.clicks_lifetime, 0) + coalesce(m.clicks_lifetime, 0))::int AS clicks_lifetime
      FROM (SELECT creative_id, ok FROM sends
            UNION SELECT creative_id, ok FROM clicks
            UNION SELECT creative_id, ok FROM manual) ids
      LEFT JOIN sends s ON s.creative_id = ids.creative_id AND s.ok = ids.ok
      LEFT JOIN clicks k ON k.creative_id = ids.creative_id AND k.ok = ids.ok
      LEFT JOIN manual m ON m.creative_id = ids.creative_id AND m.ok = ids.ok
     WHERE ids.ok <> 0
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    creative_id: Number(r.creative_id),
    offer_id: Number(r.ok) === -1 ? null : Number(r.ok),
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
// `dbc` defaults to the pool. It is threaded so a verification script can read
// the snapshot on the SAME connection as the metrics query it is checking — a
// second connection cannot see an uncommitted fixture, and every DB bar in this
// repo runs inside a transaction that always rolls back.
export async function readCreativeCtr(
  orgId: string,
  dbc: DbOrTx = db,
): Promise<CreativeCtrRow[]> {
  const rows = (await dbc.execute(sql`
    SELECT data->'rows' AS rows
    FROM operator_rollups
    WHERE org_id = ${orgId}::uuid AND rollup_key = ${CREATIVE_CTR_ROLLUP_KEY} AND data IS NOT NULL
  `)) as unknown as { rows: CreativeCtrRow[] | null }[];
  return (rows[0]?.rows ?? []).map((r) => ({ ...r, offer_id: r.offer_id ?? null }));
}
