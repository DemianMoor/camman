# Creatives Sales CR Fix + "Sales, qty (all time)" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sales CR on `/creatives` counts real sales; a new sortable "Sales, qty (all time)" column shows every sale a creative produced.

**Architecture:** In `computeCreativeMetrics`, one org-scoped per-stage Keitaro aggregate is LEFT JOINed into the 30-day and lifetime stage CTEs (replacing per-stage correlated revenue subqueries). Effective stage sales = `greatest(sales_count, keitaro sales)`. The final SELECT is driven by the lifetime aggregates so creatives idle for 30+ days keep their all-time values. The list route exposes `metrics.sales_lifetime` and sorts on it. Spec: `docs/superpowers/specs/2026-09-15-creatives-sales-fix-design.md`.

**Tech Stack:** Drizzle `sql` in a read-driven in-memory cache, Next.js 16 route, TanStack Table, tsx verify script.

## Global Constraints

- Sales per stage = max(manual `sales_count`, Σ `keitaro_stage_results.sales`) — `combineSales` in `lib/stage-results.ts`. Never sum the two.
- 30-day window = stages with `created_at >= now() - interval '30 days'` (unchanged). Sales CR denominator unchanged.
- Every aggregate filters by `org_id`.
- Revenue (EPC numerators) must equal the old values.
- Column header `Sales, qty (all time)`, sortable, placed after "Clicks (all time)".
- Worktree `C:/AFF/camman/.claude/worktrees/creatives-sales`; `git -C` on it; lint changed files only.

---

### Task 1: Metrics cache + list route, proven by the verify script

**Files:**
- Create: `scripts/verify-creatives-sales.ts` (done — every creative vs a JS recount from raw rows)
- Modify: `lib/creatives/metrics-cache.ts` (`CreativeMetricsRow`, `NO_ACTIVITY`, `computeCreativeMetrics`)
- Modify: `app/api/creatives/list/route.ts` (recordset columns, `RATIO_SQL` sort map, select, response)

**Interfaces:**
- Produces: `CreativeMetricsRow.lifetime_sales: number`; response `metrics.sales_lifetime: number`; `sortBy=sales_lifetime`.

- [ ] **Step 1: Run the script on the unchanged code — expect FAIL** (`✗ every row has an integer metrics.sales_lifetime`).

- [ ] **Step 2: Metrics cache.** Add `lifetime_sales: number` to the interface and `lifetime_sales: 0` to `NO_ACTIVITY`. In the statement:

```sql
WITH k_stage AS (
  SELECT stage_id, sum(sales)::int AS sales, sum(revenue) AS revenue
    FROM keitaro_stage_results
   WHERE org_id = ${orgId}
   GROUP BY stage_id
),
stage_agg AS (
  SELECT cs.creative_id,
         coalesce(sum(cs.delivered_count), 0)::int AS delivered,
         coalesce(sum(cs.checkout_click_count), 0)::int AS checkouts,
         coalesce(sum(greatest(cs.sales_count, coalesce(ks.sales, 0))), 0)::int AS sales,
         coalesce(sum(ks.revenue), 0)::numeric AS payout,
         coalesce(sum(cs.click_count) FILTER (WHERE c.link_mode = 'manual'), 0)::int AS manual_clean
    FROM campaign_stages cs
    JOIN campaigns c ON c.id = cs.campaign_id
    LEFT JOIN k_stage ks ON ks.stage_id = cs.id
   WHERE cs.org_id = ${orgId} AND cs.creative_id IS NOT NULL
     AND cs.created_at >= now() - interval '30 days'
   GROUP BY cs.creative_id
),
stage_life AS (
  SELECT cs.creative_id,
         coalesce(sum(ks.revenue), 0)::numeric AS lifetime_payout,
         coalesce(sum(greatest(cs.sales_count, coalesce(ks.sales, 0))), 0)::int AS lifetime_sales,
         coalesce(sum(cs.click_count) FILTER (WHERE c.link_mode = 'manual'), 0)::int AS lifetime_manual
    FROM campaign_stages cs
    JOIN campaigns c ON c.id = cs.campaign_id
    LEFT JOIN k_stage ks ON ks.stage_id = cs.id
   WHERE cs.org_id = ${orgId} AND cs.creative_id IS NOT NULL
   GROUP BY cs.creative_id
),
-- click_life / click_agg unchanged
SELECT coalesce(sl.creative_id, kl.creative_id) AS creative_id,
       ... existing columns ...,
       coalesce(sl.lifetime_sales, 0) AS lifetime_sales
  FROM stage_life sl
  FULL OUTER JOIN click_life kl ON kl.creative_id = sl.creative_id
  LEFT JOIN stage_agg s ON s.creative_id = coalesce(sl.creative_id, kl.creative_id)
  LEFT JOIN click_agg k ON k.creative_id = coalesce(sl.creative_id, kl.creative_id)
```

Map `lifetime_sales: Number(r.lifetime_sales ?? 0)`.

- [ ] **Step 3: Route.** Recordset: `lifetime_payout numeric, lifetime_clean int, lifetime_sales int,`. Sort map entry `sales_lifetime: drizzleSql\`coalesce(metrics_agg.lifetime_sales, 0)\``. Select `m_lifetime_sales`. Row type `m_lifetime_sales: number | null`. Response `sales_lifetime: Number(row.m_lifetime_sales ?? 0)`.

- [ ] **Step 4: Restart the dev server (cold cache), re-run the script — expect ALL CHECKS PASSED.**

- [ ] **Step 5: `tsc --noEmit`; eslint on the three files; commit.**

### Task 2: Page column + docs

- [ ] Page type `sales_lifetime: number;` and column after `clean_clicks_lifetime`:

```tsx
      {
        id: "sales_lifetime",
        header: "Sales, qty (all time)",
        enableSorting: true,
        cell: ({ row }) => (
          <span
            className="tabular-nums text-muted-foreground"
            title="Sales across all of this creative's stages (all time): Keitaro conversions, or the manual tally where it is larger"
          >
            {numberFmt.format(row.original.metrics.sales_lifetime)}
          </span>
        ),
      },
```

- [ ] Docs: feature doc (Sales CR definition + new column + lifetime-row fix), `operator-api.md` §6 (`sales`, `sales_lifetime`), `07-conventions.md` (never read `sales_count` alone; lifetime columns must be driven by lifetime aggregates), `CHANGELOG.md` top.
- [ ] Playwright `/creatives`: Sales CR non-zero, new column, sort. `check:docs`. eslint `page.tsx` vs origin/main baseline. Commit.

### Task 3: Ship

- [ ] Rebase on origin/main, re-run script; push; PR with verification + previous prod deployment id; checks green; squash-merge; prod deployment success; `BASE_URL=https://camman.vercel.app` smoke; teardown worktree (absolute paths, junction first).
