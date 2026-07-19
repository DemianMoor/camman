import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { ReportDimension } from "@/lib/reporting/report-dimensions";

// Read layer for the five performance reports (Phase 2). Thin GROUP BY over the
// pre-aggregated rollup fact tables (report_stage_hour = Fact A for
// number/offer/sequence/hourly; report_group_hour = Fact B for group). The rollup
// is tiny (~302 / ~2024 rows), so these are sub-millisecond aggregates — no live
// scan of the ~1M-row base tables. See lib/reporting/rollup.ts + docs.
//
// Raw counters + display labels are returned; EPC / profit / percentages are
// derived at READ time in the UI (never stored). Grand TOTALS always come from
// Fact A (report_stage_hour) even for the group report — Fact B fans out over the
// many-to-many junction and its group rows sum to MORE than the true total.

export type { ReportDimension } from "@/lib/reporting/report-dimensions";

export interface PerfMetrics {
  sent: number;
  opt_outs: number;
  clicks: number;
  redirects: number;
  sales: number;
  revenue: number;
  cost: number;
}

export interface PerfRow extends PerfMetrics {
  key: string; // stable row key (dimension value, stringified)
  label: string; // primary display label
  // number dimension only:
  phone_number?: string | null;
  number_type?: string | null;
  provider_name?: string | null;
  provider_color?: string | null;
  account_label?: string | null;
  // group dimension only:
  group_color?: string | null;
}

export interface ProviderOption {
  provider_phone_id: number;
  phone_number: string | null;
  number_type: string | null;
  provider_name: string | null;
  provider_color: string | null;
  account_label: string | null;
}

export interface PerformanceReport {
  dimension: ReportDimension;
  rows: PerfRow[];
  totals: PerfMetrics; // always the TRUE total (Fact A), never a fan-out sum
  refreshedAt: string | null;
}

const METRIC_SELECT = sql`
  coalesce(sum(sent_count),0)::int            AS sent,
  coalesce(sum(opt_out_count),0)::int         AS opt_outs,
  coalesce(sum(click_count),0)::int           AS clicks,
  coalesce(sum(offer_redirect_count),0)::int  AS redirects,
  coalesce(sum(sales_count),0)::int           AS sales,
  coalesce(sum(revenue),0)::float8            AS revenue,
  coalesce(sum(cost),0)::float8               AS cost`;

function toMetrics(r: Record<string, unknown>): PerfMetrics {
  return {
    sent: Number(r.sent) || 0,
    opt_outs: Number(r.opt_outs) || 0,
    clicks: Number(r.clicks) || 0,
    redirects: Number(r.redirects) || 0,
    sales: Number(r.sales) || 0,
    revenue: Number(r.revenue) || 0,
    cost: Number(r.cost) || 0,
  };
}

interface Bounds {
  fromUtc: string; // ISO
  toUtc: string; // ISO, exclusive
  providerPhoneId: number | null;
}

// Shared WHERE for Fact A. Optional provider-phone filter applies to every
// dimension (the by-number report ignores it as redundant).
function factAWhere(orgId: string, b: Bounds) {
  const clauses = [
    sql`r.org_id = ${orgId}::uuid`,
    sql`r.bucket_start_utc >= ${b.fromUtc}::timestamptz`,
    sql`r.bucket_start_utc < ${b.toUtc}::timestamptz`,
  ];
  if (b.providerPhoneId != null) {
    clauses.push(sql`r.provider_phone_id = ${b.providerPhoneId}`);
  }
  return sql.join(clauses, sql` AND `);
}

export async function getPerformanceReport(
  orgId: string,
  dimension: ReportDimension,
  b: Bounds,
): Promise<PerformanceReport> {
  const where = factAWhere(orgId, b);

  let rowSql;
  if (dimension === "number") {
    rowSql = sql`
      SELECT r.provider_phone_id AS key,
        pp.phone_number, pp.number_type,
        sp.name AS provider_name, sp.color AS provider_color,
        pc.label AS account_label,
        ${METRIC_SELECT}
      FROM report_stage_hour r
      LEFT JOIN provider_phones pp ON pp.id = r.provider_phone_id
      LEFT JOIN sms_providers sp ON sp.id = r.sms_provider_id
      LEFT JOIN provider_credentials pc ON pc.id = r.provider_credential_id
      WHERE ${where}
      GROUP BY r.provider_phone_id, pp.phone_number, pp.number_type,
               sp.name, sp.color, pc.label
      ORDER BY sent DESC`;
  } else if (dimension === "offer") {
    rowSql = sql`
      SELECT r.offer_id AS key, o.offer_id AS offer_code, o.name AS offer_name,
        ${METRIC_SELECT}
      FROM report_stage_hour r
      LEFT JOIN offers o ON o.id = r.offer_id
      WHERE ${where}
      GROUP BY r.offer_id, o.offer_id, o.name
      ORDER BY sent DESC`;
  } else if (dimension === "sequence") {
    rowSql = sql`
      SELECT r.stage_number AS key, ${METRIC_SELECT}
      FROM report_stage_hour r
      WHERE ${where}
      GROUP BY r.stage_number
      ORDER BY r.stage_number ASC NULLS LAST`;
  } else if (dimension === "hourly") {
    rowSql = sql`
      SELECT r.bucket_hour_et AS key, ${METRIC_SELECT}
      FROM report_stage_hour r
      WHERE ${where}
      GROUP BY r.bucket_hour_et
      ORDER BY r.bucket_hour_et ASC`;
  } else {
    // group — Fact B, fans out over contact groups.
    const gWhere = factAWhere(orgId, b); // same predicate, table alias r
    rowSql = sql`
      SELECT r.contact_group_id AS key, cg.name AS group_name, cg.color AS group_color,
        ${METRIC_SELECT}
      FROM report_group_hour r
      LEFT JOIN contact_groups cg ON cg.id = r.contact_group_id
      WHERE ${gWhere}
      GROUP BY r.contact_group_id, cg.name, cg.color
      ORDER BY sent DESC`;
  }

  const [rawRows, totalsRows, freshRows] = await Promise.all([
    db.execute(rowSql) as unknown as Promise<Record<string, unknown>[]>,
    // TRUE totals always from Fact A (report_stage_hour), even for the group report.
    db.execute(sql`
      SELECT ${METRIC_SELECT}
      FROM report_stage_hour r
      WHERE ${factAWhere(orgId, b)}
    `) as unknown as Promise<Record<string, unknown>[]>,
    db.execute(sql`
      SELECT max(refreshed_at) AS refreshed_at
      FROM ${dimension === "group" ? sql`report_group_hour` : sql`report_stage_hour`}
      WHERE org_id = ${orgId}::uuid
    `) as unknown as Promise<{ refreshed_at: string | null }[]>,
  ]);

  const rows: PerfRow[] = rawRows.map((r) => {
    const m = toMetrics(r);
    const base = { key: String(r.key ?? "—"), ...m };
    if (dimension === "number") {
      const num = (r.phone_number as string | null) ?? null;
      return {
        ...base,
        label: num ?? "No number",
        phone_number: num,
        number_type: (r.number_type as string | null) ?? null,
        provider_name: (r.provider_name as string | null) ?? null,
        provider_color: (r.provider_color as string | null) ?? null,
        account_label: (r.account_label as string | null) ?? null,
      };
    }
    if (dimension === "offer") {
      const code = (r.offer_code as string | null) ?? null;
      const name = (r.offer_name as string | null) ?? null;
      return { ...base, label: name ? `${name} (${code})` : (code ?? "No offer") };
    }
    if (dimension === "sequence") {
      return { ...base, label: r.key == null ? "—" : `Message ${r.key}` };
    }
    if (dimension === "hourly") {
      return { ...base, label: formatEtHour(Number(r.key)) };
    }
    // group
    const gname = (r.group_name as string | null) ?? null;
    return {
      ...base,
      label: gname ?? "No group",
      group_color: (r.group_color as string | null) ?? null,
    };
  });

  return {
    dimension,
    rows,
    totals: toMetrics(totalsRows[0] ?? {}),
    refreshedAt: freshRows[0]?.refreshed_at ?? null,
  };
}

// Distinct sending numbers present in the rollup (for the provider/number filter).
export async function getReportProviderOptions(
  orgId: string,
): Promise<ProviderOption[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT r.provider_phone_id,
      pp.phone_number, pp.number_type,
      sp.name AS provider_name, sp.color AS provider_color, pc.label AS account_label
    FROM report_stage_hour r
    LEFT JOIN provider_phones pp ON pp.id = r.provider_phone_id
    LEFT JOIN sms_providers sp ON sp.id = r.sms_provider_id
    LEFT JOIN provider_credentials pc ON pc.id = r.provider_credential_id
    WHERE r.org_id = ${orgId}::uuid AND r.provider_phone_id IS NOT NULL
    ORDER BY pp.phone_number
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    provider_phone_id: Number(r.provider_phone_id),
    phone_number: (r.phone_number as string | null) ?? null,
    number_type: (r.number_type as string | null) ?? null,
    provider_name: (r.provider_name as string | null) ?? null,
    provider_color: (r.provider_color as string | null) ?? null,
    account_label: (r.account_label as string | null) ?? null,
  }));
}

// "3 PM" style ET hour label (0..23).
function formatEtHour(h: number): string {
  if (!Number.isFinite(h)) return "—";
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period} ET`;
}
