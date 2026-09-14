# Operator API Grading — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `reached`, `clicks_human` and the three grading rates to `/api/reports/performance` and `/api/campaigns/{id}/stages`, `clicks_human` + a scored-human fix to click-report, and `creative_slug` to `/api/sends/today` (spec items 1, 4, 5b).

**Architecture:** Pure rate math lives in a new client-safe `lib/reporting/grading-rates.ts`. `reached` becomes a real per-stage metric in the shared `getStageMetricsInRange()` and a nullable `PerfMetrics` field; route handlers add the derived fields at the response boundary via `gradePerf()` / `gradingRates()`. The performance totals row stops summing per-stage clicker counts. No migration, no new route.

**Tech Stack:** Next.js 16 route handlers · Drizzle (`sql` templates + query builder) · postgres-js · tsx verification scripts (no test runner in this repo).

Spec: [docs/superpowers/specs/2026-09-14-operator-api-grading-design.md](../specs/2026-09-14-operator-api-grading-design.md)

## Global Constraints

- Read-only and aggregate-only: no contact rows, no recipient phone numbers, no exports, no writes.
- Every query filters by `org_id`.
- Additive only: no existing response field renamed, removed, or re-typed; `/api/keitaro/reports` (Overview) output unchanged.
- Percentages are percent units, 2 decimals (`3.04` = 3.04%); `null` when the denominator is 0 or reach is unknowable.
- A manual-mode stage has `reached` = `null`; `addNullable` skips null parts, so a row is `null` only when ALL its stages are manual (revised in Task 2 — absorbing nulls nulled nearly every total).
- "Human click" = `classification = 'human' AND scored_at IS NOT NULL` (`HUMAN_CLICK`).
- Never interpolate a JS array into a Drizzle `sql` template — use `IN (${inList(ids)})` or the query builder's `inArray`.
- Scripts that import app code: `import "./_env-preload"` first, run with `npx tsx --conditions=react-server`.
- Lint only changed files (`npx eslint <files>`); never `npm run lint`.

## File map

| File | Change |
|---|---|
| `lib/reporting/grading-rates.ts` | **Create.** `pct`, `gradingRates`, `addNullable`, types |
| `scripts/test-grading-rates.ts` | **Create.** Pure unit checks |
| `lib/reporting/stage-funnel.ts` | `StageMetrics.reached`; per-stage reach query |
| `lib/reporting/counted-clickers.ts` | `getTotalCountedClickers` gains `opts.providerPhoneId`, qualified columns |
| `lib/reporting/performance-report.ts` | `PerfMetrics.reached`; reach weights; hourly reach + clickers; totals dedupe; `gradePerf` |
| `app/api/reports/performance/route.ts` | apply `gradePerf` to rows and totals |
| `app/api/campaigns/[campaignId]/stages/route.ts` | per-stage `reached`, `clicks_human`, rates |
| `lib/links/click-report.ts` | `human` uses `HUMAN_CLICK`; `clicks_human` per stage |
| `app/api/sends/today/route.ts` | `creative_id`, `creative_slug` |
| `scripts/verify-operator-grading.ts` | **Create.** Lib-level checks vs independent SQL (prod, read-only) |
| `scripts/verify-operator-grading-http.ts` | **Create.** Route-level checks over HTTP with a session |
| docs (see Task 7) | reference + conventions + changelog |

---

### Task 1: Pure grading-rate module

**Files:**
- Create: `lib/reporting/grading-rates.ts`
- Test: `scripts/test-grading-rates.ts`

**Interfaces:**
- Produces: `pct(numerator: number | null, denominator: number | null): number | null`; `interface GradingInputs { sent: number; opt_outs: number; clicks_human: number; reached: number | null; conversions: number }`; `interface GradingRates { click_to_reach_pct: number | null; reach_to_sale_pct: number | null; opt_rate: number | null }`; `gradingRates(m: GradingInputs): GradingRates`; `addNullable(a: number | null, b: number | null): number | null`.

- [ ] **Step 1: Write the failing test** — `scripts/test-grading-rates.ts` (committed with this plan): checks `pct(912,30000)===3.04`, `pct(1,3)===33.33`, `pct(150,100)===150`, `pct(0,5)===0`, `pct(5,0)===null`, `pct(null,5)===null`, `pct(5,null)===null`; `gradingRates({sent:1000,opt_outs:31,clicks_human:40,reached:10,conversions:2})` → `25 / 20 / 3.1`; with `reached:null` → both reach rates `null`, `opt_rate` `1`; `addNullable` sums and absorbs null on either side.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx scripts/test-grading-rates.ts`
Expected: FAIL — cannot resolve `@/lib/reporting/grading-rates`.

- [ ] **Step 3: Implement**

```ts
// lib/reporting/grading-rates.ts
// Pure grading-rate math for the operator API's creative-grading fields. NO
// database import: scripts assert on it directly and a client component may use
// it. Definitions: docs/07-conventions.md "Grading metrics".

/**
 * A percentage in percent units (3.04 = 3.04%), rounded to 2 decimals.
 * null when either side is unknowable or the denominator is not positive — a
 * rate that cannot be computed must never read as a real 0.
 */
export function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export interface GradingInputs {
  sent: number;
  opt_outs: number;
  /** Distinct human clickers (the counted-clicker / EPC denominator). */
  clicks_human: number;
  /** null when the row includes a manual-mode stage: no per-recipient reach exists. */
  reached: number | null;
  /** Tracker conversions. */
  conversions: number;
}

export interface GradingRates {
  click_to_reach_pct: number | null;
  reach_to_sale_pct: number | null;
  opt_rate: number | null;
}

export function gradingRates(m: GradingInputs): GradingRates {
  return {
    // May exceed 100 and is NOT clamped: a recipient can reach the offer
    // without a click the scorer called human.
    click_to_reach_pct: pct(m.reached, m.clicks_human),
    reach_to_sale_pct: pct(m.conversions, m.reached),
    opt_rate: pct(m.opt_outs, m.sent),
  };
}

/** Sum where null (unknowable) absorbs: any null part makes the whole null. */
export function addNullable(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a + b;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx tsx scripts/test-grading-rates.ts`
Expected: `All grading-rate checks passed.` exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/reporting/grading-rates.ts scripts/test-grading-rates.ts docs/superpowers/plans/2026-09-14-operator-api-grading-pr1.md docs/superpowers/specs/2026-09-14-operator-api-grading-design.md
git commit -m "feat(grading): pure grading-rate module"
```

---

### Task 2: Per-stage `reached` in the shared stage funnel

**Files:**
- Modify: `lib/reporting/stage-funnel.ts`
- Create: `scripts/verify-operator-grading.ts`

**Interfaces:**
- Produces: `StageMetrics.reached: number | null` — tracked stage: count of its `stage_sends` with `offer_reached_at` in the ET range; manual stage: `null`.

- [ ] **Step 1: Write the failing verification** — create `scripts/verify-operator-grading.ts`:

```ts
// Lib-level verification for the operator-API grading fields.
// READ-ONLY against the database in .env.local (production). Every figure is
// compared with an INDEPENDENT SQL recomputation — never the helper that
// produced it — and every check that could pass vacuously has a control.
// Run: npx tsx --conditions=react-server scripts/verify-operator-grading.ts
import "./_env-preload";

import { sql, type SQL } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
async function one<T>(q: SQL): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

async function main() {
  const { org_id: orgId } = await one<{ org_id: string }>(sql`
    SELECT org_id FROM campaigns GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`);
  // Seven CLOSED ET days ending yesterday — today is still moving.
  const to = addDays(formatInCampaignTimezone(new Date(), "yyyy-MM-dd"), -1);
  const from = addDays(to, -6);
  const fromIso = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const toIso = fromZonedTime(`${addDays(to, 1)}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  console.log(`org ${orgId} · range ${from}..${to} ET`);

  const { n: reachTruth } = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${orgId}::uuid
      AND offer_reached_at >= ${fromIso}::timestamptz
      AND offer_reached_at <  ${toIso}::timestamptz`);
  check("control: the range has real reaches", reachTruth > 0, reachTruth);

  console.log("\nA. getStageMetricsInRange — per-stage reached");
  const { stages } = await getStageMetricsInRange(orgId, from, to);
  const manual = stages.filter((s) => s.link_mode !== "tracked");
  const tracked = stages.filter((s) => s.link_mode === "tracked");
  check("tracked stages carry a numeric reached", tracked.every((s) => typeof s.reached === "number"));
  check("manual stages carry reached = null", manual.every((s) => s.reached === null), manual.map((s) => s.stage_id));
  const stageReach = tracked.reduce((a, s) => a + (s.reached ?? 0), 0);
  check(`sum of stage reached = direct count (${reachTruth})`, stageReach === reachTruth, stageReach);

  console.log(failures === 0 ? "\nverify-operator-grading OK." : `\nFAILED: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx --conditions=react-server scripts/verify-operator-grading.ts`
Expected: FAIL on "tracked stages carry a numeric reached" and "sum of stage reached".

- [ ] **Step 3: Implement** in `lib/reporting/stage-funnel.ts`:

(a) In `interface StageMetrics`, after `total_sent: number;` add:
```ts
  // Per-recipient offer reach: stage_sends.offer_reached_at dated by REACH day
  // in range. null for manual-mode stages — they mint no links, so reach is
  // unknowable, and null must never read as a real zero.
  reached: number | null;
```
(b) In BOTH object literals that build a stage accumulator (the Keitaro-row loop and the sent-stage seed loop), after `total_sent: 0,` add `reached: null,`.
(c) In the `Promise.all` inside `if (stageIds.length > 0)`, change the destructuring to `const [optOutRows, sentRows, manualSalesByStage, reachedRows] = await Promise.all([` and append this fourth element after `manualSalesByStageInRange(...)`:
```ts
      db
        .select({ stage_id: stage_sends.stage_id, n: sql<number>`count(*)::int` })
        .from(stage_sends)
        .where(
          and(
            eq(stage_sends.org_id, orgId),
            inArray(stage_sends.stage_id, stageIds),
            gte(stage_sends.offer_reached_at, fromUtc),
            lt(stage_sends.offer_reached_at, toExclusiveUtc),
          ),
        )
        .groupBy(stage_sends.stage_id),
```
(d) After `const sentByStage = new Map(...)` add:
```ts
    const reachedByStage = new Map(reachedRows.map((r) => [r.stage_id, Number(r.n)]));
```
(e) In the `for (const acc of byStage.values())` loop, after `acc.opt_outs = ...;` add:
```ts
      acc.reached = acc.link_mode === "tracked" ? reachedByStage.get(acc.stage_id) ?? 0 : null;
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx --conditions=react-server scripts/verify-operator-grading.ts` → `verify-operator-grading OK.`
Run: `npx tsx scripts/test-performance-report.ts` → `All checks passed.` (Overview parity untouched)

- [ ] **Step 5: Commit**

```bash
git add lib/reporting/stage-funnel.ts scripts/verify-operator-grading.ts
git commit -m "feat(grading): per-stage reached in the shared stage funnel"
```

---

### Task 3: Performance report — `reached`, deduped totals, `gradePerf`

**Files:**
- Modify: `lib/reporting/counted-clickers.ts` (`getTotalCountedClickers`)
- Modify: `lib/reporting/performance-report.ts`
- Modify: `app/api/reports/performance/route.ts`
- Modify: `scripts/verify-operator-grading.ts`

**Interfaces:**
- Consumes: `StageMetrics.reached`, `ClickerDenominators` (stage-funnel); `addNullable`, `gradingRates`, `GradingRates` (Task 1).
- Produces: `PerfMetrics.reached: number | null`; `gradePerf<T extends PerfMetrics>(m: T): T & GradingRates & { clicks_human: number }`; `getTotalCountedClickers(dbc, orgId, b?, opts?: { providerPhoneId?: number | null })`.

- [ ] **Step 1: Extend the verification (failing)** — in `scripts/verify-operator-grading.ts` add imports `import { pct } from "@/lib/reporting/grading-rates";` and `import { getPerformanceReport, gradePerf } from "@/lib/reporting/performance-report";`, then insert before the final `console.log`:

```ts
  console.log("\nB. getPerformanceReport — reached, deduped totals, grading");
  const inRange = sql`first_click_at >= ${fromIso}::timestamptz AND first_click_at < ${toIso}::timestamptz`;
  const { n: clickTruth } = await one<{ n: number }>(sql`
    SELECT count(DISTINCT (campaign_id::text || ':' || contact_id::text))::int AS n
    FROM counted_clickers WHERE org_id = ${orgId}::uuid AND ${inRange}`);
  const { n: lifeClickTruth } = await one<{ n: number }>(sql`
    SELECT count(DISTINCT (campaign_id::text || ':' || contact_id::text))::int AS n
    FROM counted_clickers WHERE org_id = ${orgId}::uuid`);
  const { n: stageGrainSum } = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM counted_clickers WHERE org_id = ${orgId}::uuid AND ${inRange}`);
  const { n: manualVisits } = await one<{ n: number }>(sql`
    SELECT coalesce(sum(k.visit_clicks_clean), 0)::int AS n
    FROM keitaro_stage_results k JOIN campaigns c ON c.id = k.campaign_id
    WHERE k.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked'
      AND k.stat_date >= ${from}::date AND k.stat_date <= ${to}::date`);
  check(
    "control: a summed clicker total would differ from the distinct one",
    stageGrainSum > clickTruth,
    { stageGrainSum, clickTruth },
  );

  for (const dim of ["number", "offer", "sequence", "group"] as const) {
    const r = await getPerformanceReport(orgId, dim, { from, to, providerPhoneId: null });
    const t = r.totals;
    if (manual.length > 0) {
      check(`${dim}: range with a manual stage → totals.reached null`, t.reached === null, t.reached);
    } else {
      check(`${dim}: totals.reached = direct count`, t.reached === reachTruth, t.reached);
      const rowReach = r.rows.reduce((a, x) => a + (x.reached ?? 0), 0);
      check(`${dim}: rows' reached sum to the direct count`, Math.abs(rowReach - reachTruth) <= (dim === "group" ? 2 : 0), rowReach);
    }
    check(
      `${dim}: totals.counted_clickers = distinct + manual visits`,
      t.counted_clickers === clickTruth + manualVisits,
      { got: t.counted_clickers, want: clickTruth + manualVisits },
    );
    check(
      `${dim}: totals.lifetime_clickers = lifetime distinct + manual visits`,
      t.lifetime_clickers === lifeClickTruth + manualVisits,
      { got: t.lifetime_clickers, want: lifeClickTruth + manualVisits },
    );
    const g = gradePerf(t);
    check(
      `${dim}: grading arithmetic on totals`,
      g.clicks_human === t.counted_clickers &&
        g.click_to_reach_pct === pct(t.reached, t.counted_clickers) &&
        g.reach_to_sale_pct === pct(t.sales, t.reached) &&
        g.opt_rate === pct(t.opt_outs, t.sent),
      g,
    );
  }

  const { provider_phone_id: pid } = await one<{ provider_phone_id: number }>(sql`
    SELECT provider_phone_id FROM campaign_stages
    WHERE org_id = ${orgId}::uuid AND provider_phone_id IS NOT NULL
      AND sent_at >= ${fromIso}::timestamptz AND sent_at < ${toIso}::timestamptz
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const { n: pidClickTruth } = await one<{ n: number }>(sql`
    SELECT count(DISTINCT (cc.campaign_id::text || ':' || cc.contact_id::text))::int AS n
    FROM counted_clickers cc JOIN campaign_stages cs ON cs.id = cc.stage_id
    WHERE cc.org_id = ${orgId}::uuid AND cs.provider_phone_id = ${pid}
      AND cc.first_click_at >= ${fromIso}::timestamptz AND cc.first_click_at < ${toIso}::timestamptz`);
  const { n: pidManual } = await one<{ n: number }>(sql`
    SELECT coalesce(sum(k.visit_clicks_clean), 0)::int AS n
    FROM keitaro_stage_results k
    JOIN campaigns c ON c.id = k.campaign_id
    JOIN campaign_stages cs ON cs.id = k.stage_id
    WHERE k.org_id = ${orgId}::uuid AND c.link_mode <> 'tracked' AND cs.provider_phone_id = ${pid}
      AND k.stat_date >= ${from}::date AND k.stat_date <= ${to}::date`);
  const rp = await getPerformanceReport(orgId, "number", { from, to, providerPhoneId: pid });
  check(
    `number filtered to phone ${pid}: totals.counted_clickers = distinct for that number`,
    rp.totals.counted_clickers === pidClickTruth + pidManual,
    { got: rp.totals.counted_clickers, want: pidClickTruth + pidManual },
  );

  const h = await getPerformanceReport(orgId, "hourly", { from, to, providerPhoneId: null });
  const hours = h.rows.filter((x) => !x.pinned);
  check("hourly: each hour's reached equals its redirects", hours.every((x) => x.reached === x.redirects));
  check(
    "hourly: hours' reached sum = direct count",
    hours.reduce((a, x) => a + (x.reached ?? 0), 0) === reachTruth,
  );
  check(
    "hourly: totals.counted_clickers = distinct in range",
    h.totals.counted_clickers === clickTruth,
    h.totals.counted_clickers,
  );
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx --conditions=react-server scripts/verify-operator-grading.ts`
Expected: tsc-style import error for `gradePerf`, then (after Step 3 partially) failures on totals dedupe.

- [ ] **Step 3a: `getTotalCountedClickers` gains a number filter** — replace the function in `lib/reporting/counted-clickers.ts`:

```ts
// Org-wide total at a given grain. NOT the sum of getCountedClickers values —
// see the non-additivity note above; a contact spanning two campaigns counts
// once here and twice there. `opts.providerPhoneId` narrows it to stages sent
// from one number (the performance report's number filter).
export async function getTotalCountedClickers(
  dbc: DbOrTx,
  orgId: string,
  b: CountedClickerBounds = {},
  opts: { providerPhoneId?: number | null } = {},
): Promise<number> {
  const dateFilter =
    b.fromUtc && b.toExclusiveUtc
      ? sql`AND cc.first_click_at >= ${b.fromUtc.toISOString()}::timestamptz AND cc.first_click_at < ${b.toExclusiveUtc.toISOString()}::timestamptz`
      : sql``;
  const providerJoin =
    opts.providerPhoneId != null
      ? sql`JOIN campaign_stages cs ON cs.id = cc.stage_id AND cs.provider_phone_id = ${opts.providerPhoneId}`
      : sql``;
  const rows = (await dbc.execute(sql`
    SELECT count(DISTINCT (cc.campaign_id::text || ':' || cc.contact_id::text))::int AS n
    FROM counted_clickers cc ${providerJoin}
    WHERE cc.org_id = ${orgId}::uuid ${dateFilter}
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}
```

- [ ] **Step 3b: `lib/reporting/performance-report.ts`**

1. Imports: add `getTotalCountedClickers` to the `@/lib/reporting/counted-clickers` import; change the stage-funnel import to `import { getStageMetricsInRange, type ClickerDenominators, type StageMetrics } from "@/lib/reporting/stage-funnel";`; add `import { addNullable, gradingRates, type GradingRates } from "@/lib/reporting/grading-rates";`.
2. `interface PerfMetrics`, after `redirects: number;`:
```ts
  // Per-recipient offer reach. null when the row includes a manual-mode stage
  // (absorbing — see addNullable). Operator-API grading input.
  reached: number | null;
```
3. `ZERO`: add `reached: 0,` after `redirects: 0,`.
4. `stageMetrics()`: add `reached: s.reached,` after `redirects: ...`.
5. `addMetrics()`: add `reached: addNullable(a.reached, b.reached),`.
6. `scaleMetrics()`: add `reached: m.reached == null ? null : m.reached * f,`.
7. After `interface Bounds { ... }` add:
```ts
// ET day range → [fromUtc, toExclusiveUtc), identical to stage-funnel's window.
function etRangeUtc(b: Bounds): { fromUtc: Date; toExclusiveUtc: Date } {
  const nextDay = new Date(Date.parse(`${b.to}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    fromUtc: fromZonedTime(`${b.from}T00:00:00`, CAMPAIGN_TIMEZONE),
    toExclusiveUtc: fromZonedTime(`${nextDay}T00:00:00`, CAMPAIGN_TIMEZONE),
  };
}

export type GradedPerfMetrics<T extends PerfMetrics = PerfMetrics> = T &
  GradingRates & { clicks_human: number };

// The operator-API grading fields for one row or the totals. `clicks_human` IS
// the row's counted clickers (the EPC denominator) under the name every
// operator-API surface uses; conversions are the row's tracker `sales`.
export function gradePerf<T extends PerfMetrics>(m: T): GradedPerfMetrics<T> {
  return {
    ...m,
    clicks_human: m.counted_clickers,
    ...gradingRates({
      sent: m.sent,
      opt_outs: m.opt_outs,
      clicks_human: m.counted_clickers,
      reached: m.reached,
      conversions: m.sales,
    }),
  };
}
```
8. In `getPerformanceReport`, change `const totals = filtered.reduce(...)` so the next line is:
```ts
  await dedupeTotalClickers(orgId, b, filtered, totals, clickers);
```
and add the function below `getPerformanceReport`:
```ts
// The totals row dedupes clickers at REPORT grain — distinct (campaign,
// contact), the Overview totals-card definition — instead of summing per-stage
// counts, which double-counts anyone who clicked two stages. Manual stages add
// their Keitaro visits (an aggregate with no set to dedup), same as dimension rows.
async function dedupeTotalClickers(
  orgId: string,
  b: Bounds,
  stages: StageMetrics[],
  totals: PerfMetrics,
  clickers: ClickerDenominators,
): Promise<void> {
  const manualVisits = stages
    .filter((s) => s.link_mode !== "tracked")
    .reduce((a, s) => a + s.tally.visit_clicks_clean, 0);
  if (b.providerPhoneId == null) {
    totals.counted_clickers = clickers.periodTotal + manualVisits;
    totals.lifetime_clickers = clickers.lifetimeTotal + manualVisits;
    return;
  }
  const opts = { providerPhoneId: b.providerPhoneId };
  const [period, lifetime] = await Promise.all([
    getTotalCountedClickers(db, orgId, etRangeUtc(b), opts),
    getTotalCountedClickers(db, orgId, {}, opts),
  ]);
  totals.counted_clickers = period + manualVisits;
  totals.lifetime_clickers = lifetime + manualVisits;
}
```
9. `applyDimensionDistinctClickers`: replace its inline `fromUtc` / `nextDay` / `toExclusiveUtc` lines with `const { fromUtc, toExclusiveUtc } = etRangeUtc(b);`.
10. `distributeToGroups`: `const [wSent, wClick, wSale, wOpt, wReach] = await Promise.all([` adding `trackedWeights(orgId, trackedIds, b, "reach"),`; in the tracked branch after the `redirects` spread add:
```ts
      if (m.reached != null) {
        spread(add, m.reached, nonEmpty(wReach.get(s.stage_id)) ?? sentW, "reached");
      }
```
and in the output map add `reached: m.reached == null ? null : round2(m.reached),` after `redirects`.
11. `type WeightBasis = "sent" | "click" | "sale" | "optout" | "reach";` and in `trackedWeights`, replace the final optout arm `: sql\`` … `JOIN opt_out_attributions oa ...` with:
```ts
          : basis === "reach"
            ? sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.org_id = ${orgId}::uuid AND ss.offer_reached_at IS NOT NULL
          AND ss.stage_id IN (${inList(stageIds)})`
            : sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN opt_out_attributions oa ON oa.stage_send_id = ss.id
        WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id IN (${inList(stageIds)})`;
```
12. `getHourlyReport`: destructure a seventh result `clickerRows` from the `Promise.all` and append:
```ts
    // Distinct counted clickers (the EPC denominator) by FIRST-click ET hour.
    (await db.execute(sql`
      SELECT ${hourExpr("cc.first_click_at")} AS hour, count(DISTINCT cc.contact_id)::int AS v
      FROM counted_clickers cc
      ${provFilter ? sql`JOIN campaign_stages cs ON cs.id = cc.stage_id AND cs.provider_phone_id = ${b.providerPhoneId}` : sql``}
      WHERE cc.org_id = ${orgId}::uuid
        AND cc.first_click_at >= ${rangeStart} AND cc.first_click_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
```
replace `for (const r of redirects) bump(r.hour, "redirects", Number(r.v));` with:
```ts
  for (const r of redirects) {
    bump(r.hour, "redirects", Number(r.v));
    // Hourly "redirects" already IS per-recipient reach by reach hour.
    bump(r.hour, "reached", Number(r.v));
  }
  for (const r of clickerRows) bump(r.hour, "counted_clickers", Number(r.v));
```
and after `const totals = rows.reduce(...)` add:
```ts
  // Hour rows dedupe clickers per hour; the total dedupes across the range.
  totals.counted_clickers = await getTotalCountedClickers(db, orgId, etRangeUtc(b), {
    providerPhoneId: b.providerPhoneId,
  });
```
13. `manualRangeRow` return: add `reached: null,` (a manual row has no per-recipient reach).

- [ ] **Step 3c: Route** — `app/api/reports/performance/route.ts`: import `gradePerf` alongside `getPerformanceReport`, and in the JSON body use `data: report.rows.map((r) => gradePerf(r)),` and `totals: gradePerf(report.totals),`.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx --conditions=react-server scripts/verify-operator-grading.ts` → `verify-operator-grading OK.`
Run: `npx tsx scripts/test-performance-report.ts` → `All checks passed.`
Run: `npx tsx --conditions=react-server scripts/verify-lifetime-display.ts` → `verify-lifetime-display OK.`

- [ ] **Step 5: Commit**

```bash
git add lib/reporting/counted-clickers.ts lib/reporting/performance-report.ts app/api/reports/performance/route.ts scripts/verify-operator-grading.ts
git commit -m "feat(grading): reached + grading rates on the performance report; dedupe clicker totals"
```

---

### Task 4: HTTP harness + campaign stages fields

**Files:**
- Create: `scripts/verify-operator-grading-http.ts`
- Modify: `app/api/campaigns/[campaignId]/stages/route.ts`

**Interfaces:**
- Consumes: `gradingRates` (Task 1), `denominatorFor` (counted-clickers).
- Produces: each stage object gains `reached: number | null`, `clicks_human: number`, `click_to_reach_pct`, `reach_to_sale_pct`, `opt_rate`.

- [ ] **Step 1: Write the HTTP harness (all sections; later tasks turn their sections green)**

```ts
// Route-level checks for the operator-API grading fields, over HTTP with a real
// session. READ-ONLY (GETs + SELECTs). Before merge: BASE_URL=http://localhost:3107
// against a local `next dev` on the prod DB. After deploy:
// BASE_URL=https://camman.vercel.app. Independent SQL is the reference side.
// Run: BASE_URL=... npx tsx scripts/verify-operator-grading-http.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";

import { pct } from "../lib/reporting/grading-rates";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3107";
let failures = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
function skip(name: string, why: string) {
  console.log(`  - SKIPPED ${name}: ${why}`);
  skipped++;
}
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const etToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

async function main() {
  const db = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false });
  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cs) => {
          for (const { name, value } of cs) jar.set(name, value);
        },
      },
    },
  );
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) throw new Error(`sign-in failed: ${error.message}`);

  const bodies: { path: string; body: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function get(path: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") },
      redirect: "manual",
    });
    const body = await res.text();
    bodies.push({ path, body });
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* non-JSON body: status check reports it */
    }
    return { status: res.status, json };
  }

  const me = await get("/api/me");
  check("signed in (/api/me 200)", me.status === 200, me.status);
  const orgId: string = me.json.org.id;
  console.log(`BASE_URL ${BASE_URL} · org ${orgId}`);

  // ---- performance ----
  console.log("\n1. /api/reports/performance");
  const to = addDays(etToday(), -1);
  const from = addDays(to, -6);
  const perf = await get(`/api/reports/performance?dimension=offer&from=${from}&to=${to}`);
  check("200", perf.status === 200, perf.status);
  const t = perf.json?.totals ?? {};
  for (const k of ["reached", "clicks_human", "click_to_reach_pct", "reach_to_sale_pct", "opt_rate"]) {
    check(`totals has ${k}`, k in t);
  }
  check("totals.clicks_human = totals.counted_clickers", t.clicks_human === t.counted_clickers, t);
  check("totals.opt_rate arithmetic", t.opt_rate === pct(t.opt_outs, t.sent), t);
  check("rows carry reach_to_sale_pct", (perf.json?.data ?? []).every((r: object) => "reach_to_sale_pct" in r));

  // ---- stages ----
  console.log("\n2. /api/campaigns/{id}/stages");
  const [camp] = await db`
    SELECT ss.campaign_id FROM stage_sends ss JOIN campaigns c ON c.id = ss.campaign_id
    WHERE ss.org_id = ${orgId} AND c.link_mode = 'tracked'
      AND ss.offer_reached_at >= now() - interval '30 days'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`;
  const cid = Number(camp.campaign_id);
  const reachBy = new Map(
    (await db`
      SELECT stage_id, count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS n
      FROM stage_sends WHERE org_id = ${orgId} AND campaign_id = ${cid} GROUP BY 1`
    ).map((r) => [Number(r.stage_id), Number(r.n)]),
  );
  const clickersBy = new Map(
    (await db`
      SELECT stage_id, count(*)::int AS n FROM counted_clickers
      WHERE org_id = ${orgId} AND campaign_id = ${cid} GROUP BY 1`
    ).map((r) => [Number(r.stage_id), Number(r.n)]),
  );
  const st = await get(`/api/campaigns/${cid}/stages`);
  check(`campaign ${cid}: 200`, st.status === 200, st.status);
  let anyReach = false;
  for (const s of st.json?.data ?? []) {
    const wantReach = reachBy.get(s.id) ?? 0;
    if (wantReach > 0) anyReach = true;
    check(`stage ${s.id}: reached = direct count ${wantReach}`, s.reached === wantReach, s.reached);
    check(`stage ${s.id}: clicks_human = cached clickers`, s.clicks_human === (clickersBy.get(s.id) ?? 0), s.clicks_human);
    check(`stage ${s.id}: click_to_reach_pct`, s.click_to_reach_pct === pct(s.reached, s.clicks_human), s.click_to_reach_pct);
    check(`stage ${s.id}: reach_to_sale_pct`, s.reach_to_sale_pct === pct(s.keitaro_sales_count, s.reached), s.reach_to_sale_pct);
    check(`stage ${s.id}: opt_rate`, s.opt_rate === pct(s.inbound_stop_count, s.send_counts.sent), s.opt_rate);
  }
  check("control: at least one stage has a real reach", anyReach);

  // ---- click-report ----
  console.log("\n3. /api/campaigns/{id}/click-report");
  const humanBy = new Map(
    (await db`
      SELECT l.stage_id, count(*)::int AS n FROM links l JOIN clicks ck ON ck.link_id = l.id
      WHERE l.org_id = ${orgId} AND l.campaign_id = ${cid}
        AND ck.classification = 'human' AND ck.scored_at IS NOT NULL
      GROUP BY 1`
    ).map((r) => [Number(r.stage_id), Number(r.n)]),
  );
  const cr = await get(`/api/campaigns/${cid}/click-report`);
  check("200 + tracked", cr.status === 200 && cr.json?.source === "tracked", cr.json?.source);
  let clickersSeen = 0;
  for (const s of cr.json?.stages ?? []) {
    clickersSeen += s.clicks_human ?? 0;
    check(`stage ${s.stage_id}: human = scored human click events`, s.human === (humanBy.get(s.stage_id) ?? 0), s.human);
    check(`stage ${s.stage_id}: clicks_human = cached clickers`, s.clicks_human === (clickersBy.get(s.stage_id) ?? 0), s.clicks_human);
  }
  check("control: some stage has human clickers", clickersSeen > 0, clickersSeen);

  // ---- sends/today ----
  console.log("\n4. /api/sends/today");
  const today = await get("/api/sends/today");
  check("200", today.status === 200, today.status);
  const items: { stage_id: number; creative_id?: number | null; creative_slug?: string | null }[] =
    today.json?.data ?? [];
  if (items.length === 0) {
    skip("creative_slug per stage", "no stages in play today");
  } else {
    const slugBy = new Map(
      (await db`
        SELECT cs.id, cs.creative_id, cr.slug FROM campaign_stages cs
        LEFT JOIN creatives cr ON cr.id = cs.creative_id
        WHERE cs.org_id = ${orgId} AND cs.id IN ${db(items.map((d) => d.stage_id))}`
      ).map((r) => [Number(r.id), { id: r.creative_id == null ? null : Number(r.creative_id), slug: r.slug ?? null }]),
    );
    for (const d of items) {
      const want = slugBy.get(d.stage_id);
      check(
        `today stage ${d.stage_id}: creative_id/creative_slug match`,
        "creative_slug" in d && d.creative_slug === want?.slug && d.creative_id === want?.id,
        { got: [d.creative_id, d.creative_slug], want },
      );
    }
  }

  // ---- privacy sweep over every body fetched above ----
  console.log("\n5. Privacy sweep");
  const senders = new Set(
    (await db`SELECT phone_number FROM provider_phones`).map((r) => String(r.phone_number).replace(/\D/g, "")),
  );
  check("control: sending-number scope is non-empty", senders.size > 0, senders.size);
  for (const { path, body } of bodies) {
    check(`${path}: no contact_id`, !body.includes("contact_id"));
    const leak = (body.match(/\+?1?\d{10,15}/g) ?? [])
      .map((m) => m.replace(/\D/g, ""))
      .find((digits) => digits.length >= 10 && !senders.has(digits));
    check(`${path}: every phone-shaped value is a sending number`, leak === undefined, leak?.slice(-4));
  }

  await db.end();
  console.log(
    failures === 0
      ? `\nverify-operator-grading-http OK${skipped ? ` (${skipped} skipped)` : ""}.`
      : `\nFAILED: ${failures}${skipped ? ` (${skipped} skipped)` : ""}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Start a local server on the prod DB and run the harness (expect failures in sections 2–4)**

Run (background): `npx next dev -p 3107`
When `GET http://localhost:3107/api/me` answers, run: `BASE_URL=http://localhost:3107 npx tsx scripts/verify-operator-grading-http.ts`
Expected: section 1 passes (Task 3 is in); sections 2–4 FAIL on the new fields.

- [ ] **Step 3: Implement** in `app/api/campaigns/[campaignId]/stages/route.ts` (GET):

1. Imports: change `import { getCountedClickers } from "@/lib/reporting/counted-clickers";` to `import { denominatorFor, getCountedClickers } from "@/lib/reporting/counted-clickers";` and add `import { gradingRates } from "@/lib/reporting/grading-rates";`.
2. In the grouped `stage_sends` SELECT (the one with `count(*) FILTER (WHERE status = 'skipped_duplicate')`), add after that line:
```sql
        -- Per-recipient offer reach (operator-API grading). Same scan, no extra query.
        count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS reached
```
(add a comma to the preceding line) and `reached: number;` to its row type.
3. After `const sendCountsByStage = new Map(...)` add:
```ts
  const reachedByStage = new Map(sendCountRows.map((r) => [Number(r.stage_id), Number(r.reached)]));
```
4. Replace `let data = rows.map((r, i) => ({ ... }));` with a block body that computes the grading inputs and spreads them after the existing fields:
```ts
  let data = rows.map((r, i) => {
    const keitaro = keitaroByStage.get(r.id);
    const sendCounts = sendCountsByStage.get(r.id) ?? {
      total: 0,
      pending: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      skippedDuplicate: 0,
    };
    // Operator-API grading fields (docs/07-conventions.md "Grading metrics").
    // Manual-mode stages mint no links: reach is unknowable (null), and the
    // clicker figure falls back to Keitaro clean visits exactly as the EPC
    // denominator does.
    const tracked = linkMode === "tracked";
    const reached = tracked ? reachedByStage.get(r.id) ?? 0 : null;
    const clicksHuman = denominatorFor(
      linkMode,
      countedClickersByStage.get(r.id),
      keitaro?.visitClicksClean ?? 0,
    );
    return {
      ...r,
      link_mode: linkMode,
      creative: r.creative?.id ? r.creative : null,
      provider: r.provider?.id ? r.provider : null,
      provider_phone: r.provider_phone?.id ? r.provider_phone : null,
      brand: r.brand?.id ? r.brand : null,
      offer: r.offer?.id ? r.offer : null,
      audience_count: audienceCounts[i],
      inbound_stop_count: r.inbound_opt_out_count,
      keitaro_sales_count: keitaro?.sales ?? 0,
      keitaro_revenue: keitaro?.revenue ?? "0.0000",
      // Inputs to shouldSubstituteClickers (lib/reporting/tracking-gap.ts). A
      // stage with no keitaro_stage_results row at all is the strongest gap
      // signal, so a missing row must read 0/0 — never "unknown".
      keitaro_visit_clicks_raw: keitaro?.visitClicksRaw ?? 0,
      keitaro_visit_clicks_clean: keitaro?.visitClicksClean ?? 0,
      counted_clickers: countedClickersByStage.get(r.id) ?? 0,
      send_counts: sendCounts,
      reached,
      clicks_human: clicksHuman,
      ...gradingRates({
        sent: tracked ? sendCounts.sent : r.sms_count ?? 0,
        opt_outs: r.inbound_opt_out_count ?? 0,
        clicks_human: clicksHuman,
        reached,
        conversions: keitaro?.sales ?? 0,
      }),
    };
  });
```

- [ ] **Step 4: Re-run the harness** → section 2 all ✓ (sections 3–4 still fail until Tasks 5–6).

- [ ] **Step 5: Commit**

```bash
git add "app/api/campaigns/[campaignId]/stages/route.ts" scripts/verify-operator-grading-http.ts
git commit -m "feat(grading): reached + grading rates on campaign stages"
```

---

### Task 5: Click report — scored human + `clicks_human`

**Files:**
- Modify: `lib/links/click-report.ts`

**Interfaces:**
- Consumes: `HUMAN_CLICK`, `getCountedClickers` (counted-clickers).
- Produces: `TrackedStageRow.clicks_human: number`; `ManualStageRow.clicks_human: null`; `human` = scored human click events.

- [ ] **Step 1: Failing check** — harness section 3 (Task 4) already fails on `clicks_human` (and on `human` for any stage with unscored human clicks).

- [ ] **Step 2: Implement**

1. Add `import { getCountedClickers, HUMAN_CLICK } from "@/lib/reporting/counted-clickers";`.
2. `TrackedStageRow`, after `human: number;`:
```ts
  // Distinct recipients with a scored human click or a conversion (the EPC
  // denominator) — the operator API's `clicks_human`. `human` above counts
  // scored human click EVENTS.
  clicks_human: number;
```
3. `ManualStageRow`: add `clicks_human: null;` with comment `// No per-recipient links in manual mode.`
4. In the tracked SELECT rename the `clicks` alias `c` → `ck` throughout (`count(ck.id)`, `ck.classification`, `ck.scored_at`, `ck.asn`, `LEFT JOIN clicks ck ON ck.link_id = l.id`) and change the human line to:
```sql
        count(ck.id) FILTER (WHERE ${HUMAN_CLICK})::int               AS human,
```
5. Before `return { source: "tracked", ...`, add:
```ts
    const clickers = await getCountedClickers(dbc, orgId, "stage", { campaignId });
```
and in the row map add `clicks_human: clickers.get(Number(r.stage_id)) ?? 0,` after `human`.
6. Manual branch row map: add `clicks_human: null,`.

- [ ] **Step 3: Re-run the harness** → section 3 all ✓.

- [ ] **Step 4: Commit**

```bash
git add lib/links/click-report.ts
git commit -m "feat(grading): clicks_human on click-report; human counts scored clicks only"
```

---

### Task 6: Today's sends — `creative_slug`

**Files:**
- Modify: `app/api/sends/today/route.ts`

- [ ] **Step 1: Failing check** — harness section 4 fails (or is SKIPPED when no stage is in play today; then verify after deploy).

- [ ] **Step 2: Implement**

1. In the candidate SELECT, after `s.tracking_id     AS tracking_id,` add:
```sql
      -- Creative identity, so same-day text collisions are checkable in one call.
      s.creative_id     AS creative_id,
      cr.slug           AS creative_slug,
```
2. After the `LEFT JOIN provider_phones pp ...` line add:
```sql
    LEFT JOIN creatives cr ON cr.id = s.creative_id AND cr.org_id = ${orgId}
```
3. Row type: add `creative_id: number | null;` and `creative_slug: string | null;`.
4. Response object, after `tracking_id: r.tracking_id,`:
```ts
      creative_id: r.creative_id == null ? null : Number(r.creative_id),
      creative_slug: r.creative_slug,
```

- [ ] **Step 3: Re-run the harness** → `verify-operator-grading-http OK` (section 4 may be SKIPPED if nothing is in play today — it is re-run against prod after deploy).

- [ ] **Step 4: Commit**

```bash
git add app/api/sends/today/route.ts
git commit -m "feat(grading): creative_id and creative_slug on today's sends"
```

---

### Task 7: Documentation

**Files:** `docs/operator-api.md`, `docs/04-features/reports-rollup.md`, `docs/04-features/epc-denominator.md`, `docs/04-features/tracking-attribution.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md`

- [ ] **Step 1: `docs/operator-api.md`** — `_Last updated: 2026-09-14_`; §3 Performance: replace "Sends, delivered, clicks, conversions, revenue, cost, EPC per row." with the real field list plus the five grading fields (link §7); §3 stages bullet: "each with `reached`, `clicks_human`, `click_to_reach_pct`, `reach_to_sale_pct`, `opt_rate` for the stage's whole life"; click-report bullet: "raw click events by class, `human` (scored human click events) and `clicks_human` (distinct human clickers)"; §4: "Each stage carries `creative_id` and `creative_slug`"; §6: fix the stale `Route X` wording on provider-phones/providers (names are real); insert **§7 Grading metrics** (table of the five fields, percent units, `null` rules, "grade on `clicks_human`, never raw clicks (~91% non-human) or `clickers` (tracker landing visits)", per-event dating on performance) and renumber the old §7/§8 to §8/§9.
- [ ] **Step 2: `docs/04-features/reports-rollup.md`** — `_Last updated: 2026-09-14_`; after the **API:** paragraph add "Operator-API grading fields (2026-09-14)" (gradePerf, `reached` source + null rule, group reach weights, hourly reuse, totals dedupe — not rendered by the UI); add the three scripts to **Verification**.
- [ ] **Step 3: `docs/04-features/epc-denominator.md`** — `_Last updated: 2026-09-14_`; grain table row `| /api/reports/performance totals | report (campaign + contact) | ✅ (2026-09-14; was a sum of stage counts) |`.
- [ ] **Step 4: `docs/04-features/tracking-attribution.md`** — update the click-report bullet: `human` counts SCORED human click events (`HUMAN_CLICK`, since 2026-09-14) and tracked stages carry `clicks_human`; bump its last-updated date.
- [ ] **Step 5: `docs/07-conventions.md`** — `_Last updated: 2026-09-14_`; new top section "Grading metrics — one vocabulary for the operator API (2026-09-14)" (reached ≠ redirects with the 4,557 vs 4,204 measurement; clicks_human IS counted clickers and why event counts are off report rows (4s/13s); null = unknowable with addNullable; percent units via pct; click_to_reach may exceed 100; totals dedupe at their grain).
- [ ] **Step 6: `docs/CHANGELOG.md`** — dated entry at the top listing the change, "No migration", what was verified with numbers, and the docs touched.
- [ ] **Step 7: Commit** — `git add` the six docs explicitly; `git commit -m "docs(grading): operator API grading fields (PR 1)"`.

---

### Task 8: Verify, ship, smoke

- [ ] **Step 1: Static checks** — `npx tsc --noEmit` (exit 0); `npx eslint <every changed .ts file>` (0 problems); `npm run check:authz` (ALL PASS); `npm run check:docs` (clean).
- [ ] **Step 2: Behaviour checks** — `npx tsx scripts/test-grading-rates.ts`; `npx tsx --conditions=react-server scripts/verify-operator-grading.ts`; `npx tsx scripts/test-performance-report.ts`; `npx tsx --conditions=react-server scripts/verify-lifetime-display.ts`; `BASE_URL=http://localhost:3107 npx tsx scripts/verify-operator-grading-http.ts`. Stop the dev server with `taskkill //PID <pid> //F`.
- [ ] **Step 3: Diff hygiene** — `git diff --stat origin/main -- docs/CHANGELOG.md` is insert-only; `git fetch origin && git rev-list --count HEAD..origin/main` is 0 (rebase if not, re-run Step 1–2).
- [ ] **Step 4: Rollback target** — `gh api "repos/:owner/:repo/deployments?environment=Production&per_page=2" --jq '.[] | "\(.id) \(.sha[0:8]) \(.created_at)"'` → record the current prod deployment id.
- [ ] **Step 5: PR** — push `feat/opapi-grading-p1`, `gh pr create` with: summary, "No migration / no STOP-handling / no provider config / no data writes", the verification list with numbers, and the rollback deployment id.
- [ ] **Step 6: Merge on green** — wait for the Vercel preview check to pass; `gh pr merge --squash`; confirm `gh pr view <n> --json state` = MERGED.
- [ ] **Step 7: Prod READY + smoke** — poll the new Production deployment status to `success`; run `BASE_URL=https://camman.vercel.app npx tsx scripts/verify-operator-grading-http.ts` (no loop polling of the prod hostname) plus `curl -s -o /dev/null -w '%{http_code}' https://camman.vercel.app/api/reports/does-not-exist` as the 404 control. If the smoke fails: roll back in Vercel and report.
