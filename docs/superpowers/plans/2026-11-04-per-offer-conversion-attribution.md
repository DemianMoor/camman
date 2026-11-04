# Per-offer conversion attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversion is reported under the CamMan offer it actually converted on (mapped from its Keitaro offer id), so one SMS stage whose landing page splits traffic across several offers shows each offer separately, while every campaign and stage total stays exactly as today.

**Architecture:** Attribution is decided once, at ingest, in `conversion_events.offer_id` (Phase 1). Stage-grain reports keep reading `keitaro_stage_results` unchanged and apply a thin "offer split" layer that moves the ledger amounts belonging to another offer from the stage's campaign-offer slice to that offer's slice, so slices always sum to the stage (Phase 2). The offer report / Audience Stats matviews switch their join to the conversion's offer (Phase 3, migration). "Bought offer X" targeting moves to the conversion's offer last, as its own phase (Phase 4).

**Tech Stack:** Next.js 16, TypeScript, Drizzle + raw SQL, Postgres (Supabase), tsx scripts (no test runner — `check()` scripts, pure or camman-v2).

**Spec:** owner decisions 2026-11-03/04 on ClickUp card 1amdve2abbm and in the session that produced this plan:
- (a) attribute to the CamMan offer mapped from the conversion's Keitaro offer id; fall back to the campaign's offer when there is no mapping.
- By-offer reports show each offer separately; campaign/stage totals unchanged. General for any multi-offer prelander.
- A second offer's row shows "—" for EPC, ROI and cost, with a tooltip. No cost splitting.
- Link all nine Keitaro offers: 1→62, 11→76, 12→77, 17→82, 33→123, 34→124, 48→142, 61→152, 66→158 (archived targets included). Already linked: 41→134, 78→170, 79→171.
- Targeting ("a sale on offer X counts as buying offer X" for exclusions, segments, Offer Group exposure) is a SEPARATE phase, only after Phases 1–3 are live and the owner has reviewed the by-offer numbers.
- Prod backfill (Phase 1) and the summary-table migration (Phase 3) each need a separate owner "go". Dry-run only until then.

## Global Constraints

- Read code from `origin/main`; work in a throwaway worktree (docs/07-conventions.md "Working copy").
- Every query filters by `org_id` (CLAUDE.md §3). A Keitaro-offer mapping is used only when the mapped offer is in the SAME org as the stage.
- A Keitaro offer id linked to more than one CamMan offer in an org is ambiguous and is NOT used (existing `ambiguousOffers` rule in `lib/conversions/ingest.ts:106-110`).
- DB tests run on camman-v2 only (`scripts/_require-preview-db.ts`); prod is touched only by the read-only verify script and by the two gated applies.
- Next free migration number: rebase on origin/main when the file is created (0231 at the time of writing).
- Any recreated view carries `security_invoker = true` and the REVOKEs 0183 added.
- Docs: `docs/04-features/conversion-events.md`, `docs/04-features/reports-rollup.md`, `docs/03-data-model.md` (Phase 3), `docs/07-conventions.md`, `docs/CHANGELOG.md` in the same PR as the code.

## Review Focus

1. **A split stage with a manual sales tally** (`campaign_stages.sales_count` > tracker sales): the campaign-offer slice must never go negative; the manual top-up stays on the campaign offer. → Task 4, test S6.
2. **A conversion whose Keitaro offer maps to a CamMan offer in ANOTHER org** must keep the stage's offer. → Task 1, test R2.
3. **An offer that is primary on some stages and secondary on others** (mixed row): EPC/ROI must use only the revenue its own traffic produced, not revenue moved in from other stages. → Task 5, test P3.
4. **Unlinking a Keitaro offer later** must move rows back to the campaign offer on the next ingest (inside the 7-day window) and via the backfill (older). → Task 2, test U3; Task 3 handles both directions.
5. **A conversion with no stage** (resolved only via `offers.keitaro_offer_id`) is already attributed to that offer today and must not change. → Task 1, test R6.

---

## Phase 1 — Attribution in the ledger (code + gated prod backfill)

### Task 1: Resolve the conversion's offer from its Keitaro offer id

**Files:**
- Modify: `lib/conversions/build-rows.ts` (`buildConversionEventRows`, the `if (stage)` branch)
- Test: `scripts/test-conversion-ledger-rows.ts` (pure)

**Interfaces:**
- Consumes: `Lookups.offersByKeitaroId: Map<number, { orgId; offerId; affiliateNetworkId }>` (already loaded for every row's Keitaro offer id, ambiguous ids removed).
- Produces: `export function resolveConversionOffer(stage: { orgId: string; offerId: number | null; affiliateNetworkId: number | null }, keitaroOfferId: number | null, lookups: Pick<Lookups, "offersByKeitaroId">): { offerId: number | null; affiliateNetworkId: number | null; source: "keitaro_offer" | "campaign" }` in `lib/conversions/build-rows.ts`. `buildConversionEventRows` uses it for the stage path; the resolved `affiliateNetworkId` feeds `resolveMapping`, so the rules of the offer the user actually converted on apply.

- [ ] **Step 1: Write the failing tests** (`R1`–`R6`, each building one source row + lookups and asserting `rows[0].offerId` and the mapping used):
  - `R1` stage offer 10 (network 1), Keitaro offer 78 → offer 20 (network 2) same org ⇒ `offerId 20`, rule resolved on network 2 (give network 2 a `sale` rule with a different event type and assert that type).
  - `R2` Keitaro offer maps to an offer in another org ⇒ `offerId 10`.
  - `R3` Keitaro offer not in the map ⇒ `offerId 10`.
  - `R4` `keitaroOfferId` null ⇒ `offerId 10`.
  - `R5` Keitaro offer maps to offer 10 itself ⇒ `offerId 10`, `source "keitaro_offer"`.
  - `R6` no stage, Keitaro offer mapped ⇒ unchanged from today (`offerId` = mapped offer).
- [ ] **Step 2:** `npx tsx scripts/test-conversion-ledger-rows.ts` → R1, R2-with-network, R5 FAIL (R2–R4, R6 pass on today's code).
- [ ] **Step 3:** Implement `resolveConversionOffer` and use it in the stage branch.
- [ ] **Step 4:** Re-run → all pass (existing 38 + 6).
- [ ] **Step 5:** Commit `feat(conversions): attribute a conversion to the offer mapped from its Keitaro offer`.

### Task 2: Offer attribution follows the current mapping on re-ingest

**Files:**
- Modify: `lib/conversions/ingest.ts` (`upsertConversionEvents` `set:` block, `offer_id` line; also the "no-op writes are skipped" comparison so an offer change is not skipped)
- Test: `scripts/test-conversion-events-upsert.ts` (camman-v2, rolled back)

**Interfaces:**
- Produces: `offer_id: sql\`COALESCE(excluded.offer_id, conversion_events.offer_id)\`` — the newly resolved offer wins; a null never erases one. Every other sticky field is unchanged.

- [ ] **Step 1: Write the failing tests:** `U1` existing row offer A, upsert same event with offer B ⇒ stored B; `U2` upsert with offer null ⇒ stays B; `U3` upsert back to A (mapping removed) ⇒ A; `U4` an offer change alone is written (not skipped as a no-op) and bumps `updated_at`.
- [ ] **Step 2:** Run on camman-v2 → U1, U3, U4 FAIL.
- [ ] **Step 3:** Change the `set` line and the no-op comparison.
- [ ] **Step 4:** Run → all pass (17 existing + 4).
- [ ] **Step 5:** Commit `feat(conversions): offer attribution is recomputed, not sticky`.

### Task 3: Backfill script for existing rows (dry-run default)

**Files:**
- Create: `scripts/backfill-conversion-offer-attribution.ts`
- Modify: `scripts/test-preview-db-guard.ts` (exclusion entry, reason: "one-shot production backfill; writes only behind --apply, attended, after owner go")
- Test: `scripts/test-offer-attribution-backfill-db.ts` (camman-v2, rolled back)

**Interfaces:**
- Produces: CLI `npx tsx scripts/backfill-conversion-offer-attribution.ts [--org <uuid>] [--apply]`.
  - Dry run prints: rows moving grouped by `(from offer, to offer, keitaro_offer_id)`; per-offer before → after (rows, sales via `purchasedClause("ce")`, approved revenue via `approvedRevenueClause("ce")`); per-campaign totals before vs after (must be identical — exit 1 if any differs).
  - `--apply`: ONE transaction, `SET LOCAL lock_timeout = '5s'`, a single `UPDATE conversion_events … SET offer_id = <target>, updated_at = now()` for rows whose target (same rule as Task 1: unambiguous same-org mapping else the campaign's offer) differs; re-reads and asserts the moved count equals the dry run. `updated_at = now()` makes the stage-day projection re-project those stages.
  - Moves in BOTH directions (a row on a mapped offer whose mapping was removed returns to the campaign offer).

- [ ] **Step 1: Write the failing test:** fixture org with 2 offers + mapping, a stage on offer A, 3 ledger rows (2 Keitaro offer A, 1 Keitaro offer B); assert dry run reports 1 row A→B, campaign totals equal; `--apply` moves exactly 1; a second dry run reports 0.
- [ ] **Step 2:** Run → FAIL (script missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → pass; `npm run check:guards` → pass.
- [ ] **Step 5:** Commit `feat(conversions): offer attribution backfill (dry run by default)`.

### Phase 1 ship and gated apply

- [ ] PR → green (`guards`) → merge → prod deploy on the merge SHA. Live ingest now attributes NEW conversions; existing rows unchanged.
- [ ] Prod dry run of Task 3 (read-only) with the nine mappings applied *in a rolled-back transaction*; post the report. Expected: 34 rows, $2,105.90 (62 −7/+11, 76 −11/+7, 77 −4, 82 +4, 123 −6, 124 +6, 142 −1, 152 −5, 158 +6).
- [ ] **STOP — owner go #1.** Then, attended: link the nine Keitaro offers (`UPDATE offers SET keitaro_offer_id = …` guarded on `keitaro_offer_id IS NULL`), run the backfill `--apply`, re-run the dry run (0 rows), and after the next projection tick confirm per-campaign totals unchanged.

---

## Phase 2 — By-offer reports (code, no migration)

### Task 4: Offer split layer

**Files:**
- Create: `lib/reporting/offer-splits.ts`
- Test: `scripts/test-offer-splits.ts` (pure) and `scripts/test-offer-splits-db.ts` (camman-v2)

**Interfaces:**
- Produces:
  - `export interface OfferSplit { stage_id: number; offer_id: number; sales: number; revenue: number; pending_revenue: number; events: EventMap }` — ledger amounts on that stage whose `ce.offer_id` differs from the stage's campaign offer.
  - `export async function getOfferSplits(orgId: string, stageIds: number[], b: { fromEt: string; toEt: string } | null): Promise<OfferSplit[]>` — one grouped query over `conversion_events` (`org_id`, `stage_id IN`, `offer_id IS DISTINCT FROM campaigns.offer_id`), dated by `occurred_at` in ET exactly like the stage-day projection; uses `purchasedClause`, `approvedRevenueClause`, `pendingRevenueClause` and the per-event aggregation of `lib/reporting/event-columns.ts`. `null` range = lifetime.
  - `export function splitStageMetrics(campaignOfferId: number | null, m: PerfMetrics, splits: OfferSplit[]): { offer_id: number | null; metrics: PerfMetrics; secondary: boolean }[]` — pure. The campaign-offer slice keeps sent, clickers, counted/lifetime clickers, cost, opt-outs, reach, manual_topup, unmapped, and gets `sales/revenue/pending_revenue/events` minus Σ splits; each split becomes a `secondary: true` slice with only those four fields. Sets `split_out_revenue` on the primary slice and `split_in_revenue` on each secondary slice (Task 5 fields).
- **Invariant (the bar):** for every numeric field and every `events[key]` field, Σ slices = `m` exactly.

- [ ] **Step 1: Write the failing pure tests:** `S1` no splits ⇒ one slice identical to `m`; `S2` one split ⇒ two slices, Σ = `m` field-by-field; `S3` two splits to two offers; `S4` events map moves by key (a `lead` and a `purchase`); `S5` `campaignOfferId` null ⇒ still sums; `S6` split amounts larger than the tracker part (manual tally case) ⇒ campaign slice never negative: the function returns the unsplit stage and reports `skipped: "would_go_negative"` (log, never silently clamp).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement both functions.
- [ ] **Step 4: DB test:** fixture split stage on camman-v2; `getOfferSplits` returns the moved rows only, respects the ET date window and org.
- [ ] **Step 5:** Commit `feat(reports): offer split layer`.

### Task 5: Wire the split into every by-offer reader + "—" rendering

**Files:**
- Modify: `lib/reporting/performance-report.ts` — `PerfMetrics` (+ `split_in_revenue: number; split_out_revenue: number`, both in `ZERO`, `addMetrics`, `scaleMetrics`), `groupByStageDimension` (offer dimension), `groupByCreativeOffer`, the `offerId` filter / offer totals path (~:349, :395); `app/api/reports/performance/route.ts` (`offer_totals`); `lib/reporting/creative-lifetime.ts`; `lib/creatives/metrics-cache.ts` (offer GROUPING SETS); `lib/reporting/landing-page-report.ts` (stages picked by `c.offer_id` — also include stages with conversions split to this offer, and count conversions by `ce.offer_id`).
- Modify: EPC/ROI numerators — `lib/keitaro/funnel.ts` `withFunnelDerived` and `components/reports/performance-report.tsx` (period + lifetime EPC, ROI, cost cells).
- Test: `scripts/test-offer-split-report-db.ts` (camman-v2) + extend `scripts/test-event-columns-view.ts` with the "—" rendering bar.

**Interfaces:**
- Consumes: Task 4 (`getOfferSplits`, `splitStageMetrics`).
- Produces: EPC and ROI numerator for any `PerfRow` = `revenue − split_in_revenue + split_out_revenue` (revenue its own traffic produced). A row with `sent === 0 && split_in_revenue > 0` renders "—" for EPC, ROI and cost, with tooltip copy exactly: **"This offer's sales here came through another offer's landing page, so they have no sends or cost of their own."**
- Rows not touched by a split are byte-identical to today.

- [ ] **Step 1: Write the failing DB tests:** `P1` By Offer on a fixture with one split stage: two offer rows; Σ sales/revenue across rows = the stage's; the campaign row's `sent/cost` unchanged. `P2` pure-secondary row: `sent 0`, `cost 0`, renders "—" + tooltip. `P3` mixed row (offer B primary on stage X, secondary on stage Y): EPC = B's own revenue / B's counted clickers. `P4` Overview, By Campaign, By Number, Hourly totals identical with and without the split (the layer only runs for offer-keyed groupers). `P5` landing-page report for offer B shows B's conversions from the split stage. `P6` creatives page offer filter = By Offer numbers for the same range.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; every grouper calls `getOfferSplits` once per request for its stage set.
- [ ] **Step 4:** Run → pass; `npx tsx scripts/test-stage-funnel.ts`, `scripts/test-funnel-pending-exclusion.ts`, `scripts/test-event-columns-view.ts` → pass.
- [ ] **Step 5:** Commit `feat(reports): by-offer readers report split conversions under their own offer`.

### Task 6: Keitaro offer id on the Offer form

**Files:**
- Modify: `lib/validators/offers.ts` (`keitaro_offer_id: z.number().int().positive().nullable().optional()`), `components/offers/offer-form.tsx` (field "Keitaro offer ID", manager+), `app/api/offers/route.ts` + `app/api/offers/[offerId]/route.ts` (persist; 409 `duplicate` when another active offer in the org already has that id).
- Test: extend `scripts/test-offers-api.ts` (or the existing offers API test) on a PR preview.

- [ ] **Step 1:** Failing tests: set → stored; duplicate in org → 409; another org may use the same id; clearing → null; operator PATCH → 403.
- [ ] **Step 2–4:** Implement, run, pass; `npm run check:authz`.
- [ ] **Step 5:** Commit `feat(offers): link an offer to its Keitaro offer id from the form`.

### Task 7: Read-only verify script for prod

**Files:**
- Create: `scripts/verify-offer-split-totals.ts` (read-only, `BEGIN READ ONLY`; guard exclusion with reason)

**Interfaces:**
- Produces: for a range (`--from --to`, default last 30 ET days), per campaign and per stage: unsplit totals vs Σ split slices (must be equal; exit 1 otherwise); per offer: before → after and the ledger rows that explain each delta.

- [ ] Steps: write → run on camman-v2 fixture (pass) → commit `chore(reports): verify offer-split totals`.

### Phase 2 ship
- [ ] Docs + changelog; PR green; merge (no data write, no migration → ships on green); prod deploy on merge SHA; run Task 7 on prod read-only; report per-offer numbers to the owner.

---

## Phase 3 — Offer report / Audience Stats summary tables (migration, gated)

### Task 8: Migration 0231 — matviews read the conversion's offer

**Files:**
- Create: `db/migrations/0231_offer_report_conversion_offer.sql` + snapshot/journal (hand-authored, see `project_migrations_handwritten`)
- Test: `scripts/test-offer-report-split-db.ts` (camman-v2, after the preview auto-migrates)

**Design:**
- Before writing: read the CURRENT definitions on prod read-only (`pg_get_viewdef`) of `offer_report_campaign_econ`, `offer_report_offer_totals_mv`, `offer_group_report_mv`, `audience_report_group_totals_mv`; start from those, not from 0183's text.
- Ledger halves (`conv` CTE, group rows): `COALESCE(ce.offer_id, camp.offer_id)` replaces the campaign-offer join.
- Stage-grain half of `offer_report_offer_totals_mv` (revenue/sales from `offer_report_campaign_econ`): subtract the split amounts from the campaign offer and add them to the target offer, using a view `offer_split_amounts_v (org_id, stage_id, campaign_offer_id, offer_id, sales, revenue, pending_revenue)` that is the SQL twin of `getOfferSplits` (lifetime). Both halves of the footer then agree.
- `audience_report_group_totals_mv` depends on `offer_group_report_mv`: drop/recreate in dependency order; `security_invoker = true`; re-issue the 0183 REVOKEs.
- `offer_group_exposure_mv` (0227) is NOT touched here — it is Phase 4.

- [ ] **Step 1: Failing DB test:** fixture split stage; after refresh, `/offers/[A]/report` and `/offers/[B]/report` totals: A + B = the stage; footer `revenue` = Σ group rows' revenue for each offer; Audience Stats "all offers" row unchanged.
- [ ] **Step 2:** Push the branch; camman-v2 auto-migrates via the preview deploy → test FAILs before the SQL change, passes after.
- [ ] **Step 3:** `scripts/verify-migration-integrity.ts` on camman-v2; PR green.
- [ ] **STOP — owner go #2.** Then, attended, outside 05:00/20:00 UTC: `npm run db:migrate` against prod (the refresh is ~112 s against the 120 s statement timeout — run the first refresh on a session connection with a raised `statement_timeout`, as Gate 3 did), verify integrity, merge, deploy on merge SHA, compare `/offers/*/report` before/after for the nine-offer set.

---

## Phase 4 — "Bought offer X" = a sale on offer X (separate; starts only after the owner reviews Phases 1–3)

### Task 9: Targeting reads the conversion's offer

**Files:**
- Modify: `lib/sale-attribution.ts` `purchasedOfferContacts` (`COALESCE(ce.offer_id, ca.offer_id) = offerId`; rewrite the comment at :70-74 that says the campaign offer is intended); `db/migrations/0232_offer_group_exposure_conversion_offer.sql` (the inline `buyers` CTE in `offer_group_exposure_mv`, 0227:71-75).
- Test: `scripts/test-eligibility-layers-identical.ts`, `scripts/test-preview-matches-snapshot.ts` PART F, `scripts/test-lifecycle-send-recheck.ts`, plus a new fixture bar: a contact who bought offer B through offer A's campaign is excluded from a campaign for B and NOT from one for A.

- [ ] Steps: failing bar → implement → all four pass on camman-v2 → read-only prod count of contacts whose `bought_offer` membership changes, per offer → **owner approval before merge (changes who receives SMS)** and **go for 0232 on prod**.

---

## Self-review notes

- Spec coverage: (a) attribution → T1–T3; separate by-offer rows + unchanged totals → T4, T5, T7; "—" + tooltip → T5; general solution → T1 (any mapped Keitaro offer), T4 (any number of offers per stage); nine links → Phase 1 apply; gated backfill/migration → Phase 1/3 STOPs; targeting later → Phase 4.
- EPC on a mixed row is traffic-based (revenue its own traffic produced). This is an interpretation of "—" on a second offer's row: pure-secondary rows show "—"; a mixed row shows its own traffic's EPC. Flagged to the owner.
