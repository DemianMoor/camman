import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";

import { db } from "@/db/client";
import {
  DIMENSION_NONE_KEY,
  denominatorFor,
  getCountedClickersByDimension,
  type ReportDimensionKey,
} from "@/lib/reporting/counted-clickers";
import type { ReportDimension } from "@/lib/reporting/report-dimensions";
import {
  getStageMetricsInRange,
  type StageMetrics,
} from "@/lib/reporting/stage-funnel";

// Read layer for the performance reports. All dimensions except "hourly" source
// from the SHARED per-stage funnel (lib/reporting/stage-funnel.ts) — the exact
// same numbers as the Overview tab — so By Number / By Offer / By Sequence match
// Overview to the cent, and By Group distributes those same stage totals across
// contact groups. "hourly" is different: it buckets by USER-ACTIVITY time from the
// internal per-event tables (clicks.clicked_at, stage_sends.converted_at /
// offer_reached_at, opt_out_attributions.created_at). See docs/04-features/reports-rollup.md.

export type { ReportDimension } from "@/lib/reporting/report-dimensions";

// Raw counters returned to the client; EPC / profit / percentages derived at read
// time in the UI with Overview's formulas (redirect_rate = redirects/clickers,
// sales_cr = sales/redirects, epc = revenue/redirects, opt_out_rate/CR = /sent).
export interface PerfMetrics {
  sent: number;
  opt_outs: number;
  clickers: number;
  redirects: number;
  // The EPC denominator — counted clickers (lib/reporting/counted-clickers.ts),
  // the same source every other surface divides by. `clickers` above is the
  // Keitaro landing-visit count and is display-only; `redirects` is no longer a
  // denominator anywhere.
  counted_clickers: number;
  // LIFETIME pair — ignores the date filter entirely, and is the PRIMARY figure.
  // Not derivable from the period pair: counted clickers are deduplicated and
  // therefore not additive over time, so a lifetime figure can never be summed
  // out of period slices. Both are carried so each EPC can be shown next to the
  // count it actually divided by — a $0.00 EPC is only interpretable when you
  // can see the denominator was 4.
  lifetime_clickers: number;
  lifetime_revenue: number;
  sales: number;
  revenue: number;
  cost: number;
}

export interface PerfRow extends PerfMetrics {
  key: string;
  label: string;
  // number dimension:
  phone_number?: string | null;
  number_type?: string | null;
  provider_name?: string | null;
  provider_color?: string | null;
  account_label?: string | null;
  // group dimension:
  group_color?: string | null;
  // hourly: a pinned "Manual" row sorts first.
  pinned?: boolean;
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
  totals: PerfMetrics;
  refreshedAt: string | null;
}

const ZERO: PerfMetrics = {
  sent: 0,
  opt_outs: 0,
  clickers: 0,
  redirects: 0,
  counted_clickers: 0,
  lifetime_clickers: 0,
  lifetime_revenue: 0,
  sales: 0,
  revenue: 0,
  cost: 0,
};

function stageMetrics(
  s: StageMetrics,
  countedByStage: Map<number, number>,
  lifetimeByStage: Map<number, number>,
  lifetimeRevenueByStage: Map<number, number>,
): PerfMetrics {
  return {
    sent: s.total_sent,
    opt_outs: s.opt_outs,
    clickers: s.tally.visit_clicks_clean,
    redirects: s.tally.redirect_clicks_clean,
    counted_clickers: denominatorFor(
      s.link_mode,
      countedByStage.get(s.stage_id),
      s.tally.visit_clicks_clean,
    ),
    lifetime_clickers: denominatorFor(
      s.link_mode,
      lifetimeByStage.get(s.stage_id),
      s.tally.visit_clicks_clean,
    ),
    lifetime_revenue: lifetimeRevenueByStage.get(s.stage_id) ?? 0,
    sales: s.tally.sales,
    revenue: s.tally.revenue,
    cost: s.tally.cost,
  };
}

function addMetrics(a: PerfMetrics, b: PerfMetrics): PerfMetrics {
  return {
    sent: a.sent + b.sent,
    opt_outs: a.opt_outs + b.opt_outs,
    clickers: a.clickers + b.clickers,
    redirects: a.redirects + b.redirects,
    counted_clickers: a.counted_clickers + b.counted_clickers,
    lifetime_clickers: a.lifetime_clickers + b.lifetime_clickers,
    lifetime_revenue: a.lifetime_revenue + b.lifetime_revenue,
    sales: a.sales + b.sales,
    revenue: a.revenue + b.revenue,
    cost: a.cost + b.cost,
  };
}
function scaleMetrics(m: PerfMetrics, f: number): PerfMetrics {
  return {
    sent: m.sent * f,
    opt_outs: m.opt_outs * f,
    clickers: m.clickers * f,
    redirects: m.redirects * f,
    counted_clickers: m.counted_clickers * f,
    lifetime_clickers: m.lifetime_clickers * f,
    lifetime_revenue: m.lifetime_revenue * f,
    sales: m.sales * f,
    revenue: m.revenue * f,
    cost: m.cost * f,
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// Build a parameterized IN-list from a JS number array (drizzle spreads a bare
// array, which ANY() rejects). Returns "$1, $2, ...".
function inList(ids: number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

interface Bounds {
  from: string; // ET day
  to: string; // ET day
  providerPhoneId: number | null;
}

export async function getPerformanceReport(
  orgId: string,
  dimension: ReportDimension,
  b: Bounds,
): Promise<PerformanceReport> {
  if (dimension === "hourly") return getHourlyReport(orgId, b);

  const { stages, clickers } = await getStageMetricsInRange(orgId, b.from, b.to);
  const countedByStage = clickers.periodByStage;
  const lifeByStage = clickers.lifetimeByStage;
  const lifeRevByStage = clickers.lifetimeRevenueByStage;
  const metricsOf = (s: StageMetrics) =>
    stageMetrics(s, countedByStage, lifeByStage, lifeRevByStage);
  const filtered =
    b.providerPhoneId != null
      ? stages.filter((s) => s.provider_phone_id === b.providerPhoneId)
      : stages;

  const totals = filtered.reduce((acc, s) => addMetrics(acc, metricsOf(s)), { ...ZERO });
  const refreshedAt = await maxSyncedAt(orgId);

  let rows: PerfRow[];
  if (dimension === "group") {
    // BY-GROUP IS EXEMPT from dimension-grain deduplication, by construction.
    // Its metrics are FRACTIONALLY SPLIT across a contact's groups (a contact in
    // 3 used groups contributes ⅓ to each), and a fractional share cannot be
    // deduplicated — there is no set to take a DISTINCT over. Its clicker counts
    // therefore remain split sums and are NOT comparable with the other tabs.
    // Labelled as such in the UI. See docs/04-features/epc-denominator.md.
    rows = await distributeToGroups(orgId, filtered, b, metricsOf);
  } else {
    rows = await groupByStageDimension(filtered, dimension, metricsOf);
    // Replace the summed clicker counts with DISTINCT counts at the dimension's
    // own grain — the row grain the rule refers to. Revenue stays summed; it is
    // genuinely additive.
    await applyDimensionDistinctClickers(orgId, dimension, b, rows, filtered);
  }
  return { dimension, rows, totals, refreshedAt };
}

// ---- number / offer / sequence: group the shared stage metrics -------------
async function groupByStageDimension(
  stages: StageMetrics[],
  dimension: "number" | "offer" | "sequence",
  metricsOf: (s: StageMetrics) => PerfMetrics,
): Promise<PerfRow[]> {
  const keyOf = (s: StageMetrics): string => {
    if (dimension === "number") return s.provider_phone_id == null ? "none" : String(s.provider_phone_id);
    if (dimension === "offer") return s.offer_id == null ? "none" : String(s.offer_id);
    return s.stage_number == null ? "none" : String(s.stage_number);
  };
  const acc = new Map<string, PerfMetrics>();
  for (const s of stages) {
    const k = keyOf(s);
    acc.set(k, addMetrics(acc.get(k) ?? { ...ZERO }, metricsOf(s)));
  }

  if (dimension === "number") {
    const ids = [...acc.keys()].filter((k) => k !== "none").map(Number);
    const info = await providerInfo(ids);
    return [...acc.entries()]
      .map(([k, m]) => {
        const pi = k === "none" ? null : info.get(Number(k));
        return {
          key: k,
          label: pi?.phone_number ?? "No number",
          phone_number: pi?.phone_number ?? null,
          number_type: pi?.number_type ?? null,
          provider_name: pi?.provider_name ?? null,
          provider_color: pi?.provider_color ?? null,
          account_label: pi?.account_label ?? null,
          ...m,
        };
      })
      .sort((a, b) => b.sent - a.sent);
  }
  if (dimension === "offer") {
    const ids = [...acc.keys()].filter((k) => k !== "none").map(Number);
    const info = await offerInfo(ids);
    return [...acc.entries()]
      .map(([k, m]) => {
        const oi = k === "none" ? null : info.get(Number(k));
        return {
          key: k,
          label: oi ? (oi.name ? `${oi.name} (${oi.code})` : oi.code) : "No offer",
          ...m,
        };
      })
      .sort((a, b) => b.sent - a.sent);
  }
  // sequence
  return [...acc.entries()]
    .map(([k, m]) => ({ key: k, label: k === "none" ? "—" : `Message ${k}`, ...m }))
    .sort((a, b) => (Number(a.key) || 0) - (Number(b.key) || 0));
}

// Overwrite the summed clicker counts on already-grouped rows with DISTINCT
// counts at the dimension's grain.
//
// MANUAL-MODE STAGES need care: they mint no links, so they have no
// counted_clickers rows and their denominator is Keitaro's clean landing-visit
// counter. Visits are an aggregate, not a set, so they cannot join a DISTINCT.
// The dimension total is therefore:
//     DISTINCT(tracked contacts in the dimension)  +  SUM(manual stages' visits)
// which is the exact aggregate form of the per-stage denominatorFor() rule.
async function applyDimensionDistinctClickers(
  orgId: string,
  dimension: "number" | "offer" | "sequence",
  b: Bounds,
  rows: PerfRow[],
  stages: StageMetrics[],
): Promise<void> {
  // Same ET-range → UTC conversion stage-funnel uses, so the period window here
  // is byte-identical to the one the funnel metrics were computed over.
  const fromUtc = fromZonedTime(`${b.from}T00:00:00`, CAMPAIGN_TIMEZONE);
  const nextDay = new Date(Date.parse(`${b.to}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const toExclusiveUtc = fromZonedTime(`${nextDay}T00:00:00`, CAMPAIGN_TIMEZONE);
  const [period, lifetime] = await Promise.all([
    getCountedClickersByDimension(db, orgId, dimension as ReportDimensionKey, {
      fromUtc,
      toExclusiveUtc,
    }),
    getCountedClickersByDimension(db, orgId, dimension as ReportDimensionKey),
  ]);

  // Manual-mode visit counts per dimension key, summed (they cannot be deduped).
  const manualVisits = new Map<string, number>();
  const keyOf = (s: StageMetrics): string => {
    if (dimension === "number") return s.provider_phone_id == null ? "none" : String(s.provider_phone_id);
    if (dimension === "offer") return s.offer_id == null ? "none" : String(s.offer_id);
    return s.stage_number == null ? "none" : String(s.stage_number);
  };
  for (const s of stages) {
    if (s.link_mode === "tracked") continue;
    const k = keyOf(s);
    manualVisits.set(k, (manualVisits.get(k) ?? 0) + s.tally.visit_clicks_clean);
  }

  for (const row of rows) {
    const dimKey = row.key === "none" ? DIMENSION_NONE_KEY : Number(row.key);
    const manual = manualVisits.get(row.key) ?? 0;
    row.counted_clickers = (period.get(dimKey) ?? 0) + manual;
    row.lifetime_clickers = (lifetime.get(dimKey) ?? 0) + manual;
  }
}

// ---- group: distribute each stage's totals across its used contact groups ---
// Tracked campaigns: per-metric weights from per-contact events (each event ⅟k
// across the contact's groups that were USED in the campaign audience). Manual
// campaigns: weights from each used group's audience-allocation count. Shares sum
// to 1 per stage, so per-metric group totals reconcile to the stage total (and
// thus to Overview). Values rounded to 2 decimals.
async function distributeToGroups(
  orgId: string,
  stages: StageMetrics[],
  b: Bounds,
  metricsOf: (s: StageMetrics) => PerfMetrics,
): Promise<PerfRow[]> {
  const trackedIds = stages.filter((s) => s.link_mode === "tracked").map((s) => s.stage_id);
  const manualStages = stages.filter((s) => s.link_mode !== "tracked");
  const manualCampaignIds = [...new Set(manualStages.map((s) => s.campaign_id))];

  // Per-(stage, group) weights for tracked stages, one map per metric basis.
  const [wSent, wClick, wSale, wOpt] = await Promise.all([
    trackedWeights(orgId, trackedIds, b, "sent"),
    trackedWeights(orgId, trackedIds, b, "click"),
    trackedWeights(orgId, trackedIds, b, "sale"),
    trackedWeights(orgId, trackedIds, b, "optout"),
  ]);
  // Per-(campaign, group) allocation weights for manual campaigns.
  const manualAlloc = await manualAllocationWeights(orgId, manualCampaignIds);
  // Campaign → used contact groups, for the last-resort equal split that
  // guarantees no metric is dropped (every campaign has ≥1 used group).
  const usedGroups = await usedGroupsByCampaign(orgId, [
    ...new Set(stages.map((s) => s.campaign_id)),
  ]);

  const byGroup = new Map<number, PerfMetrics>();
  const add = (gid: number, m: PerfMetrics) =>
    byGroup.set(gid, addMetrics(byGroup.get(gid) ?? { ...ZERO }, m));

  for (const s of stages) {
    const m = metricsOf(s);
    // Final fallback: equal split across the campaign's used groups.
    const equalW = new Map((usedGroups.get(s.campaign_id) ?? []).map((g) => [g, 1]));
    if (s.link_mode === "tracked") {
      // Each metric by its own per-contact weights → sent weights → equal split,
      // so a metric is never lost when its finer signal is missing for a stage.
      const sentW = nonEmpty(wSent.get(s.stage_id)) ?? equalW;
      spread(add, m.sent, sentW, "sent");
      spread(add, m.opt_outs, nonEmpty(wOpt.get(s.stage_id)) ?? sentW, "opt_outs");
      spread(add, m.clickers, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "clickers");
      // Counted clickers distribute on the CLICK weights — same basis as the
      // metric they denominate. The LIFETIME pair gets the same treatment on the
      // same bases (clickers on click weights, revenue on sale weights), so a
      // group's lifetime EPC is built from consistently-split parts rather than
      // mixing a split numerator with an unsplit denominator.
      spread(add, m.counted_clickers, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "counted_clickers");
      spread(add, m.lifetime_clickers, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "lifetime_clickers");
      spread(add, m.lifetime_revenue, nonEmpty(wSale.get(s.stage_id)) ?? sentW, "lifetime_revenue");
      spread(add, m.redirects, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "redirects");
      spread(add, m.sales, nonEmpty(wSale.get(s.stage_id)) ?? sentW, "sales");
      spread(add, m.revenue, nonEmpty(wSale.get(s.stage_id)) ?? sentW, "revenue");
      spread(add, m.cost, sentW, "cost");
    } else {
      const allocW = nonEmpty(manualAlloc.get(s.campaign_id)) ?? equalW;
      for (const [gid, frac] of shares(allocW)) add(gid, scaleMetrics(m, frac));
    }
  }

  const info = await groupInfo([...byGroup.keys()]);
  return [...byGroup.entries()]
    .map(([gid, m]) => ({
      key: String(gid),
      label: info.get(gid)?.name ?? "No group",
      group_color: info.get(gid)?.color ?? null,
      sent: round2(m.sent),
      opt_outs: round2(m.opt_outs),
      clickers: round2(m.clickers),
      redirects: round2(m.redirects),
      counted_clickers: round2(m.counted_clickers),
      lifetime_clickers: round2(m.lifetime_clickers),
      lifetime_revenue: round2(m.lifetime_revenue),
      sales: round2(m.sales),
      revenue: round2(m.revenue),
      cost: round2(m.cost),
    }))
    .sort((a, b) => b.sent - a.sent);
}

// Return the weight map only if it has entries, else undefined (so the caller's
// ?? fallback chain kicks in — keeps a metric from vanishing when its finer
// per-contact signal is missing for a stage).
function nonEmpty(w: Map<number, number> | undefined): Map<number, number> | undefined {
  return w && w.size > 0 ? w : undefined;
}

// Campaign → its used contact-group ids (campaigns.audience_contact_group_ids).
async function usedGroupsByCampaign(
  orgId: string,
  campaignIds: number[],
): Promise<Map<number, number[]>> {
  if (campaignIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT id, audience_contact_group_ids AS groups
    FROM campaigns WHERE org_id = ${orgId}::uuid AND id IN (${inList(campaignIds)})
  `)) as unknown as { id: number; groups: number[] | null }[];
  return new Map(rows.map((r) => [Number(r.id), (r.groups ?? []).map(Number)]));
}

// Distribute `total` across groups by the weight map's shares, adding to the acc.
function spread(
  add: (gid: number, m: PerfMetrics) => void,
  total: number,
  weights: Map<number, number>,
  field: keyof PerfMetrics,
) {
  if (total === 0) return;
  for (const [gid, frac] of shares(weights)) {
    add(gid, { ...ZERO, [field]: total * frac });
  }
}

// Normalize a weight map into fractional shares summing to 1.
function shares(weights: Map<number, number>): Map<number, number> {
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  const out = new Map<number, number>();
  if (sum <= 0) return out;
  for (const [gid, w] of weights) out.set(gid, w / sum);
  return out;
}

type WeightBasis = "sent" | "click" | "sale" | "optout";

// Per-(stage, group) weight = Σ over the stage's qualifying contacts of 1/k,
// where k = how many of the contact's groups were USED in the campaign audience.
async function trackedWeights(
  orgId: string,
  stageIds: number[],
  b: Bounds,
  basis: WeightBasis,
): Promise<Map<number, Map<number, number>>> {
  if (stageIds.length === 0) return new Map();
  // Candidate (stage, contact) set per basis.
  const candidate =
    basis === "sent"
      ? sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
          AND ss.stage_id IN (${inList(stageIds)})`
      : basis === "click"
        ? sql`
        SELECT DISTINCT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN clicks ck ON ck.link_id = ss.link_id
          AND ck.classification = 'human' AND ck.scored_at IS NOT NULL
        WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id IN (${inList(stageIds)})`
        : basis === "sale"
          ? sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.org_id = ${orgId}::uuid AND ss.converted_at IS NOT NULL
          AND ss.stage_id IN (${inList(stageIds)})`
          : sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN opt_out_attributions oa ON oa.stage_send_id = ss.id
        WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id IN (${inList(stageIds)})`;

  const rows = (await db.execute(sql`
    WITH cand AS (${candidate}),
    cgu AS (
      SELECT cand.stage_id, cand.contact_id, ccg.contact_group_id AS group_id
      FROM cand
      JOIN campaigns c ON c.id = cand.campaign_id
      JOIN contact_contact_groups ccg ON ccg.contact_id = cand.contact_id
        AND ccg.contact_group_id = ANY(c.audience_contact_group_ids)
    ),
    kc AS (
      SELECT stage_id, contact_id, count(*) AS k FROM cgu GROUP BY stage_id, contact_id
    )
    SELECT cgu.stage_id, cgu.group_id, sum(1.0 / kc.k)::float8 AS weight
    FROM cgu JOIN kc ON kc.stage_id = cgu.stage_id AND kc.contact_id = cgu.contact_id
    GROUP BY cgu.stage_id, cgu.group_id
  `)) as unknown as { stage_id: number; group_id: number; weight: number }[];

  const out = new Map<number, Map<number, number>>();
  for (const r of rows) {
    if (!out.has(r.stage_id)) out.set(r.stage_id, new Map());
    out.get(r.stage_id)!.set(Number(r.group_id), Number(r.weight));
  }
  return out;
}

// Per-(campaign, group) allocation weight = # of the campaign's frozen audience
// contacts in each used group (a shared contact counts in each of its groups).
async function manualAllocationWeights(
  orgId: string,
  campaignIds: number[],
): Promise<Map<number, Map<number, number>>> {
  if (campaignIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT cap.campaign_id, ccg.contact_group_id AS group_id, count(*)::int AS weight
    FROM campaign_audience_pool cap
    JOIN campaigns c ON c.id = cap.campaign_id
    JOIN contact_contact_groups ccg ON ccg.contact_id = cap.contact_id
      AND ccg.contact_group_id = ANY(c.audience_contact_group_ids)
    WHERE cap.org_id = ${orgId}::uuid AND cap.campaign_id IN (${inList(campaignIds)})
    GROUP BY cap.campaign_id, ccg.contact_group_id
  `)) as unknown as { campaign_id: number; group_id: number; weight: number }[];
  const out = new Map<number, Map<number, number>>();
  for (const r of rows) {
    if (!out.has(r.campaign_id)) out.set(r.campaign_id, new Map());
    out.get(r.campaign_id)!.set(Number(r.group_id), Number(r.weight));
  }
  return out;
}

// ---- hourly: user-activity time from internal per-event tables --------------
async function getHourlyReport(orgId: string, b: Bounds): Promise<PerformanceReport> {
  const provFilter = b.providerPhoneId != null;
  // Tracked events across the ET date range, bucketed by the EVENT's ET hour-of-day (summed over all days in the range). The
  // provider filter (if set) restricts to sends from that number (via the stage).
  const provJoin = provFilter
    ? sql`JOIN campaign_stages cs ON cs.id = ss.stage_id AND cs.provider_phone_id = ${b.providerPhoneId}`
    : sql``;
  const rangeStart = sql`(${b.from} || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'`;
  const rangeEnd = sql`((${b.to}::date + 1) || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'`;
  const hourExpr = (col: string) =>
    sql`EXTRACT(HOUR FROM ${sql.raw(col)} AT TIME ZONE 'America/New_York')::int`;

  const eventAgg = async (
    tsCol: string,
    join: ReturnType<typeof sql>,
    where: ReturnType<typeof sql>,
    valueExpr: ReturnType<typeof sql>,
  ) =>
    (await db.execute(sql`
      SELECT ${hourExpr(tsCol)} AS hour, ${valueExpr} AS v
      FROM stage_sends ss ${join}
      WHERE ss.org_id = ${orgId}::uuid
        AND ${sql.raw(tsCol)} >= ${rangeStart} AND ${sql.raw(tsCol)} < ${rangeEnd}
        AND ${where}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[];

  const [sentRows, clicks, redirects, sales, revenue, optouts] = await Promise.all([
    // Sent messages by SEND hour (tracked stage_sends; manual-campaign sends have
    // no per-message time and roll up into the Manual row). This is the one column
    // bucketed by send time, not activity time — it's the denominator for the rates.
    (await db.execute(sql`
      SELECT ${hourExpr("ss.sent_at")} AS hour, count(*)::int AS v
      FROM stage_sends ss ${provJoin}
      WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
        AND ss.sent_at >= ${rangeStart} AND ss.sent_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
    // clean internal clicks by click time
    (await db.execute(sql`
      SELECT ${hourExpr("ck.clicked_at")} AS hour, count(*)::int AS v
      FROM clicks ck
      JOIN stage_sends ss ON ss.link_id = ck.link_id ${provJoin}
      WHERE ck.org_id = ${orgId}::uuid
        AND ck.classification = 'human' AND ck.scored_at IS NOT NULL
        AND ck.clicked_at >= ${rangeStart} AND ck.clicked_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
    eventAgg("ss.offer_reached_at", provJoin, sql`ss.offer_reached_at IS NOT NULL`, sql`count(*)::int`),
    eventAgg("ss.converted_at", provJoin, sql`ss.converted_at IS NOT NULL`, sql`count(*)::int`),
    eventAgg("ss.converted_at", provJoin, sql`ss.converted_at IS NOT NULL`, sql`coalesce(sum(ss.sale_revenue),0)::float8`),
    // opt-outs by receipt time, for TRACKED stages
    (await db.execute(sql`
      SELECT ${hourExpr("oa.created_at")} AS hour, count(*)::int AS v
      FROM opt_out_attributions oa
      JOIN stage_sends ss ON ss.id = oa.stage_send_id ${provJoin}
      JOIN campaign_stages cs2 ON cs2.id = ss.stage_id
      JOIN campaigns c ON c.id = cs2.campaign_id AND c.link_mode = 'tracked'
      WHERE oa.org_id = ${orgId}::uuid
        AND oa.created_at >= ${rangeStart} AND oa.created_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
  ]);

  const hours = new Map<number, PerfMetrics>();
  const bump = (h: number, field: keyof PerfMetrics, v: number) => {
    if (!hours.has(h)) hours.set(h, { ...ZERO });
    (hours.get(h)![field] as number) += v;
  };
  for (const r of sentRows) bump(r.hour, "sent", Number(r.v));
  for (const r of clicks) bump(r.hour, "clickers", Number(r.v));
  for (const r of redirects) bump(r.hour, "redirects", Number(r.v));
  for (const r of sales) bump(r.hour, "sales", Number(r.v));
  for (const r of revenue) bump(r.hour, "revenue", Number(r.v));
  for (const r of optouts) bump(r.hour, "opt_outs", Number(r.v));

  const rows: PerfRow[] = [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, m]) => ({ key: String(h), label: formatEtHour(h), ...m }));

  // Manual row (pinned first): all results from MANUAL campaigns mapped to the
  // range — manual sales by ledger entry date, plus manual-campaign opt-outs.
  const manual = await manualRangeRow(orgId, b);
  if (manual.sent > 0 || manual.sales > 0 || manual.opt_outs > 0 || manual.revenue > 0) {
    rows.unshift({ key: "manual", label: "Manual", pinned: true, ...manual });
  }

  const totals = rows.reduce((acc, r) => addMetrics(acc, r), { ...ZERO });
  return { dimension: "hourly", rows, totals, refreshedAt: await maxSyncedAt(orgId) };
}

async function manualRangeRow(orgId: string, b: Bounds): Promise<PerfMetrics> {
  const rangeStart = sql`(${b.from} || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'`;
  const rangeEnd = sql`((${b.to}::date + 1) || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'`;
  const rows = (await db.execute(sql`
    SELECT
      coalesce((
        SELECT sum(sms.delta)::int FROM stage_manual_sales sms
        JOIN campaign_stages cs ON cs.id = sms.stage_id
        JOIN campaigns c ON c.id = cs.campaign_id AND c.link_mode = 'manual'
        WHERE sms.org_id = ${orgId}::uuid
          AND sms.created_at >= ${rangeStart} AND sms.created_at < ${rangeEnd}
      ), 0) AS sales,
      coalesce((
        SELECT count(*)::int FROM opt_out_attributions oa
        JOIN campaign_stages cs ON cs.id = oa.stage_id
        JOIN campaigns c ON c.id = cs.campaign_id AND c.link_mode = 'manual'
        WHERE oa.org_id = ${orgId}::uuid
          AND oa.created_at >= ${rangeStart} AND oa.created_at < ${rangeEnd}
      ), 0) AS opt_outs,
      coalesce((
        SELECT sum(cs.sms_count)::int FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id AND c.link_mode = 'manual'
        WHERE cs.org_id = ${orgId}::uuid AND cs.archived_at IS NULL
          AND cs.sent_at >= ${rangeStart} AND cs.sent_at < ${rangeEnd}
      ), 0) AS sent
  `)) as unknown as { sales: number; opt_outs: number; sent: number }[];
  const r = rows[0] ?? { sales: 0, opt_outs: 0, sent: 0 };
  return {
    ...ZERO,
    sent: Number(r.sent) || 0,
    sales: Number(r.sales) || 0,
    opt_outs: Number(r.opt_outs) || 0,
  };
}

// ---- label + freshness helpers ---------------------------------------------
async function providerInfo(ids: number[]) {
  const out = new Map<
    number,
    { phone_number: string | null; number_type: string | null; provider_name: string | null; provider_color: string | null; account_label: string | null }
  >();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT pp.id, pp.phone_number, pp.number_type, sp.name AS provider_name,
           sp.color AS provider_color, pc.label AS account_label
    FROM provider_phones pp
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    LEFT JOIN provider_credentials pc ON pc.id = pp.credential_id
    WHERE pp.id IN (${inList(ids)})
  `)) as unknown as Record<string, unknown>[];
  for (const r of rows) {
    out.set(Number(r.id), {
      phone_number: (r.phone_number as string) ?? null,
      number_type: (r.number_type as string) ?? null,
      provider_name: (r.provider_name as string) ?? null,
      provider_color: (r.provider_color as string) ?? null,
      account_label: (r.account_label as string) ?? null,
    });
  }
  return out;
}

async function offerInfo(ids: number[]) {
  const out = new Map<number, { code: string; name: string | null }>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, offer_id AS code, name FROM offers WHERE id IN (${inList(ids)})
  `)) as unknown as { id: number; code: string; name: string | null }[];
  for (const r of rows) out.set(Number(r.id), { code: r.code, name: r.name });
  return out;
}

async function groupInfo(ids: number[]) {
  const out = new Map<number, { name: string; color: string | null }>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, name, color FROM contact_groups WHERE id IN (${inList(ids)})
  `)) as unknown as { id: number; name: string; color: string | null }[];
  for (const r of rows) out.set(Number(r.id), { name: r.name, color: r.color });
  return out;
}

async function maxSyncedAt(orgId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT max(synced_at) AS t FROM keitaro_stage_results WHERE org_id = ${orgId}::uuid
  `)) as unknown as { t: string | null }[];
  return rows[0]?.t ?? null;
}

export async function getReportProviderOptions(orgId: string): Promise<ProviderOption[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT cs.provider_phone_id,
      pp.phone_number, pp.number_type,
      sp.name AS provider_name, sp.color AS provider_color, pc.label AS account_label
    FROM campaign_stages cs
    LEFT JOIN provider_phones pp ON pp.id = cs.provider_phone_id
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    LEFT JOIN provider_credentials pc ON pc.id = pp.credential_id
    WHERE cs.org_id = ${orgId}::uuid AND cs.provider_phone_id IS NOT NULL
    ORDER BY pp.phone_number
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    provider_phone_id: Number(r.provider_phone_id),
    phone_number: (r.phone_number as string) ?? null,
    number_type: (r.number_type as string) ?? null,
    provider_name: (r.provider_name as string) ?? null,
    provider_color: (r.provider_color as string) ?? null,
    account_label: (r.account_label as string) ?? null,
  }));
}

function formatEtHour(h: number): string {
  if (!Number.isFinite(h)) return "—";
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period} ET`;
}
