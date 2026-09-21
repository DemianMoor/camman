import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  withRefreshSession,
  type RefreshConnection,
} from "@/lib/reporting/refresh-session";

// No `"server-only"` import: this module is also exercised directly by
// scripts/test-offer-group-report-helper.ts (a plain Node/tsx entry point,
// same pattern as lib/tracking-id.ts). It holds no secrets — just SQL over
// the shared matviews — and its sibling lib/reporting/attribution.ts follows
// the same convention for the same reason.

export type RawMetrics = {
  sends: number;
  revenue: number;
  // PER EVENT, not per recipient (migration 0183). One ledger row with an
  // is_purchase event type and status pending|approved is one sale, so a
  // recipient who bought twice is two sales and a row's `sales` can legitimately
  // EXCEED its `sends`. It no longer means "buyers" — nothing asserts
  // sales <= sends, and the coverage wording on the offer report already handles
  // a ratio over 100%. Before 0183 this counted stage_sends rows carrying a
  // converted_at, which could only ever be one per recipient (latest wins) and
  // silently dropped the second conversion.
  sales: number;
  clicks: number;
  cost: number;
  optouts: number;
};

export type GroupRawRow = RawMetrics & {
  group_id: number;
  group_name: string;
  // Approved-only revenue is RawMetrics.revenue; this is the same money still in
  // lifecycle status `pending` (a held conversion). A SEPARATE figure — never
  // added into revenue, and never in EPC / RPM / net profit.
  pending_revenue: number;
  sent_7d: number;
  sent_30d: number;
  sent_90d: number;
  fresh_pool: number;
};

// Offer grain. Read from its own matview rather than summed from the group
// rows: those are per-recipient full counts and a contact in three of the
// offer's groups appears in three of them. Summing was the defect 0132 removed.
export type OfferTotals = RawMetrics & {
  has_manual_stages: boolean;
  attributable_sends: number;
  // sends - attributable_sends: recorded outside the app, from a non-tracked
  // or untargeted campaign, or sent to a recipient outside its targeted groups.
  unattributed_sends: number;
  // The group rows' revenue/sales and these three come from the conversion_events
  // ledger (one row per conversion, joined on stage_send_id); this row's
  // `revenue`/`sales` come from Keitaro's per-stage aggregate — and for sales
  // GREATEST(keitaro, manual). The two bases still differ: the ledger can only
  // place a conversion whose RECIPIENT resolved, while the stage-day projection
  // also counts conversions known only at stage level. So a group row still
  // reads a little lower than its share of the footer.
  // NOT a whole-and-part pair with revenue/sales — do not subtract them.
  attributable_revenue: number;
  attributable_sales: number;
  attributable_pending_revenue: number;
};

export type OfferGroupReport = {
  rows: GroupRawRow[];
  offerTotals: OfferTotals;
  orgBenchmark: RawMetrics;
  benchmarkHasManual: boolean;
  refreshedAt: string | null;
};

const ZERO: RawMetrics = { sends: 0, revenue: 0, sales: 0, clicks: 0, cost: 0, optouts: 0 };

// Read the precomputed report for one offer, org-scoped. Sorting is done
// client-side (tiny row set), so no ORDER BY here.
export async function getOfferGroupReport(
  orgId: string,
  offerId: number,
): Promise<OfferGroupReport> {
  const groupRows = (await db.execute(sql`
    select group_id, group_name, sends, revenue, pending_revenue, sales, clicks, cost, optouts,
           sent_7d, sent_30d, sent_90d, fresh_pool
    from offer_group_report_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  // Separate matview, not groupRows[0]: an offer whose sends were all recorded
  // outside the app has NO group rows, and still needs a footer.
  const totalsRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages,
           attributable_sends, unattributed_sends,
           attributable_revenue, attributable_sales, attributable_pending_revenue
    from offer_report_offer_totals_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  const { orgBenchmark, benchmarkHasManual } = await readOrgBenchmark(orgId);
  const refreshedAt = await readGroupReportRefreshedAt();

  const n = (v: unknown) => Number(v ?? 0);
  const t = totalsRows[0];
  return {
    rows: groupRows.map((r) => ({
      group_id: n(r.group_id),
      group_name: String(r.group_name),
      sends: n(r.sends),
      revenue: n(r.revenue),
      pending_revenue: n(r.pending_revenue),
      sales: n(r.sales),
      clicks: n(r.clicks),
      cost: n(r.cost),
      optouts: n(r.optouts),
      sent_7d: n(r.sent_7d),
      sent_30d: n(r.sent_30d),
      sent_90d: n(r.sent_90d),
      fresh_pool: n(r.fresh_pool),
    })),
    offerTotals: t
      ? {
          sends: n(t.sends),
          revenue: n(t.revenue),
          sales: n(t.sales),
          clicks: n(t.clicks),
          cost: n(t.cost),
          optouts: n(t.optouts),
          has_manual_stages: Boolean(t.has_manual_stages),
          attributable_sends: n(t.attributable_sends),
          unattributed_sends: n(t.unattributed_sends),
          attributable_revenue: n(t.attributable_revenue),
          attributable_sales: n(t.attributable_sales),
          attributable_pending_revenue: n(t.attributable_pending_revenue),
        }
      : {
          ...ZERO,
          has_manual_stages: false,
          attributable_sends: 0,
          unattributed_sends: 0,
          attributable_revenue: 0,
          attributable_sales: 0,
          attributable_pending_revenue: 0,
        },
    orgBenchmark,
    benchmarkHasManual,
    refreshedAt,
  };
}

// The de-duplicated org-wide benchmark row. Shared with the Audience Stats
// report (lib/reporting/audience-report.ts) so both screens read one definition.
export async function readOrgBenchmark(
  orgId: string,
): Promise<{ orgBenchmark: RawMetrics; benchmarkHasManual: boolean }> {
  const benchRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages
    from offer_report_org_summary_mv
    where org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];

  const n = (v: unknown) => Number(v ?? 0);
  const b = benchRows[0];
  return {
    orgBenchmark: b
      ? {
          sends: n(b.sends),
          revenue: n(b.revenue),
          sales: n(b.sales),
          clicks: n(b.clicks),
          cost: n(b.cost),
          optouts: n(b.optouts),
        }
      : { ...ZERO },
    benchmarkHasManual: Boolean(b?.has_manual_stages),
  };
}

// "Data as of" for both group reports: offer_group_report_mv's refresh. The
// Audience Stats totals matview is derived from it and refreshed moments later
// in the same cron run, so this one stamp is honest for both.
export async function readGroupReportRefreshedAt(): Promise<string | null> {
  const logRows = (await db.execute(sql`
    select refreshed_at from report_refresh_log
    where view_name = 'offer_group_report_mv'
  `)) as unknown as { refreshed_at: string | null }[];
  return logRows[0]?.refreshed_at
    ? new Date(logRows[0].refreshed_at).toISOString()
    : null;
}

/** Per-view result. One entry per matview, in refresh order, always all four. */
export type RefreshOutcome = {
  view: string;
  ok: boolean;
  durationMs: number;
  /** Present only when ok === false. */
  error?: string;
};

export type RefreshDurations = {
  totalsMs: number;
  summaryMs: number;
  groupMs: number;
  audienceTotalsMs: number;
  totalMs: number;
  /** All four views, in order, with per-view success and duration. */
  outcomes: RefreshOutcome[];
  /** Names of the views that failed this run. Empty on a clean run. */
  failed: string[];
  /**
   * Which connection ran the refreshes and the settings ACTUALLY in force on
   * it. `mode: "pooled"` means the session connection was unavailable and the
   * headroom fix was NOT active for this run (a Tier-2 alert will have fired).
   */
  connection: RefreshConnection;
};

// The four matviews, in refresh order. Ordering still matters even though a
// failure no longer stops the run:
//
//   * audience_report_group_totals_mv SUMS offer_group_report_mv, so it must
//     refresh after it to pick up the same snapshot. If the group refresh
//     FAILS, this one still runs and sums the previous group snapshot — stale,
//     but internally consistent and visibly stale via its own log stamp, which
//     beats freezing it too.
//   * The two 0093 matviews lead, so a code-before-migration deploy (CLAUDE.md
//     §14) breaks on the newer views rather than the older ones.
const REFRESH_SEQUENCE = [
  { view: "offer_report_org_summary_mv", durationKey: "summaryMs" },
  { view: "offer_group_report_mv", durationKey: "groupMs" },
  { view: "offer_report_offer_totals_mv", durationKey: "totalsMs" },
  { view: "audience_report_group_totals_mv", durationKey: "audienceTotalsMs" },
] as const satisfies ReadonlyArray<{
  view: string;
  durationKey: "summaryMs" | "groupMs" | "totalsMs" | "audienceTotalsMs";
}>;

// Rebuild all four matviews (CONCURRENTLY -- non-blocking) and stamp the
// refresh log. Called by the twice-daily cron. CONCURRENTLY must run outside a
// transaction, so each statement is its own execute() call.
//
// ── EACH VIEW REFRESHES INDEPENDENTLY ────────────────────────────────────────
// This used to be four awaits in a row, so the FIRST failure ended the
// invocation and every view queued behind it was skipped. Because the group
// view is #2 and the one that was 12.5s from the 120s statement_timeout, the
// realistic failure was: group hits 57014, and offer-totals + audience-totals
// are skipped ENTIRELY on every run until someone notices -- three of four
// reports frozen by one view's problem, on a twice-daily schedule.
//
// Now each refresh is caught on its own. One view's failure freezes ONE view.
// Nothing is swallowed: every failure is recorded in the returned `outcomes`,
// logged, and the caller (/api/cron/refresh-offer-group-report) turns a
// non-empty `failed` into a Tier-1 Telegram alert and an HTTP 500.
//
// ── EACH VIEW STAMPS ITS OWN SUCCESS ─────────────────────────────────────────
// report_refresh_log is updated immediately after that view's OWN refresh
// succeeds, and NOT at all when it fails. That is what makes the four
// refreshed_at values independently meaningful: a view whose stamp is current
// really was rebuilt on the last run, and a view whose stamp is stale really
// was not, regardless of what its neighbours did. Reading all four back is the
// supported way to check a run.
//
// Runs on a dedicated session-mode connection (see ./refresh-session) so the
// raised statement_timeout and work_mem actually apply; the connection is
// closed in that helper's `finally`.
//
// Refresh timings -- pre-ledger, and post-0183 (which rebuilt group +
// offer-totals + audience-totals over conversion_events) -- live ONLY in
// app/api/cron/refresh-offer-group-report/route.ts, so two comments cannot
// drift into two different "last measured" figures again.
export async function refreshOfferGroupReport(): Promise<RefreshDurations> {
  return withRefreshSession(async (sessionDb, connection) => {
    const t0 = Date.now();
    const outcomes: RefreshOutcome[] = [];
    const durations = { summaryMs: 0, groupMs: 0, totalsMs: 0, audienceTotalsMs: 0 };

    for (const target of REFRESH_SEQUENCE) {
      const startedAt = Date.now();
      try {
        // View names come from the frozen REFRESH_SEQUENCE above, never from
        // input; REFRESH does not accept a bind parameter for its target.
        await sessionDb.execute(
          sql.raw(`refresh materialized view concurrently ${target.view}`),
        );
        durations[target.durationKey] = Date.now() - startedAt;
        await sessionDb.execute(sql`
          update report_refresh_log set refreshed_at = now() where view_name = ${target.view}
        `);
        outcomes.push({
          view: target.view,
          ok: true,
          durationMs: durations[target.durationKey],
        });
      } catch (err) {
        // Reported, not swallowed: recorded below, logged here, alerted by the
        // route. The loop continues so the remaining views still refresh.
        durations[target.durationKey] = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[refresh-offer-group-report] ${target.view} FAILED after ${durations[target.durationKey]}ms:`,
          err,
        );
        outcomes.push({
          view: target.view,
          ok: false,
          durationMs: durations[target.durationKey],
          error: message,
        });
      }
    }

    return {
      ...durations,
      totalMs: Date.now() - t0,
      outcomes,
      failed: outcomes.filter((o) => !o.ok).map((o) => o.view),
      connection,
    };
  });
}
