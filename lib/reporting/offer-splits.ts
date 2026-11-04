import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { addEventMaps, type EventMap } from "@/lib/reporting/event-columns";
import { zeroMetrics, type PerfMetrics } from "@/lib/reporting/performance-report";
import {
  approvedRevenueClause,
  countedClause,
  pendingRevenueClause,
  purchasedClause,
} from "@/lib/sale-attribution";

// THE OFFER SPLIT LAYER (per-offer conversion attribution, phase 2).
//
// Phase 1 stores each conversion under the CamMan offer mapped from its Keitaro
// offer, so conversion_events.offer_id can differ from the stage's campaign offer.
// A stage's tracker totals (keitaro_stage_results) are keyed by stage, not offer,
// so by-offer readers need the part of those totals that belongs to ANOTHER offer.
// getOfferSplits reads exactly that from the ledger; splitStageMetrics moves it
// between slices. The invariant: sum of slices == the unsplit metrics, field for field.

/** Ledger amounts on one stage whose conversion offer differs from the stage's campaign offer. */
export interface OfferSplit {
  stage_id: number;
  offer_id: number;
  sales: number;
  revenue: number;
  pending_revenue: number;
  events: EventMap;
}

/**
 * One grouped query over the ledger. `b` is an inclusive ET-day range, dated by
 * `occurred_at` in ET exactly like the stage-day projection
 * (lib/keitaro/stage-day-conversions.ts); null = lifetime.
 */
export async function getOfferSplits(
  orgId: string,
  stageIds: number[],
  b: { fromEt: string; toEt: string } | null,
): Promise<OfferSplit[]> {
  if (stageIds.length === 0) return [];
  const range = b
    ? sql`AND (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date BETWEEN ${b.fromEt}::date AND ${b.toEt}::date`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT ce.stage_id::int AS stage_id,
           ce.offer_id::int AS offer_id,
           et.key AS event_key,
           count(*) FILTER (WHERE ${purchasedClause()})::int AS sales,
           coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)::text AS revenue,
           coalesce(sum(ce.revenue) FILTER (WHERE ${pendingRevenueClause()}), 0)::text AS pending_revenue,
           count(*) FILTER (WHERE ${countedClause()})::int AS n,
           count(*) FILTER (WHERE ce.status = 'pending')::int AS pending_n,
           coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'approved'), 0)::text AS ev_revenue,
           coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'pending'), 0)::text AS ev_pending_revenue
    FROM conversion_events ce
    JOIN campaign_stages cs ON cs.id = ce.stage_id AND cs.org_id = ce.org_id
    JOIN campaigns ca ON ca.id = cs.campaign_id AND ca.org_id = ce.org_id
    LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
    WHERE ce.org_id = ${orgId}::uuid
      AND ce.stage_id IN (${sql.join(
        stageIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND ce.offer_id IS NOT NULL
      AND ce.offer_id IS DISTINCT FROM ca.offer_id
      ${range}
    GROUP BY ce.stage_id, ce.offer_id, et.key
  `)) as unknown as {
    stage_id: number;
    offer_id: number;
    event_key: string | null;
    sales: number;
    revenue: string;
    pending_revenue: string;
    n: number;
    pending_n: number;
    ev_revenue: string;
    ev_pending_revenue: string;
  }[];

  const out = new Map<string, OfferSplit>();
  for (const r of rows) {
    const k = `${r.stage_id}:${r.offer_id}`;
    let s = out.get(k);
    if (!s) {
      s = { stage_id: r.stage_id, offer_id: r.offer_id, sales: 0, revenue: 0, pending_revenue: 0, events: {} };
      out.set(k, s);
    }
    s.sales += Number(r.sales);
    s.revenue += Number(r.revenue);
    s.pending_revenue += Number(r.pending_revenue);
    const n = Number(r.n);
    const pn = Number(r.pending_n);
    const er = Number(r.ev_revenue);
    const ep = Number(r.ev_pending_revenue);
    // Same omission rule as the projection: a key that is zero on every field has no entry.
    if (r.event_key !== null && (n !== 0 || pn !== 0 || er !== 0 || ep !== 0)) {
      s.events[r.event_key] = { n, pending_n: pn, revenue: er, pending_revenue: ep };
    }
  }
  return [...out.values()].sort((a, b) => a.stage_id - b.stage_id || a.offer_id - b.offer_id);
}

/**
 * A split that moves something. getOfferSplits already omits event keys that are
 * zero on every field, so an empty `events` plus zero amounts moves nothing (e.g.
 * only rejected conversions) — and would mint an all-zero offer row.
 */
export function isMovingSplit(sp: OfferSplit): boolean {
  return sp.sales !== 0 || sp.revenue !== 0 || sp.pending_revenue !== 0 || Object.keys(sp.events).length > 0;
}

export interface OfferSlice {
  offer_id: number | null;
  metrics: PerfMetrics;
  secondary: boolean;
  /** Set (on a single unsplit slice) when the split would drive the campaign-offer slice negative. */
  skipped?: "would_go_negative";
}

const EPS = 1e-9;

/**
 * Pure. The campaign-offer slice keeps everything but sales / revenue /
 * pending_revenue / events, which lose the sum of the splits; each split becomes
 * a secondary slice carrying only those four fields. NEVER CLAMPS: if the splits
 * exceed what the tracker-derived metrics hold (a manual-tally stage, say) the
 * stage is returned unsplit with `skipped: "would_go_negative"` and a console.warn.
 */
export function splitStageMetrics(
  campaignOfferId: number | null,
  m: PerfMetrics,
  splits: OfferSplit[],
): OfferSlice[] {
  if (splits.length === 0) return [{ offer_id: campaignOfferId, metrics: m, secondary: false }];

  const total = { sales: 0, revenue: 0, pending_revenue: 0 };
  const evTotal: EventMap = {};
  for (const s of splits) {
    total.sales += s.sales;
    total.revenue += s.revenue;
    total.pending_revenue += s.pending_revenue;
    addEventMaps(evTotal, s.events);
  }

  const events: EventMap = addEventMaps({}, m.events);
  let negative =
    m.sales - total.sales < -EPS ||
    m.revenue - total.revenue < -EPS ||
    m.pending_revenue - total.pending_revenue < -EPS;
  for (const [k, t] of Object.entries(evTotal)) {
    const cur = events[k] ?? { n: 0, pending_n: 0, revenue: 0, pending_revenue: 0 };
    const next = {
      n: cur.n - t.n,
      pending_n: cur.pending_n - t.pending_n,
      revenue: cur.revenue - t.revenue,
      pending_revenue: cur.pending_revenue - t.pending_revenue,
    };
    if (Object.values(next).some((v) => v < -EPS)) negative = true;
    events[k] = next;
  }

  if (negative) {
    console.warn(
      `[offer-splits] split would drive campaign-offer slice negative; leaving stage unsplit ` +
        `(campaign offer ${campaignOfferId}, stage ${splits[0].stage_id}, offers ${splits.map((s) => s.offer_id).join(",")})`,
    );
    return [{ offer_id: campaignOfferId, metrics: m, secondary: false, skipped: "would_go_negative" }];
  }

  const primary: PerfMetrics = {
    ...m,
    sales: m.sales - total.sales,
    revenue: m.revenue - total.revenue,
    pending_revenue: m.pending_revenue - total.pending_revenue,
    events,
    split_out_revenue: m.split_out_revenue + total.revenue,
    event_split_delta: Object.fromEntries(
      Object.entries(evTotal).map(([k, t]) => [k, (m.event_split_delta[k] ?? 0) + t.revenue]),
    ),
  };
  for (const [k, v] of Object.entries(m.event_split_delta)) {
    if (!(k in primary.event_split_delta)) primary.event_split_delta[k] = v;
  }
  const secondaries: OfferSlice[] = splits.map((s) => ({
    offer_id: s.offer_id,
    secondary: true,
    metrics: {
      ...zeroMetrics(),
      sales: s.sales,
      revenue: s.revenue,
      pending_revenue: s.pending_revenue,
      events: addEventMaps({}, s.events),
      split_in_revenue: s.revenue,
      event_split_delta: Object.fromEntries(Object.entries(s.events).map(([k, t]) => [k, -t.revenue])),
    },
  }));
  return [{ offer_id: campaignOfferId, metrics: primary, secondary: false }, ...secondaries];
}
