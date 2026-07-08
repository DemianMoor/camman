# Offer Group Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, per-offer report that breaks an offer's lifetime economics down by contact group (sends, revenue, cost, sales, opt-outs, RPM, Net RPM, EPC, net profit, opt-out %) plus 7/30/90-day list-pressure and fresh-pool columns, precomputed into materialized views refreshed twice daily.

**Architecture:** A plain SQL view (`offer_report_campaign_econ`) computes per-campaign economics once; two materialized views build on it — `offer_group_report_mv` (per offer×group, + list pressure + fresh pool) and `offer_report_org_summary_mv` (per org, de-duplicated benchmark). A Vercel cron `REFRESH`es them twice a day and stamps `report_refresh_log`. A thin API route reads the matviews (org-scoped) and a client page renders a custom sortable table with pinned benchmark/total rows.

**Tech Stack:** Next.js 16 (App Router, async params), TypeScript, Drizzle ORM (`db.execute(sql\`…\`)` raw for aggregates), Postgres materialized views, Tailwind, Vercel Cron.

## Global Constraints

- **Multi-tenancy:** every query filters `org_id`. Matviews can't carry RLS — the API route enforces `WHERE org_id = auth.orgId`; matviews are server-only. (CLAUDE.md §3)
- **Permissions:** gate the report route with `can(role, "offers.view")`; the cron with `CRON_SECRET`.
- **Money:** `NUMERIC(12,4)`; display USD with `$`. Timestamps `TIMESTAMPTZ` (UTC), displayed via `formatCampaignDateTime()` (ET).
- **Migrations are hand-authored** (drizzle-kit generate is unusable here): write `db/migrations/NNNN_*.sql` with `--> statement-breakpoint` between statements, clone `meta/NNNN_snapshot.json` forward, add the `_journal.json` entry, `npm run db:migrate` (SHARED prod DB — confirm first), then `npx tsx scripts/verify-migration-integrity.ts` must print "Migration integrity OK". **Write JSON with the Write tool, never PowerShell `Set-Content -Encoding utf8` (BOM breaks JSON.parse).**
- **Identifiers shown to users are names/slugs only**, never internal numeric IDs.
- **Docs are part of "done"** (CLAUDE.md §"Documentation maintenance"): update `docs/03-data-model.md`, `docs/04-features/`, `docs/06-integrations.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md`.
- **Tests:** no unit runner. E2E scripts live at `scripts/test-*.ts`, run via `npx tsx scripts/test-<name>.ts` against a dev server on `localhost:3001` + live DB. Mirror `scripts/test-offers-api.ts` (cookie-jar Supabase auth, `check()` helper, try/finally hard-delete cleanup, `process.exit(failed>0?1:0)`).

**Spec:** `docs/superpowers/specs/2026-07-08-offer-group-report-design.md` (metric definitions are LOCKED in spec §3).

---

## File Structure

- **Create** `db/migrations/0093_offer_group_report.sql` — table + view + 2 matviews + indexes.
- **Create** `db/migrations/meta/0093_snapshot.json` — cloned from 0092 + `report_refresh_log`.
- **Modify** `db/migrations/meta/_journal.json` — add idx 93.
- **Modify** `db/schema.ts` — add `report_refresh_log` table def.
- **Create** `lib/reporting/offer-group-report.ts` — `getOfferGroupReport()` + `refreshOfferGroupReport()` + types.
- **Create** `app/api/offers/[id]/report/route.ts` — GET, org-scoped read.
- **Create** `app/api/cron/refresh-offer-group-report/route.ts` — cron refresh.
- **Modify** `vercel.json` — add cron entry.
- **Create** `app/(protected)/offers/[id]/report/page.tsx` — client report page.
- **Modify** `app/(protected)/offers/page.tsx` — add "Group Report" link + `import Link`.
- **Create** `scripts/test-offer-group-report.ts` — E2E test.
- **Modify** docs (Task 8).

---

## Task 1: Database migration (view + matviews + refresh log)

**Files:**
- Create: `db/migrations/0093_offer_group_report.sql`
- Create: `db/migrations/meta/0093_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`
- Modify: `db/schema.ts` (add `report_refresh_log`)

**Interfaces:**
- Produces (DB objects later tasks read):
  - matview `offer_group_report_mv (org_id uuid, offer_id int, group_id int, group_name text, sends bigint, revenue numeric, sales bigint, clicks bigint, cost numeric, optouts bigint, sent_7d bigint, sent_30d bigint, sent_90d bigint, fresh_pool bigint)`
  - matview `offer_report_org_summary_mv (org_id uuid, sends bigint, revenue numeric, sales bigint, clicks bigint, cost numeric, optouts bigint)`
  - table `report_refresh_log (view_name text PK, refreshed_at timestamptz)`
  - Drizzle export `report_refresh_log` from `@/db/schema`.

- [ ] **Step 1: Add the Drizzle table to `db/schema.ts`**

Find an existing simple table for placement (e.g. near other small tables) and add:

```ts
// ============ Report refresh bookkeeping ============
// One row per materialized view; the twice-daily cron stamps refreshed_at so the
// UI can show "data as of …". Global (no org_id) — server-only bookkeeping.
export const report_refresh_log = pgTable("report_refresh_log", {
  view_name: text("view_name").primaryKey(),
  refreshed_at: timestamp("refreshed_at", { withTimezone: true }),
});
```

(Ensure `pgTable`, `text`, `timestamp` are already imported at the top of `db/schema.ts` — they are, used pervasively.)

- [ ] **Step 2: Write the migration SQL**

Create `db/migrations/0093_offer_group_report.sql`. **The metric semantics here are LOCKED by spec §3 — do not "simplify" them.**

```sql
CREATE TABLE public.report_refresh_log (
  view_name    text PRIMARY KEY,
  refreshed_at timestamptz
);
--> statement-breakpoint
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_group_report_mv', NULL), ('offer_report_org_summary_mv', NULL);
--> statement-breakpoint

-- Per-campaign economics for every SENT campaign of any offer (tracked + manual).
-- Shared source for both matviews. Semantics per spec §3:
--   sends   : tracked -> count(stage_sends sent); manual -> sum(campaign_stages.sms_count sent)
--   revenue : sum(keitaro revenue)               (100% Keitaro)
--   sales   : per stage max(keitaro sales, manual delta), summed across stages
--   clicks  : per keitaro row, redirect_clicks_clean when any split col > 0 else clean_clicks
--   cost    : sum(campaign_stages.total_cost) for sent stages
--   optouts : count(distinct opt_out_id) from opt_out_attributions
CREATE VIEW public.offer_report_campaign_econ AS
WITH stage_sales AS (
  SELECT cs.id AS stage_id, cs.campaign_id,
    GREATEST(COALESCE(k.k_sales, 0), COALESCE(m.m_sales, 0)) AS sales,
    COALESCE(k.revenue, 0)::numeric(12,4) AS revenue,
    COALESCE(k.clicks, 0) AS clicks
  FROM public.campaign_stages cs
  LEFT JOIN (
    SELECT stage_id,
      SUM(sales)::int AS k_sales,
      SUM(revenue) AS revenue,
      SUM(CASE
            WHEN (visit_clicks_raw > 0 OR visit_clicks_clean > 0
               OR redirect_clicks_raw > 0 OR redirect_clicks_clean > 0)
            THEN redirect_clicks_clean ELSE clean_clicks END)::int AS clicks
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  LEFT JOIN (
    SELECT stage_id, SUM(delta)::int AS m_sales
    FROM public.stage_manual_sales
    GROUP BY stage_id
  ) m ON m.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL
)
SELECT
  c.id            AS campaign_id,
  c.org_id        AS org_id,
  c.offer_id      AS offer_id,
  c.audience_contact_group_ids AS group_ids,
  CASE WHEN c.link_mode = 'tracked'
       THEN COALESCE(ts.sends, 0)
       ELSE COALESCE(mc.sms_sends, 0) END AS sends,
  COALESCE(ss.revenue, 0)::numeric(12,4) AS revenue,
  COALESCE(ss.sales, 0)                  AS sales,
  COALESCE(ss.clicks, 0)                 AS clicks,
  COALESCE(cst.cost, 0)::numeric(12,4)   AS cost,
  COALESCE(oo.optouts, 0)                AS optouts
FROM public.campaigns c
JOIN (
  SELECT DISTINCT campaign_id
  FROM public.campaign_stages
  WHERE sent_at IS NOT NULL
) sent ON sent.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, COUNT(*)::int AS sends
  FROM public.stage_sends WHERE sent_at IS NOT NULL
  GROUP BY campaign_id
) ts ON ts.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(sms_count)::int AS sms_sends
  FROM public.campaign_stages WHERE sent_at IS NOT NULL
  GROUP BY campaign_id
) mc ON mc.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(sales)::int AS sales,
         SUM(revenue) AS revenue, SUM(clicks)::int AS clicks
  FROM stage_sales GROUP BY campaign_id
) ss ON ss.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(total_cost) AS cost
  FROM public.campaign_stages WHERE sent_at IS NOT NULL
  GROUP BY campaign_id
) cst ON cst.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, COUNT(DISTINCT opt_out_id)::int AS optouts
  FROM public.opt_out_attributions GROUP BY campaign_id
) oo ON oo.campaign_id = c.id
WHERE c.offer_id IS NOT NULL;
--> statement-breakpoint

-- Org-wide benchmark: de-duplicated (each campaign counted ONCE, no group unnest).
CREATE MATERIALIZED VIEW public.offer_report_org_summary_mv AS
SELECT org_id,
  SUM(sends)::bigint            AS sends,
  SUM(revenue)::numeric(14,4)   AS revenue,
  SUM(sales)::bigint            AS sales,
  SUM(clicks)::bigint           AS clicks,
  SUM(cost)::numeric(14,4)      AS cost,
  SUM(optouts)::bigint          AS optouts
FROM public.offer_report_campaign_econ
GROUP BY org_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_report_org_summary_mv_org_uniq
  ON public.offer_report_org_summary_mv (org_id);
--> statement-breakpoint

-- Per offer×group report. Economics from the view (campaign counted fully in each
-- targeted group); list pressure + fresh pool joined per group.
CREATE MATERIALIZED VIEW public.offer_group_report_mv AS
WITH econ AS (
  SELECT e.org_id, e.offer_id, g.group_id,
    SUM(e.sends)::bigint          AS sends,
    SUM(e.revenue)::numeric(14,4) AS revenue,
    SUM(e.sales)::bigint          AS sales,
    SUM(e.clicks)::bigint         AS clicks,
    SUM(e.cost)::numeric(14,4)    AS cost,
    SUM(e.optouts)::bigint        AS optouts
  FROM public.offer_report_campaign_econ e
  CROSS JOIN LATERAL unnest(e.group_ids) AS g(group_id)
  GROUP BY e.org_id, e.offer_id, g.group_id
),
list_pressure AS (
  -- distinct contacts in the group sent (ANY offer) within each window, as-of now()
  SELECT ss.org_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT ss.contact_id) FILTER (WHERE ss.sent_at >= now() - interval '7 days')  AS sent_7d,
    COUNT(DISTINCT ss.contact_id) FILTER (WHERE ss.sent_at >= now() - interval '30 days') AS sent_30d,
    COUNT(DISTINCT ss.contact_id) AS sent_90d
  FROM public.stage_sends ss
  JOIN public.contact_contact_groups ccg ON ccg.contact_id = ss.contact_id
  WHERE ss.sent_at IS NOT NULL AND ss.sent_at >= now() - interval '90 days'
  GROUP BY ss.org_id, ccg.contact_group_id
),
sent_offer_contacts AS (
  SELECT DISTINCT c.offer_id, ss.contact_id
  FROM public.stage_sends ss
  JOIN public.campaigns c ON c.id = ss.campaign_id
  WHERE ss.sent_at IS NOT NULL AND c.offer_id IS NOT NULL
),
optout_contacts AS (
  SELECT DISTINCT org_id, contact_id FROM public.opt_outs WHERE contact_id IS NOT NULL
),
fresh AS (
  SELECT e.org_id, e.offer_id, e.group_id, COUNT(*) AS fresh_pool
  FROM econ e
  JOIN public.contact_contact_groups gc
    ON gc.contact_group_id = e.group_id
  LEFT JOIN sent_offer_contacts s
    ON s.offer_id = e.offer_id AND s.contact_id = gc.contact_id
  LEFT JOIN optout_contacts o
    ON o.contact_id = gc.contact_id AND o.org_id = e.org_id
  WHERE s.contact_id IS NULL AND o.contact_id IS NULL
  GROUP BY e.org_id, e.offer_id, e.group_id
)
SELECT e.org_id, e.offer_id, e.group_id, cg.name AS group_name,
  e.sends, e.revenue, e.sales, e.clicks, e.cost, e.optouts,
  COALESCE(lp.sent_7d, 0)  AS sent_7d,
  COALESCE(lp.sent_30d, 0) AS sent_30d,
  COALESCE(lp.sent_90d, 0) AS sent_90d,
  COALESCE(f.fresh_pool, 0) AS fresh_pool
FROM econ e
JOIN public.contact_groups cg ON cg.id = e.group_id AND cg.org_id = e.org_id
LEFT JOIN list_pressure lp ON lp.org_id = e.org_id AND lp.group_id = e.group_id
LEFT JOIN fresh f ON f.org_id = e.org_id AND f.offer_id = e.offer_id AND f.group_id = e.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
--> statement-breakpoint

-- Supporting indexes for the twice-daily refresh (see spec §4.2).
CREATE INDEX IF NOT EXISTS stage_sends_sent_at_contact_idx
  ON public.stage_sends (sent_at, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_contact_groups_group_contact_idx
  ON public.contact_contact_groups (contact_group_id, contact_id);
```

Notes:
- `IF NOT EXISTS` on the two base indexes is defensive — `stage_sends (campaign_id)` and the `contact_contact_groups` PK `(contact_id, contact_group_id)` already exist; do **not** re-create them.
- Do **not** wrap `CREATE MATERIALIZED VIEW … WITH DATA` in anything special — the default populates immediately, so the matviews have data the moment the migration applies.

- [ ] **Step 3: Clone the snapshot forward**

Copy `db/migrations/meta/0092_snapshot.json` → `db/migrations/meta/0093_snapshot.json` **with the Write tool** (not PowerShell). In the new file:
1. Change the top-level `"id"` to a new random UUID.
2. Set `"prevId"` to the **exact `id` value** that was in `0092_snapshot.json`.
3. Add this entry into the `"tables"` object (match the surrounding indentation and the shape of a sibling text-PK table already present in the file):

```json
"public.report_refresh_log": {
  "name": "report_refresh_log",
  "schema": "",
  "columns": {
    "view_name": { "name": "view_name", "type": "text", "primaryKey": true, "notNull": true },
    "refreshed_at": { "name": "refreshed_at", "type": "timestamp with time zone", "primaryKey": false, "notNull": false }
  },
  "indexes": {},
  "foreignKeys": {},
  "compositePrimaryKeys": {},
  "uniqueConstraints": {},
  "policies": {},
  "checkConstraints": {},
  "isRLSEnabled": false
}
```

Do NOT add the view or matviews to the snapshot — Drizzle does not model them; they live only in the `.sql`.

- [ ] **Step 4: Add the journal entry**

Edit `db/migrations/meta/_journal.json`, append to `entries` (after idx 92). Use a `when` timestamp one day after 0092's (`1784332800000 + 86400000 = 1784419200000`):

```json
{ "idx": 93, "version": "7", "when": 1784419200000, "tag": "0093_offer_group_report", "breakpoints": true }
```

- [ ] **Step 5: Apply the migration (SHARED prod DB — confirm the connection first)**

Run: `npm run db:migrate`
Expected: applies `0093_offer_group_report` with no error.

- [ ] **Step 6: Verify integrity + smoke-check the objects exist and populate**

Run: `npx tsx scripts/verify-migration-integrity.ts`
Expected: ends with "Migration integrity OK."

Then smoke-check with a scratch query (create `scripts/tmp-smoke-mv.ts`, run `npx tsx scripts/tmp-smoke-mv.ts`, then delete it):

```ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const a = await sql`select count(*)::int as n from offer_group_report_mv`;
const b = await sql`select count(*)::int as n from offer_report_org_summary_mv`;
const c = await sql`select * from report_refresh_log order by view_name`;
console.log("group rows:", a[0].n, "| org rows:", b[0].n, "| log:", c);
// Invariant: sent_7d <= group size for a sampled row
const s = await sql`
  select g.group_id, g.sent_90d,
    (select count(*) from contact_contact_groups x where x.contact_group_id = g.group_id) as members
  from offer_group_report_mv g order by g.sent_90d desc limit 3`;
console.log("pressure<=members sample:", s);
await sql.end();
```
Expected: non-negative counts; both log rows present; every sampled `sent_90d <= members`.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations/0093_offer_group_report.sql db/migrations/meta/0093_snapshot.json db/migrations/meta/_journal.json
git commit -m "feat(reports): offer group report matviews + refresh-log migration"
```

---

## Task 2: Reporting helper (read + refresh)

**Files:**
- Create: `lib/reporting/offer-group-report.ts`
- Test: `scripts/test-offer-group-report-helper.ts` (smoke, deleted after — see Step 6 note)

**Interfaces:**
- Consumes: DB objects from Task 1; `db` from `@/db/client`; `sql` from `drizzle-orm`.
- Produces:
  - `type RawMetrics = { sends: number; revenue: number; sales: number; clicks: number; cost: number; optouts: number }`
  - `type GroupRawRow = RawMetrics & { group_id: number; group_name: string; sent_7d: number; sent_30d: number; sent_90d: number; fresh_pool: number }`
  - `type OfferGroupReport = { rows: GroupRawRow[]; orgBenchmark: RawMetrics; refreshedAt: string | null }`
  - `async function getOfferGroupReport(orgId: string, offerId: number): Promise<OfferGroupReport>`
  - `async function refreshOfferGroupReport(): Promise<void>`

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/test-offer-group-report-helper.ts`:

```ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";
import {
  getOfferGroupReport,
  refreshOfferGroupReport,
} from "../lib/reporting/offer-group-report";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const db = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  // Resolve an org + offer that actually has report rows (offer 62 per the brief).
  const [own] = await db`select org_id from offers where id = 62 limit 1`;
  const orgId = own?.org_id as string | undefined;
  await db.end();
  if (!orgId) { console.log("SKIP: offer 62 not present in this DB"); process.exit(0); }

  await refreshOfferGroupReport(); // must not throw
  check("refresh completed", true);

  const rep = await getOfferGroupReport(orgId, 62);
  check("rows is array", Array.isArray(rep.rows));
  check("has benchmark", typeof rep.orgBenchmark.sends === "number");
  check("numbers are numeric", rep.rows.every(r =>
    typeof r.sends === "number" && typeof r.revenue === "number"));
  check("pressure <= 90d floor", rep.rows.every(r =>
    r.sent_7d <= r.sent_30d && r.sent_30d <= r.sent_90d));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx scripts/test-offer-group-report-helper.ts`
Expected: FAIL — cannot resolve import `../lib/reporting/offer-group-report` (module doesn't exist).

- [ ] **Step 3: Implement the helper**

Create `lib/reporting/offer-group-report.ts`:

```ts
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

export type RawMetrics = {
  sends: number;
  revenue: number;
  sales: number;
  clicks: number;
  cost: number;
  optouts: number;
};

export type GroupRawRow = RawMetrics & {
  group_id: number;
  group_name: string;
  sent_7d: number;
  sent_30d: number;
  sent_90d: number;
  fresh_pool: number;
};

export type OfferGroupReport = {
  rows: GroupRawRow[];
  orgBenchmark: RawMetrics;
  refreshedAt: string | null;
};

const ZERO: RawMetrics = { sends: 0, revenue: 0, sales: 0, clicks: 0, cost: 0, optouts: 0 };

// Read the precomputed report for one offer, org-scoped. Sorting is done client-side
// (tiny row set), so no ORDER BY here.
export async function getOfferGroupReport(
  orgId: string,
  offerId: number,
): Promise<OfferGroupReport> {
  const groupRows = (await db.execute(sql`
    select group_id, group_name, sends, revenue, sales, clicks, cost, optouts,
           sent_7d, sent_30d, sent_90d, fresh_pool
    from offer_group_report_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  const benchRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts
    from offer_report_org_summary_mv
    where org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];

  const logRows = (await db.execute(sql`
    select refreshed_at from report_refresh_log
    where view_name = 'offer_group_report_mv'
  `)) as unknown as { refreshed_at: string | null }[];

  const n = (v: unknown) => Number(v ?? 0);
  return {
    rows: groupRows.map((r) => ({
      group_id: n(r.group_id),
      group_name: String(r.group_name),
      sends: n(r.sends),
      revenue: n(r.revenue),
      sales: n(r.sales),
      clicks: n(r.clicks),
      cost: n(r.cost),
      optouts: n(r.optouts),
      sent_7d: n(r.sent_7d),
      sent_30d: n(r.sent_30d),
      sent_90d: n(r.sent_90d),
      fresh_pool: n(r.fresh_pool),
    })),
    orgBenchmark: benchRows[0]
      ? {
          sends: n(benchRows[0].sends),
          revenue: n(benchRows[0].revenue),
          sales: n(benchRows[0].sales),
          clicks: n(benchRows[0].clicks),
          cost: n(benchRows[0].cost),
          optouts: n(benchRows[0].optouts),
        }
      : { ...ZERO },
    refreshedAt: logRows[0]?.refreshed_at
      ? new Date(logRows[0].refreshed_at).toISOString()
      : null,
  };
}

// Rebuild both matviews (CONCURRENTLY — non-blocking) and stamp the refresh log.
// Called by the twice-daily cron. CONCURRENTLY must run outside a transaction, so
// each statement is its own execute() call.
export async function refreshOfferGroupReport(): Promise<void> {
  await db.execute(sql`refresh materialized view concurrently offer_report_org_summary_mv`);
  await db.execute(sql`refresh materialized view concurrently offer_group_report_mv`);
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now()
    where view_name in ('offer_group_report_mv', 'offer_report_org_summary_mv')
  `);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-offer-group-report-helper.ts`
Expected: PASS (or "SKIP" if offer 62 absent — acceptable; then verify manually against any offer id that has data).

- [ ] **Step 5: Validate refresh runtime (spec §10 risk gate)**

Run once, wrapped in timing:
`npx tsx -e "const t=Date.now();import('./lib/reporting/offer-group-report.ts').then(async m=>{await m.refreshOfferGroupReport();console.log('refresh ms:',Date.now()-t);process.exit(0)})"`
Expected: comfortably < 60000 ms. **If it approaches 60s, STOP and escalate** — fall back to non-`CONCURRENTLY` refresh (edit the two statements) or split `fresh` into its own matview before proceeding.

- [ ] **Step 6: Commit** (keep the helper test; delete the one-off smoke script from Task 1 Step 6 if still present)

```bash
git add lib/reporting/offer-group-report.ts scripts/test-offer-group-report-helper.ts
git commit -m "feat(reports): offer group report read + refresh helper"
```

---

## Task 3: API route `GET /api/offers/[id]/report`

**Files:**
- Create: `app/api/offers/[id]/report/route.ts`
- Test: `scripts/test-offer-group-report.ts`

**Interfaces:**
- Consumes: `getOfferGroupReport`, `RawMetrics`, `GroupRawRow` from Task 2; `requireApiMembership`, `apiError` from `@/lib/api/helpers`; `API_ERROR_CODES`; `can`.
- Produces the JSON contract (also the page's `ReportResponse` in Task 5):
  ```ts
  {
    offerName: string;
    rows: GroupRawRow[];
    offerTotals: RawMetrics;    // sum of rows (foots the table)
    orgBenchmark: RawMetrics;   // de-duplicated org-wide
    breakEvenPer1k: number | null; // offerTotals.cost / offerTotals.sends * 1000
    refreshedAt: string | null; // ISO
  }
  ```

- [ ] **Step 1: Write the failing E2E test**

Create `scripts/test-offer-group-report.ts` (mirror `scripts/test-offers-api.ts` auth/cookie-jar shape). Core:

```ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: {
        getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
        setAll: (cs) => cs.forEach((c) => cookieJar.set(c.name, c.value)),
      } },
  );
  await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!, password: process.env.TEST_USER_PASSWORD!,
  });
  const cookie = [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ");
  const apiFetch = (p: string) => fetch(`${BASE}${p}`, { headers: { cookie } });

  // [1] Unauthenticated → 401
  const anon = await fetch(`${BASE}/api/offers/62/report`);
  check("[1] anon rejected", anon.status === 401 || anon.status === 403, `got ${anon.status}`);

  // [2] Invalid id → 400
  const bad = await apiFetch(`/api/offers/not-a-number/report`);
  check("[2] invalid id -> 400", bad.status === 400, `got ${bad.status}`);

  // [3] Valid offer → 200 + shape
  const res = await apiFetch(`/api/offers/62/report`);
  check("[3] 200", res.status === 200, `got ${res.status}`);
  const body = await res.json();
  check("[4] has offerName", typeof body.offerName === "string");
  check("[5] rows array", Array.isArray(body.rows));
  check("[6] offerTotals + benchmark present",
    typeof body.offerTotals?.sends === "number" &&
    typeof body.orgBenchmark?.sends === "number");
  check("[7] breakEven derived",
    body.breakEvenPer1k === null || typeof body.breakEvenPer1k === "number");
  check("[8] rows carry no internal contact ids (names only)",
    body.rows.every((r: any) => typeof r.group_name === "string"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
```

- [ ] **Step 2: Run it to confirm it fails**

Run (dev server must be up on :3001): `npx tsx scripts/test-offer-group-report.ts`
Expected: FAIL — `[3] 200` fails (route 404s), downstream shape checks fail.

- [ ] **Step 3: Implement the route**

Create `app/api/offers/[id]/report/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { db } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { offers } from "@/db/schema";
import {
  getOfferGroupReport,
  type RawMetrics,
} from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const offerId = Number(id);
  if (!Number.isInteger(offerId) || offerId <= 0) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const [offer] = await db
    .select({ name: offers.name })
    .from(offers)
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);
  if (!offer) {
    return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, { entity: "offer" });
  }

  const report = await getOfferGroupReport(orgId, offerId);

  // offerTotals = sum of the visible group rows (foots the table; multi-group
  // campaigns counted fully in each group — same footnote as the rows).
  const offerTotals: RawMetrics = report.rows.reduce(
    (t, r) => ({
      sends: t.sends + r.sends,
      revenue: t.revenue + r.revenue,
      sales: t.sales + r.sales,
      clicks: t.clicks + r.clicks,
      cost: t.cost + r.cost,
      optouts: t.optouts + r.optouts,
    }),
    { sends: 0, revenue: 0, sales: 0, clicks: 0, cost: 0, optouts: 0 },
  );

  const breakEvenPer1k =
    offerTotals.sends > 0 ? (offerTotals.cost / offerTotals.sends) * 1000 : null;

  return NextResponse.json({
    offerName: offer.name,
    rows: report.rows,
    offerTotals,
    orgBenchmark: report.orgBenchmark,
    breakEvenPer1k,
    refreshedAt: report.refreshedAt,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-offer-group-report.ts`
Expected: PASS (8 checks). If offer 62 has no report rows in this DB, `[3]`–`[8]` still pass with empty `rows` (200 + shape holds).

- [ ] **Step 5: Commit**

```bash
git add app/api/offers/[id]/report/route.ts scripts/test-offer-group-report.ts
git commit -m "feat(reports): GET /api/offers/[id]/report endpoint + E2E test"
```

---

## Task 4: Refresh cron + vercel.json

**Files:**
- Create: `app/api/cron/refresh-offer-group-report/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `refreshOfferGroupReport` from Task 2; `CRON_SECRET` env.

- [ ] **Step 1: Write the failing test (extend the Task 3 script)**

Append to `scripts/test-offer-group-report.ts` before the summary print:

```ts
  // [9] Cron rejects without secret
  const noSecret = await fetch(`${BASE}/api/cron/refresh-offer-group-report`);
  check("[9] cron 401 without secret", noSecret.status === 401, `got ${noSecret.status}`);

  // [10] Cron accepts with secret + advances the log timestamp
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const ok = await fetch(`${BASE}/api/cron/refresh-offer-group-report`, {
      headers: { "x-cron-secret": secret },
    });
    check("[10] cron 200 with secret", ok.status === 200, `got ${ok.status}`);
  } else {
    console.log("… [10] skipped (no CRON_SECRET in env)");
  }
```

- [ ] **Step 2: Run to confirm `[9]`/`[10]` fail**

Run: `npx tsx scripts/test-offer-group-report.ts`
Expected: `[9]` fails (route 404 not 401), `[10]` fails.

- [ ] **Step 3: Implement the cron route**

Create `app/api/cron/refresh-offer-group-report/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";

import { refreshOfferGroupReport } from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";
// Task 2 measured the full CONCURRENTLY refresh at ~50s worst-case (cold) / ~37s
// warm. 60s left no cold-start headroom, so this cron gets a larger budget. It is
// a background job (not user-facing), so a longer ceiling costs nothing.
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await refreshOfferGroupReport();
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
```

- [ ] **Step 4: Register the cron in `vercel.json`**

Add this entry to the `crons` array (fixed-UTC 05:00 & 20:00 ≈ midnight & 3 PM ET; ~1h DST drift is acceptable per spec §5):

```json
{ "path": "/api/cron/refresh-offer-group-report", "schedule": "0 5,20 * * *" }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx scripts/test-offer-group-report.ts`
Expected: PASS including `[9]` and `[10]`.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/refresh-offer-group-report/route.ts vercel.json scripts/test-offer-group-report.ts
git commit -m "feat(reports): twice-daily cron to refresh offer group report matviews"
```

---

## Task 5: Report page UI

**Files:**
- Create: `app/(protected)/offers/[id]/report/page.tsx`

**Interfaces:**
- Consumes: the API contract from Task 3; `useApiCall` from `@/lib/hooks/use-api-call`; `formatCampaignDateTime` from `@/lib/campaign-timezone`; `useParams` from `next/navigation`.

- [ ] **Step 1: Implement the page**

Create `app/(protected)/offers/[id]/report/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";

type RawMetrics = {
  sends: number; revenue: number; sales: number; clicks: number; cost: number; optouts: number;
};
type GroupRawRow = RawMetrics & {
  group_id: number; group_name: string;
  sent_7d: number; sent_30d: number; sent_90d: number; fresh_pool: number;
};
type ReportResponse = {
  offerName: string;
  rows: GroupRawRow[];
  offerTotals: RawMetrics;
  orgBenchmark: RawMetrics;
  breakEvenPer1k: number | null;
  refreshedAt: string | null;
};

// ---- formatting ----
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const int = new Intl.NumberFormat("en-US");
const fmtUsd = (n: number | null) => (n == null ? "—" : usd.format(n));
const fmtInt = (n: number) => int.format(n);
const fmtNum = (n: number | null, dp = 2) => (n == null ? "—" : n.toFixed(dp));
const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

// ---- derived ratios (uniform for group rows, offer total, benchmark) ----
type Derived = { rpm: number | null; net_rpm: number | null; epc: number | null; net_profit: number; oo_pct: number | null };
function derive(m: RawMetrics): Derived {
  const rpm = m.sends > 0 ? (m.revenue / m.sends) * 1000 : null;
  const net_rpm = m.sends > 0 ? ((m.revenue - m.cost) / m.sends) * 1000 : null;
  const epc = m.clicks > 0 ? m.revenue / m.clicks : null;
  const oo_pct = m.sends > 0 ? (m.optouts / m.sends) * 100 : null;
  return { rpm, net_rpm, epc, net_profit: m.revenue - m.cost, oo_pct };
}

type SortKey =
  | "group_name" | "sends" | "rpm" | "net_rpm" | "epc" | "sales"
  | "oo_pct" | "net_profit" | "sent_7d" | "sent_30d" | "sent_90d" | "fresh_pool";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "group_name", label: "Group", numeric: false },
  { key: "sends", label: "Sends", numeric: true },
  { key: "rpm", label: "RPM", numeric: true },
  { key: "net_rpm", label: "Net RPM", numeric: true },
  { key: "epc", label: "EPC", numeric: true },
  { key: "sales", label: "Sales", numeric: true },
  { key: "oo_pct", label: "Opt-out %", numeric: true },
  { key: "net_profit", label: "Net profit", numeric: true },
  { key: "sent_7d", label: "Sent 7d", numeric: true },
  { key: "sent_30d", label: "Sent 30d", numeric: true },
  { key: "sent_90d", label: "Sent 90d", numeric: true },
  { key: "fresh_pool", label: "Fresh pool", numeric: true },
];

type ViewRow = GroupRawRow & Derived;

export default function OfferGroupReportPage() {
  const params = useParams<{ id: string }>();
  const offerId = params.id;
  const api = useApiCall<ReportResponse>();
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("net_rpm");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const load = useCallback(async () => {
    setError(null);
    const res = await api.execute(`/api/offers/${offerId}/report`);
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, [api.execute, offerId]);

  useEffect(() => { void load(); }, [load]);

  const viewRows: ViewRow[] = useMemo(
    () => (data?.rows ?? []).map((r) => ({ ...r, ...derive(r) })),
    [data],
  );

  const sorted = useMemo(() => {
    const rows = [...viewRows];
    rows.sort((a, b) => {
      let cmp: number;
      if (sortBy === "group_name") cmp = a.group_name.localeCompare(b.group_name);
      else {
        const av = a[sortBy] as number | null;
        const bv = b[sortBy] as number | null;
        // nulls sort last regardless of direction
        if (av == null && bv == null) cmp = 0;
        else if (av == null) return 1;
        else if (bv == null) return -1;
        else cmp = av - bv;
      }
      if (cmp === 0) cmp = a.group_id - b.group_id;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [viewRows, sortBy, sortDir]);

  const breakEven = data?.breakEvenPer1k ?? null;
  const offerTotal = data ? { ...data.offerTotals, ...derive(data.offerTotals) } : null;
  const benchmark = data ? { ...data.orgBenchmark, ...derive(data.orgBenchmark) } : null;

  const netRpmClass = (v: number | null) =>
    v == null ? "" : breakEven != null && v >= breakEven ? "text-emerald-600" : "text-destructive";
  const ooClass = (v: number | null) =>
    v == null ? "" : v <= 2 ? "text-emerald-600" : v <= 3 ? "text-amber-600" : "text-destructive";

  function toggleSort(key: SortKey) {
    if (key === sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(key); setSortDir(key === "group_name" ? "asc" : "desc"); }
  }

  function exportCsv() {
    if (!data) return;
    const header = COLUMNS.map((c) => c.label);
    const line = (label: string, m: RawMetrics & Derived) => [
      label, m.sends, fmtNum(m.rpm), fmtNum(m.net_rpm), fmtNum(m.epc), m.sales,
      fmtNum(m.oo_pct), m.net_profit.toFixed(2),
      "sent_7d" in m ? (m as ViewRow).sent_7d : "",
      "sent_30d" in m ? (m as ViewRow).sent_30d : "",
      "sent_90d" in m ? (m as ViewRow).sent_90d : "",
      "fresh_pool" in m ? (m as ViewRow).fresh_pool : "",
    ];
    const rows = [
      header,
      ...(benchmark ? [line("All offers (org-wide)", benchmark as ViewRow)] : []),
      ...sorted.map((r) => line(r.group_name, r)),
      ...(offerTotal ? [line("This offer · all groups", offerTotal as ViewRow)] : []),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `offer-${offerId}-group-report.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function MetricCells({ m, isGroup }: { m: RawMetrics & Derived; isGroup: boolean }) {
    return (
      <>
        <td className="px-3 py-2 text-right tabular-nums">{fmtInt(m.sends)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.rpm)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${netRpmClass(m.net_rpm)}`}>{fmtUsd(m.net_rpm)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.epc)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtInt(m.sales)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${ooClass(m.oo_pct)}`}>{fmtPct(m.oo_pct)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.net_profit)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).sent_7d) : "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).sent_30d) : "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).sent_90d) : "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).fresh_pool) : "—"}</td>
      </>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link href="/offers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
            <ArrowLeft className="size-4" /> Offers
          </Link>
          <h1 className="text-xl font-semibold">
            Group Report{data ? ` — ${data.offerName}` : ""}
          </h1>
          <p className="text-xs text-muted-foreground">
            Data as of {data ? formatCampaignDateTime(data.refreshedAt) : "…"}
            {breakEven != null ? ` · break-even ${fmtUsd(breakEven)}/1k` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={api.isLoading}>
            <RefreshCw className={`size-4 ${api.isLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data}>
            <Download className="size-4" /> CSV
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className={`cursor-pointer select-none px-3 py-2 font-medium ${c.numeric ? "text-right" : "text-left"}`}
                >
                  {c.label}{sortBy === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {benchmark ? (
              <tr className="border-t bg-muted/30 font-medium">
                <td className="px-3 py-2">All offers (org-wide)</td>
                <MetricCells m={benchmark} isGroup={false} />
              </tr>
            ) : null}
            {sorted.map((r) => (
              <tr key={r.group_id} className="border-t">
                <td className="px-3 py-2">{r.group_name}</td>
                <MetricCells m={r} isGroup />
              </tr>
            ))}
            {offerTotal ? (
              <tr className="border-t bg-muted/30 font-medium">
                <td className="px-3 py-2">This offer · all groups</td>
                <MetricCells m={offerTotal} isGroup={false} />
              </tr>
            ) : null}
            {data && sorted.length === 0 ? (
              <tr className="border-t">
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-muted-foreground">
                  No group data for this offer yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        A campaign targeting multiple groups is counted fully in each group, so group
        rows may sum to more than the org-wide total. “Sent last 7/30/90d” and “Fresh
        pool” count every in-app send (tracked or manual link mode); sends performed
        entirely outside the app (count-only, no per-recipient record) aren’t included.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Verify build + typecheck**

Run: `npm run lint` (or `npx tsc --noEmit` if available)
Expected: no type errors in the new file.

- [ ] **Step 3: Manual verification (dev server on :3001)**

Navigate to `http://localhost:3001/offers/62/report`. Confirm: table renders, top "All offers" row + bottom "This offer" row are visually distinct, Net RPM cells are green/red vs break-even, opt-out % green/amber/red, clicking a header re-sorts, Refresh re-fetches, CSV downloads. (Use the `/run` skill or Playwright MCP to drive + screenshot.)

- [ ] **Step 4: Commit**

```bash
git add "app/(protected)/offers/[id]/report/page.tsx"
git commit -m "feat(reports): offer group report page (sortable table, pinned summary rows, CSV)"
```

---

## Task 6: Offers-list entry point

**Files:**
- Modify: `app/(protected)/offers/page.tsx`

- [ ] **Step 1: Add the `Link` import**

At the top of `app/(protected)/offers/page.tsx`, add (it is not currently imported):

```ts
import Link from "next/link";
```

- [ ] **Step 2: Add the "Group Report" link in the actions cell**

In the `actions` column `cell` (around lines 423–478), replace the opening of the returned `<div className="flex justify-end">` so the link sits **before** the `<DropdownMenu>`, and make the row always render the link even when the dropdown would be empty. Change:

```tsx
    const showRestore = offer.status === "archived" && canRestore;
    if (!showEdit && !showArchive && !showRestore) return null;
    return (
      <div className="flex justify-end">
        <DropdownMenu>
```

to:

```tsx
    const showRestore = offer.status === "archived" && canRestore;
    return (
      <div className="flex items-center justify-end gap-1">
        <Link
          href={`/offers/${offer.id}/report`}
          onClick={(e) => e.stopPropagation()}
          className="text-sm font-medium text-primary hover:underline"
        >
          Group Report
        </Link>
        {showEdit || showArchive || showRestore ? (
          <DropdownMenu>
```

Then close the new conditional: find the matching `</DropdownMenu>` that ends this block and add `) : null}` immediately after it, before the closing `</div>`. The end of the block becomes:

```tsx
          </DropdownMenuContent>
        </DropdownMenu>
        ) : null}
      </div>
    );
```

(The `onClick={(e) => e.stopPropagation()}` prevents the row's edit-dialog `onRowClick` from firing — the established pattern in this file.)

- [ ] **Step 3: Manual verification**

Reload `http://localhost:3001/offers`. Every offer row shows a "Group Report" link before the ⋯ menu; clicking it navigates to that offer's report and does NOT open the edit dialog.

- [ ] **Step 4: Commit**

```bash
git add "app/(protected)/offers/page.tsx"
git commit -m "feat(offers): Group Report link on each offer row"
```

---

## Task 7: End-to-end verification pass

- [ ] **Step 1: Full test script green**

Ensure the dev server is running on :3001, matviews are freshly refreshed (`[10]` in the test does this), then run:
`npx tsx scripts/test-offer-group-report.ts`
Expected: all checks pass (`10 passed, 0 failed`).

- [ ] **Step 2: Spec acceptance spot-checks (spec §9)**

Query the live matview for offer 62 and eyeball vs the brief's shape (Memory highest RPM, Manifestation highest opt-out). Confirm a two-group campaign appears in both group rows, and the org-benchmark totals are NOT equal to the sum of group rows when a multi-group campaign exists. Note in the PR description that absolute sales differ from the brief's Keitaro-only figures by design (Keitaro+manual `max`).

- [ ] **Step 3: Commit any fixes, then proceed to docs.**

---

## Task 8: Documentation (part of "done" — CLAUDE.md)

**Files:**
- Modify: `docs/03-data-model.md` (+ its Mermaid ERD)
- Create: `docs/04-features/offer-group-report.md`
- Modify: `docs/06-integrations.md`
- Modify: `docs/07-conventions.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Data model** — in `docs/03-data-model.md`, add a subsection documenting the new `report_refresh_log` table and the two materialized views + the `offer_report_campaign_econ` view, with column lists and the note that matviews carry no RLS (server-only, route-scoped). Add the three objects to the Mermaid ERD (or a note that matviews are derived, not base tables, if the ERD only shows base tables). Bump the "last updated" date.

- [ ] **Step 2: Feature doc** — create `docs/04-features/offer-group-report.md` covering: purpose, entry point (`/offers/[id]/report`), the exact metric definitions (copy spec §3 table), the manual-campaign inclusion + per-contact-column limitation, the twice-daily refresh + DST drift, and the files involved (route, helper, cron, page, migration 0093).

- [ ] **Step 3: Integrations** — in `docs/06-integrations.md`, add the new Vercel cron `/api/cron/refresh-offer-group-report` (`0 5,20 * * *`, `CRON_SECRET`-gated, `maxDuration=60`) to the cron list.

- [ ] **Step 4: Conventions** — in `docs/07-conventions.md`, record: (a) sales = per-stage `max(Keitaro, manual)` never summed; (b) Sends = link_mode-based (tracked→stage_sends, manual→sms_count); (c) multi-group campaigns counted fully in each group; (d) matview refresh DST drift; (e) per-contact columns count every in-app per-recipient send (both link modes); only fully-external `sms_count`-only sends are excluded.

- [ ] **Step 5: Changelog** — append to `docs/CHANGELOG.md`:
`2026-07-08 — Added per-offer Group Performance Report (matviews + twice-daily cron) — docs/03-data-model, 04-features/offer-group-report, 06-integrations, 07-conventions`

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs(reports): document offer group report (data model, feature, cron, conventions)"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §1 purpose → whole plan; §2 scope incl. manual inclusion + per-contact limitation → Task 1 SQL (`link_mode` sends, list_pressure/fresh tracked-only) + Task 5 footnote; §3 metric defs → Task 1 view/matview SQL (LOCKED); §4 data layer → Task 1; §5 cron → Task 4; §6 API → Task 3; §7 UI (columns, sort, summary rows, colors, CSV, entry point) → Tasks 5–6; §8 docs → Task 8; §9 verification → Tasks 2/3/7; §10 refresh-runtime risk → Task 2 Step 5 gate. All covered.
- **Placeholder scan:** none — every code/SQL step is complete.
- **Type consistency:** `RawMetrics` / `GroupRawRow` defined in Task 2, re-exported through Task 3's contract, mirrored verbatim in Task 5. `getOfferGroupReport(orgId, offerId)` / `refreshOfferGroupReport()` signatures consistent across Tasks 2–4. Matview column names identical between Task 1 DDL and Task 2 reads.
