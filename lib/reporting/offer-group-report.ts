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

// Lifecycle-cohort columns for one group row (migration 0226,
// offer_group_lifecycle_v2_mv; 0214/0215's offer_group_lifecycle_mv merged hot +
// warm into one "hw" cohort and is no longer read). Cohort = the contact's
// CURRENT lifecycle status; Hot and Warm are SEPARATE cohorts (owner,
// 2026-10-23). Sent = messages (same scope as sent_7d/30d/90d); fresh =
// contacts (0133 definition). new/suppressed are in no cohort.
export type GroupLifecycleRow = {
  hot_sent_14d: number;
  hot_sent_30d: number;
  hot_fresh_pool: number;
  warm_sent_14d: number;
  warm_sent_30d: number;
  warm_fresh_pool: number;
  cold_sent_14d: number;
  cold_sent_30d: number;
  cold_fresh_pool: number;
  freeze_sent_14d: number;
  freeze_sent_30d: number;
  freeze_fresh_pool: number;
};

export const LIFECYCLE_COLUMNS = [
  "hot_sent_14d", "hot_sent_30d", "hot_fresh_pool",
  "warm_sent_14d", "warm_sent_30d", "warm_fresh_pool",
  "cold_sent_14d", "cold_sent_30d", "cold_fresh_pool",
  "freeze_sent_14d", "freeze_sent_30d", "freeze_fresh_pool",
] as const satisfies ReadonlyArray<keyof GroupLifecycleRow>;

// Offer-exposure columns per lifecycle cohort for one group row (migration
// 0227, offer_group_exposure_mv; owner 2026-10-27, ClickUp 1amdve28n15).
// Contacts, not messages: the cohort's SENDABLE contacts in the group split by
// how many campaigns of THIS offer reached them (contact_offer_campaigns), and
// how many of them a new campaign of the offer could message today at the
// defaults (limit 2, cooldown 14 days, not a buyer, Freeze not resting).
// x0 + x1 + x2plus = the cohort's sendable contacts in the group.
export type GroupExposureRow = {
  hot_x0: number;
  hot_x1: number;
  hot_x2plus: number;
  hot_eligible: number;
  warm_x0: number;
  warm_x1: number;
  warm_x2plus: number;
  warm_eligible: number;
  cold_x0: number;
  cold_x1: number;
  cold_x2plus: number;
  cold_eligible: number;
  freeze_x0: number;
  freeze_x1: number;
  freeze_x2plus: number;
  freeze_eligible: number;
};

export const EXPOSURE_COLUMNS = [
  "hot_x0", "hot_x1", "hot_x2plus", "hot_eligible",
  "warm_x0", "warm_x1", "warm_x2plus", "warm_eligible",
  "cold_x0", "cold_x1", "cold_x2plus", "cold_eligible",
  "freeze_x0", "freeze_x1", "freeze_x2plus", "freeze_eligible",
] as const satisfies ReadonlyArray<keyof GroupExposureRow>;

/** One group's lifecycle detail. Either view may lack the group (not yet refreshed); absent cells render "—". */
export type GroupLifecycleDetail = Partial<GroupLifecycleRow & GroupExposureRow>;

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

// The lifecycle columns per group_id, read only when the page asks for them
// (the "Show lifecycle detailed report" checkbox): the cohort sends from
// offer_group_lifecycle_v2_mv (0226) merged with the cohort exposure from
// offer_group_exposure_mv (0227). A group absent from a view (not yet
// refreshed) simply lacks those cells and renders "—". Both views refresh in
// the same cron run; `refreshedAt` is the OLDER of the two stamps (null until
// both have refreshed), so "as of" never overstates the staler one.
export async function getOfferGroupLifecycle(
  orgId: string,
  offerId: number,
): Promise<{ rows: Record<number, GroupLifecycleDetail>; refreshedAt: string | null }> {
  const lifecycleRows = (await db.execute(sql`
    select group_id, ${sql.raw(LIFECYCLE_COLUMNS.join(", "))}
    from offer_group_lifecycle_v2_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];
  const exposureRows = (await db.execute(sql`
    select group_id, ${sql.raw(EXPOSURE_COLUMNS.join(", "))}
    from offer_group_exposure_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];
  const logRows = (await db.execute(sql`
    select refreshed_at from report_refresh_log
    where view_name in ('offer_group_lifecycle_v2_mv', 'offer_group_exposure_mv')
  `)) as unknown as { refreshed_at: string | null }[];

  const out: Record<number, GroupLifecycleDetail> = {};
  const merge = (r: Record<string, unknown>, cols: readonly (keyof GroupLifecycleDetail)[]) => {
    const row = (out[Number(r.group_id)] ??= {});
    for (const c of cols) row[c] = Number(r[c] ?? 0);
  };
  for (const r of lifecycleRows) merge(r, LIFECYCLE_COLUMNS);
  for (const r of exposureRows) merge(r, EXPOSURE_COLUMNS);

  const stamps = logRows.map((l) => (l.refreshed_at ? new Date(l.refreshed_at).getTime() : null));
  const refreshedAt =
    stamps.length === 2 && stamps.every((t) => t != null)
      ? new Date(Math.min(...(stamps as number[]))).toISOString()
      : null;
  return { rows: out, refreshedAt };
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

/** Per-view result. One entry per matview of the run, in refresh order. */
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

// The four matviews of the main run, in refresh order. Ordering still matters
// even though a failure no longer stops the run:
//
//   * audience_report_group_totals_mv SUMS offer_group_report_mv, so it must
//     refresh after it to pick up the same snapshot. If the group refresh
//     FAILS, this one still runs and sums the previous group snapshot — stale,
//     but internally consistent and visibly stale via its own log stamp, which
//     beats freezing it too.
//   * The two 0093 matviews lead, so a code-before-migration deploy (CLAUDE.md
//     §14) breaks on the newer views rather than the older ones.
//
// The LIFECYCLE views are not here. Since 0227 they are
// LIFECYCLE_REFRESH_SEQUENCE, refreshed by their own cron run 30 minutes later
// (owner, 2026-10-27): with the exposure view added, one run of all six would
// sit at or past the 300 s route limit — the group view alone peaked at 175.9 s.
const REFRESH_SEQUENCE = [
  { view: "offer_report_org_summary_mv", durationKey: "summaryMs" },
  { view: "offer_group_report_mv", durationKey: "groupMs" },
  { view: "offer_report_offer_totals_mv", durationKey: "totalsMs" },
  { view: "audience_report_group_totals_mv", durationKey: "audienceTotalsMs" },
] as const satisfies ReadonlyArray<{
  view: string;
  durationKey: "summaryMs" | "groupMs" | "totalsMs" | "audienceTotalsMs";
}>;

// The lifecycle run (/api/cron/refresh-offer-group-lifecycle, 05:30 / 20:30 UTC).
// Neither view reads another matview, so the order only puts the view the
// screen has read longest first.
const LIFECYCLE_REFRESH_SEQUENCE = [
  { view: "offer_group_lifecycle_v2_mv", durationKey: "lifecycleMs" },
  { view: "offer_group_exposure_mv", durationKey: "exposureMs" },
] as const satisfies ReadonlyArray<{ view: string; durationKey: "lifecycleMs" | "exposureMs" }>;

type SessionDb = Parameters<Parameters<typeof withRefreshSession>[0]>[0];

// One sequence on one session connection: each view refreshed CONCURRENTLY,
// caught on its own, and stamped in report_refresh_log only on its own
// success. Shared by both cron runs so they cannot disagree about isolation.
async function refreshSequence<K extends string>(
  sessionDb: SessionDb,
  sequence: ReadonlyArray<{ view: string; durationKey: K }>,
  logTag: string,
): Promise<{ outcomes: RefreshOutcome[]; durations: Record<K, number> }> {
  const outcomes: RefreshOutcome[] = [];
  const durations = Object.fromEntries(sequence.map((t) => [t.durationKey, 0])) as Record<K, number>;
  for (const target of sequence) {
    const startedAt = Date.now();
    try {
      // View names come from the frozen sequences above, never from input;
      // REFRESH does not accept a bind parameter for its target.
      await sessionDb.execute(
        sql.raw(`refresh materialized view concurrently ${target.view}`),
      );
      durations[target.durationKey] = Date.now() - startedAt;
      await sessionDb.execute(sql`
        update report_refresh_log set refreshed_at = now() where view_name = ${target.view}
      `);
      outcomes.push({ view: target.view, ok: true, durationMs: durations[target.durationKey] });
    } catch (err) {
      // Reported, not swallowed: recorded below, logged here, alerted by the
      // route. The loop continues so the remaining views still refresh.
      durations[target.durationKey] = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[${logTag}] ${target.view} FAILED after ${durations[target.durationKey]}ms:`,
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
  return { outcomes, durations };
}

// Rebuild the four main matviews (CONCURRENTLY -- non-blocking) and stamp the
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
// succeeds, and NOT at all when it fails. That is what makes every
// refreshed_at value independently meaningful: a view whose stamp is current
// really was rebuilt on the last run, and a view whose stamp is stale really
// was not, regardless of what its neighbours did. Reading them all back is the
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
    const { outcomes, durations } = await refreshSequence(
      sessionDb,
      REFRESH_SEQUENCE,
      "refresh-offer-group-report",
    );
    return {
      ...durations,
      totalMs: Date.now() - t0,
      outcomes,
      failed: outcomes.filter((o) => !o.ok).map((o) => o.view),
      connection,
    };
  });
}

export type LifecycleRefreshDurations = {
  lifecycleMs: number;
  exposureMs: number;
  totalMs: number;
  /** Both lifecycle views, in order, with per-view success and duration. */
  outcomes: RefreshOutcome[];
  failed: string[];
  connection: RefreshConnection;
};

// The lifecycle run: offer_group_lifecycle_v2_mv (0226) and
// offer_group_exposure_mv (0227), with the same session connection, per-view
// isolation and stamping as the main run. Called by
// /api/cron/refresh-offer-group-lifecycle.
export async function refreshOfferGroupLifecycle(): Promise<LifecycleRefreshDurations> {
  return withRefreshSession(async (sessionDb, connection) => {
    const t0 = Date.now();
    const { outcomes, durations } = await refreshSequence(
      sessionDb,
      LIFECYCLE_REFRESH_SEQUENCE,
      "refresh-offer-group-lifecycle",
    );
    return {
      ...durations,
      totalMs: Date.now() - t0,
      outcomes,
      failed: outcomes.filter((o) => !o.ok).map((o) => o.view),
      connection,
    };
  });
}

// ── ONE-OFF: the first fill of offer_group_lifecycle_v2_mv (migration 0226) ──
//
// 0226 creates the view WITH NO DATA, because building it (~150 s) does not fit
// prod's 120 s server-wide statement_timeout inside db:migrate. This fills it on
// the same session-mode connection the twice-daily refresh uses (180 s
// statement_timeout, raised work_mem), so it lives in this module — the one
// caller refresh-session.ts allows. Called only by
// scripts/fill-offer-group-lifecycle-v2.ts, attended, in the quiet window.
//
// ⚠️ A PLAIN REFRESH, NOT CONCURRENTLY: CONCURRENTLY refuses a matview that has
// never been populated. The plain form takes an ACCESS EXCLUSIVE lock on v2
// only — nothing reads v2 until the code that reads it is deployed, which
// happens after this fill verifies.
//
// ⚠️ THE OLD VIEW IS REFRESHED STRAIGHT AFTER (CONCURRENTLY, non-blocking — its
// normal refresh), so the verification compares two snapshots minutes apart,
// not hours. Any drift between them is sends that landed in between, and the
// verify script reports it rather than hiding it.
export type LifecycleV2FillResult = {
  v2Ms: number;
  oldMs: number;
  connection: RefreshConnection;
};

export async function fillOfferGroupLifecycleV2(): Promise<LifecycleV2FillResult> {
  return withRefreshSession(async (sessionDb, connection) => {
    const t0 = Date.now();
    await sessionDb.execute(sql`refresh materialized view offer_group_lifecycle_v2_mv`);
    const v2Ms = Date.now() - t0;
    await sessionDb.execute(sql`
      update report_refresh_log set refreshed_at = now()
      where view_name = 'offer_group_lifecycle_v2_mv'
    `);
    const t1 = Date.now();
    await sessionDb.execute(
      sql`refresh materialized view concurrently offer_group_lifecycle_mv`,
    );
    const oldMs = Date.now() - t1;
    await sessionDb.execute(sql`
      update report_refresh_log set refreshed_at = now()
      where view_name = 'offer_group_lifecycle_mv'
    `);
    return { v2Ms, oldMs, connection };
  });
}

// ── ONE-OFF: the first fill of offer_group_exposure_mv (migration 0227) ──────
//
// Same reason and shape as fillOfferGroupLifecycleV2 above: 0227 creates the
// view WITH NO DATA (its build reads contact_offer_campaigns, ~1 GB), so it is
// filled once, attended, by scripts/fill-offer-group-exposure.ts — a PLAIN
// REFRESH (CONCURRENTLY refuses an unpopulated view) on the report's session.
// Nothing reads the view until the code that reads it deploys after the fill
// verifies.
export async function fillOfferGroupExposure(): Promise<{ ms: number; connection: RefreshConnection }> {
  return withRefreshSession(async (sessionDb, connection) => {
    const t0 = Date.now();
    await sessionDb.execute(sql`refresh materialized view offer_group_exposure_mv`);
    const ms = Date.now() - t0;
    await sessionDb.execute(sql`
      update report_refresh_log set refreshed_at = now()
      where view_name = 'offer_group_exposure_mv'
    `);
    return { ms, connection };
  });
}
