import { fromZonedTime } from "date-fns-tz";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { pct } from "@/lib/reporting/grading-rates";
import { OPT_OUT_ATTRIBUTION_WINDOW_HOURS } from "@/lib/sends/opt-out-window";

// Server-side queries behind the operator API's creative-grading endpoints. Pure
// rate math lives in grading-rates.ts. Definitions: docs/07-conventions.md
// "Grading metrics".

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar day. The regex alone lets 2026-02-31 through to a Postgres
// 22008; the round-trip rejects it. Shared by every grading route so they cannot
// disagree about what a valid date is.
export function isCalendarDay(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const daysBetween = (later: string, earlier: string) =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
const nextDay = (ymd: string) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// ---- tails -----------------------------------------------------------------

export interface TailRow {
  campaign_id: number;
  campaign_name: string;
  creative_id: number | null;
  creative_slug: string | null;
  send_date: string;
  days_after_send: number;
  conversions: number;
  revenue: number;
}

export interface ConversionTails {
  date: string;
  data: TailRow[];
  totals: {
    conversions: number;
    revenue: number;
    same_day_conversions: number;
    tail_conversions: number;
    unknown_send_date_conversions: number;
    tail_revenue: number;
  };
}

// Tracker conversions dated `date` (keitaro_stage_results.stat_date is already an
// ET day), split by when the stage that earned them was sent: that same ET day,
// an EARLIER day (a tail — returned as rows by campaign + creative + send day), or
// unknown (never stamped, or stamped after the conversion day, which a real sale
// cannot be). same_day + tail + unknown = conversions by construction.
export async function getConversionTails(orgId: string, date: string): Promise<ConversionTails> {
  const rows = (await db.execute(sql`
    SELECT k.campaign_id, c.name AS campaign_name, cs.creative_id, cr.slug AS creative_slug,
           to_char((cs.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS send_date,
           sum(k.sales)::int AS conversions,
           sum(k.revenue)::float8 AS revenue
    FROM keitaro_stage_results k
    JOIN campaigns c ON c.id = k.campaign_id
    JOIN campaign_stages cs ON cs.id = k.stage_id
    LEFT JOIN creatives cr ON cr.id = cs.creative_id
    WHERE k.org_id = ${orgId}::uuid AND k.stat_date = ${date}::date
      AND (k.sales > 0 OR k.revenue > 0)
    GROUP BY 1, 2, 3, 4, 5
  `)) as unknown as {
    campaign_id: number;
    campaign_name: string;
    creative_id: number | null;
    creative_slug: string | null;
    send_date: string | null;
    conversions: number;
    revenue: number;
  }[];

  const totals = {
    conversions: 0,
    revenue: 0,
    same_day_conversions: 0,
    tail_conversions: 0,
    unknown_send_date_conversions: 0,
    tail_revenue: 0,
  };
  const data: TailRow[] = [];
  for (const r of rows) {
    const conversions = Number(r.conversions);
    const revenue = Number(r.revenue);
    totals.conversions += conversions;
    totals.revenue += revenue;
    const days = r.send_date == null ? null : daysBetween(date, r.send_date);
    if (days === 0) {
      totals.same_day_conversions += conversions;
    } else if (days != null && days > 0) {
      totals.tail_conversions += conversions;
      totals.tail_revenue += revenue;
      data.push({
        campaign_id: Number(r.campaign_id),
        campaign_name: r.campaign_name,
        creative_id: r.creative_id == null ? null : Number(r.creative_id),
        creative_slug: r.creative_slug,
        send_date: r.send_date as string,
        days_after_send: days,
        conversions,
        revenue: round2(revenue),
      });
    } else {
      totals.unknown_send_date_conversions += conversions;
    }
  }
  data.sort((a, b) => b.days_after_send - a.days_after_send || b.conversions - a.conversions);
  return {
    date,
    data,
    totals: { ...totals, revenue: round2(totals.revenue), tail_revenue: round2(totals.tail_revenue) },
  };
}

// ---- opt-outs by dimension and day (send-day cohort) ------------------------

export const OPT_OUT_DIMENSIONS = ["number", "campaign", "stage", "group"] as const;
export type OptOutDimension = (typeof OPT_OUT_DIMENSIONS)[number];

export function isOptOutDimension(v: string | null | undefined): v is OptOutDimension {
  return v != null && (OPT_OUT_DIMENSIONS as readonly string[]).includes(v);
}

export interface OptOutRow {
  date: string;
  key: string;
  label: string;
  sent: number;
  opt_outs: number;
  opt_rate: number | null;
  complete: boolean;
}

export interface OptOutDayTotal {
  date: string;
  sent: number;
  opt_outs: number;
  opt_rate: number | null;
  complete: boolean;
}

export interface OptOutCohorts {
  dimension: OptOutDimension;
  granularity: "day";
  basis: "send_date";
  window_hours: number;
  range: { from: string; to: string; timezone: string };
  data: OptOutRow[];
  totals: OptOutDayTotal[];
}

// The row key per dimension over the `sends` CTE (alias s), plus any join it needs.
// A send with no sending number keys to -1 so it still joins and still counts.
// A contact in two of the campaign's targeted groups counts in both group rows, so
// group rows do NOT add up to the day's total — which is why totals are computed
// from the sends directly, never by summing rows.
const OPT_OUT_KEY: Record<OptOutDimension, { join: SQL; key: SQL }> = {
  number: { join: sql``, key: sql`coalesce(s.provider_phone_id, -1)` },
  campaign: { join: sql``, key: sql`s.campaign_id` },
  stage: { join: sql``, key: sql`s.stage_id` },
  group: {
    join: sql`JOIN campaigns c ON c.id = s.campaign_id
      JOIN contact_contact_groups ccg ON ccg.contact_id = s.contact_id
        AND ccg.contact_group_id = ANY(c.audience_contact_group_ids)`,
    key: sql`ccg.contact_group_id`,
  },
};

// Send-day cohort opt-outs: for each ET day and dimension value, the messages
// SENT that day (stage_sends status='sent') and the distinct STOPs credited to
// exactly those sends (a STOP credits the single most recent stage that messaged
// the number within the attribution window). A day is `complete` once that
// window has passed since its end — until then late STOPs can still land on it.
// ONE statement: the sends are materialized once and both the keyed rows and the
// per-day totals read them, so stage_sends is scanned once. Sends and STOPs are
// aggregated separately and joined on (day, key), which avoids a
// count(DISTINCT send) sort. Manual-mode campaigns have no per-send rows and do
// not appear.
export async function getOptOutCohorts(
  orgId: string,
  dimension: OptOutDimension,
  from: string,
  to: string,
): Promise<OptOutCohorts> {
  const fromUtc = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const toExclusiveUtc = fromZonedTime(`${nextDay(to)}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const { join, key } = OPT_OUT_KEY[dimension];

  const rows = (await db.execute(sql`
    WITH sends AS MATERIALIZED (
      SELECT ss.id, ss.contact_id, ss.campaign_id, ss.stage_id, ss.provider_phone_id,
             to_char((ss.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day
      FROM stage_sends ss
      WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
        AND ss.sent_at >= ${fromUtc}::timestamptz AND ss.sent_at < ${toExclusiveUtc}::timestamptz
    ),
    keyed AS (SELECT s.id, s.day, (${key})::bigint AS key FROM sends s ${join}),
    rows_sent AS (SELECT day, key, count(*)::int AS sent FROM keyed GROUP BY 1, 2),
    rows_opt AS (
      SELECT k.day, k.key, count(DISTINCT oa.opt_out_id)::int AS opt_outs
      FROM keyed k
      JOIN opt_out_attributions oa ON oa.stage_send_id = k.id AND oa.org_id = ${orgId}::uuid
      GROUP BY 1, 2
    ),
    day_sent AS (SELECT day, count(*)::int AS sent FROM sends GROUP BY 1),
    day_opt AS (
      SELECT s.day, count(DISTINCT oa.opt_out_id)::int AS opt_outs
      FROM sends s
      JOIN opt_out_attributions oa ON oa.stage_send_id = s.id AND oa.org_id = ${orgId}::uuid
      GROUP BY 1
    )
    SELECT 'row' AS kind, rs.day, rs.key, rs.sent, coalesce(ro.opt_outs, 0)::int AS opt_outs
    FROM rows_sent rs LEFT JOIN rows_opt ro ON ro.day = rs.day AND ro.key = rs.key
    UNION ALL
    SELECT 'total' AS kind, ds.day, NULL AS key, ds.sent, coalesce(dopt.opt_outs, 0)::int AS opt_outs
    FROM day_sent ds LEFT JOIN day_opt dopt ON dopt.day = ds.day
  `)) as unknown as {
    kind: "row" | "total";
    day: string;
    key: number | string | null;
    sent: number;
    opt_outs: number;
  }[];

  const windowMs = OPT_OUT_ATTRIBUTION_WINDOW_HOURS * 3_600_000;
  const now = Date.now();
  const completeFor = (day: string) =>
    now >= fromZonedTime(`${nextDay(day)}T00:00:00`, CAMPAIGN_TIMEZONE).getTime() + windowMs;

  const keyRows = rows.filter((r) => r.kind === "row");
  const labels = await optOutLabels(
    orgId,
    dimension,
    [...new Set(keyRows.map((r) => Number(r.key)))].filter((k) => k !== -1),
  );

  const data: OptOutRow[] = keyRows
    .map((r) => {
      const k = Number(r.key);
      const sent = Number(r.sent);
      const optOuts = Number(r.opt_outs);
      return {
        date: r.day,
        key: String(k),
        label: k === -1 ? "No number" : labels.get(k) ?? `#${k}`,
        sent,
        opt_outs: optOuts,
        opt_rate: pct(optOuts, sent),
        complete: completeFor(r.day),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.sent - a.sent);

  const totals: OptOutDayTotal[] = rows
    .filter((r) => r.kind === "total")
    .map((r) => {
      const sent = Number(r.sent);
      const optOuts = Number(r.opt_outs);
      return {
        date: r.day,
        sent,
        opt_outs: optOuts,
        opt_rate: pct(optOuts, sent),
        complete: completeFor(r.day),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    dimension,
    granularity: "day",
    basis: "send_date",
    window_hours: OPT_OUT_ATTRIBUTION_WINDOW_HOURS,
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
    data,
    totals,
  };
}

// Human-readable labels for the row keys: the SENDING number (never a recipient),
// the campaign name, "campaign · stage N", or the contact group's name.
async function optOutLabels(
  orgId: string,
  dimension: OptOutDimension,
  keys: number[],
): Promise<Map<number, string>> {
  if (keys.length === 0) return new Map();
  const ids = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const query =
    dimension === "number"
      ? sql`SELECT pp.id AS key, pp.phone_number AS label FROM provider_phones pp
            WHERE pp.org_id = ${orgId}::uuid AND pp.id IN (${ids})`
      : dimension === "campaign"
        ? sql`SELECT c.id AS key, c.name AS label FROM campaigns c
              WHERE c.org_id = ${orgId}::uuid AND c.id IN (${ids})`
        : dimension === "stage"
          ? sql`SELECT cs.id AS key, c.name || ' · stage ' || cs.stage_number AS label
                FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
                WHERE cs.org_id = ${orgId}::uuid AND cs.id IN (${ids})`
          : sql`SELECT g.id AS key, g.name AS label FROM contact_groups g
                WHERE g.org_id = ${orgId}::uuid AND g.id IN (${ids})`;
  const rows = (await db.execute(query)) as unknown as { key: number; label: string | null }[];
  return new Map(rows.map((r) => [Number(r.key), r.label ?? `#${r.key}`]));
}
