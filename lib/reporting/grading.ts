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

// ---- shared label lookups ------------------------------------------------------

function idList(ids: number[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

interface CampaignLabel {
  name: string;
  offer_id: number | null;
  offer_name: string | null;
  group_names: string[];
}

// Campaign name, offer, and the names of the contact groups the campaign targets.
async function campaignLabels(orgId: string, ids: number[]): Promise<Map<number, CampaignLabel>> {
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT c.id, c.name, o.id AS offer_id, o.name AS offer_name,
           ARRAY(SELECT g.name FROM contact_groups g
                 WHERE g.org_id = c.org_id AND g.id = ANY(c.audience_contact_group_ids)
                 ORDER BY g.name) AS group_names
    FROM campaigns c
    LEFT JOIN offers o ON o.id = c.offer_id
    WHERE c.org_id = ${orgId}::uuid AND c.id IN (${idList(ids)})
  `)) as unknown as {
    id: number;
    name: string;
    offer_id: number | null;
    offer_name: string | null;
    group_names: string[] | null;
  }[];
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        name: r.name,
        offer_id: r.offer_id == null ? null : Number(r.offer_id),
        offer_name: r.offer_name,
        group_names: r.group_names ?? [],
      },
    ]),
  );
}

// Sending numbers by provider_phones id — our own numbers, never a recipient.
async function sendingNumbers(orgId: string, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT id, phone_number FROM provider_phones
    WHERE org_id = ${orgId}::uuid AND id IN (${idList(ids)})
  `)) as unknown as { id: number; phone_number: string }[];
  return new Map(rows.map((r) => [Number(r.id), r.phone_number]));
}

// ---- creative usage ----------------------------------------------------------

export interface CreativeUsageRow {
  campaign_id: number;
  campaign_name: string;
  group_names: string[];
  sending_number: string | null;
  date: string;
  sends: number;
  clicks_human: number;
  reached: number | null;
  conversions: number;
}

export interface CreativeUsage {
  creative_id: number;
  creative_slug: string;
  data: CreativeUsageRow[];
}

// Every place a creative has run: one row per campaign + sending number + ET send
// day over the creative's SENT stages (archived included — it is history), for
// cohort freshness and the one-text-one-number-per-day rule. `clicks_human`
// dedupes across the row's stages (manual stages add Keitaro visits);
// sends / reached / conversions are additive. link_mode is per campaign, so a row
// is all-tracked or all-manual, and `reached` is null only for an all-manual row.
// Returns null when the creative is not in the org.
export async function getCreativeUsage(
  orgId: string,
  creativeId: number,
): Promise<CreativeUsage | null> {
  const creative = (await db.execute(sql`
    SELECT id, slug FROM creatives WHERE org_id = ${orgId}::uuid AND id = ${creativeId}
  `)) as unknown as { id: number; slug: string }[];
  if (!creative[0]) return null;

  const rows = (await db.execute(sql`
    WITH st AS (
      SELECT cs.id, cs.campaign_id, cs.provider_phone_id, cs.sms_count, c.link_mode,
             to_char((cs.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day
      FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.org_id = ${orgId}::uuid AND cs.creative_id = ${creativeId} AND cs.sent_at IS NOT NULL
    ),
    se AS (
      SELECT stage_id,
             count(*) FILTER (WHERE status = 'sent')::int AS sent,
             count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS reached
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid AND stage_id IN (SELECT id FROM st)
      GROUP BY 1
    ),
    k AS (
      SELECT stage_id, sum(sales)::int AS sales, sum(visit_clicks_clean)::int AS visits
      FROM keitaro_stage_results
      WHERE org_id = ${orgId}::uuid AND stage_id IN (SELECT id FROM st)
      GROUP BY 1
    ),
    cc AS (
      SELECT st.campaign_id, coalesce(st.provider_phone_id, -1) AS phone, st.day,
             count(DISTINCT c2.contact_id)::int AS clickers
      FROM counted_clickers c2 JOIN st ON st.id = c2.stage_id
      WHERE c2.org_id = ${orgId}::uuid
      GROUP BY 1, 2, 3
    )
    SELECT st.campaign_id, coalesce(st.provider_phone_id, -1) AS phone, st.day,
           sum(CASE WHEN st.link_mode = 'tracked' THEN coalesce(se.sent, 0)
                    ELSE coalesce(st.sms_count, 0) END)::int AS sends,
           sum(CASE WHEN st.link_mode = 'tracked' THEN coalesce(se.reached, 0) END)::int AS reached,
           sum(coalesce(k.sales, 0))::int AS conversions,
           (coalesce(max(cc.clickers), 0)
             + sum(CASE WHEN st.link_mode <> 'tracked' THEN coalesce(k.visits, 0) ELSE 0 END))::int
             AS clicks_human
    FROM st
    LEFT JOIN se ON se.stage_id = st.id
    LEFT JOIN k ON k.stage_id = st.id
    LEFT JOIN cc ON cc.campaign_id = st.campaign_id
      AND cc.phone = coalesce(st.provider_phone_id, -1) AND cc.day = st.day
    GROUP BY 1, 2, 3
  `)) as unknown as {
    campaign_id: number;
    phone: number;
    day: string;
    sends: number;
    reached: number | null;
    conversions: number;
    clicks_human: number;
  }[];

  const [campaigns, numbers] = await Promise.all([
    campaignLabels(orgId, [...new Set(rows.map((r) => Number(r.campaign_id)))]),
    sendingNumbers(
      orgId,
      [...new Set(rows.map((r) => Number(r.phone)))].filter((p) => p !== -1),
    ),
  ]);

  const data: CreativeUsageRow[] = rows
    .map((r) => {
      const camp = campaigns.get(Number(r.campaign_id));
      const phone = Number(r.phone);
      return {
        campaign_id: Number(r.campaign_id),
        campaign_name: camp?.name ?? `#${r.campaign_id}`,
        group_names: camp?.group_names ?? [],
        sending_number: phone === -1 ? null : numbers.get(phone) ?? null,
        date: r.day,
        sends: Number(r.sends),
        clicks_human: Number(r.clicks_human),
        reached: r.reached == null ? null : Number(r.reached),
        conversions: Number(r.conversions),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.sends - a.sends);

  return { creative_id: Number(creative[0].id), creative_slug: creative[0].slug, data };
}

// ---- campaign audit ------------------------------------------------------------

export const AUDIT_STATUSES = ["active", "paused", "completed"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export function isAuditStatus(v: string | null | undefined): v is AuditStatus {
  return v != null && (AUDIT_STATUSES as readonly string[]).includes(v);
}

export interface AuditStage {
  stage_id: number;
  stage_seq: number;
  label: string | null;
  split_index: number | null;
  behavioral_tier: number | string | null;
  status: string;
  scheduled_date: string | null;
  sent_date: string | null;
  sent: number;
  reached: number | null;
  conversions: number;
  creative_slug: string | null;
}

export interface AuditCampaign {
  campaign_id: number;
  campaign_name: string;
  offer: { id: number; name: string | null } | null;
  group_names: string[];
  stage_count: number;
  last_send_date: string | null;
  total_conversions: number;
  revenue: number;
  stages: AuditStage[];
}

export interface CampaignAudit {
  status: AuditStatus;
  data: AuditCampaign[];
}

// Every campaign in `status` with its non-archived stages, in ONE request — the
// daily "which campaigns have sales but no D2 / D3 yet" sweep without an N+1
// against the token rate limit. `stage_seq` is stage_number; split siblings share
// it, so split_index and behavioral_tier tell them apart. Lifetime per stage;
// conversions and revenue from the tracker. A campaign with no live stages still
// appears, with `stages: []`.
export async function getCampaignAudit(orgId: string, status: AuditStatus): Promise<CampaignAudit> {
  const campaignRows = (await db.execute(sql`
    SELECT id FROM campaigns WHERE org_id = ${orgId}::uuid AND status = ${status}
  `)) as unknown as { id: number }[];
  const campaignIds = campaignRows.map((r) => Number(r.id));
  if (campaignIds.length === 0) return { status, data: [] };

  const [stageRows, labels] = await Promise.all([
    db.execute(sql`
      WITH st AS (
        SELECT cs.id, cs.campaign_id, cs.stage_number, cs.label, cs.split_index,
               cs.behavioral_tier, cs.status, cs.sms_count, cs.creative_id, c.link_mode,
               to_char((cs.scheduled_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS scheduled_date,
               to_char((cs.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS sent_date
        FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.org_id = ${orgId}::uuid AND cs.campaign_id IN (${idList(campaignIds)})
          AND cs.status <> 'archived'
      ),
      se AS (
        SELECT stage_id,
               count(*) FILTER (WHERE status = 'sent')::int AS sent,
               count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS reached
        FROM stage_sends
        WHERE org_id = ${orgId}::uuid AND campaign_id IN (${idList(campaignIds)})
        GROUP BY 1
      ),
      k AS (
        SELECT stage_id, sum(sales)::int AS sales, sum(revenue)::float8 AS revenue
        FROM keitaro_stage_results
        WHERE org_id = ${orgId}::uuid AND campaign_id IN (${idList(campaignIds)})
        GROUP BY 1
      )
      SELECT st.*, cr.slug AS creative_slug,
             coalesce(se.sent, 0)::int AS se_sent, coalesce(se.reached, 0)::int AS se_reached,
             coalesce(k.sales, 0)::int AS sales, coalesce(k.revenue, 0)::float8 AS revenue
      FROM st
      LEFT JOIN se ON se.stage_id = st.id
      LEFT JOIN k ON k.stage_id = st.id
      LEFT JOIN creatives cr ON cr.id = st.creative_id
      ORDER BY st.campaign_id, st.stage_number, st.split_index NULLS FIRST
    `) as unknown as Promise<
      {
        id: number;
        campaign_id: number;
        stage_number: number;
        label: string | null;
        split_index: number | null;
        behavioral_tier: number | string | null;
        status: string;
        sms_count: number | null;
        link_mode: string;
        scheduled_date: string | null;
        sent_date: string | null;
        creative_slug: string | null;
        se_sent: number;
        se_reached: number;
        sales: number;
        revenue: number;
      }[]
    >,
    campaignLabels(orgId, campaignIds),
  ]);

  const stagesByCampaign = new Map<number, { stage: AuditStage; revenue: number }[]>();
  for (const r of stageRows) {
    const tracked = r.link_mode === "tracked";
    const list = stagesByCampaign.get(Number(r.campaign_id)) ?? [];
    list.push({
      stage: {
        stage_id: Number(r.id),
        stage_seq: Number(r.stage_number),
        label: r.label,
        split_index: r.split_index == null ? null : Number(r.split_index),
        behavioral_tier: r.behavioral_tier,
        status: r.status,
        scheduled_date: r.scheduled_date,
        sent_date: r.sent_date,
        sent: tracked ? Number(r.se_sent) : Number(r.sms_count ?? 0),
        reached: tracked ? Number(r.se_reached) : null,
        conversions: Number(r.sales),
        creative_slug: r.creative_slug,
      },
      revenue: Number(r.revenue),
    });
    stagesByCampaign.set(Number(r.campaign_id), list);
  }

  const data: AuditCampaign[] = campaignIds
    .map((id) => {
      const camp = labels.get(id);
      const entries = stagesByCampaign.get(id) ?? [];
      const stages = entries.map((e) => e.stage);
      const sentDates = stages.map((s) => s.sent_date).filter((d): d is string => d != null);
      return {
        campaign_id: id,
        campaign_name: camp?.name ?? `#${id}`,
        offer: camp?.offer_id == null ? null : { id: camp.offer_id, name: camp.offer_name },
        group_names: camp?.group_names ?? [],
        stage_count: stages.length,
        last_send_date: sentDates.length > 0 ? sentDates.sort().at(-1)! : null,
        total_conversions: stages.reduce((a, s) => a + s.conversions, 0),
        revenue: round2(entries.reduce((a, e) => a + e.revenue, 0)),
        stages,
      };
    })
    .sort(
      (a, b) =>
        (b.last_send_date ?? "").localeCompare(a.last_send_date ?? "") || b.campaign_id - a.campaign_id,
    );

  return { status, data };
}
