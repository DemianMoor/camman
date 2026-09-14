# Operator API Pools — PR 2 Implementation Plan (creative dimension)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/reports/performance?dimension=creative` — one row per creative × offer with every performance column plus `first_sent_date`, `last_sent_date`, `distinct_send_days` and `rpm`, over a from/to range or `range=lifetime` (hourly snapshot), with `offer_id`, `min_sent` and `sortBy`.

**Architecture:** The shared per-stage funnel gains `creative_id`; the performance report groups stages by `creative_id:offer_id` and dedupes human clickers at that grain. Stage metrics are computed once per request even when several groupings are needed (the lifetime job builds creative rows and per-offer totals from one pass). `range=lifetime` reads `operator_rollups` key `performance_creative_lifetime`, refreshed hourly. Sorting, `min_sent` and RPM are pure helpers.

**Tech Stack:** Next.js 16 route handlers · Drizzle · Supabase Postgres · Vercel Cron · tsx scripts.

Spec: [../specs/2026-09-14-operator-api-pools-creative-design.md](../specs/2026-09-14-operator-api-pools-creative-design.md) §3, §4, §5.

## Global Constraints

- Read-only, aggregate-only; every query filters `org_id`.
- API-only: `creative` is NOT added to `REPORT_DIMENSIONS` (that list drives the Reports tabs).
- Row key `"{creative_id}:{offer_id}"` with `-1` for a missing id; creative = `campaign_stages.creative_id` (the stage's, not the link's); offer = `campaigns.offer_id`; label `"{slug} — {offer name, else code}"`.
- `counted_clickers` / `lifetime_clickers` on a row = distinct contacts at creative × offer grain + manual-mode visits.
- Send-day fields over the row's stages whose `sent_at` falls in the range (lifetime: all), ET days.
- `rpm` = `revenue / sent × 1000`, 2 decimals, `null` when `sent = 0`; on rows and totals.
- `range`, `offer_id`, `min_sent`, `sortBy` → 400 on any other dimension. `range` accepts only `lifetime`; lifetime + `from`/`to`/`provider_phone_id` → 400; `offer_id` + `provider_phone_id` → 400.
- `min_sent` hides rows only (totals unchanged) and reports `hidden_rows`. `sortBy` ∈ `revenue` (default), `rpm`, `sent`, `click_to_reach_pct`; descending, nulls last, ties by `sent` desc then `key`.
- `offer_id` filters stages; totals then equal the `dimension=offer` row for that offer.
- Lifetime: hourly cron `14 * * * *`, `withCronLease` 6 min, `maxDuration = 300`; response adds `computed_at`, `stale_seconds`, `range: { lifetime: true, from, to, timezone }`; `503 rollup_not_ready` before the first run. `refreshedAt` keeps meaning "latest tracker sync" (as of the snapshot).
- Never interpolate a JS array into a `sql` template.

## File map

| File | Change |
|---|---|
| `lib/reporting/report-dimensions.ts` | `API_ONLY_DIMENSIONS`, `PerformanceDimension`, `isPerformanceDimension`, `CREATIVE_SORT_KEYS`, `isCreativeSortKey` |
| `lib/reporting/creative-rows.ts` | **Create.** Pure `rpmOf`, `sortCreativeRows`, `hideBelowMinSent`, `sendDaysOf` |
| `lib/reporting/stage-funnel.ts` | `StageMetrics.creative_id` in both selects and both builders |
| `lib/reporting/counted-clickers.ts` | `getCountedClickersByCreativeOffer()` |
| `lib/reporting/performance-report.ts` | `Bounds.offerId`; `getStageDimensionReports()`; creative grouping; offer-scoped totals; export `ZERO` |
| `lib/reporting/creative-lifetime.ts` | **Create.** `computeCreativeLifetime`, `refreshCreativeLifetime`, `readCreativeLifetime` |
| `app/api/reports/performance/route.ts` | creative params, lifetime branch |
| `app/api/cron/refresh-creative-lifetime/route.ts` | **Create.** |
| `vercel.json`, `lib/authz/route-map.ts` | cron entry; `"cron/refresh-creative-lifetime": null` |
| `scripts/test-creative-rows.ts` | **Create.** pure checks |
| `scripts/verify-creative-report.ts` | **Create.** lib vs independent SQL (prod, read-only) |
| `scripts/verify-operator-grading-http.ts` | section 12 |
| docs | operator-api.md (§3 creative, §7 `rpm`), 04-features/reports-rollup.md, 04-features/crons.md, 04-features/operator-api-tokens.md (276 routes), CHANGELOG.md |

---

### Task 1: Pure helpers + dimension constants

**Files:** Create `lib/reporting/creative-rows.ts`, `scripts/test-creative-rows.ts`; modify `lib/reporting/report-dimensions.ts`.

**Interfaces — Produces:**
- `rpmOf(revenue: number, sent: number): number | null`
- `sortCreativeRows<T extends CreativeSortable>(rows: T[], sortBy: CreativeSortKey): T[]`
- `hideBelowMinSent<T extends { sent: number }>(rows: T[], minSent: number): { rows: T[]; hidden: number }`
- `sendDaysOf(days: string[]): SendDays`
- `isPerformanceDimension(v): v is PerformanceDimension`, `isCreativeSortKey(v): v is CreativeSortKey`

- [ ] **Step 1: `scripts/test-creative-rows.ts`** (fails first: module missing)

```ts
// Pure checks for lib/reporting/creative-rows.ts. No database.
// Run: npx tsx scripts/test-creative-rows.ts
import { hideBelowMinSent, rpmOf, sendDaysOf, sortCreativeRows } from "../lib/reporting/creative-rows";
import { isCreativeSortKey, isPerformanceDimension, REPORT_DIMENSIONS } from "../lib/reporting/report-dimensions";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

check("rpm = revenue / sent × 1000, 2 decimals", rpmOf(250, 3000) === 83.33, rpmOf(250, 3000));
check("rpm is null at 0 sent", rpmOf(10, 0) === null);

const rows = [
  { key: "1:10", sent: 1000, revenue: 50, rpm: 50, click_to_reach_pct: null },
  { key: "2:10", sent: 4000, revenue: 50, rpm: 12.5, click_to_reach_pct: 3.1 },
  { key: "3:11", sent: 2000, revenue: 90, rpm: 45, click_to_reach_pct: 9.9 },
  { key: "4:11", sent: 0, revenue: 0, rpm: null, click_to_reach_pct: null },
];
check("revenue desc, ties by sent desc", sortCreativeRows(rows, "revenue").map((r) => r.key).join() === "3:11,2:10,1:10,4:11");
check("rpm desc, nulls last", sortCreativeRows(rows, "rpm").map((r) => r.key).join() === "1:10,3:11,2:10,4:11");
check("click_to_reach_pct desc, nulls last, null ties by sent", sortCreativeRows(rows, "click_to_reach_pct").map((r) => r.key).join() === "3:11,2:10,1:10,4:11");
check("sent desc", sortCreativeRows(rows, "sent").map((r) => r.key).join() === "2:10,3:11,1:10,4:11");
check("sorting does not mutate the input", rows[0].key === "1:10");

const hidden = hideBelowMinSent(rows, 1500);
check("min_sent keeps rows with sent >= threshold", hidden.rows.map((r) => r.key).join() === "2:10,3:11");
check("min_sent counts the hidden rows", hidden.hidden === 2);
check("min_sent 0 hides nothing", hideBelowMinSent(rows, 0).hidden === 0);

check("send days: first, last, distinct", JSON.stringify(sendDaysOf(["2026-09-03", "2026-09-01", "2026-09-03"])) === JSON.stringify({ first_sent_date: "2026-09-01", last_sent_date: "2026-09-03", distinct_send_days: 2 }));
check("send days: none", JSON.stringify(sendDaysOf([])) === JSON.stringify({ first_sent_date: null, last_sent_date: null, distinct_send_days: 0 }));

check("creative is a performance dimension", isPerformanceDimension("creative"));
check("creative is NOT a Reports tab", !(REPORT_DIMENSIONS as readonly string[]).includes("creative"));
check("existing dimensions stay accepted", isPerformanceDimension("offer") && isPerformanceDimension("hourly"));
check("unknown dimension rejected", !isPerformanceDimension("brand"));
check("sort keys", isCreativeSortKey("rpm") && !isCreativeSortKey("profit"));

console.log(failures === 0 ? "\ntest-creative-rows OK." : `\nFAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run** `npx tsx scripts/test-creative-rows.ts` → FAIL (module not found).

- [ ] **Step 3: `lib/reporting/creative-rows.ts`**

```ts
// Pure helpers for the creative dimension of GET /api/reports/performance: RPM,
// server-side sorting, the min_sent hide and the send-day fields. No server
// imports, so scripts/test-creative-rows.ts runs without a database.
import type { CreativeSortKey } from "./report-dimensions";

export interface CreativeSortable {
  key: string;
  sent: number;
  revenue: number;
  rpm: number | null;
  click_to_reach_pct: number | null;
}

export interface SendDays {
  first_sent_date: string | null;
  last_sent_date: string | null;
  distinct_send_days: number;
}

/** Revenue per 1,000 messages sent, 2 decimals; null when nothing was sent. */
export function rpmOf(revenue: number, sent: number): number | null {
  return sent > 0 ? Math.round((revenue / sent) * 100_000) / 100 : null;
}

/** Descending by `sortBy`, nulls last, ties by sent desc then key. Returns a copy. */
export function sortCreativeRows<T extends CreativeSortable>(rows: T[], sortBy: CreativeSortKey): T[] {
  return [...rows].sort((a, b) => {
    const va = a[sortBy];
    const vb = b[sortBy];
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return vb - va;
    return b.sent - a.sent || a.key.localeCompare(b.key);
  });
}

/** Rows below the threshold are hidden, and counted so the caller can see it. */
export function hideBelowMinSent<T extends { sent: number }>(
  rows: T[],
  minSent: number,
): { rows: T[]; hidden: number } {
  const kept = rows.filter((r) => r.sent >= minSent);
  return { rows: kept, hidden: rows.length - kept.length };
}

/** First / last ET send day and the number of distinct days, from YYYY-MM-DD strings. */
export function sendDaysOf(days: string[]): SendDays {
  if (days.length === 0) return { first_sent_date: null, last_sent_date: null, distinct_send_days: 0 };
  const unique = [...new Set(days)].sort();
  return {
    first_sent_date: unique[0],
    last_sent_date: unique[unique.length - 1],
    distinct_send_days: unique.length,
  };
}
```

- [ ] **Step 4: `lib/reporting/report-dimensions.ts`** — append after `isReportDimension`:

```ts
// Dimensions the operator API accepts that have NO Reports tab — the tab bar and
// the /reports/[dimension] page map REPORT_DIMENSIONS, so these stay out of it.
// `creative` = one row per creative × offer.
export const API_ONLY_DIMENSIONS = ["creative"] as const;
export type ApiOnlyDimension = (typeof API_ONLY_DIMENSIONS)[number];
export type PerformanceDimension = ReportDimension | ApiOnlyDimension;

export function isPerformanceDimension(v: string | null | undefined): v is PerformanceDimension {
  return isReportDimension(v) || (v != null && (API_ONLY_DIMENSIONS as readonly string[]).includes(v));
}

// Server-side sort keys for dimension=creative (always descending).
export const CREATIVE_SORT_KEYS = ["revenue", "rpm", "sent", "click_to_reach_pct"] as const;
export type CreativeSortKey = (typeof CREATIVE_SORT_KEYS)[number];

export function isCreativeSortKey(v: string | null | undefined): v is CreativeSortKey {
  return v != null && (CREATIVE_SORT_KEYS as readonly string[]).includes(v);
}
```

- [ ] **Step 5: Run** the test → `test-creative-rows OK.` (17 checks). **Commit.**

### Task 2: Creative grouping in the shared report

**Files:** modify `lib/reporting/stage-funnel.ts`, `lib/reporting/counted-clickers.ts`, `lib/reporting/performance-report.ts`.

**Interfaces:**
- Consumes: `sendDaysOf`, `PerformanceDimension` (Task 1).
- Produces:
  - `StageMetrics.creative_id: number | null`
  - `getCountedClickersByCreativeOffer(dbc: DbOrTx, orgId: string, b?: CountedClickerBounds): Promise<Map<string, number>>` keyed `"creative:offer"`
  - `Bounds.offerId?: number | null`
  - `getStageDimensionReports(orgId: string, dimensions: StageDimension[], b: Bounds): Promise<PerformanceReport[]>` where `StageDimension = Exclude<PerformanceDimension, "hourly">`
  - `getPerformanceReport(orgId: string, dimension: PerformanceDimension, b: Bounds): Promise<PerformanceReport>`
  - `PerfRow` optional `creative_id`, `offer_id`, `first_sent_date`, `last_sent_date`, `distinct_send_days`
  - `export const ZERO: PerfMetrics`

- [ ] **Step 1: stage-funnel** — in `StageMetrics` after `offer_id: number | null;` add

```ts
  // The stage's creative (campaign_stages.creative_id) — the creative dimension's key.
  creative_id: number | null;
```

In both `.select({...})` blocks add `creative_id: campaign_stages.creative_id,` after `offer_id: campaigns.offer_id,`; in both builders add `creative_id: r.creative_id ?? null,` after `offer_id: r.offer_id ?? null,`.

- [ ] **Step 2: counted-clickers** — after `getCountedClickersByDimension` add

```ts
// Distinct counted clickers per creative × offer, keyed "creative_id:offer_id"
// (-1 for a missing id). The creative is the STAGE's (campaign_stages.creative_id),
// the key the creative dimension groups stages by — not counted_clickers.creative_id,
// which is the link's creative at mint time and can differ after an edit.
export async function getCountedClickersByCreativeOffer(
  dbc: DbOrTx,
  orgId: string,
  b: CountedClickerBounds = {},
): Promise<Map<string, number>> {
  const dateFilter =
    b.fromUtc && b.toExclusiveUtc
      ? sql`AND cc.first_click_at >= ${b.fromUtc.toISOString()}::timestamptz AND cc.first_click_at < ${b.toExclusiveUtc.toISOString()}::timestamptz`
      : sql``;
  const rows = (await dbc.execute(sql`
    SELECT coalesce(cs.creative_id, ${DIMENSION_NONE_KEY}) AS creative_id,
           coalesce(ca.offer_id, ${DIMENSION_NONE_KEY}) AS offer_id,
           count(DISTINCT cc.contact_id)::int AS n
    FROM counted_clickers cc
    JOIN campaign_stages cs ON cs.id = cc.stage_id
    JOIN campaigns ca ON ca.id = cc.campaign_id
    WHERE cc.org_id = ${orgId}::uuid ${dateFilter} ${stageIdFilter(b, "cc.stage_id")}
    GROUP BY 1, 2
  `)) as unknown as { creative_id: number; offer_id: number; n: number }[];
  return new Map(rows.map((r) => [`${Number(r.creative_id)}:${Number(r.offer_id)}`, Number(r.n)]));
}
```

- [ ] **Step 3: performance-report** —
  - imports: add `getCountedClickersByCreativeOffer`; `import { formatInCampaignTimezone } from "@/lib/campaign-timezone"` (alongside `CAMPAIGN_TIMEZONE`); `import { sendDaysOf } from "@/lib/reporting/creative-rows"`; `PerformanceDimension` instead of `ReportDimension` in the type import.
  - `PerfRow` add `// creative dimension:` `creative_id?: number | null; offer_id?: number | null; first_sent_date?: string | null; last_sent_date?: string | null; distinct_send_days?: number;`
  - `PerformanceReport.dimension: PerformanceDimension`; `const ZERO` → `export const ZERO`.
  - `Bounds` add `// Only this offer's stages (dimension=creative).` `offerId?: number | null;`
  - replace `getPerformanceReport` with:

```ts
export type StageDimension = Exclude<PerformanceDimension, "hourly">;

export async function getPerformanceReport(
  orgId: string,
  dimension: PerformanceDimension,
  b: Bounds,
): Promise<PerformanceReport> {
  if (dimension === "hourly") return getHourlyReport(orgId, b);
  const [report] = await getStageDimensionReports(orgId, [dimension], b);
  return report;
}

// Several groupings of ONE stage-metrics pass — the funnel is the expensive part
// (~13s for all time), so the lifetime job builds creative rows and per-offer
// totals from a single pass instead of two.
export async function getStageDimensionReports(
  orgId: string,
  dimensions: StageDimension[],
  b: Bounds,
): Promise<PerformanceReport[]> {
  const { stages, clickers } = await getStageMetricsInRange(orgId, b.from, b.to, {
    attribution: b.attribution,
  });
  const countedByStage = clickers.periodByStage;
  const lifeByStage = clickers.lifetimeByStage;
  const lifeRevByStage = clickers.lifetimeRevenueByStage;
  const metricsOf = (s: StageMetrics) =>
    stageMetrics(s, countedByStage, lifeByStage, lifeRevByStage);
  const filtered = stages.filter(
    (s) =>
      (b.providerPhoneId == null || s.provider_phone_id === b.providerPhoneId) &&
      (b.offerId == null || s.offer_id === b.offerId),
  );

  const totals = filtered.reduce((acc, s) => addMetrics(acc, metricsOf(s)), { ...ZERO });
  await dedupeTotalClickers(orgId, b, filtered, totals, clickers);
  const refreshedAt = await maxSyncedAt(orgId);

  return Promise.all(
    dimensions.map(async (dimension): Promise<PerformanceReport> => {
      let rows: PerfRow[];
      if (dimension === "group") {
        // BY-GROUP IS EXEMPT from dimension-grain deduplication, by construction.
        // Its metrics are FRACTIONALLY SPLIT across a contact's groups (a contact in
        // 3 used groups contributes ⅓ to each), and a fractional share cannot be
        // deduplicated — there is no set to take a DISTINCT over. Its clicker counts
        // therefore remain split sums and are NOT comparable with the other tabs.
        // Labelled as such in the UI. See docs/04-features/epc-denominator.md.
        rows = await distributeToGroups(orgId, filtered, b, metricsOf);
      } else if (dimension === "creative") {
        rows = await groupByCreativeOffer(orgId, filtered, b, metricsOf);
      } else {
        rows = await groupByStageDimension(filtered, dimension, metricsOf);
        // Replace the summed clicker counts with DISTINCT counts at the dimension's
        // own grain — the row grain the rule refers to. Revenue stays summed; it is
        // genuinely additive.
        await applyDimensionDistinctClickers(orgId, dimension, b, rows, filtered);
      }
      return { dimension, rows, totals, refreshedAt };
    }),
  );
}
```

  - in `dedupeTotalClickers`, after the `manualVisits` line add:

```ts
  if (b.offerId != null) {
    // One offer's totals = that offer's row in dimension=offer: distinct clickers
    // at the offer grain, over the same period scope.
    const [period, lifetime] = await Promise.all([
      getCountedClickersByDimension(db, orgId, "offer", periodBounds(b, stages)),
      getCountedClickersByDimension(db, orgId, "offer"),
    ]);
    totals.counted_clickers = (period.get(b.offerId) ?? 0) + manualVisits;
    totals.lifetime_clickers = (lifetime.get(b.offerId) ?? 0) + manualVisits;
    return;
  }
```

  - after `applyDimensionDistinctClickers` add:

```ts
// ---- creative: one row per creative × offer --------------------------------
// Additive metrics summed over the row's stages; clickers DISTINCT at creative ×
// offer grain plus manual-mode visits (the denominatorFor rule, aggregated). The
// send-day fields cover the row's stages SENT inside the range — for lifetime the
// range starts at the first send, so that is every stage.
async function groupByCreativeOffer(
  orgId: string,
  stages: StageMetrics[],
  b: Bounds,
  metricsOf: (s: StageMetrics) => PerfMetrics,
): Promise<PerfRow[]> {
  const { fromUtc, toExclusiveUtc } = etRangeUtc(b);
  const acc = new Map<
    string,
    { m: PerfMetrics; creativeId: number | null; offerId: number | null; days: string[]; manualVisits: number }
  >();
  for (const s of stages) {
    const key = `${s.creative_id ?? DIMENSION_NONE_KEY}:${s.offer_id ?? DIMENSION_NONE_KEY}`;
    const e = acc.get(key) ?? {
      m: { ...ZERO },
      creativeId: s.creative_id,
      offerId: s.offer_id,
      days: [],
      manualVisits: 0,
    };
    e.m = addMetrics(e.m, metricsOf(s));
    if (s.sent_at && s.sent_at >= fromUtc && s.sent_at < toExclusiveUtc) {
      e.days.push(formatInCampaignTimezone(s.sent_at, "yyyy-MM-dd"));
    }
    if (s.link_mode !== "tracked") e.manualVisits += s.tally.visit_clicks_clean;
    acc.set(key, e);
  }

  const entries = [...acc.entries()];
  const [period, lifetime, slugs, offers] = await Promise.all([
    getCountedClickersByCreativeOffer(db, orgId, periodBounds(b, stages)),
    getCountedClickersByCreativeOffer(db, orgId),
    creativeSlugs(orgId, entries.map(([, e]) => e.creativeId).filter((id): id is number => id != null)),
    offerInfo(entries.map(([, e]) => e.offerId).filter((id): id is number => id != null)),
  ]);

  return entries.map(([key, e]) => {
    const slug = e.creativeId == null ? "No creative" : slugs.get(e.creativeId) ?? `#${e.creativeId}`;
    const oi = e.offerId == null ? null : offers.get(e.offerId);
    return {
      key,
      label: `${slug} — ${oi ? oi.name || oi.code : "No offer"}`,
      creative_id: e.creativeId,
      offer_id: e.offerId,
      ...e.m,
      counted_clickers: (period.get(key) ?? 0) + e.manualVisits,
      lifetime_clickers: (lifetime.get(key) ?? 0) + e.manualVisits,
      ...sendDaysOf(e.days),
    };
  });
}
```

  - after `offerInfo` add:

```ts
async function creativeSlugs(orgId: string, ids: number[]) {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, slug FROM creatives WHERE org_id = ${orgId}::uuid AND id IN (${inList([...new Set(ids)])})
  `)) as unknown as { id: number; slug: string }[];
  for (const r of rows) out.set(Number(r.id), r.slug);
  return out;
}
```

- [ ] **Step 4:** `npx tsc --noEmit` → exit 0. **Commit.**

### Task 3: Lifetime snapshot + route + cron

**Files:** create `lib/reporting/creative-lifetime.ts`, `app/api/cron/refresh-creative-lifetime/route.ts`; modify `app/api/reports/performance/route.ts`, `vercel.json`, `lib/authz/route-map.ts`.

**Interfaces — Produces:**
- `computeCreativeLifetime(orgId: string): Promise<CreativeLifetimeSnapshot>`
- `refreshCreativeLifetime(orgId: string): Promise<{ durationMs: number }>`
- `readCreativeLifetime(orgId: string, basis: AttributionBasis): Promise<{ basis: CreativeLifetimeBasis; computedAt: string } | null>`

- [ ] **Step 1: `lib/reporting/creative-lifetime.ts`**

```ts
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  getStageDimensionReports,
  type PerfMetrics,
  type PerfRow,
} from "@/lib/reporting/performance-report";
import { ATTRIBUTION_BASES, type AttributionBasis } from "@/lib/reporting/report-dimensions";

// All-time creative × offer rows behind GET /api/reports/performance
// dimension=creative range=lifetime — ranking the whole creative bank, which the
// 92-day live range cannot do. Stored in operator_rollups, refreshed hourly by
// /api/cron/refresh-creative-lifetime.
//
// ⚠️ ONE STAGE-METRICS PASS PER BASIS. The all-time funnel measured 13.7s
// (conversion_date) and 12.0s (send_date) on 2026-09-14; creative rows AND the
// per-offer totals an offer_id filter needs are grouped from the same pass.
//
// The blob holds creative / offer ids, slugs and offer names, and integers — no
// contact data.

export const CREATIVE_LIFETIME_ROLLUP_KEY = "performance_creative_lifetime";

export interface CreativeLifetimeBasis {
  rows: PerfRow[];
  totals: PerfMetrics;
  /** Per offer id: that offer's row in dimension=offer — the totals under offer_id. */
  offer_totals: Record<string, PerfMetrics>;
  refreshedAt: string | null;
  from: string;
  to: string;
}

export interface CreativeLifetimeSnapshot {
  version: 1;
  bases: Record<AttributionBasis, CreativeLifetimeBasis>;
}

// All time = the first ET day with a sent stage or a tracker row, through today.
async function lifetimeRange(orgId: string): Promise<{ from: string; to: string }> {
  const to = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const rows = (await db.execute(sql`
    SELECT to_char(least(
      (SELECT min((sent_at AT TIME ZONE 'America/New_York')::date)
       FROM campaign_stages WHERE org_id = ${orgId}::uuid AND sent_at IS NOT NULL),
      (SELECT min(stat_date) FROM keitaro_stage_results WHERE org_id = ${orgId}::uuid)
    ), 'YYYY-MM-DD') AS first_day
  `)) as unknown as { first_day: string | null }[];
  return { from: rows[0]?.first_day ?? to, to };
}

export async function computeCreativeLifetime(orgId: string): Promise<CreativeLifetimeSnapshot> {
  const { from, to } = await lifetimeRange(orgId);
  const bases = {} as Record<AttributionBasis, CreativeLifetimeBasis>;
  for (const attribution of ATTRIBUTION_BASES) {
    const [creative, offer] = await getStageDimensionReports(orgId, ["creative", "offer"], {
      from,
      to,
      providerPhoneId: null,
      attribution,
    });
    const offerTotals: Record<string, PerfMetrics> = {};
    for (const row of offer.rows) {
      if (row.key === "none") continue;
      const { key: _key, label: _label, ...metrics } = row;
      offerTotals[row.key] = metrics;
    }
    bases[attribution] = {
      rows: creative.rows,
      totals: creative.totals,
      offer_totals: offerTotals,
      refreshedAt: creative.refreshedAt,
      from,
      to,
    };
  }
  return { version: 1, bases };
}

export async function refreshCreativeLifetime(orgId: string): Promise<{ durationMs: number }> {
  const startedAt = Date.now();
  const snapshot = await computeCreativeLifetime(orgId);
  const durationMs = Date.now() - startedAt;
  await db.execute(sql`
    INSERT INTO operator_rollups (org_id, rollup_key, data, computed_at, duration_ms, updated_at)
    VALUES (${orgId}::uuid, ${CREATIVE_LIFETIME_ROLLUP_KEY}, ${JSON.stringify(snapshot)}::jsonb,
            now(), ${durationMs}, now())
    ON CONFLICT (org_id, rollup_key) DO UPDATE
      SET data = EXCLUDED.data,
          computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms,
          updated_at = now()
  `);
  return { durationMs };
}

export async function readCreativeLifetime(
  orgId: string,
  basis: AttributionBasis,
): Promise<{ basis: CreativeLifetimeBasis; computedAt: string } | null> {
  const rows = (await db.execute(sql`
    SELECT data->'bases'->${basis}::text AS basis,
           to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at
    FROM operator_rollups
    WHERE org_id = ${orgId}::uuid AND rollup_key = ${CREATIVE_LIFETIME_ROLLUP_KEY}
      AND data IS NOT NULL AND computed_at IS NOT NULL
  `)) as unknown as { basis: CreativeLifetimeBasis | null; computed_at: string }[];
  const row = rows[0];
  return row?.basis ? { basis: row.basis, computedAt: row.computed_at } : null;
}
```

  (If eslint flags the unused `_key` / `_label`, build `metrics` by deleting the two keys from a spread copy instead.)

- [ ] **Step 2: route** — replace `app/api/reports/performance/route.ts` with:

```ts
import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { readCreativeLifetime } from "@/lib/reporting/creative-lifetime";
import { hideBelowMinSent, rpmOf, sortCreativeRows } from "@/lib/reporting/creative-rows";
import {
  getPerformanceReport,
  getReportProviderOptions,
  gradePerf,
  ZERO,
  type PerfMetrics,
  type PerfRow,
} from "@/lib/reporting/performance-report";
import {
  API_ONLY_DIMENSIONS,
  ATTRIBUTION_BASES,
  CREATIVE_SORT_KEYS,
  isAttributionBasis,
  isCreativeSortKey,
  isPerformanceDimension,
  REPORT_DIMENSIONS,
  type CreativeSortKey,
} from "@/lib/reporting/report-dimensions";

// Read API for the performance reports. Number/offer/sequence/group/creative
// source from the shared per-stage Keitaro funnel (matches the Overview tab);
// hourly buckets by user-activity time. `creative` is API-only (no Reports tab)
// and adds range=lifetime (hourly snapshot), offer_id, min_sent and sortBy.
// Gated on campaigns.view (same as Overview).
export const dynamic = "force-dynamic";
// A long attribution=send_date range counts every send of every cohort stage
// (~10s for 7 days, measured 2026-09-14); give it headroom over the default.
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;
const MAX_INT4 = 2_147_483_647;
const CREATIVE_ONLY_PARAMS = ["range", "offer_id", "min_sent", "sortBy"] as const;

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

// Creative rows and totals for the response: grading fields + rpm, offer filter,
// the min_sent hide and the server-side sort.
function creativeBody(
  rows: PerfRow[],
  totals: PerfMetrics,
  offerId: number | null,
  minSent: number,
  sortBy: CreativeSortKey,
) {
  const inOffer = offerId == null ? rows : rows.filter((r) => r.offer_id === offerId);
  const graded = inOffer.map((r) => ({ ...gradePerf(r), rpm: rpmOf(r.revenue, r.sent) }));
  const { rows: kept, hidden } = hideBelowMinSent(graded, minSent);
  return {
    data: sortCreativeRows(kept, sortBy),
    totals: { ...gradePerf(totals), rpm: rpmOf(totals.revenue, totals.sent) },
    hidden_rows: hidden,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/performance",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;

  const dimensionRaw = sp.get("dimension") ?? "";
  if (!isPerformanceDimension(dimensionRaw)) {
    return badRequest(
      `Unknown dimension. Expected one of: ${[...REPORT_DIMENSIONS, ...API_ONLY_DIMENSIONS].join(", ")}`,
    );
  }
  const dimension = dimensionRaw;
  const creative = dimension === "creative";

  // Creative-only params are rejected elsewhere, never silently ignored.
  for (const p of CREATIVE_ONLY_PARAMS) {
    if (!creative && sp.has(p)) return badRequest(`${p} is only supported for dimension=creative`);
  }
  const rangeRaw = sp.get("range");
  if (rangeRaw != null && rangeRaw !== "lifetime") {
    return badRequest("range must be lifetime, or omitted to use from/to");
  }
  const lifetime = rangeRaw === "lifetime";
  if (lifetime && (sp.has("from") || sp.has("to") || sp.has("provider_phone_id"))) {
    return badRequest("range=lifetime cannot be combined with from, to or provider_phone_id");
  }
  const offerRaw = sp.get("offer_id");
  const offerId =
    offerRaw == null
      ? null
      : /^\d+$/.test(offerRaw) && Number(offerRaw) > 0 && Number(offerRaw) <= MAX_INT4
        ? Number(offerRaw)
        : Number.NaN;
  if (Number.isNaN(offerId)) return badRequest("offer_id must be a positive whole number");
  if (offerId != null && sp.has("provider_phone_id")) {
    return badRequest("offer_id cannot be combined with provider_phone_id");
  }
  const minSentRaw = sp.get("min_sent");
  const minSent = minSentRaw == null ? 0 : /^\d+$/.test(minSentRaw) ? Number(minSentRaw) : Number.NaN;
  if (Number.isNaN(minSent)) return badRequest("min_sent must be a whole number of 0 or more");
  const sortRaw = sp.get("sortBy") ?? "revenue";
  if (!isCreativeSortKey(sortRaw)) {
    return badRequest(`Unknown sortBy. Expected one of: ${CREATIVE_SORT_KEYS.join(", ")}`);
  }
  const sortBy = sortRaw;

  // conversion_date (default) = every metric on its own event day; send_date = the
  // cohort of stages sent in range, with everything they have produced to date.
  const attributionRaw = sp.get("attribution") ?? "conversion_date";
  if (!isAttributionBasis(attributionRaw)) {
    return badRequest(`Unknown attribution. Expected one of: ${ATTRIBUTION_BASES.join(", ")}`);
  }
  const attribution = attributionRaw;
  if (dimension === "hourly" && attribution === "send_date") {
    return badRequest("hourly buckets by event time; attribution=send_date is not supported for it");
  }

  if (lifetime) {
    const stored = await readCreativeLifetime(auth.orgId, attribution);
    if (!stored) {
      // 503, not an empty 200: "never computed" is a service state, not zero rows.
      return NextResponse.json(
        {
          error: "Lifetime creative rows have not been computed yet. The refresh runs hourly.",
          code: "internal",
          details: { reason: "rollup_not_ready" },
        },
        { status: 503 },
      );
    }
    const totals =
      offerId == null ? stored.basis.totals : stored.basis.offer_totals[String(offerId)] ?? ZERO;
    const providers = await getReportProviderOptions(auth.orgId);
    return NextResponse.json({
      dimension,
      attribution,
      sort_by: sortBy,
      min_sent: minSent,
      offer_id: offerId,
      ...creativeBody(stored.basis.rows, totals, offerId, minSent, sortBy),
      refreshedAt: stored.basis.refreshedAt,
      providers,
      range: { lifetime: true, from: stored.basis.from, to: stored.basis.to, timezone: CAMPAIGN_TIMEZONE },
      computed_at: stored.computedAt,
      stale_seconds: Math.max(0, Math.round((Date.now() - Date.parse(stored.computedAt)) / 1000)),
    });
  }

  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : todayEt;
  // Hourly buckets by hour-of-day across the whole range (each hour summed over
  // all days), so it takes a from/to range like every other dimension.
  const to = toRaw && DATE_RE.test(toRaw) ? toRaw : todayEt;

  if (from > to) return badRequest("`from` must be on or before `to`");
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) return badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);

  const providerRaw = sp.get("provider_phone_id");
  const providerPhoneId =
    providerRaw && /^\d+$/.test(providerRaw) ? Number(providerRaw) : null;

  const [report, providers] = await Promise.all([
    getPerformanceReport(auth.orgId, dimension, { from, to, providerPhoneId, attribution, offerId }),
    getReportProviderOptions(auth.orgId),
  ]);

  if (creative) {
    return NextResponse.json({
      dimension,
      attribution,
      sort_by: sortBy,
      min_sent: minSent,
      offer_id: offerId,
      ...creativeBody(report.rows, report.totals, offerId, minSent, sortBy),
      refreshedAt: report.refreshedAt,
      providers,
      range: { from, to, timezone: CAMPAIGN_TIMEZONE },
    });
  }

  return NextResponse.json({
    dimension,
    attribution,
    // Operator-API grading fields on every row and the totals (gradePerf).
    data: report.rows.map((r) => gradePerf(r)),
    totals: gradePerf(report.totals),
    refreshedAt: report.refreshedAt,
    providers,
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
  });
}
```

- [ ] **Step 3: cron** `app/api/cron/refresh-creative-lifetime/route.ts` — the refresh-audience-pools route with `refreshCreativeLifetime` from `@/lib/reporting/creative-lifetime`, lease name `refresh-creative-lifetime`, log tag `[creative-lifetime]`, header comment: "Refreshes the all-time creative × offer rows (operator_rollups key performance_creative_lifetime) behind dimension=creative range=lifetime. Two all-time stage-metrics passes per org (13.7s + 12.0s measured 2026-09-14); read-only against report tables, writes one row per org. Hourly at :14, off every */5 and fresh-counts / pools minute."
- [ ] **Step 4:** `vercel.json` entry `{ "path": "/api/cron/refresh-creative-lifetime", "schedule": "14 * * * *" }` after refresh-audience-pools; route map `"cron/refresh-creative-lifetime": null, // cron / webhook / import machinery -- no operator session reaches these` before `"cron/refresh-fresh-counts"`.
- [ ] **Step 5:** `npx tsc --noEmit`; `npx eslint` changed files; `npm run check:authz` (276 routes, 39 token routes). **Commit.**

### Task 4: Verification

- [ ] **`scripts/verify-creative-report.ts`** (prod, read-only; 7 CLOSED ET days ending yesterday):
  - **A (conversion_date):** rows' `sent` / `sales` sum = totals; control ≥ 5 rows and ≥ 1 row with sales. Independent SQL per `creative_id:offer_id`: tracked sent = `count(*)` of `stage_sends` (`status='sent'`, `sent_at` in range) ⋈ `campaign_stages` (`archived_at IS NULL`) ⋈ `campaigns` (`link_mode='tracked'`), plus manual `sum(sms_count)` of stages sent in range; sales = `sum(keitaro_stage_results.sales)` with `stat_date` in range (skip the sales check if `stage_manual_sales` has entries in range); tracked distinct clickers = `count(DISTINCT contact_id)` of `counted_clickers` ⋈ stage ⋈ campaign with `first_click_at` in range, compared on rows whose stages are all tracked; send days = min / max / `count(DISTINCT)` of the ET day of `campaign_stages.sent_at` in range. Every compared row exact.
  - **B (offer_id):** for the offer with the most sent, the creative report with `offerId` has only that offer's rows, and its totals (`sent, opt_outs, sales, revenue, cost, reached, counted_clickers, lifetime_clickers`) equal the `dimension=offer` row for it.
  - **C (send_date):** rows' `sent` sum = totals; per key, sent = all-time `status='sent'` sends of stages whose `sent_at` is in range.
- [ ] **HTTP section 12** in `scripts/verify-operator-grading-http.ts` (before the privacy sweep): creative 200 with `creative_id, offer_id, first_sent_date, last_sent_date, distinct_send_days, rpm, clicks_human` and a `—` label; default order non-increasing revenue and `sort_by: "revenue"`; `sortBy=rpm|sent|click_to_reach_pct` non-increasing with nulls last; `min_sent` = the median `sent` → every row ≥ it, `hidden_rows` = the rows below it, totals unchanged; `offer_id` of the first row → every row carries it and totals `sent` = that offer's `dimension=offer` row; 400s: `dimension=offer&sortBy=rpm`, `dimension=number&range=lifetime`, `dimension=offer&min_sent=5`, `dimension=offer&offer_id=1`, `sortBy=profit`, `min_sent=-1`, `range=weekly`, `range=lifetime&from=…`, `offer_id=1&provider_phone_id=2`, `offer_id=abc`; lifetime (after the local cron ran) 200 with `range.lifetime === true`, `computed_at`, integer `stale_seconds`, rows' `sent` sum = totals `sent` ≥ the 7-day totals `sent`, and `min_sent=1500` → every row ≥ 1500.
- [ ] Run: `npx tsx scripts/test-creative-rows.ts`; `npx tsx --conditions=react-server scripts/verify-creative-report.ts`; `next dev -p 3107`; local `curl` of the cron with `CRON_SECRET`; `BASE_URL=http://localhost:3107 npx tsx scripts/verify-operator-grading-http.ts`. All ✓. **Commit.**

### Task 5: Docs, PR, ship

- [ ] `docs/operator-api.md` §3: params table (`dimension` adds `creative`; rows for `range`, `offer_id`, `min_sent`, `sortBy`); "Creative bank — `dimension=creative`" with a real redacted row, lifetime caching (hourly, heavy, `computed_at` / `stale_seconds`, 503), `min_sent>=1500` guidance, multi-offer creatives, send-day fields; §7 `rpm` row.
- [ ] `docs/04-features/reports-rollup.md` paragraph; `docs/04-features/crons.md` row; `docs/04-features/operator-api-tokens.md` route count; `docs/CHANGELOG.md`; `npm run check:docs`.
- [ ] PR body (verification counts, Risk: an hourly ~26s read-only report pass, route refactor keeps every existing dimension's output; rollback = the PR 1 production deployment). Merge on green, deploy wait, local-cron-free prod smoke after the first `:14` tick (or trigger once locally against prod before merge, as in PR 1).
