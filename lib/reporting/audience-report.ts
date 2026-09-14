import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  type RawMetrics,
  readGroupReportRefreshedAt,
  readOrgBenchmark,
} from "@/lib/reporting/offer-group-report";

// Read side of the Audience Stats report (/reports/audience, ClickUp
// 869eydqn0): one contact group, one row per offer. The inverse view of
// offer-group-report.ts over the same matview, offer_group_report_mv.
//
// No `"server-only"` import, for the same reason as offer-group-report.ts:
// scripts/verify-audience-report.ts calls these directly under tsx.

export type AudienceGroupOption = { id: number; name: string; archived: boolean };

export type SentWindows = { sent_7d: number; sent_30d: number; sent_90d: number };

export type AudienceOfferRow = RawMetrics &
  SentWindows & {
    offer_id: number;
    offer_name: string;
    offer_archived: boolean;
    fresh_pool: number;
  };

// "This group · all offers". Read from audience_report_group_totals_mv, never
// summed from the offer rows: clicks and opt-outs there are deduplicated at
// GROUP grain (a contact who clicked two offers is one clicker), so they are
// lower than the rows added up, by design.
export type AudienceGroupTotals = RawMetrics & SentWindows;

export type AudienceReport = {
  rows: AudienceOfferRow[];
  groupTotals: AudienceGroupTotals;
  orgBenchmark: RawMetrics;
  benchmarkHasManual: boolean;
  refreshedAt: string | null;
};

const n = (v: unknown) => Number(v ?? 0);

// Groups the picker offers: every group with report data, archived included.
// Active groups first, then by name.
export async function getAudienceGroups(orgId: string): Promise<AudienceGroupOption[]> {
  const rows = (await db.execute(sql`
    select g.id, g.name, g.status
    from audience_report_group_totals_mv t
    join contact_groups g on g.id = t.group_id and g.org_id = t.org_id
    where t.org_id = ${orgId}::uuid
    order by (g.status = 'archived'), lower(g.name), g.id
  `)) as unknown as { id: number; name: string; status: string }[];
  return rows.map((r) => ({
    id: n(r.id),
    name: String(r.name),
    archived: r.status === "archived",
  }));
}

// Read the precomputed report for one group, org-scoped. Sorting is done
// client-side (at most a few dozen offers), so no ORDER BY here.
export async function getAudienceReport(orgId: string, groupId: number): Promise<AudienceReport> {
  // No status filter on offers: the report must show every offer ever sent to
  // the group, archived ones included. LEFT JOIN so a cell whose offer row is
  // gone still renders (until the next refresh drops it).
  const offerRows = (await db.execute(sql`
    select m.offer_id, o.name as offer_name, o.status as offer_status,
           m.sends, m.revenue, m.sales, m.clicks, m.cost, m.optouts,
           m.sent_7d, m.sent_30d, m.sent_90d, m.fresh_pool
    from offer_group_report_mv m
    left join offers o on o.id = m.offer_id and o.org_id = m.org_id
    where m.org_id = ${orgId}::uuid and m.group_id = ${groupId}
  `)) as unknown as Record<string, unknown>[];

  const totalsRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, sent_7d, sent_30d, sent_90d
    from audience_report_group_totals_mv
    where org_id = ${orgId}::uuid and group_id = ${groupId}
  `)) as unknown as Record<string, unknown>[];

  const { orgBenchmark, benchmarkHasManual } = await readOrgBenchmark(orgId);
  const refreshedAt = await readGroupReportRefreshedAt();

  const metrics = (r: Record<string, unknown> | undefined): AudienceGroupTotals => ({
    sends: n(r?.sends),
    revenue: n(r?.revenue),
    sales: n(r?.sales),
    clicks: n(r?.clicks),
    cost: n(r?.cost),
    optouts: n(r?.optouts),
    sent_7d: n(r?.sent_7d),
    sent_30d: n(r?.sent_30d),
    sent_90d: n(r?.sent_90d),
  });

  return {
    rows: offerRows.map((r) => ({
      ...metrics(r),
      offer_id: n(r.offer_id),
      offer_name: r.offer_name == null ? `Offer #${n(r.offer_id)}` : String(r.offer_name),
      offer_archived: r.offer_status === "archived",
      fresh_pool: n(r.fresh_pool),
    })),
    // A group with no data has no totals row: zeros, not a missing footer.
    groupTotals: metrics(totalsRows[0]),
    orgBenchmark,
    benchmarkHasManual,
    refreshedAt,
  };
}
