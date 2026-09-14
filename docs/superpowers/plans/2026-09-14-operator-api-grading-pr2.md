# Operator API Grading — PR 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `attribution=send_date|conversion_date` on `/api/reports/performance`, and a new token-reachable `GET /api/reports/tails?date=YYYY-MM-DD` (spec item 2).

**Architecture:** `getStageMetricsInRange()` gains an optional `attribution`. `send_date` selects the COHORT of stages sent in range and drops every date window on the per-stage metrics; the default path is untouched. Counted-clicker readers gain a `stageIds` bound so a cohort's clickers dedupe over exactly its stages. Tails is a new pure-read lib function in a new `lib/reporting/grading.ts` behind a thin route, added to `OPERATOR_ROUTE_MAP` with `token: ["GET"]`. No migration.

**Tech Stack:** Next.js 16 route handlers · Drizzle · postgres-js · tsx verification scripts.

Spec: [../specs/2026-09-14-operator-api-grading-design.md](../specs/2026-09-14-operator-api-grading-design.md) · PR 1 plan: [2026-09-14-operator-api-grading-pr1.md](2026-09-14-operator-api-grading-pr1.md)

## Global Constraints

- Read-only, aggregate-only; every query filters `org_id`; no contact rows or recipient phones in any payload.
- The default (`conversion_date`) output of `/api/reports/performance` and of `/api/keitaro/reports` (Overview) must not change by a single value — `scripts/test-performance-report.ts` stays green.
- Conversions/revenue come from the tracker (`keitaro_stage_results`); performance `sales` keeps its manual-ledger top-up.
- A `stageIds` bound of `[]` means "no stages" and returns nothing — never "all stages".
- Never interpolate a JS array into a Drizzle `sql` template: `sql.join(ids.map((id) => sql\`${id}\`), sql\`, \`)` or query-builder `inArray`.
- Scripts that import app code: `import "./_env-preload"` first; `npx tsx --conditions=react-server`.
- Destructive / link-touching shell commands use absolute paths; never `cd` in one call of a parallel batch.
- Lint changed files only.

## File map

| File | Change |
|---|---|
| `lib/reporting/report-dimensions.ts` | `ATTRIBUTION_BASES`, `AttributionBasis`, `isAttributionBasis` (client-safe) |
| `lib/reporting/counted-clickers.ts` | `CountedClickerBounds.stageIds`; applied in `getCountedClickers`, `getTotalCountedClickers`, `getCountedClickersByDimension` |
| `lib/reporting/attribution.ts` | `lifetimeManualSalesByStage({ orgId, stageIds })` — lifetime, no window |
| `lib/reporting/stage-funnel.ts` | `opts.attribution`; cohort selection; windowless per-stage queries; clicker period bounds |
| `lib/reporting/performance-report.ts` | `Bounds.attribution?`; `periodBounds()`; dimension + totals clickers follow the basis |
| `app/api/reports/performance/route.ts` | parse/validate `attribution`, reject hourly + send_date, echo it, `maxDuration = 60` |
| `lib/reporting/grading.ts` | **Create.** `getConversionTails(orgId, date)` |
| `app/api/reports/tails/route.ts` | **Create.** thin GET route |
| `lib/authz/route-map.ts` | `"reports/tails": { methods: ["GET"], token: ["GET"] }` |
| `scripts/verify-operator-grading.ts` | sections C (send_date) and D (tails) |
| `scripts/verify-operator-grading-http.ts` | sections 6 (attribution param) and 7 (tails) |
| docs | operator-api.md, 04-features/operator-api-tokens.md (33 → 34), 04-features/reports-rollup.md, 07-conventions.md, CHANGELOG.md |

---

### Task 1: Failing verification for send_date and tails

**Files:** Modify `scripts/verify-operator-grading.ts`, `scripts/verify-operator-grading-http.ts`

- [ ] **Step 1: Lib section C (send_date).** Before the final `console.log`, add:

```ts
  console.log("\nC. attribution=send_date — the cohort of stages sent in range");
  const [cohortTruth] = (await db.execute(sql`
    WITH cohort AS (
      SELECT cs.id, c.link_mode, cs.sms_count FROM campaign_stages cs
      JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.org_id = ${orgId}::uuid AND cs.archived_at IS NULL
        AND cs.sent_at >= ${fromIso}::timestamptz AND cs.sent_at < ${toIso}::timestamptz
    )
    SELECT
      (SELECT count(*) FROM stage_sends ss JOIN cohort ON cohort.id = ss.stage_id
         AND cohort.link_mode = 'tracked' WHERE ss.status = 'sent')::int
        + (SELECT coalesce(sum(sms_count), 0) FROM cohort WHERE link_mode <> 'tracked')::int AS sent,
      (SELECT count(*) FROM stage_sends ss JOIN cohort ON cohort.id = ss.stage_id
         AND cohort.link_mode = 'tracked' WHERE ss.offer_reached_at IS NOT NULL)::int AS reached,
      (SELECT count(*) FROM opt_out_attributions oa JOIN cohort ON cohort.id = oa.stage_id)::int AS opt_outs,
      (SELECT coalesce(sum(k.revenue), 0) FROM keitaro_stage_results k
         JOIN cohort ON cohort.id = k.stage_id)::float8 AS revenue,
      (SELECT coalesce(sum(greatest(coalesce(ms.m, 0), coalesce(ks.s, 0))), 0) FROM cohort
         LEFT JOIN (SELECT stage_id, sum(sales) AS s FROM keitaro_stage_results GROUP BY 1) ks ON ks.stage_id = cohort.id
         LEFT JOIN (SELECT stage_id, sum(delta) AS m FROM stage_manual_sales GROUP BY 1) ms ON ms.stage_id = cohort.id
      )::int AS sales,
      (SELECT count(DISTINCT (cc.campaign_id::text || ':' || cc.contact_id::text))
         FROM counted_clickers cc JOIN cohort ON cohort.id = cc.stage_id)::int AS clickers,
      (SELECT coalesce(sum(k.visit_clicks_clean), 0) FROM keitaro_stage_results k
         JOIN cohort ON cohort.id = k.stage_id AND cohort.link_mode <> 'tracked')::int AS manual_visits
  `)) as unknown as {
    sent: number; reached: number; opt_outs: number; revenue: number;
    sales: number; clickers: number; manual_visits: number;
  }[];
  const convTotals = (await getPerformanceReport(orgId, "offer", { from, to, providerPhoneId: null })).totals;
  for (const dim of ["number", "offer", "sequence"] as const) {
    const r = await getPerformanceReport(orgId, dim, { from, to, providerPhoneId: null, attribution: "send_date" });
    const t = r.totals;
    check(`${dim} send_date: totals.sent = cohort sends`, t.sent === cohortTruth.sent, { got: t.sent, want: cohortTruth.sent });
    check(`${dim} send_date: totals.reached = cohort reaches`, t.reached === cohortTruth.reached, { got: t.reached, want: cohortTruth.reached });
    check(`${dim} send_date: totals.opt_outs = cohort attributions`, t.opt_outs === cohortTruth.opt_outs, { got: t.opt_outs, want: cohortTruth.opt_outs });
    check(`${dim} send_date: totals.sales = cohort tracker+manual sales`, t.sales === cohortTruth.sales, { got: t.sales, want: cohortTruth.sales });
    check(`${dim} send_date: totals.revenue = cohort revenue`, Math.abs(t.revenue - cohortTruth.revenue) < 0.01, { got: t.revenue, want: cohortTruth.revenue });
    check(
      `${dim} send_date: totals.counted_clickers = cohort distinct + manual visits`,
      t.counted_clickers === cohortTruth.clickers + cohortTruth.manual_visits,
      { got: t.counted_clickers, want: cohortTruth.clickers + cohortTruth.manual_visits },
    );
    check(`${dim} send_date: rows' reached sum to totals`, r.rows.reduce((a, x) => a + (x.reached ?? 0), 0) === t.reached);
    check(`${dim} send_date: rows' sent sum to totals`, r.rows.reduce((a, x) => a + x.sent, 0) === t.sent);
  }
  check(
    "control: the two bases really differ on sales (tails exist)",
    convTotals.sales !== cohortTruth.sales,
    { conversion_date: convTotals.sales, send_date: cohortTruth.sales },
  );
```

- [ ] **Step 2: Lib section D (tails).** Add `import { getConversionTails } from "@/lib/reporting/grading";` and, before the final `console.log`:

```ts
  console.log("\nD. getConversionTails");
  // The most recent day in the last 14 with a real tail, so the check can't pass vacuously.
  const [tailDay] = (await db.execute(sql`
    SELECT to_char(k.stat_date, 'YYYY-MM-DD') AS d
    FROM keitaro_stage_results k JOIN campaign_stages cs ON cs.id = k.stage_id
    WHERE k.org_id = ${orgId}::uuid AND k.sales > 0
      AND k.stat_date >= (now() AT TIME ZONE 'America/New_York')::date - 14
      AND (cs.sent_at AT TIME ZONE 'America/New_York')::date < k.stat_date
    ORDER BY k.stat_date DESC LIMIT 1`)) as unknown as { d: string }[];
  check("control: a recent day with a real tail exists", tailDay != null, tailDay);
  if (tailDay) {
    const D = tailDay.d;
    const [truth] = (await db.execute(sql`
      SELECT coalesce(sum(k.sales), 0)::int AS conversions,
             coalesce(sum(k.sales) FILTER (WHERE (cs.sent_at AT TIME ZONE 'America/New_York')::date < k.stat_date), 0)::int AS tail
      FROM keitaro_stage_results k JOIN campaign_stages cs ON cs.id = k.stage_id
      WHERE k.org_id = ${orgId}::uuid AND k.stat_date = ${D}::date`)) as unknown as { conversions: number; tail: number }[];
    const tails = await getConversionTails(orgId, D);
    const tt = tails.totals;
    check(`tails ${D}: totals.conversions = tracker sum for the day`, tt.conversions === truth.conversions, { got: tt.conversions, want: truth.conversions });
    check(`tails ${D}: totals.tail_conversions = sends before the day`, tt.tail_conversions === truth.tail, { got: tt.tail_conversions, want: truth.tail });
    check(
      `tails ${D}: same_day + tail + unknown = conversions`,
      tt.same_day_conversions + tt.tail_conversions + tt.unknown_send_date_conversions === tt.conversions,
      tt,
    );
    check(`tails ${D}: rows sum to tail_conversions`, tails.data.reduce((a, x) => a + x.conversions, 0) === tt.tail_conversions);
    check(`tails ${D}: every row is at least a day after its send`, tails.data.every((x) => x.days_after_send >= 1));
  }
```

- [ ] **Step 3: HTTP sections 6 and 7.** In `scripts/verify-operator-grading-http.ts`, before `// ---- privacy sweep`, add:

```ts
  // ---- attribution param ----
  console.log("\n6. /api/reports/performance?attribution=");
  const sd = await get(`/api/reports/performance?dimension=offer&from=${from}&to=${to}&attribution=send_date`);
  check("send_date: 200", sd.status === 200, sd.status);
  check("send_date: response echoes the basis", sd.json?.attribution === "send_date", sd.json?.attribution);
  check("default: response echoes conversion_date", perf.json?.attribution === "conversion_date", perf.json?.attribution);
  const bad = await get(`/api/reports/performance?dimension=offer&from=${from}&to=${to}&attribution=click_date`);
  check("unknown attribution: 400", bad.status === 400, bad.status);
  const hr = await get(`/api/reports/performance?dimension=hourly&from=${to}&to=${to}&attribution=send_date`);
  check("hourly + send_date: 400", hr.status === 400, hr.status);

  // ---- tails ----
  console.log("\n7. /api/reports/tails");
  const tl = await get(`/api/reports/tails?date=${to}`);
  check("200", tl.status === 200, tl.status);
  const tt = tl.json?.totals ?? {};
  check(
    "same_day + tail + unknown = conversions",
    tt.same_day_conversions + tt.tail_conversions + tt.unknown_send_date_conversions === tt.conversions,
    tt,
  );
  check("rows carry creative_slug and days_after_send", (tl.json?.data ?? []).every((r: object) => "creative_slug" in r && "days_after_send" in r));
  const badDate = await get("/api/reports/tails?date=2026-02-31");
  check("impossible date: 400", badDate.status === 400, badDate.status);
```

- [ ] **Step 4: Run both; expect FAIL** (lib: `attribution` ignored → C totals wrong; `@/lib/reporting/grading` missing; HTTP: 6/7 fail). Start the local server first: background `npx next dev -p 3107` in the worktree.

---

### Task 2: Attribution constants, cohort bounds, lifetime manual sales

**Files:** `lib/reporting/report-dimensions.ts`, `lib/reporting/counted-clickers.ts`, `lib/reporting/attribution.ts`

- [ ] **Step 1: `report-dimensions.ts`** — append:

```ts
// Attribution basis for the performance report. conversion_date = every metric on
// its own event day (the historical behaviour, and the default); send_date = the
// stages SENT in range with everything they have produced to date. Hourly buckets
// by event time and accepts only the default.
export const ATTRIBUTION_BASES = ["conversion_date", "send_date"] as const;
export type AttributionBasis = (typeof ATTRIBUTION_BASES)[number];

export function isAttributionBasis(v: string | null | undefined): v is AttributionBasis {
  return v != null && (ATTRIBUTION_BASES as readonly string[]).includes(v);
}
```

- [ ] **Step 2: `counted-clickers.ts`** — in `CountedClickerBounds` add:

```ts
  // Restrict to these stages — the send-date cohort. An EMPTY array means "no
  // stages" and returns nothing; it must never widen to "all stages".
  stageIds?: number[];
```

add below the interface:

```ts
function stageIdFilter(b: CountedClickerBounds, column: string): SQL {
  if (b.stageIds == null) return sql``;
  if (b.stageIds.length === 0) return sql`AND false`;
  return sql`AND ${sql.raw(column)} IN (${sql.join(
    b.stageIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}
```

and append `${stageIdFilter(b, "stage_id")}` to the WHERE of `getCountedClickers`, `${stageIdFilter(b, "cc.stage_id")}` to the WHERE of `getTotalCountedClickers` and of `getCountedClickersByDimension`.

- [ ] **Step 3: `attribution.ts`** — append:

```ts
// Manual sales per stage over the stage's WHOLE life (no date window) — the
// send-date cohort basis, where every sale a cohort stage ever earned counts.
export async function lifetimeManualSalesByStage(args: {
  orgId: string;
  stageIds: number[];
}): Promise<Map<number, number>> {
  if (args.stageIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    select sms.stage_id, sum(sms.delta)::int as m_sales
    from stage_manual_sales sms
    where sms.org_id = ${args.orgId}::uuid
      and sms.stage_id in (${sql.join(args.stageIds.map((id) => sql`${id}`), sql`, `)})
    group by sms.stage_id
  `)) as unknown as { stage_id: number; m_sales: number }[];
  return new Map(rows.map((row) => [row.stage_id, row.m_sales]));
}
```

- [ ] **Step 5: Commit** — `feat(grading): attribution constants, cohort clicker bounds, lifetime manual sales`.

---

### Task 3: `send_date` in the stage funnel, report and route

**Files:** `lib/reporting/stage-funnel.ts`, `lib/reporting/performance-report.ts`, `app/api/reports/performance/route.ts`

- [ ] **Step 1: `stage-funnel.ts`**
  1. Imports: add `isNotNull` and `type SQL` is not needed; add `import type { AttributionBasis } from "@/lib/reporting/report-dimensions";`, add `manualSalesByStage` to the attribution import, add `type CountedClickerBounds` to the counted-clickers import.
  2. Signature: `getStageMetricsInRange(orgId: string, from: string, to: string, opts: { attribution?: AttributionBasis } = {})`; first line of the body: `const sendDate = opts.attribution === "send_date";` with a comment naming both bases.
  3. Move the `fromUtc` / `toExclusiveUtc` computation and the `sentStageRows` query (unchanged) ABOVE the Keitaro rows query; after it `const cohortIds = sentStageRows.map((r) => r.stage_id);`.
  4. Keitaro rows: `const rows = sendDate && cohortIds.length === 0 ? [] : await db.select({ …unchanged… })…where(and(eq(keitaro_stage_results.org_id, orgId), ...(sendDate ? [inArray(keitaro_stage_results.stage_id, cohortIds)] : [gte(keitaro_stage_results.stat_date, from), lte(keitaro_stage_results.stat_date, to)])));`
  5. The accumulation loop and the sent-stage seed loop stay as they are (the seed loop now runs after the Keitaro loop, over the already-fetched `sentStageRows`).
  6. Per-stage queries: opt-outs `...(sendDate ? [] : [gte(opt_out_attributions.created_at, fromUtc), lt(opt_out_attributions.created_at, toExclusiveUtc)])`; sent `...(sendDate ? [] : [gte(stage_sends.sent_at, fromUtc), lt(stage_sends.sent_at, toExclusiveUtc)])`; manual `sendDate ? lifetimeManualSalesByStage({ orgId, stageIds }) : manualSalesByStageInRange({ orgId, fromUtc, toExclusiveUtc })`; reached `...(sendDate ? [isNotNull(stage_sends.offer_reached_at)] : [gte(stage_sends.offer_reached_at, fromUtc), lt(stage_sends.offer_reached_at, toExclusiveUtc)])`.
  7. `const inRange = sendDate || sentInRange(a.sentAt);` (a cohort stage is in range by definition).
  8. `getClickerDenominators(orgId, period: CountedClickerBounds)` — replace its `fromUtc, toExclusiveUtc` params with `period` and pass it to the three period calls; call it as `getClickerDenominators(orgId, sendDate ? { stageIds: cohortIds } : { fromUtc, toExclusiveUtc })`.

- [ ] **Step 2: `performance-report.ts`**
  1. Import `type AttributionBasis` from report-dimensions and `type CountedClickerBounds` from counted-clickers.
  2. `interface Bounds` gains `attribution?: AttributionBasis;` (optional: existing scripts pass none and mean the default).
  3. After `etRangeUtc` add:
```ts
// The PERIOD clicker scope for this basis: the ET date range (conversion_date) or
// exactly the report's own stages, date-unbounded (send_date cohort).
function periodBounds(b: Bounds, stages: StageMetrics[]): CountedClickerBounds {
  return b.attribution === "send_date"
    ? { stageIds: stages.map((s) => s.stage_id) }
    : etRangeUtc(b);
}
```
  4. `getPerformanceReport`: `getStageMetricsInRange(orgId, b.from, b.to, { attribution: b.attribution })`.
  5. `dedupeTotalClickers` filtered branch: `b.attribution === "send_date" ? getTotalCountedClickers(db, orgId, periodBounds(b, stages)) : getTotalCountedClickers(db, orgId, etRangeUtc(b), opts)` for the period figure (the cohort stages are already number-filtered).
  6. `applyDimensionDistinctClickers`: the period call uses `periodBounds(b, stages)` instead of `{ fromUtc, toExclusiveUtc }`.

- [ ] **Step 3: route** — `export const maxDuration = 60;`; import `ATTRIBUTION_BASES`, `isAttributionBasis`; after the range checks:
```ts
  const attributionRaw = sp.get("attribution") ?? "conversion_date";
  if (!isAttributionBasis(attributionRaw)) {
    return NextResponse.json(
      { error: `Unknown attribution. Expected one of: ${ATTRIBUTION_BASES.join(", ")}` },
      { status: 400 },
    );
  }
  const attribution = attributionRaw;
  if (dimension === "hourly" && attribution === "send_date") {
    return NextResponse.json(
      { error: "hourly buckets by event time; attribution=send_date is not supported for it" },
      { status: 400 },
    );
  }
```
pass `attribution` into `getPerformanceReport(..., { from, to, providerPhoneId, attribution })` and add `attribution,` to the JSON body after `dimension`.

- [ ] **Step 4: Run** lib verification (sections A–C green), `scripts/test-performance-report.ts` (Overview parity unchanged), HTTP section 6 green.
- [ ] **Step 5: Commit** — `feat(grading): attribution=send_date on the performance report`.

---

### Task 4: Tails

**Files:** Create `lib/reporting/grading.ts`, `app/api/reports/tails/route.ts`; modify `lib/authz/route-map.ts`

- [ ] **Step 1: `lib/reporting/grading.ts`**

```ts
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
```

- [ ] **Step 2: `app/api/reports/tails/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { getConversionTails } from "@/lib/reporting/grading";

// Operator API (creative grading): tracker conversions dated one ET day, split into
// same-day and TAILS — conversions whose stage was sent on an earlier day. Daily
// grading is wrong without them (25% of sales land after the send day). Read-only.
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar day: the regex alone lets 2026-02-31 through to a Postgres 22008.
function isCalendarDay(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({ route: "reports/tails", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const raw = req.nextUrl.searchParams.get("date");
  if (raw != null && !isCalendarDay(raw)) {
    return NextResponse.json({ error: "`date` must be a real YYYY-MM-DD day" }, { status: 400 });
  }
  const date = raw ?? formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  return NextResponse.json(await getConversionTails(auth.orgId, date));
}
```

- [ ] **Step 3: `lib/authz/route-map.ts`** — after `"reports/performance": …` add:
```ts
  // Operator API creative grading (2026-09-14): same-day vs tail conversions.
  "reports/tails": { methods: ["GET"], token: ["GET"] },
```

- [ ] **Step 4: Run** lib verification (A–D green), `npm run check:authz` (34 token pairs, all wired), HTTP sections 6–7 green.
- [ ] **Step 5: Commit** — `feat(grading): /api/reports/tails`.

---

### Task 5: Docs

- [ ] `docs/operator-api.md` — performance param table gains `attribution`; new "Tails" subsection under §3 with a real response; §7 gains the two bases; last-updated.
- [ ] `docs/04-features/operator-api-tokens.md` — "33 (route, method) pairs" → 34, mention `reports/tails`; last-updated.
- [ ] `docs/04-features/reports-rollup.md` — attribution param + cohort semantics under the API paragraph; tails; last-updated.
- [ ] `docs/07-conventions.md` — grading section gains "two attribution bases" and the tails unknown-bucket rule.
- [ ] `docs/CHANGELOG.md` — entry with verification numbers.
- [ ] Commit — `docs(grading): send_date attribution and tails (PR 2)`.

### Task 6: Verify, ship, smoke

Same sequence as PR 1 Task 8: tsc, eslint changed files, check:authz, check:docs, the three grading scripts + Overview parity (sequential, not in parallel), HTTP harness on local; rebase check; rollback target; PR; merge on green; prod READY; `BASE_URL=https://camman.vercel.app` smoke + 404 control; memory update.
