import { inArray, sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { campaign_stages, campaigns, keitaro_stage_results } from "@/db/schema";
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
// multi-day window catches late sales attaching to earlier clicks. Re-reading
// stable older days is cheap and the UPSERT is idempotent.
const DEFAULT_WINDOW_DAYS = 3;

export interface KeitaroPollResult {
  ok: boolean;
  // false ⇒ the report fetch failed; rows were left untouched for next cycle.
  degraded: boolean;
  range: { from: string; to: string; timezone: string };
  fetched: number; // report rows returned by Keitaro
  matched: number; // rows whose sub_id_3 mapped to a CamMan stage
  upserted: number; // (stage, date) aggregates written
  unmatched: number; // rows skipped (no/blank/unknown sub_id_3)
  errored: number; // (stage, date) aggregates that threw during upsert
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
interface StageDayAgg {
  orgId: string;
  campaignId: number;
  stageId: number;
  tid: string;
  statDate: string;
  visitRaw: number;
  visitClean: number;
  redirectRaw: number;
  redirectClean: number;
  checkouts: number;
  sales: number;
  revenue: number;
  cost: number;
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
    classification_degraded: false,
    visit_campaigns_matched: 0,
    unmatched_samples: [],
    error: null,
  };

  const report = await buildKeitaroReport(range);
  if (!report.ok) {
    return { ...base, error: report.error };
  }

  // Classifier (visit vs redirect) and stage resolution can run independently.
  const rows = report.rows;
  const trackingIds = [
    ...new Set(
      rows
        .map((r) => (typeof r.sub_id_3 === "string" ? r.sub_id_3.trim() : ""))
        .filter((s) => s.length > 0),
    ),
  ];
  const [classifier, stageMap] = await Promise.all([
    buildVisitClassifier(),
    resolveStages(database, trackingIds),
  ]);

  let matched = 0;
  let unmatched = 0;
  const unmatchedSamples = new Set<string>();
  // Fold the per-campaign rows into one aggregate per (stage, date).
  const aggregates = new Map<string, StageDayAgg>();

  for (const row of rows as KeitaroReportRow[]) {
    const tid = typeof row.sub_id_3 === "string" ? row.sub_id_3.trim() : "";
    const statDate = extractDate(row.day);
    const stage = tid ? stageMap.get(tid) : undefined;

    if (!stage || !statDate) {
      unmatched++;
      if (tid && unmatchedSamples.size < 10) unmatchedSamples.add(tid);
      continue;
    }
    matched++;

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
        checkouts: 0,
        sales: 0,
        revenue: 0,
        cost: 0,
      };
      aggregates.set(key, agg);
    }

    const rawClicks = toInt(row.clicks);
    const cleanClicks = toInt(row.campaign_unique_clicks);

    if (classifier.isVisitRow(row)) {
      // Visit campaign: clicks are "Clickers". Conversions never attach here.
      agg.visitRaw += rawClicks;
      agg.visitClean += cleanClicks;
    } else {
      // Offer campaign: clicks are "Offer Redirect"; conversions are sales.
      agg.redirectRaw += rawClicks;
      agg.redirectClean += cleanClicks;
      agg.checkouts += toInt(row.leads);
      agg.sales += toInt(row.sales);
      agg.revenue += toNum(row.revenue);
      agg.cost += toNum(row.cost);
    }
  }

  let upserted = 0;
  let errored = 0;
  for (const agg of aggregates.values()) {
    // EPC is revenue per offer-redirect raw click (derived from the fold).
    const epc = agg.redirectRaw > 0 ? agg.revenue / agg.redirectRaw : 0;
    const values = {
      visit_clicks_raw: agg.visitRaw,
      visit_clicks_clean: agg.visitClean,
      redirect_clicks_raw: agg.redirectRaw,
      redirect_clicks_clean: agg.redirectClean,
      // Mirror redirect totals into the legacy columns so the pre-5b column
      // meaning (offer clicks) stays consistent for any back-compat reader.
      raw_clicks: agg.redirectRaw,
      clean_clicks: agg.redirectClean,
      checkouts: agg.checkouts,
      sales: agg.sales,
      revenue: toNumericString(agg.revenue),
      cost: toNumericString(agg.cost),
      epc: toNumericString(epc),
    };
    try {
      await database
        .insert(keitaro_stage_results)
        .values({
          org_id: agg.orgId,
          campaign_id: agg.campaignId,
          stage_id: agg.stageId,
          stage_tracking_id: agg.tid,
          stat_date: agg.statDate,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            keitaro_stage_results.org_id,
            keitaro_stage_results.stage_id,
            keitaro_stage_results.stat_date,
          ],
          set: {
            stage_tracking_id: agg.tid,
            ...values,
            synced_at: sql`now()`,
          },
        });
      upserted++;
    } catch {
      errored++;
    }
  }

  // Mirror the auto-owned stage counters from the freshly-upserted Keitaro rows:
  //   Clickers       = landing-page visits (visit_clicks_clean)
  //   Checkout Clicks = checkouts
  //   Sales          = sales
  // summed across ALL stat_dates for each stage touched this run. Only stages
  // that appear in Keitaro this cycle are overwritten — an untracked stage keeps
  // whatever was entered manually or via CSV. sales_payout_each is snapshotted
  // from the campaign's offer CPA the first time sales appear (COALESCE keeps an
  // existing snapshot) so revenue/ROI stay rateable, mirroring the manual-results
  // route. Best-effort: a failure here never invalidates the committed upserts;
  // the counters re-sync on the next poll.
  const syncStageIds = [
    ...new Set([...aggregates.values()].map((a) => a.stageId)),
  ];
  if (syncStageIds.length > 0) {
    try {
      await database.execute(sql`
        UPDATE campaign_stages cs SET
          click_count = k.clickers,
          checkout_click_count = k.checkouts,
          sales_count = k.sales,
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
          WHERE stage_id IN (${sql.join(syncStageIds, sql`, `)})
          GROUP BY stage_id
        ) k
        LEFT JOIN campaigns c ON c.id = k.campaign_id
        LEFT JOIN offers o    ON o.id = c.offer_id
        WHERE cs.id = k.stage_id
      `);
    } catch {
      // Non-fatal — the counters re-sync on the next poll.
    }
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
    classification_degraded: classifier.degraded,
    visit_campaigns_matched: classifier.visitCampaignCount,
    unmatched_samples: [...unmatchedSamples],
    error: null,
  };
}
