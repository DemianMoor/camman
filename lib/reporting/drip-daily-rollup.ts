import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { DLR_SOURCES, terminalCte } from "@/lib/reporting/delivery";
import { addEtDays, etDayBounds, type EtDayRange } from "@/lib/reporting/delivery-rollup";
import { journeyForSend } from "@/lib/reporting/drip-send-journey";
import { approvedRevenueClause, purchasedClause } from "@/lib/sale-attribution";

// drip_daily_rollup (migration 0208) — the cells behind the drip campaign
// "Daily results" tab. Spec: docs/superpowers/specs/2026-10-12-drip-daily-results-design.md.
//
// Two bases, one row per (campaign, basis, ET day, stage, partner key):
//
//   activity  every event on the ET day it HAPPENED — a send on its sent_at, a
//             click on its clicked_at, an opt-out on its STOP's arrival, a sale
//             and its revenue on DETECTION (conversion_events.created_at). These
//             are the partner report's dating rules (owner ruling Q1), so the
//             partner rows of a range sum to that report's columns.
//   cohort    the leads ADMITTED (drip_journeys.routed_at) on that ET day, and
//             everything those leads did since, whenever it happened.
//
// stage_id NULL = the campaign-level LEAD row (admissions have no stage).
// partner_key_id NULL on a stage row = sends that reach no non-sandbox lead —
// kept so a stage's activity cells sum to ALL its sends (Overview counts them).
//
// ⭐ BUILT FROM THE LIVE QUERIES' OWN FRAGMENTS, not retyped copies:
//   journeyForSend   send -> its one journey (shared with the partner report)
//   terminalCte      delivery receipts (shared with the Delivery report/rollup)
//   purchasedClause / approvedRevenueClause   sales / revenue (the ledger rules)
//   rate             COALESCE(snapshot, the number's current rate, 0), as the
//                    partner report and dripCostByStageInRange price a send.
// Opt-out replies are billed at the rate of the send they answered.
//
// ADDITIVE COUNTERS ONLY. Ratios, the latency median and lookup cost are read-
// time arithmetic over summed cells.

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Basis = "activity" | "cohort";
export const BASES: readonly Basis[] = ["activity", "cohort"];

// cron_locks rows. Heartbeat expectations live in lib/reporting/cron-heartbeat.ts.
export const DRIP_DAILY_ROLLUP_JOB = "drip-daily-rollup";
export const DRIP_DAILY_ROLLUP_SETTLE_JOB = "drip-daily-rollup-settle";
export const DRIP_DAILY_ROLLUP_RECONCILE_JOB = "drip-daily-rollup-reconcile";

/**
 * Tier A: today + yesterday (a cohort keeps taking follow-ups for ~24 h), every
 * run (every 15 min). Measured warm on prod 2026-10-12: ~4.5 s for both bases, ~1M
 * buffer hits, ~0 disk reads.
 */
export const FRESH_DAYS = 2;
/**
 * Tier B: the last 14 ET days, ONCE A NIGHT in the quiet slot (the brief's
 * "last 14 days nightly"). Older cells are final. What can still move a past
 * cell, measured on prod drip data 2026-10-12: sends ≤ 15 h after admission;
 * conversions detected ≤ 68 h (p99 57 h); opt-out attribution window 72 h; late
 * txr undelivered callbacks ~3 days; click re-scoring hours. 14 days is > 4× the
 * longest. NOT every few hours: cold, the receipt side reads ~830 MB per 3 days
 * (prod, 2026-10-12), and a multi-GB read in working hours is visible as report
 * slowness. The reconciliation is what notices if 14 ever stops being enough.
 */
export const SETTLE_DAYS = 14;
/** The reconciliation checks a 7-day window of FROZEN cells, days 15–21 ago. */
export const RECONCILE_WINDOW_DAYS = 7;
/** Earliest UTC hour the nightly settle + reconciliation may start (~01:00 ET). */
export const NIGHTLY_UTC_HOUR = 5;

/**
 * Lead-to-send histogram bucket lower edges, seconds. Cell arrays have
 * LATENCY_EDGES_SEC.length + 1 slots: slot 0 is "< 0" (clock skew), slot i is
 * [edge[i-1], edge[i]), the last is ≥ 48 h. NEVER REORDER OR EDIT — stored
 * arrays are positional; a change needs a full rebuild.
 */
export const LATENCY_EDGES_SEC = [
  0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800,
  2700, 3600, 5400, 7200, 10800, 14400, 21600, 43200, 86400, 172800,
] as const;
const EDGES_SQL = sql.raw(`ARRAY[${LATENCY_EDGES_SEC.join(",")}]::float8[]`);
const HIST_SLOTS = LATENCY_EDGES_SEC.length + 1;

// Providers with a delivery-receipt intake; the rest are excluded from the
// Delivered % denominator (null, never 0 — see lib/reporting/delivery.ts).
const DLR_CAPABLE = sql.join(
  Object.keys(DLR_SOURCES).map((k) => sql`${k}`),
  sql`, `,
);

const day = (ts: SQL) => sql`(${ts} AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date`;
// A sandbox lead is test traffic: its activity stays in the stage's NULL
// (unattributed) bucket rather than under a partner key.
const PARTNER = sql`CASE WHEN le.sandbox = false THEN le.partner_key_id END`;
const RATE = sql`COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0)`;

const STAGE_COUNTERS = [
  "first_sends", "followup_sends", "dlr_sent", "delivered", "clicks", "opt_outs", "sales", "revenue", "send_cost",
] as const;
const LEAD_COUNTERS = ["leads_admitted", "admitted", "admitted_carried"] as const;
export const ALL_COUNTERS = [...LEAD_COUNTERS, ...STAGE_COUNTERS] as const;

// One part per source, same column list, summed into cells afterwards.
function part(cols: Partial<Record<(typeof STAGE_COUNTERS)[number], SQL>>): SQL {
  return sql.join(
    STAGE_COUNTERS.map((c) => {
      const isMoney = c === "revenue" || c === "send_cost";
      const v = cols[c] ?? (isMoney ? sql`0::numeric` : sql`0`);
      return isMoney ? sql`(${v})::numeric AS ${sql.raw(c)}` : sql`(${v})::int AS ${sql.raw(c)}`;
    }),
    sql`, `,
  );
}

function campaignScope(orgId: string, campaignIds?: number[]): SQL {
  const only =
    campaignIds && campaignIds.length > 0
      ? sql`AND id IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  return sql`SELECT id FROM campaigns WHERE org_id = ${orgId}::uuid AND type = 'drip' ${only}`;
}

// The latency of a first send: sent_at − the lead's arrival, for leads routed on
// arrival only — the definition of lib/drip/lead-latency.ts (carried_days = 0,
// never deferred, not sandbox).
function latencyBucket(sentAt: SQL): SQL {
  return sql`width_bucket(extract(epoch FROM ${sentAt} - li.received_at)::float8, ${EDGES_SQL})`;
}

// ⭐ THE CANDIDATE SETS ARE MATERIALIZED INTO TEMP TABLES AND ANALYZEd — load-
// bearing, not tidiness. Inline as CTEs, Postgres estimated the cohort's send set
// at ONE row (a LATERAL behind a DISTINCT join) when it was thousands, nested-
// looped the delivery-receipt aggregation once per send, and today's cohort hit
// a 110 s timeout on prod (2026-10-12). Real row counts → hash joins. Same trap
// and same fix as the audience snapshot (CLAUDE.md §10b). Hence a transaction is
// required: the tables are ON COMMIT DROP.
const TMP = {
  s: "ddr_activity_sends",
  cj: "ddr_cohort_journeys",
  cand: "ddr_cohort_candidates",
  cs: "ddr_cohort_sends",
} as const;

async function materialize(dbc: DbOrTx, name: string, select: SQL): Promise<void> {
  // DROP … IF EXISTS raises a NOTICE every first run; keep it out of the logs.
  await dbc.execute(sql`SET LOCAL client_min_messages = warning`);
  await dbc.execute(sql.raw(`DROP TABLE IF EXISTS ${name}`));
  await dbc.execute(sql`CREATE TEMP TABLE ${sql.raw(name)} ON COMMIT DROP AS ${select}`);
  await dbc.execute(sql.raw(`ANALYZE ${name}`));
}

/**
 * Materialize one basis's candidate sets for `range` (inside the caller's
 * transaction) and return the SELECT producing its cells:
 * (campaign_id, stage_id, partner_key_id, day_et, <ALL_COUNTERS>, latency_hist).
 * Used by the refresh (to write) and by the reconciliation (to compare).
 */
export async function prepareCells(
  dbc: DbOrTx,
  basis: Basis,
  orgId: string,
  range: EtDayRange,
  campaignIds?: number[],
): Promise<SQL> {
  const { fromUtc, toExclusiveUtc } = etDayBounds(range);
  const F = sql`${fromUtc.toISOString()}::timestamptz`;
  const T = sql`${toExclusiveUtc.toISOString()}::timestamptz`;
  const within = (ts: SQL) => sql`${ts} >= ${F} AND ${ts} < ${T}`;
  const dc = campaignScope(orgId, campaignIds);
  return basis === "activity"
    ? activitySql(dbc, orgId, dc, F, within)
    : cohortSql(dbc, orgId, dc, F, within);
}

async function activitySql(dbc: DbOrTx, orgId: string, dc: SQL, F: SQL, within: (ts: SQL) => SQL): Promise<SQL> {
  // A send/event's partner, first-send flag and lead come through its journey.
  const viaJourney = sql`
      LEFT JOIN LATERAL (${journeyForSend("ss")}) jj ON true
      LEFT JOIN lead_events le ON le.id = jj.lead_event_id`;
  await materialize(dbc, TMP.s, sql`
      WITH dc AS (${dc})
      SELECT ss.id, ss.campaign_id, ss.stage_id, ss.sent_at,
             ${RATE} AS rate,
             COALESCE(sp.sms_provider_id IN (${DLR_CAPABLE}), false) AS cap,
             COALESCE(jj.first_send_id = ss.id, false) AS is_first,
             jj.carried_days, le.drip_recheck_at, le.sandbox, le.inbox_id,
             ${PARTNER} AS pk
      FROM stage_sends ss
      JOIN dc ON dc.id = ss.campaign_id
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
      ${viaJourney}
      WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent' AND ${within(sql`ss.sent_at`)}`);
  return sql`
    WITH dc AS (${dc}),
    s AS (SELECT * FROM ${sql.raw(TMP.s)}),
    terminal AS (${terminalCte(F)}),
    parts AS (
      SELECT s.campaign_id, s.stage_id, s.pk, ${day(sql`s.sent_at`)} AS d, ${part({
        first_sends: sql`count(*) FILTER (WHERE s.is_first)`,
        followup_sends: sql`count(*) FILTER (WHERE NOT s.is_first)`,
        dlr_sent: sql`count(*) FILTER (WHERE s.cap)`,
        delivered: sql`count(*) FILTER (WHERE s.cap AND COALESCE(t.d, false))`,
        send_cost: sql`sum(s.rate)`,
      })}
      FROM s LEFT JOIN terminal t ON t.ss_id = s.id
      GROUP BY 1, 2, 3, 4
      UNION ALL
      -- clean clicks, dated by the click (partner-report definition: rows, repeats count)
      SELECT ss.campaign_id, ss.stage_id, ${PARTNER}, ${day(sql`ck.clicked_at`)}, ${part({ clicks: sql`count(*)` })}
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      JOIN stage_sends ss ON ss.link_id = l.id
      JOIN dc ON dc.id = ss.campaign_id
      ${viaJourney}
      WHERE ck.org_id = ${orgId}::uuid
        AND ck.classification NOT IN ('bot', 'prefetch', 'suspect')
        AND ${within(sql`ck.clicked_at`)}
      GROUP BY 1, 2, 3, 4
      UNION ALL
      -- opt-outs, dated by the STOP's arrival, on the attributed stage; billed at
      -- the answered send's rate (0 when the send is gone — Overview counts it too)
      SELECT oa.campaign_id, oa.stage_id, ${PARTNER}, ${day(sql`o.created_at`)}, ${part({
        opt_outs: sql`count(*)`,
        send_cost: sql`COALESCE(sum(${RATE}), 0)`,
      })}
      FROM opt_out_attributions oa
      JOIN opt_outs o ON o.id = oa.opt_out_id
      JOIN dc ON dc.id = oa.campaign_id
      LEFT JOIN stage_sends ss ON ss.id = oa.stage_send_id
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      ${viaJourney}
      WHERE o.org_id = ${orgId}::uuid AND ${within(sql`o.created_at`)}
      GROUP BY 1, 2, 3, 4
      UNION ALL
      -- sales + approved revenue, dated by DETECTION (partner-report rule)
      SELECT ss.campaign_id, ss.stage_id, ${PARTNER}, ${day(sql`ce.created_at`)}, ${part({
        sales: sql`count(*) FILTER (WHERE ${purchasedClause()})`,
        revenue: sql`COALESCE(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)`,
      })}
      FROM conversion_events ce
      JOIN stage_sends ss ON ss.id = ce.stage_send_id
      JOIN dc ON dc.id = ss.campaign_id
      ${viaJourney}
      WHERE ce.org_id = ${orgId}::uuid AND ${within(sql`ce.created_at`)}
      GROUP BY 1, 2, 3, 4
    ),
    lat AS (
      SELECT s.campaign_id, s.stage_id, s.pk, ${day(sql`s.sent_at`)} AS d, ${latencyBucket(sql`s.sent_at`)} AS b
      FROM s JOIN lead_inbox li ON li.id = s.inbox_id
      WHERE s.is_first AND COALESCE(s.carried_days, 0) = 0
        AND s.drip_recheck_at IS NULL AND s.sandbox = false
    ),
    leads AS (
      -- admitted + carried on the ADMISSION day
      SELECT j.campaign_id, ${PARTNER} AS pk, ${day(sql`j.routed_at`)} AS d,
             0 AS leads_admitted, 1 AS admitted, (COALESCE(j.carried_days, 0) > 0)::int AS admitted_carried
      FROM drip_journeys j
      JOIN dc ON dc.id = j.campaign_id
      LEFT JOIN lead_events le ON le.id = j.lead_event_id
      WHERE j.org_id = ${orgId}::uuid AND ${within(sql`j.routed_at`)}
      UNION ALL
      -- "Leads admitted" (owner ruling Q2): admitted leads on the day they were RECEIVED.
      -- Admission follows receipt, so routed_at >= the window start bounds the scan.
      SELECT j.campaign_id, ${PARTNER}, ${day(sql`le.received_at`)}, 1, 0, 0
      FROM drip_journeys j
      JOIN dc ON dc.id = j.campaign_id
      JOIN lead_events le ON le.id = j.lead_event_id
      WHERE j.org_id = ${orgId}::uuid AND j.routed_at >= ${F} AND ${within(sql`le.received_at`)}
    )
    ${assemble()}`;
}

async function cohortSql(dbc: DbOrTx, orgId: string, dc: SQL, F: SQL, within: (ts: SQL) => SQL): Promise<SQL> {
  await materialize(dbc, TMP.cj, sql`
      WITH dc AS (${dc})
      SELECT j.id, j.campaign_id, j.contact_id, j.first_send_id, j.carried_days,
             ${day(sql`j.routed_at`)} AS d, ${PARTNER} AS pk,
             le.drip_recheck_at, le.sandbox, le.inbox_id
      FROM drip_journeys j
      JOIN dc ON dc.id = j.campaign_id
      LEFT JOIN lead_events le ON le.id = j.lead_event_id
      WHERE j.org_id = ${orgId}::uuid AND ${within(sql`j.routed_at`)}`);
  // Every send whose ONE journey (same rule as the activity basis) is in the
  // cohort. A journey's sends are created after it is routed, so created_at
  // >= the window start bounds the scan.
  // TWO steps, each analyzed: (1) the candidate sends with the journey each one
  // belongs to, (2) a hash join of those to the cohort. In one statement the
  // planner estimated 1 candidate and re-scanned the whole cohort per send
  // (44 s for one day of prod, 2026-10-12).
  const cj = sql.raw(TMP.cj);
  await materialize(dbc, TMP.cand, sql`
      SELECT ss.id, ss.stage_id, ss.status, ss.sent_at, ss.link_id,
             ${RATE} AS rate,
             COALESCE(sp.sms_provider_id IN (${DLR_CAPABLE}), false) AS cap,
             jj.id AS journey_id
      FROM stage_sends ss
      JOIN (SELECT DISTINCT campaign_id, contact_id FROM ${cj}) k
        ON k.campaign_id = ss.campaign_id AND k.contact_id = ss.contact_id
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
      JOIN LATERAL (${journeyForSend("ss")}) jj ON true
      WHERE ss.org_id = ${orgId}::uuid AND ss.created_at >= ${F}`);
  await materialize(dbc, TMP.cs, sql`
      SELECT c.id, c.stage_id, c.status, c.sent_at, c.link_id, c.rate, c.cap,
             (cj.first_send_id = c.id) AS is_first,
             cj.campaign_id, cj.pk, cj.d, cj.carried_days, cj.drip_recheck_at, cj.sandbox, cj.inbox_id
      FROM ${sql.raw(TMP.cand)} c
      JOIN ${cj} cj ON cj.id = c.journey_id`);
  return sql`
    WITH cj AS (SELECT * FROM ${cj}),
    cs AS (SELECT * FROM ${sql.raw(TMP.cs)}),
    terminal AS (${terminalCte(F)}),
    parts AS (
      SELECT cs.campaign_id, cs.stage_id, cs.pk, cs.d, ${part({
        first_sends: sql`count(*) FILTER (WHERE cs.is_first)`,
        followup_sends: sql`count(*) FILTER (WHERE NOT cs.is_first)`,
        dlr_sent: sql`count(*) FILTER (WHERE cs.cap)`,
        delivered: sql`count(*) FILTER (WHERE cs.cap AND COALESCE(t.d, false))`,
        send_cost: sql`sum(cs.rate)`,
      })}
      FROM cs LEFT JOIN terminal t ON t.ss_id = cs.id
      WHERE cs.status = 'sent'
      GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT cs.campaign_id, cs.stage_id, cs.pk, cs.d, ${part({ clicks: sql`count(*)` })}
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      JOIN cs ON cs.link_id = l.id
      WHERE ck.org_id = ${orgId}::uuid AND ck.classification NOT IN ('bot', 'prefetch', 'suspect')
      GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT cs.campaign_id, oa.stage_id, cs.pk, cs.d, ${part({
        opt_outs: sql`count(*)`,
        send_cost: sql`sum(cs.rate)`,
      })}
      FROM opt_out_attributions oa
      JOIN cs ON cs.id = oa.stage_send_id
      GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT cs.campaign_id, cs.stage_id, cs.pk, cs.d, ${part({
        sales: sql`count(*) FILTER (WHERE ${purchasedClause()})`,
        revenue: sql`COALESCE(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)`,
      })}
      FROM conversion_events ce
      JOIN cs ON cs.id = ce.stage_send_id
      WHERE ce.org_id = ${orgId}::uuid
      GROUP BY 1, 2, 3, 4
    ),
    lat AS (
      SELECT cs.campaign_id, cs.stage_id, cs.pk, cs.d, ${latencyBucket(sql`cs.sent_at`)} AS b
      FROM cs JOIN lead_inbox li ON li.id = cs.inbox_id
      WHERE cs.status = 'sent' AND cs.is_first AND COALESCE(cs.carried_days, 0) = 0
        AND cs.drip_recheck_at IS NULL AND cs.sandbox = false
    ),
    leads AS (
      SELECT cj.campaign_id, cj.pk, cj.d,
             0 AS leads_admitted, 1 AS admitted, (COALESCE(cj.carried_days, 0) > 0)::int AS admitted_carried
      FROM cj
    )
    ${assemble()}`;
}

// Shared tail: sum parts into stage cells (dropping all-zero cells), attach the
// histogram, add lead cells.
function assemble(): SQL {
  const sums = sql.join(
    STAGE_COUNTERS.map((c) =>
      c === "revenue" || c === "send_cost"
        ? sql`sum(${sql.raw(c)})::numeric(12, 4) AS ${sql.raw(c)}`
        : sql`sum(${sql.raw(c)})::int AS ${sql.raw(c)}`,
    ),
    sql`, `,
  );
  const nonZero = sql.join(STAGE_COUNTERS.map((c) => sql`sum(${sql.raw(c)}) <> 0`), sql` OR `);
  return sql`,
    stage_cells AS (
      SELECT campaign_id, stage_id, pk, d, ${sums}
      FROM parts GROUP BY 1, 2, 3, 4
      HAVING ${nonZero}
    ),
    hist AS (
      SELECT k.campaign_id, k.stage_id, k.pk, k.d,
             array_agg(COALESCE(n.c, 0) ORDER BY g.i)::int[] AS h
      FROM (SELECT DISTINCT campaign_id, stage_id, pk, d FROM lat) k
      CROSS JOIN generate_series(0, ${HIST_SLOTS - 1}) g(i)
      LEFT JOIN (SELECT campaign_id, stage_id, pk, d, b, count(*)::int AS c FROM lat GROUP BY 1, 2, 3, 4, 5) n
        ON n.campaign_id = k.campaign_id AND n.stage_id = k.stage_id
       AND n.pk IS NOT DISTINCT FROM k.pk AND n.d = k.d AND n.b = g.i
      GROUP BY 1, 2, 3, 4
    )
    SELECT sc.campaign_id, sc.stage_id, sc.pk AS partner_key_id, sc.d AS day_et,
           0 AS leads_admitted, 0 AS admitted, 0 AS admitted_carried,
           ${sql.join(STAGE_COUNTERS.map((c) => sql`sc.${sql.raw(c)}`), sql`, `)},
           h.h AS latency_hist
    FROM stage_cells sc
    LEFT JOIN hist h
      ON h.campaign_id = sc.campaign_id AND h.stage_id = sc.stage_id
     AND h.pk IS NOT DISTINCT FROM sc.pk AND h.d = sc.d
    UNION ALL
    SELECT campaign_id, NULL::int, pk, d,
           sum(leads_admitted)::int, sum(admitted)::int, sum(admitted_carried)::int,
           ${sql.join(STAGE_COUNTERS.map((c) => (c === "revenue" || c === "send_cost" ? sql`0::numeric(12, 4)` : sql`0`)), sql`, `)},
           NULL::int[]
    FROM leads GROUP BY campaign_id, pk, d`;
}

export interface RefreshResult {
  basis: Basis;
  cells: number;
  written: number;
  deleted: number;
  durationMs: number;
}

/**
 * Recompute every cell of one org's drip campaigns (or `campaignIds`) for one
 * basis whose day is in `range`, in ONE statement: compute, upsert the cells
 * whose values changed, delete the ones that vanished. Caller owns the
 * transaction and its statement_timeout.
 */
export async function refreshDripDailyRollup(
  dbc: DbOrTx,
  orgId: string,
  basis: Basis,
  range: EtDayRange,
  campaignIds?: number[],
): Promise<RefreshResult> {
  const started = Date.now();
  const cols = sql.raw(ALL_COUNTERS.join(", "));
  const set = sql.raw(
    [...ALL_COUNTERS, "latency_hist"].map((c) => `${c} = EXCLUDED.${c}`).join(", "),
  );
  const tupleR = sql.raw(`(${[...ALL_COUNTERS, "latency_hist"].map((c) => `r.${c}`).join(", ")})`);
  const tupleX = sql.raw(`(${[...ALL_COUNTERS, "latency_hist"].map((c) => `EXCLUDED.${c}`).join(", ")})`);
  const scope =
    campaignIds && campaignIds.length > 0
      ? sql`AND r.campaign_id IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;

  const rows = (await dbc.execute(sql`
    WITH fresh AS (${await prepareCells(dbc, basis, orgId, range, campaignIds)}),
    written AS (
      INSERT INTO drip_daily_rollup AS r
        (org_id, campaign_id, basis, day_et, stage_id, partner_key_id, ${cols}, latency_hist, refreshed_at)
      SELECT ${orgId}::uuid, campaign_id, ${basis}, day_et, stage_id, partner_key_id, ${cols}, latency_hist, now()
      FROM fresh
      ON CONFLICT ON CONSTRAINT drip_daily_rollup_cell_uniq DO UPDATE
        SET ${set}, refreshed_at = EXCLUDED.refreshed_at
        -- An unchanged cell is not rewritten: no dead tuple, and refreshed_at
        -- keeps meaning "last time this cell moved".
        WHERE ${tupleR} IS DISTINCT FROM ${tupleX}
      RETURNING 1
    ),
    deleted AS (
      DELETE FROM drip_daily_rollup r
      WHERE r.org_id = ${orgId}::uuid AND r.basis = ${basis}
        AND r.day_et BETWEEN ${range.from}::date AND ${range.to}::date
        ${scope}
        AND NOT EXISTS (
          SELECT 1 FROM fresh f
          WHERE f.campaign_id = r.campaign_id AND f.day_et = r.day_et
            AND f.stage_id IS NOT DISTINCT FROM r.stage_id
            AND f.partner_key_id IS NOT DISTINCT FROM r.partner_key_id
        )
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM fresh)::int   AS cells,
           (SELECT count(*) FROM written)::int AS written,
           (SELECT count(*) FROM deleted)::int AS deleted
  `)) as unknown as { cells: number; written: number; deleted: number }[];

  return {
    basis,
    cells: Number(rows[0]?.cells ?? 0),
    written: Number(rows[0]?.written ?? 0),
    deleted: Number(rows[0]?.deleted ?? 0),
    durationMs: Date.now() - started,
  };
}

export interface RollupScope {
  range: EtDayRange;
  settle: boolean;
}

/** Whether a once-a-night job is due: in the quiet slot and not yet this UTC day. Pure. */
export function nightlyDue(now: Date, last: Date | null): boolean {
  if (now.getUTCHours() < NIGHTLY_UTC_HOUR) return false;
  // An unparseable stamp counts as "never" (NaN compares false).
  if (last == null || Number.isNaN(last.getTime())) return true;
  return last.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
}

/** What one run recomputes: tier A always; tier B (14 days) once a night. Pure. */
export function rollupScope(now: Date, lastSettle: Date | null): RollupScope {
  const today = formatInCampaignTimezone(now, "yyyy-MM-dd");
  const settle = nightlyDue(now, lastSettle);
  const days = settle ? SETTLE_DAYS : FRESH_DAYS;
  return { range: { from: addEtDays(today, -(days - 1)), to: today }, settle };
}

/** The frozen window the reconciliation checks: the 7 ET days before the settle window. */
export function reconcileRange(now: Date): EtDayRange {
  const today = formatInCampaignTimezone(now, "yyyy-MM-dd");
  const to = addEtDays(today, -SETTLE_DAYS);
  return { from: addEtDays(to, -(RECONCILE_WINDOW_DAYS - 1)), to };
}


export interface CellDiff {
  basis: Basis;
  key: string;
  stored: Record<string, unknown> | null;
  live: Record<string, unknown> | null;
}

/**
 * Compare stored cells with a fresh computation for `range`, both read in the
 * caller's transaction (run it REPEATABLE READ so both sides see one snapshot).
 * Returns every differing cell; empty = exact.
 */
export async function diffDripDailyRollup(
  dbc: DbOrTx,
  orgId: string,
  basis: Basis,
  range: EtDayRange,
): Promise<{ cells: number; diffs: CellDiff[] }> {
  // Values as text on both sides, so numeric(12,4) and int[] compare exactly.
  const vals = sql.raw([...ALL_COUNTERS].map((c) => `${c}::text AS ${c}`).join(", "));
  // FULL JOIN needs a hash/merge-joinable condition, so NULL keys are folded to
  // -1 (no real stage / partner key id is negative).
  const k = (a: string) =>
    sql.raw(`${a}.campaign_id, ${a}.day_et, COALESCE(${a}.stage_id, -1), COALESCE(${a}.partner_key_id, -1)`);
  const rows = (await dbc.execute(sql`
    WITH live AS (${await prepareCells(dbc, basis, orgId, range)}),
    l AS (SELECT campaign_id, stage_id, partner_key_id, day_et, ${vals}, latency_hist::text AS latency_hist FROM live),
    s AS (
      SELECT campaign_id, stage_id, partner_key_id, day_et, ${vals}, latency_hist::text AS latency_hist
      FROM drip_daily_rollup
      WHERE org_id = ${orgId}::uuid AND basis = ${basis}
        AND day_et BETWEEN ${range.from}::date AND ${range.to}::date
    ),
    j AS (
      SELECT to_jsonb(s) AS stored, to_jsonb(l) AS live
      FROM l FULL JOIN s ON (${k("l")}) = (${k("s")})
    )
    SELECT (SELECT count(*) FROM l)::int AS live_cells,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('stored', stored, 'live', live))
                     FROM j WHERE stored IS DISTINCT FROM live), '[]'::jsonb) AS diffs
  `)) as unknown as { live_cells: number; diffs: { stored: Record<string, unknown> | null; live: Record<string, unknown> | null }[] }[];
  const r = rows[0];
  return {
    cells: Number(r?.live_cells ?? 0),
    diffs: (r?.diffs ?? []).map((d) => {
      const ref = (d.live ?? d.stored)!;
      return {
        basis,
        key: `${ref.campaign_id}/${ref.day_et}/${ref.stage_id ?? "lead"}/${ref.partner_key_id ?? "unattributed"}`,
        stored: d.stored,
        live: d.live,
      };
    }),
  };
}

// ── read-time arithmetic, shared by the API and the verification scripts ──────

/** Median seconds from a summed histogram, interpolated inside its bucket; null when empty. */
export function histogramMedian(hist: readonly number[] | null | undefined): number | null {
  if (!hist || hist.length === 0) return null;
  const n = hist.reduce((a, b) => a + b, 0);
  if (n === 0) return null;
  const half = n / 2;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    if (cum + hist[i] >= half && hist[i] > 0) {
      if (i === 0) return 0;
      const lo = LATENCY_EDGES_SEC[i - 1];
      if (i >= LATENCY_EDGES_SEC.length) return lo; // open-ended last bucket: report its floor
      const hi = LATENCY_EDGES_SEC[i];
      return lo + ((half - cum) / hist[i]) * (hi - lo);
    }
    cum += hist[i];
  }
  return null;
}

/** Element-wise sum of histograms (positional, HIST_SLOTS long). */
export function sumHistograms(hists: readonly (readonly number[] | null | undefined)[]): number[] {
  const out = new Array<number>(HIST_SLOTS).fill(0);
  for (const h of hists) if (h) for (let i = 0; i < HIST_SLOTS; i++) out[i] += Number(h[i] ?? 0);
  return out;
}
