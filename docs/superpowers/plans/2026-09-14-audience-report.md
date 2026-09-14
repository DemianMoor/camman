# Audience Report Implementation Plan

> **For agentic workers:** executed inline in the session that wrote it (user said "go ahead and implement"). The code files named below are the source of truth; this plan fixes task boundaries, interfaces, and the verification gates. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `/reports/audience` ("Audience Stats") tab: pick a contact group, see one row per offer (archived included) with the offer report's metrics, plus an accurate "This group · all offers" row.

**Architecture:** Offer rows are `offer_group_report_mv` filtered to one group. The totals row comes from a new matview `audience_report_group_totals_mv` (migration 0180). It sums the additive cell columns and recomputes clicks/opt-outs distinct at group grain. The existing twice-daily cron refreshes it last.

**Tech Stack:** Next.js 16 App Router · Drizzle raw `sql` · Postgres materialized views · shadcn/ui · `SearchableSelect`.

**Spec:** [docs/superpowers/specs/2026-09-14-audience-report-design.md](../specs/2026-09-14-audience-report-design.md)

## Global Constraints

- Every query filters `org_id`; matviews have no RLS, so the helper filter is the only defense.
- No status filter on offers or groups anywhere in the read path (archived must show).
- Clicks and opt-outs are never summed across offers; the totals row reads them from the matview.
- Permission `campaigns.view`; route-map entry `"reports/audience": { methods: ["GET"], token: ["GET"] }`.
- UI label "Audience Stats" (a nav *group* is already named "Audience"); route `/reports/audience`.
- Migration is hand-authored (SQL + cloned snapshot with bumped `id`/`prevId` + journal). It is applied to prod **only with user approval**, after the file is committed.
- Timestamps are displayed via `formatCampaignDateTime`.

---

### Task 1: Migration 0180

**Files:**
- Create: `db/migrations/0180_audience_report_group_totals.sql`
- Create: `db/migrations/meta/0180_snapshot.json`: clone of 0179 with `id` `0180a000-0180-4180-8180-000000000180` and `prevId` `0179a000-0179-4179-8179-000000000179`
- Modify: `db/migrations/meta/_journal.json`: add `{ idx: 180, version: "7", when: 1791936000000, tag: "0180_audience_report_group_totals", breakpoints: true }`

**Produces:** `audience_report_group_totals_mv (org_id, group_id, sends, revenue, sales, clicks, cost, optouts, sent_7d, sent_30d, sent_90d)`, UNIQUE `(org_id, group_id)`, revoked from anon/authenticated, and a `report_refresh_log` row seeded NULL.

- [ ] Write the SQL (spec §4.1 plus index, revoke, and seed).
- [ ] Clone the snapshot and add the journal entry with node (no BOM).
- [ ] Time the defining SELECT on prod with `EXPLAIN ANALYZE` (read-only). Expect a few seconds.
- [ ] Commit.

### Task 2: Read helper + refresh wiring

**Files:**
- Modify: `lib/reporting/offer-group-report.ts`
  - export `readOrgBenchmark(orgId)` and `readGroupReportRefreshedAt()`, used by `getOfferGroupReport` too
  - refresh the new matview last and stamp its log row
  - `RefreshDurations.audienceTotalsMs`
- Modify: `app/api/cron/refresh-offer-group-report/route.ts`: log `audienceTotalsMs`
- Create: `lib/reporting/audience-report.ts`

**Produces:**
- `getAudienceGroups(orgId: string): Promise<AudienceGroupOption[]>`, where `AudienceGroupOption = { id: number; name: string; archived: boolean }`
- `getAudienceReport(orgId: string, groupId: number): Promise<AudienceReport>`, where `AudienceReport = { rows: AudienceOfferRow[]; groupTotals: AudienceGroupTotals; orgBenchmark: RawMetrics; benchmarkHasManual: boolean; refreshedAt: string | null }`
- `AudienceOfferRow = RawMetrics & SentWindows & { offer_id; offer_name; offer_archived; fresh_pool }`
- `AudienceGroupTotals = RawMetrics & SentWindows`
- `SentWindows = { sent_7d; sent_30d; sent_90d }`

- [ ] Implement, `tsc --noEmit` clean, commit.

### Task 3: API route

**Files:**
- Create: `app/api/reports/audience/route.ts`
- Modify: `lib/authz/route-map.ts`

**Behavior:**
- `GET ?group_id` absent → `{ groups, report: null }`.
- Non-positive-int → 400. Group not in org → 404.
- Otherwise → `{ groups, report: { groupId, groupName, groupArchived, ...AudienceReport, breakEvenPer1k } }`.

- [ ] Implement; `npm run check:authz` passes; commit.

### Task 4: UI

**Files:**
- Create: `components/reports/report-metrics.tsx`, holding the pure helpers moved out of the offer report page: formatters, `derive`/`Derived`, `netRpmClass`, `ooClass`, `ManualMix`, `StaleBanner`, `downloadCsv`
- Modify: `app/(protected)/offers/[id]/report/page.tsx` to import them, rendering unchanged
- Create: `components/reports/audience-report.tsx`, `app/(protected)/reports/audience/page.tsx`
- Modify: `components/reports/reports-tabs.tsx`, `components/protected/nav-config.ts`, `app/(protected)/reports/layout.tsx`

- [ ] Implement; `tsc` and eslint on changed files (offer page compared against a baseline); commit.

### Task 5: Verify script

**Files:** Create `scripts/verify-audience-report.ts`, which prints its input scope and runs checks V2a–f from the spec:
- a. Totals equal the sums over cells; skips if the refresh order is off.
- b. In one REPEATABLE READ snapshot, the **shipped** totals definition (read from `pg_matviews`) against live cell-grain counts: `max ≤ group ≤ sum`; the stored totals are also checked against `max(stored cell)`.
- c. Opt-out recipient invariant.
- d. Helper rows equal the matview offer set for every group.
- e. A foreign org gets nothing.
- f. No anon/authenticated SELECT; the log row exists.

- [ ] Implement; commit. (Runs against prod only after 0180 is applied.)

### Task 6: Docs

**Files:**
- `docs/04-features/audience-report.md` (new)
- `docs/03-data-model.md`
- `docs/04-features/crons.md`
- `docs/04-features/offer-group-report.md`
- `docs/07-conventions.md`
- `docs/security-notes.md`
- `docs/CHANGELOG.md`

- [ ] Write; commit.

### Task 7: Ship

- [ ] Run `tsc`, eslint on changed files, `npm run check:authz`, and `next build`.
- [ ] Push the branch and open a PR. The preview auto-applies 0180 on camman-v2; confirm the matview exists there.
- [ ] Playwright on the PR preview (spec V4).
- [ ] **Ask the user** to apply 0180 to prod. Then run `npm run db:migrate` and `verify-migration-integrity.ts`, and run `verify-audience-report.ts` on prod.
- [ ] Merge, confirm the prod deploy is READY, and smoke-test `/api/reports/audience` plus the page.
