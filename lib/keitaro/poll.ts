import { inArray, sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import {
  CAMPAIGN_TIMEZONE,
  formatInCampaignTimezone,
} from "@/lib/campaign-timezone";
import {
  buildKeitaroReport,
  fetchKeitaroCampaigns,
  KEITARO_VISIT_CAMPAIGN_NAME,
  type KeitaroReportRow,
} from "@/lib/keitaro/client";

export type Database = typeof db;

// Rolling window: re-read the last N days every poll. Conversions arrive late
// (the affiliate fires the postback minutes-to-hours after the click), so a
// multi-day window catches late sales. Re-reading stable older days is cheap and
// the UPSERT is idempotent. CLICKS come from report/build (dated by click day);
// CONVERSIONS come from conversions/log (dated by the conversion's own datetime).
// A conversion is always dated on its event day (≤ now), so the window only needs
// to cover the recent days we want kept fresh — both fetches share this window so
// a clicks-only upsert can never zero a stored conversion.
const DEFAULT_WINDOW_DAYS = 3;

export interface KeitaroPollResult {
  ok: boolean;
  // false ⇒ the report fetch failed; rows were left untouched for next cycle.
  degraded: boolean;
  range: { from: string; to: string; timezone: string };
  fetched: number; // report rows returned by Keitaro (clicks side)
  matched: number; // report rows whose sub_id_3 mapped to a CamMan stage
  upserted: number; // (stage, date) aggregates written
  unmatched: number; // report rows skipped (no/blank/unknown sub_id_3)
  errored: number; // (stage, date) aggregates that threw during upsert
  // The CONVERSION side of keitaro_stage_results is no longer written here. It is
  // re-derived from the conversion_events ledger by
  // lib/keitaro/stage-day-conversions.ts, which the poll ROUTE runs after the
  // ledger ingest — so a conversion lands on its ORIGINAL day and a re-post can
  // no longer count twice (recon bug 2). See docs/04-features/keitaro-poll.md.
  // The stages this window's CLICK rows touched. The route feeds them to the
  // stage-day conversion projection, so a stage that got clicks today also gets
  // its conversion columns re-derived on the same tick.
  stage_ids: number[];
  // Step 5b: rows we couldn't classify as visit vs redirect because the Keitaro
  // campaigns list failed to load — those clicks fall back to the redirect side
  // (the brief's default for "any non-visit campaign"). >0 ⇒ visit counts may be
  // undercounted this cycle; the next cycle self-heals once the list loads.
  classification_degraded: boolean;
  // How many Keitaro campaigns matched the visit name (`gk-lp-visits`). Expect 1;
  // 0 ⇒ visits can't be separated (every click counts as a redirect).
  visit_campaigns_matched: number;
  // A few unmatched sub_id_3 values, for debugging what Keitaro actually sends.
  unmatched_samples: string[];
  error: string | null;
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Keep money/EPC as a decimal string for the NUMERIC column (no float drift).
function toNumericString(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : "0.0000";
}

// Extract a YYYY-MM-DD date from Keitaro's `day` grouping value (which may be a
// bare date or a full datetime string). Returns null if no date is present.
function extractDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// Resolve a batch of sub_id_3 values (= stage tracking ids) to their CamMan
// stage/campaign/org in one query. A tracking_id is unique per org; on the rare
// cross-org collision we drop it (ambiguous) rather than guess.
async function resolveStages(
  database: Database,
  trackingIds: string[],
): Promise<Map<string, { stageId: number; campaignId: number; orgId: string }>> {
  const map = new Map<
    string,
    { stageId: number; campaignId: number; orgId: string }
  >();
  if (trackingIds.length === 0) return map;

  const rows = await database
    .select({
      stage_id: campaign_stages.id,
      campaign_id: campaign_stages.campaign_id,
      org_id: campaigns.org_id,
      tracking_id: campaign_stages.tracking_id,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, sql`${campaigns.id} = ${campaign_stages.campaign_id}`)
    .where(inArray(campaign_stages.tracking_id, trackingIds));

  const ambiguous = new Set<string>();
  for (const r of rows) {
    const tid = r.tracking_id;
    if (!tid) continue;
    if (map.has(tid)) {
      ambiguous.add(tid); // same tracking_id in >1 org — drop it
      continue;
    }
    map.set(tid, {
      stageId: r.stage_id,
      campaignId: r.campaign_id,
      orgId: r.org_id,
    });
  }
  for (const tid of ambiguous) map.delete(tid);
  return map;
}

// Build a classifier: given a report row, is its Keitaro campaign the visit
// campaign? The visit campaign is identified by NAME (`gk-lp-visits`, trimmed +
// case-insensitive) — its alias is a random code, so matching on alias finds
// nothing. We resolve the name → its campaign_id(s) ONCE here, then classify
// each row by the reliable `campaign_id` dimension the report returns (with the
// row's own `campaign` name as a fallback). If the campaigns list fails to load,
// every row is treated as non-visit (redirect) — the safe default — and
// `degraded` is set.
async function buildVisitClassifier(): Promise<{
  isVisitRow: (row: KeitaroReportRow) => boolean;
  degraded: boolean;
  visitCampaignCount: number;
}> {
  const result = await fetchKeitaroCampaigns();
  if (!result.ok) {
    return { isVisitRow: () => false, degraded: true, visitCampaignCount: 0 };
  }

  const target = KEITARO_VISIT_CAMPAIGN_NAME.trim().toLowerCase();
  const visitIds = new Set<number>();
  const visitNames = new Set<string>();
  for (const c of result.campaigns) {
    if ((c.name ?? "").trim().toLowerCase() === target) {
      if (Number.isFinite(c.id)) visitIds.add(c.id);
      visitNames.add(target);
    }
  }

  const isVisitRow = (row: KeitaroReportRow): boolean => {
    const idRaw = row.campaign_id;
    if (idRaw !== undefined && idRaw !== null && idRaw !== "") {
      const id = Number(idRaw);
      if (Number.isFinite(id) && visitIds.has(id)) return true;
    }
    const name = row.campaign;
    if (typeof name === "string" && visitNames.has(name.trim().toLowerCase())) {
      return true;
    }
    return false;
  };

  return { isVisitRow, degraded: false, visitCampaignCount: visitIds.size };
}

// One per (stage, ET date) — the aggregate we UPSERT. Multiple Keitaro campaign
// rows (the visit campaign + one or more offer campaigns) fold into one entry.
export interface StageDayAgg {
  orgId: string;
  campaignId: number;
  stageId: number;
  tid: string;
  statDate: string;
  visitRaw: number;
  visitClean: number;
  redirectRaw: number;
  redirectClean: number;
  cost: number;
}

// Fold one Keitaro report/build row's CLICK metrics into a (stage, date) aggregate.
// The row's `day` is the CLICK day, so only click-day quantities ride this path:
//
// CLICKS are split by campaign: a gk-lp-visits row's clicks are landing-page
// VISITS ("Clickers"); any other campaign's clicks are OFFER REDIRECTS. Cost is
// ad-spend on the offer campaign, so it rides the redirect side too.
//
// CONVERSIONS (sales / checkouts / revenue) are NOT taken from report/build —
// report/build attributes a conversion to the originating CLICK's day, but we need
// it on the day the sale actually happened. Those columns are the
// conversion_events ledger's projection (lib/keitaro/stage-day-conversions.ts).
export function applyRowToAggregate(
  agg: StageDayAgg,
  row: KeitaroReportRow,
  isVisit: boolean,
): void {
  const rawClicks = toInt(row.clicks);
  const cleanClicks = toInt(row.campaign_unique_clicks);

  if (isVisit) {
    agg.visitRaw += rawClicks;
    agg.visitClean += cleanClicks;
  } else {
    agg.redirectRaw += rawClicks;
    agg.redirectClean += cleanClicks;
    agg.cost += toNum(row.cost);
  }
}

// Pull the rolling window from Keitaro (grouped by day + sub_id_3 + campaign),
// classify each report row as a landing-page VISIT or an OFFER REDIRECT, fold
// the campaign rows into one per-(stage, ET date) aggregate, and idempotently
// UPSERT it. Never throws: a fetch failure returns degraded; a single bad
// aggregate is counted and skipped so it can't abort the batch.
export async function pollKeitaro(
  database: Database,
  opts?: { windowDays?: number },
): Promise<KeitaroPollResult> {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const from = `${formatInCampaignTimezone(
    new Date(now.getTime() - (windowDays - 1) * 86_400_000),
    "yyyy-MM-dd",
  )} 00:00:00`;
  const to = formatInCampaignTimezone(now, "yyyy-MM-dd HH:mm:ss");
  const range = { from, to, timezone: CAMPAIGN_TIMEZONE };

  const base: KeitaroPollResult = {
    ok: false,
    degraded: true,
    range,
    fetched: 0,
    matched: 0,
    upserted: 0,
    unmatched: 0,
    errored: 0,
    stage_ids: [],
    classification_degraded: false,
    visit_campaigns_matched: 0,
    unmatched_samples: [],
    error: null,
  };

  // CLICKS ONLY. The conversion side comes from the ledger (see the header): the
  // poll no longer fetches conversions/log at all, so a conversions outage can no
  // longer block the click write, and there is one Keitaro conversion fetch per
  // tick (the ledger ingest's) instead of two.
  const report = await buildKeitaroReport(range);
  if (!report.ok) {
    return { ...base, error: report.error };
  }

  const rows = report.rows;
  const tidOf = (r: KeitaroReportRow): string =>
    typeof r.sub_id_3 === "string" ? r.sub_id_3.trim() : "";
  // Resolve every tracking id seen in the report in one query.
  const trackingIds = [...new Set(rows.map(tidOf).filter((s) => s.length > 0))];
  const [classifier, stageMap] = await Promise.all([
    buildVisitClassifier(),
    resolveStages(database, trackingIds),
  ]);

  let matched = 0;
  let unmatched = 0;
  const unmatchedSamples = new Set<string>();
  // Fold both sides into one aggregate per (stage, date).
  const aggregates = new Map<string, StageDayAgg>();
  const aggFor = (
    stage: { stageId: number; campaignId: number; orgId: string },
    tid: string,
    statDate: string,
  ): StageDayAgg => {
    const key = `${stage.stageId}|${statDate}`;
    let agg = aggregates.get(key);
    if (!agg) {
      agg = {
        orgId: stage.orgId,
        campaignId: stage.campaignId,
        stageId: stage.stageId,
        tid,
        statDate,
        visitRaw: 0,
        visitClean: 0,
        redirectRaw: 0,
        redirectClean: 0,
        cost: 0,
      };
      aggregates.set(key, agg);
    }
    return agg;
  };

  // CLICKS — report/build rows, dated by the report `day` (= click day).
  for (const row of rows as KeitaroReportRow[]) {
    const tid = tidOf(row);
    const statDate = extractDate(row.day);
    const stage = tid ? stageMap.get(tid) : undefined;
    if (!stage || !statDate) {
      unmatched++;
      if (tid && unmatchedSamples.size < 10) unmatchedSamples.add(tid);
      continue;
    }
    matched++;
    applyRowToAggregate(aggFor(stage, tid, statDate), row, classifier.isVisitRow(row));
  }

  // Collect one VALUES tuple per (stage, date) aggregate, then flush in chunked,
  // batched INSERT … ON CONFLICT statements inside a single transaction — instead
  // of one round-trip per aggregate. The old per-row loop fired ~one DB round-trip
  // per (stage, day) — hundreds on a busy 3-day window — which, cross-region to the
  // Frankfurt DB, overran the function's maxDuration and dropped the tail (new
  // same-day stages never landed, so the report undercounted). Mirrors the batched
  // write in poll-conversions.ts; the SET references EXCLUDED since each row updates
  // to its own freshly-computed metrics. Column order below is load-bearing — it
  // must match the INSERT column list exactly.
  const rowVals: SQL[] = [...aggregates.values()].map((agg) => {
    // NOTE: `epc` is no longer written (it stored a THIRD EPC definition and
    // nothing read it). The column itself is already gone — migration 0127
    // dropped it.
    // NOTE: checkouts / sales / revenue / payout_at_conversion are no longer
    // written HERE either. They are the ledger's projection
    // (lib/keitaro/stage-day-conversions.ts). A brand-new row gets their column
    // defaults (0) and the projection fills them in the same tick.
    // Legacy raw_clicks/clean_clicks mirror the redirect totals so the pre-5b
    // column meaning (offer clicks) stays consistent for any back-compat reader.
    return sql`(${agg.orgId}::uuid, ${agg.campaignId}::integer, ${agg.stageId}::integer, ${agg.tid}::text, ${agg.statDate}::date, ${agg.visitRaw}::integer, ${agg.visitClean}::integer, ${agg.redirectRaw}::integer, ${agg.redirectClean}::integer, ${agg.redirectRaw}::integer, ${agg.redirectClean}::integer, ${toNumericString(agg.cost)}::numeric)`;
  });

  let upserted = 0;
  let errored = 0;
  if (rowVals.length > 0) {
    // 16 params/row ⇒ Postgres's 65535-param ceiling allows ~4095 rows/statement;
    // 500 leaves ample headroom and matches poll-conversions. One transaction so
    // the write is all-or-nothing even once multiple chunks engage (pooler-safe in
    // transaction mode). now() evaluates once per batch — a consistent sync stamp.
    const CHUNK = 500;
    try {
      await database.transaction(async (tx) => {
        for (let i = 0; i < rowVals.length; i += CHUNK) {
          const chunk = rowVals.slice(i, i + CHUNK);
          await tx.execute(sql`
            INSERT INTO keitaro_stage_results
              (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
               visit_clicks_raw, visit_clicks_clean, redirect_clicks_raw, redirect_clicks_clean,
               raw_clicks, clean_clicks, cost)
            VALUES ${sql.join(chunk, sql`, `)}
            ON CONFLICT (org_id, stage_id, stat_date) DO UPDATE SET
              stage_tracking_id     = EXCLUDED.stage_tracking_id,
              visit_clicks_raw      = EXCLUDED.visit_clicks_raw,
              visit_clicks_clean    = EXCLUDED.visit_clicks_clean,
              redirect_clicks_raw   = EXCLUDED.redirect_clicks_raw,
              redirect_clicks_clean = EXCLUDED.redirect_clicks_clean,
              raw_clicks            = EXCLUDED.raw_clicks,
              clean_clicks          = EXCLUDED.clean_clicks,
              cost                  = EXCLUDED.cost,
              synced_at             = now()
          `);
        }
      });
      upserted = rowVals.length;
    } catch {
      errored = rowVals.length;
    }
  }

  const syncStageIds = [...new Set([...aggregates.values()].map((a) => a.stageId))];
  try {
    await mirrorStageCountersFromResults(database, syncStageIds);
  } catch (err) {
    // Non-fatal HERE, and only here: `database` is the module-level pool, so a
    // failed mirror has poisoned nothing and the counters re-sync on the next
    // poll. The swallow lives at this call site rather than inside the mirror
    // because the other caller passes a TRANSACTION (the resync's --apply and
    // the DB tests) — swallowing there would leave a poisoned tx whose later
    // statements all fail with "current transaction is aborted".
    console.error("[keitaro/poll] stage counter mirror failed", err);
  }

  return {
    ok: true,
    degraded: false,
    range,
    fetched: rows.length,
    matched,
    upserted,
    unmatched,
    errored,
    stage_ids: syncStageIds,
    classification_degraded: classifier.degraded,
    visit_campaigns_matched: classifier.visitCampaignCount,
    unmatched_samples: [...unmatchedSamples],
    error: null,
  };
}

// Mirror the auto-owned stage counters from keitaro_stage_results:
//   Clickers        = landing-page visits (visit_clicks_clean)
//   Checkout Clicks = checkouts (Keitaro `leads`)
// summed across ALL stat_dates for each named stage. Only stages named here are
// overwritten — an untracked stage keeps whatever was entered manually or by CSV.
//
// SALES IS ADDITIVE, NOT OVERWRITTEN. `sales_count` holds the operator's MANUAL
// tally; the tracker count is added on top at read time, so this must never touch
// it. `sales_payout_each` is still snapshotted from the offer CPA when the tracker
// reports conversions, so Revenue/ROI can rate the combined count.
//
// Per-field guard: a counter is only overwritten when the tracker reports a
// POSITIVE value for that field, so a 0 leaves a manual/CSV value intact.
//
// ⚠️ EXCEPT `checkout_click_count` UNDER `exactCheckoutClicks` (review fix I2).
// The positive-only guard was right while every source was monotonic (Keitaro
// click sums only grow). `checkouts` is no longer one: it is the ledger
// projection's column (lib/keitaro/stage-day-conversions.ts), which DELIBERATELY
// zeroes a day the ledger no longer explains. Guarded, a correction downwards
// could never reach the stage counter, so the campaign page and the creatives
// metrics cache would keep a stale higher number forever. So the projection calls
// this with `exactCheckoutClicks: true` and that ONE field takes the recomputed
// sum even when it decreases, 0 included. `click_count` (Keitaro visits, still
// monotonic) and `sales_payout_each` (COALESCEd snapshot) keep the guard, and
// `sales_count` is never touched by either mode. Consequence, accepted: on a
// stage the projection has in scope, a hand-entered Checkout Clicks value is
// overwritten by the tracker's sum — the field is the projection's.
//
// FAILURE: this THROWS. The caller decides, because it knows whether `database`
// is the pool or a transaction — see the call in pollKeitaro (swallows) versus
// syncStageDayConversions (propagates, so the resync's --apply rolls back).
//
// Exported because the conversion columns are now written after the poll, by
// lib/keitaro/stage-day-conversions.ts, which re-mirrors its own scope.
export async function mirrorStageCountersFromResults(
  database: Database,
  stageIds: number[],
  opts: { exactCheckoutClicks?: boolean } = {},
): Promise<void> {
  if (stageIds.length === 0) return;
  const checkoutClicks: SQL = opts.exactCheckoutClicks
    ? sql`k.checkouts`
    : sql`CASE WHEN k.checkouts > 0 THEN k.checkouts ELSE cs.checkout_click_count END`;
  await database.execute(sql`
    UPDATE campaign_stages cs SET
      click_count = CASE WHEN k.clickers > 0 THEN k.clickers ELSE cs.click_count END,
      checkout_click_count = ${checkoutClicks},
      sales_payout_each = CASE
        WHEN k.sales > 0 THEN COALESCE(cs.sales_payout_each, o.payout_cpa)
        ELSE cs.sales_payout_each
      END
    FROM (
      SELECT stage_id,
             max(campaign_id) AS campaign_id,
             coalesce(sum(visit_clicks_clean), 0)::int AS clickers,
             coalesce(sum(checkouts), 0)::int          AS checkouts,
             coalesce(sum(sales), 0)::int              AS sales
      FROM keitaro_stage_results
      WHERE stage_id IN (${sql.join(
        stageIds.map((id) => sql`${id}::int`),
        sql`, `,
      )})
      GROUP BY stage_id
    ) k
    LEFT JOIN campaigns c ON c.id = k.campaign_id
    LEFT JOIN offers o    ON o.id = c.offer_id
    WHERE cs.id = k.stage_id
  `);
}
