import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";

// Accept either the top-level `db` or a transaction handle.
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Reports rollup maintenance (migration 0112). Aggregates the per-recipient
// event tables into two hourly-bucket fact tables (report_stage_hour = Fact A,
// report_group_hour = Fact B), bucketed by the SEND hour in America/New_York.
// See REPORTS-ROLLUP-RECON.md and docs/04-features/reports-rollup.md.
//
// MAINTENANCE MODEL — bounded rolling-window UPSERT (not a pure append-only
// watermark, because clicks/opt-outs/offer-reaches/conversions trickle in for
// days after the send and UPDATE an already-written bucket; not a full matview
// refresh, because that re-scans all history forever). Every run recomputes
// buckets whose SEND hour is within the last UNSETTLED_WINDOW_DAYS from the base
// tables and UPSERTs them; buckets older than that horizon are frozen
// (`settled = true`) and never re-scanned. The horizon (14d) safely covers every
// trickle window: opt-out attribution 72h, offer-reach / Keitaro conversion 7d.
//
// SALES/REVENUE are the PER-RECIPIENT attribution on stage_sends (sale_status /
// converted_at / sale_revenue), which is send-hour- and group-attributable.
// It recovers ~93% of the authoritative Keitaro daily aggregate — the read layer
// surfaces that reconciliation delta (approved Open Question #2).
export const UNSETTLED_WINDOW_DAYS = 14;
export const REPORT_ROLLUP_JOB_NAME = "report-rollup";

// Shared per-send classification. Everything is expressed as a per-send flag /
// value, then grouped by the send's ET hour bucket. `since` bounds the scan to
// sends with sent_at >= since. The two semijoin CTEs (clean clicks, attributed
// opt-outs) keep this off correlated subqueries so it hash-joins at scale.
//
// Cost basis: COALESCE(snapshot cost_per_sms, the stage phone's live rate) — new
// sends carry the durable snapshot (migration 0112); pre-0112 history falls back
// to the stage. Per stage the rate is constant, so bucket cost =
// Σ cost_per_sms·(1 + opted_out) reconstructs total_cost = rate·(sends+optouts).
// Number is resolved the same way: COALESCE(send snapshot, stage) so historical
// attribution is durable against later stage edits.
// `preSnapshot` compatibility shim: before migration 0112 is applied, the
// snapshot columns (ss.provider_phone_id / ss.cost_per_sms) don't exist yet.
// Passing preSnapshot=true substitutes NULLs so the read-only verify test can
// run the exact aggregation against existing data (every existing row's snapshot
// would be NULL regardless, so results are identical). Production always uses
// the real columns (preSnapshot=false, the default).
function sentCte(since: SQL, preSnapshot = false): SQL {
  const snapPhone = preSnapshot ? sql`NULL::integer` : sql`ss.provider_phone_id`;
  const snapCost = preSnapshot ? sql`NULL::numeric` : sql`ss.cost_per_sms`;
  return sql`
    clicked_links AS (
      SELECT DISTINCT ck.link_id
      FROM clicks ck
      WHERE ck.classification = 'human'
        AND ck.scored_at IS NOT NULL
        AND ck.link_id IS NOT NULL
    ),
    optout_sends AS (
      SELECT DISTINCT oa.stage_send_id
      FROM opt_out_attributions oa
      WHERE oa.stage_send_id IS NOT NULL
    ),
    sent AS (
      SELECT
        ss.id                                                                       AS send_id,
        ss.org_id,
        ss.stage_id,
        ss.campaign_id,
        ss.contact_id,
        date_trunc('hour', ss.sent_at AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'America/New_York'                                           AS bucket_start_utc,
        (ss.sent_at AT TIME ZONE 'America/New_York')::date                          AS bucket_date_et,
        EXTRACT(HOUR FROM ss.sent_at AT TIME ZONE 'America/New_York')::smallint      AS bucket_hour_et,
        COALESCE(${snapPhone}, cs.provider_phone_id)                               AS resolved_phone_id,
        COALESCE(${snapCost}, pp.cost_per_sms, 0)::numeric(12, 4)                   AS cost_per_sms,
        (ss.offer_reached_at IS NOT NULL)::int                                      AS redirect,
        (ss.converted_at IS NOT NULL)::int                                          AS sale,
        COALESCE(ss.sale_revenue, 0)::numeric(12, 4)                                AS revenue,
        (ss.link_id IS NOT NULL AND cl.link_id IS NOT NULL)::int                    AS clicked,
        (os.stage_send_id IS NOT NULL)::int                                         AS opted_out
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      LEFT JOIN provider_phones pp ON pp.id = COALESCE(${snapPhone}, cs.provider_phone_id)
      LEFT JOIN clicked_links cl ON cl.link_id = ss.link_id
      LEFT JOIN optout_sends os ON os.stage_send_id = ss.id
      WHERE ss.status = 'sent'
        AND ss.sent_at IS NOT NULL
        AND ss.sent_at >= ${since}
    )`;
}

// Fact A SELECT — one row per (org, stage, ET send-hour). Output columns are in
// report_stage_hour insert order.
function stageHourSelect(since: SQL, preSnapshot = false): SQL {
  return sql`
    WITH ${sentCte(since, preSnapshot)},
    agg AS (
      SELECT
        org_id, stage_id, campaign_id, bucket_start_utc, bucket_date_et,
        bucket_hour_et, resolved_phone_id,
        count(*)::int                              AS sent_count,
        sum(opted_out)::int                        AS opt_out_count,
        sum(clicked)::int                          AS click_count,
        sum(redirect)::int                         AS offer_redirect_count,
        sum(sale)::int                             AS sales_count,
        sum(revenue)::numeric(12, 4)               AS revenue,
        sum(cost_per_sms * (1 + opted_out))::numeric(12, 4) AS cost
      FROM sent
      GROUP BY org_id, stage_id, campaign_id, bucket_start_utc, bucket_date_et,
               bucket_hour_et, resolved_phone_id
    )
    SELECT
      a.org_id,
      a.stage_id,
      a.campaign_id,
      a.bucket_start_utc,
      a.bucket_date_et,
      a.bucket_hour_et,
      c.offer_id,
      c.brand_id,
      pp.credential_id                             AS provider_credential_id,
      a.resolved_phone_id                          AS provider_phone_id,
      cs.sms_provider_id,
      cs.stage_number,
      cs.behavioral_tier::smallint                 AS behavioral_tier,
      cr.funnel_stage,
      cs.creative_id,
      a.sent_count,
      a.opt_out_count,
      a.click_count,
      a.offer_redirect_count,
      a.sales_count,
      a.revenue,
      a.cost
    FROM agg a
    JOIN campaign_stages cs ON cs.id = a.stage_id
    JOIN campaigns c ON c.id = a.campaign_id
    LEFT JOIN creatives cr ON cr.id = cs.creative_id
    LEFT JOIN provider_phones pp ON pp.id = a.resolved_phone_id`;
}

// Fact B SELECT — one row per (org, contact_group, stage, ET send-hour). INNER
// JOIN to the junction ⇒ sends whose contact has no group are excluded (correct:
// the by-group report only covers grouped contacts). Fans out over groups.
function groupHourSelect(since: SQL, preSnapshot = false): SQL {
  return sql`
    WITH ${sentCte(since, preSnapshot)},
    agg AS (
      SELECT
        s.org_id, ccg.contact_group_id, s.stage_id, s.campaign_id,
        s.bucket_start_utc, s.bucket_date_et, s.bucket_hour_et, s.resolved_phone_id,
        count(*)::int                              AS sent_count,
        sum(s.opted_out)::int                      AS opt_out_count,
        sum(s.clicked)::int                        AS click_count,
        sum(s.redirect)::int                       AS offer_redirect_count,
        sum(s.sale)::int                           AS sales_count,
        sum(s.revenue)::numeric(12, 4)             AS revenue,
        sum(s.cost_per_sms * (1 + s.opted_out))::numeric(12, 4) AS cost
      FROM sent s
      JOIN contact_contact_groups ccg ON ccg.contact_id = s.contact_id
      GROUP BY s.org_id, ccg.contact_group_id, s.stage_id, s.campaign_id,
               s.bucket_start_utc, s.bucket_date_et, s.bucket_hour_et, s.resolved_phone_id
    )
    SELECT
      a.org_id,
      a.contact_group_id,
      a.stage_id,
      a.campaign_id,
      a.bucket_start_utc,
      a.bucket_date_et,
      a.bucket_hour_et,
      c.offer_id,
      c.brand_id,
      pp.credential_id                             AS provider_credential_id,
      a.resolved_phone_id                          AS provider_phone_id,
      cs.sms_provider_id,
      cs.stage_number,
      cs.behavioral_tier::smallint                 AS behavioral_tier,
      cr.funnel_stage,
      cs.creative_id,
      a.sent_count,
      a.opt_out_count,
      a.click_count,
      a.offer_redirect_count,
      a.sales_count,
      a.revenue,
      a.cost
    FROM agg a
    JOIN campaign_stages cs ON cs.id = a.stage_id
    JOIN campaigns c ON c.id = a.campaign_id
    LEFT JOIN creatives cr ON cr.id = cs.creative_id
    LEFT JOIN provider_phones pp ON pp.id = a.resolved_phone_id`;
}

// Read-only aggregate builders (used by the verify test and any preview).
// preSnapshot=true when running before migration 0112 is applied.
export function stageHourAggregate(since: SQL, preSnapshot = false): SQL {
  return stageHourSelect(since, preSnapshot);
}
export function groupHourAggregate(since: SQL, preSnapshot = false): SQL {
  return groupHourSelect(since, preSnapshot);
}

export interface RefreshReportRollupResult {
  recomputeSinceDays: number;
  stageRowsUpserted: number;
  groupRowsUpserted: number;
  stageRowsSettled: number;
  groupRowsSettled: number;
}

// Recompute the unsettled window and UPSERT both fact tables in one transaction.
// `recomputeSinceDays` defaults to the 14-day horizon (the cron path); the
// backfill passes a larger depth (or null for all-time). The SETTLE boundary is
// ALWAYS now()-14d regardless of the recompute depth, so a deep backfill still
// freezes old buckets. Single-runner is the caller's job (withCronLease).
export async function refreshReportRollup(
  dbc: DbOrTx,
  opts: { recomputeSinceDays?: number | null } = {},
): Promise<RefreshReportRollupResult> {
  const days = opts.recomputeSinceDays === undefined ? UNSETTLED_WINDOW_DAYS : opts.recomputeSinceDays;
  // Recompute-window lower bound. null ⇒ all-time (backfill).
  const since: SQL =
    days === null
      ? sql`'-infinity'::timestamptz`
      : sql`now() - (${days}::int * interval '1 day')`;
  const settleBoundary = sql`now() - (${UNSETTLED_WINDOW_DAYS}::int * interval '1 day')`;

  return await dbc.transaction(async (tx) => {
    const stageUpserted = (await tx.execute(sql`
      INSERT INTO report_stage_hour (
        org_id, stage_id, campaign_id, bucket_start_utc, bucket_date_et, bucket_hour_et,
        offer_id, brand_id, provider_credential_id, provider_phone_id, sms_provider_id,
        stage_number, behavioral_tier, funnel_stage, creative_id,
        sent_count, opt_out_count, click_count, offer_redirect_count, sales_count, revenue, cost
      )
      ${stageHourSelect(since)}
      ON CONFLICT (org_id, stage_id, bucket_start_utc) DO UPDATE SET
        campaign_id = EXCLUDED.campaign_id,
        bucket_date_et = EXCLUDED.bucket_date_et,
        bucket_hour_et = EXCLUDED.bucket_hour_et,
        offer_id = EXCLUDED.offer_id,
        brand_id = EXCLUDED.brand_id,
        provider_credential_id = EXCLUDED.provider_credential_id,
        provider_phone_id = EXCLUDED.provider_phone_id,
        sms_provider_id = EXCLUDED.sms_provider_id,
        stage_number = EXCLUDED.stage_number,
        behavioral_tier = EXCLUDED.behavioral_tier,
        funnel_stage = EXCLUDED.funnel_stage,
        creative_id = EXCLUDED.creative_id,
        sent_count = EXCLUDED.sent_count,
        opt_out_count = EXCLUDED.opt_out_count,
        click_count = EXCLUDED.click_count,
        offer_redirect_count = EXCLUDED.offer_redirect_count,
        sales_count = EXCLUDED.sales_count,
        revenue = EXCLUDED.revenue,
        cost = EXCLUDED.cost,
        settled = false,
        refreshed_at = now()
      RETURNING 1
    `)) as unknown as unknown[];

    const groupUpserted = (await tx.execute(sql`
      INSERT INTO report_group_hour (
        org_id, contact_group_id, stage_id, campaign_id, bucket_start_utc, bucket_date_et, bucket_hour_et,
        offer_id, brand_id, provider_credential_id, provider_phone_id, sms_provider_id,
        stage_number, behavioral_tier, funnel_stage, creative_id,
        sent_count, opt_out_count, click_count, offer_redirect_count, sales_count, revenue, cost
      )
      ${groupHourSelect(since)}
      ON CONFLICT (org_id, contact_group_id, stage_id, bucket_start_utc) DO UPDATE SET
        campaign_id = EXCLUDED.campaign_id,
        bucket_date_et = EXCLUDED.bucket_date_et,
        bucket_hour_et = EXCLUDED.bucket_hour_et,
        offer_id = EXCLUDED.offer_id,
        brand_id = EXCLUDED.brand_id,
        provider_credential_id = EXCLUDED.provider_credential_id,
        provider_phone_id = EXCLUDED.provider_phone_id,
        sms_provider_id = EXCLUDED.sms_provider_id,
        stage_number = EXCLUDED.stage_number,
        behavioral_tier = EXCLUDED.behavioral_tier,
        funnel_stage = EXCLUDED.funnel_stage,
        creative_id = EXCLUDED.creative_id,
        sent_count = EXCLUDED.sent_count,
        opt_out_count = EXCLUDED.opt_out_count,
        click_count = EXCLUDED.click_count,
        offer_redirect_count = EXCLUDED.offer_redirect_count,
        sales_count = EXCLUDED.sales_count,
        revenue = EXCLUDED.revenue,
        cost = EXCLUDED.cost,
        settled = false,
        refreshed_at = now()
      RETURNING 1
    `)) as unknown as unknown[];

    const stageSettled = (await tx.execute(sql`
      UPDATE report_stage_hour SET settled = true
      WHERE settled = false AND bucket_start_utc < ${settleBoundary}
      RETURNING 1
    `)) as unknown as unknown[];

    const groupSettled = (await tx.execute(sql`
      UPDATE report_group_hour SET settled = true
      WHERE settled = false AND bucket_start_utc < ${settleBoundary}
      RETURNING 1
    `)) as unknown as unknown[];

    // Record last-successful-refresh time on the shared cron_locks row (its
    // `watermark` column; withCronLease owns `lease_until` on the same row).
    await tx.execute(sql`
      INSERT INTO cron_locks (job_name, watermark) VALUES (${REPORT_ROLLUP_JOB_NAME}, now())
      ON CONFLICT (job_name) DO UPDATE SET watermark = now()
    `);

    return {
      recomputeSinceDays: days ?? -1,
      stageRowsUpserted: stageUpserted.length,
      groupRowsUpserted: groupUpserted.length,
      stageRowsSettled: stageSettled.length,
      groupRowsSettled: groupSettled.length,
    };
  });
}
