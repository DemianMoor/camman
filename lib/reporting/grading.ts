import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Server-side queries behind the operator API's creative-grading endpoints. Pure
// rate math lives in grading-rates.ts. Definitions: docs/07-conventions.md
// "Grading metrics".

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

const round2 = (n: number) => Math.round(n * 100) / 100;
const daysBetween = (later: string, earlier: string) =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

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
