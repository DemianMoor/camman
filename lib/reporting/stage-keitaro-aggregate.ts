import { sql } from "drizzle-orm";

import { keitaro_stage_results } from "@/db/schema";
import { parseEventMap, type DbOrTx, type EventMap } from "@/lib/reporting/event-columns";

// =============================================================================
// THE CAMPAIGN PAGE'S keitaro_stage_results ROLL-UP — one query, per stage.
//
// It lives here rather than inside app/api/campaigns/[campaignId]/stages/route.ts
// for ONE reason: testability. A route module drags in requireApiMembership and
// the whole auth chain, so a `tsx` script that wants to execute this SELECT would
// have to stand all of that up — and a bar that RETYPES the query instead proves
// only that the typist agreed with themselves. Bars K1-K5,
// scripts/test-report-event-columns-db.ts, call this exact function.
// (It is NOT here because a route may export only route fields — it may not:
// app/api/keitaro/reports/route.ts exports SORTABLE and EVENT_SORT_RE.)
// =============================================================================

/** One stage's Keitaro figures, summed across every stat_date it has a row for. */
export interface StageKeitaroTotals {
  sales: number;
  /** numeric(12,4) as text — the wire shape the campaign page already parses. */
  revenue: string;
  /** Migration 0182. The same money still HELD; never summed into revenue. */
  pendingRevenue: string;
  visitClicksRaw: number;
  visitClicksClean: number;
  /** Migration 0185: the same sales/revenue, split per event_types.key. */
  events: EventMap;
  /**
   * Conversions on this stage that matched NO event-type mapping. They count as
   * nothing in `sales`, in `revenue` and under every key of `events` — this is
   * the only place they are visible at all, which is why every surface that
   * shows the breakdown has to show this beside it.
   */
  unmapped: number;
}

/**
 * Every stage of one campaign that has at least one keitaro_stage_results row.
 *
 * A stage with NO row is simply absent from the map: the caller reads that as
 * 0 / {} / 0, never as "unknown". An absent row IS the zero here — a null would
 * make every gap look like a data outage, and the tracking-gap rule
 * (shouldSubstituteClickers) depends on a missing row reading 0/0.
 *
 * ⭐ ONE QUERY, KEYED ON campaign_id, so keitaro_stage_results_campaign_date_idx
 * serves it — not 2xN correlated subqueries.
 *
 * ⭐ NO AGGREGATE OVER jsonb ANYWHERE, and that is a constraint, not a style
 * choice: PostgreSQL defines min()/max() for anyarray, anyenum and the scalar
 * types only — there is no min(jsonb) and no implicit jsonb -> text cast, so
 * `min(o.events)` fails at EXECUTION time with 42883 (bar K5). The scalars are
 * therefore grouped in their OWN CTE and joined to the per-event object
 * afterwards, which also keeps the two properties below true:
 *
 *   - a stage whose `events` is '{}' still gets a row. jsonb_each('{}') yields
 *     NO rows, so the lateral cannot be what carries a stage forward: a stage
 *     with clicks and no conversions is ordinary and must read 0, never blank
 *     (bar K2).
 *   - pending_revenue keeps its place among the scalars. It reaches the campaign
 *     page's per-stage pending segment and its "Pending revenue" tile, and
 *     dropping it is SILENT — the figure just becomes 0 (bar K4).
 */
export async function getStageKeitaroTotals(
  dbc: DbOrTx,
  orgId: string,
  campaignId: number,
): Promise<Map<number, StageKeitaroTotals>> {
  // The CTE is named `ksr`, not `rows`: ROWS is non-reserved so `WITH rows AS`
  // parses, but it sits one keyword away from window-frame and FETCH ... ROWS
  // syntax and is an avoidable trap for the next reader.
  const rows = (await dbc.execute(sql`
    WITH ksr AS (
      SELECT stage_id, sales, revenue, pending_revenue,
             visit_clicks_raw, visit_clicks_clean,
             events, unmapped_conversions
      FROM ${keitaro_stage_results}
      WHERE org_id = ${orgId} AND campaign_id = ${campaignId}
    ),
    scal AS (
      SELECT stage_id,
             sum(sales)::int AS sales,
             sum(revenue)::numeric(12,4)::text AS revenue,
             sum(pending_revenue)::numeric(12,4)::text AS pending_revenue,
             -- Both visit columns: the clickers-gap rule is a ZERO-test across
             -- the pair (hasNoKeitaroVisits), never clean alone — raw is a
             -- superset, so "raw > 0, clean = 0" is common and is NOT a gap.
             sum(visit_clicks_raw)::int AS visit_clicks_raw,
             sum(visit_clicks_clean)::int AS visit_clicks_clean,
             sum(unmapped_conversions)::int AS unmapped_conversions
      FROM ksr
      GROUP BY stage_id
    ),
    -- The per-event block re-aggregated across the stage's days. jsonb has no
    -- sum(), so the object is unrolled to (key, value) pairs and summed per key.
    ev AS (
      SELECT k.stage_id,
             e.key AS event_key,
             sum((e.value ->> 'n')::numeric)::int AS n,
             sum((e.value ->> 'pending_n')::numeric)::int AS pending_n,
             sum((e.value ->> 'revenue')::numeric)::numeric(12,4) AS revenue,
             sum((e.value ->> 'pending_revenue')::numeric)::numeric(12,4) AS pending_revenue
      FROM ksr k
      CROSS JOIN LATERAL jsonb_each(k.events) AS e(key, value)
      GROUP BY 1, 2
    ),
    ev_obj AS (
      SELECT stage_id,
             jsonb_object_agg(event_key, jsonb_build_object(
               'n', n, 'pending_n', pending_n,
               'revenue', revenue, 'pending_revenue', pending_revenue)) AS events
      FROM ev GROUP BY 1
    )
    SELECT s.stage_id,
           s.sales, s.revenue, s.pending_revenue,
           s.visit_clicks_raw, s.visit_clicks_clean,
           s.unmapped_conversions,
           coalesce(o.events, '{}'::jsonb) AS events
    FROM scal s
    LEFT JOIN ev_obj o ON o.stage_id = s.stage_id
  `)) as unknown as {
    stage_id: number;
    sales: number;
    revenue: string;
    pending_revenue: string;
    visit_clicks_raw: number;
    visit_clicks_clean: number;
    unmapped_conversions: number;
    // jsonb. postgres-js JSON.parses it, so the money inside arrives as JS
    // numbers while the top-level numerics above arrive as strings —
    // parseEventMap accepts both and neither branch is dead.
    events: unknown;
  }[];

  return new Map(
    rows.map((r) => [
      Number(r.stage_id),
      {
        sales: Number(r.sales ?? 0),
        revenue: r.revenue ?? "0.0000",
        pendingRevenue: r.pending_revenue ?? "0.0000",
        visitClicksRaw: Number(r.visit_clicks_raw ?? 0),
        visitClicksClean: Number(r.visit_clicks_clean ?? 0),
        events: parseEventMap(r.events),
        unmapped: Number(r.unmapped_conversions ?? 0),
      },
    ]),
  );
}
