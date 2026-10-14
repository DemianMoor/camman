# Drip Hour-Level Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routing diverts a lead from a same-tag campaign whose current hour is full to the next candidate with hourly room — divert only, never defer — behind `org_settings.drip_routing_hour_overflow` (0211), with one shared hourly-room formula.

**Architecture:** New `lib/drip/hourly-room.ts` owns the hour counts (`sentH`, `assigned`, `queued`, `pendingFresh`) and the fullness test; the scheduler's maintenance pass, routing and "Why not routed" all read through it. Routing adds a per-candidate `hour_capacity` rule (window-open only), an O3 fallback that routes to the best-ranked hour-only-failing candidate instead of deferring, and `kind` on `overflowed_from`.

**Tech Stack:** Next.js 16 · TypeScript · Drizzle (hand-authored migrations) · Postgres · tsx scripts on the preview DB.

**Spec:** [docs/superpowers/specs/2026-10-14-drip-hour-overflow-design.md](../specs/2026-10-14-drip-hour-overflow-design.md)

## Global Constraints

- Flag off (`drip_routing_hour_overflow = false`, default) ⇒ routing verdicts, stored `reason` JSON and outcomes byte-identical to origin/main a4a5d3c2 — whether `drip_routing_send_capacity` is on or off. The `hour_capacity` rule is ABSENT when inactive, never `"pass"`.
- The hour rule applies only when ALL hold: `drip_routing_hour_overflow` AND `drip_routing_send_capacity` AND `drip_hourly_cap_enabled` AND the candidate's `hourly_cap` is set AND one of its first-send windows (`drip_active`, not archived, `parent_stage_id IS NULL`) covers the current ET minute (half-open).
- **Divert, never defer (O3):** if no candidate is fully eligible, the best-ranked candidate whose ONLY failing rule is `hour_capacity` wins, with `hour_fallback: true`. `hour_capacity` is never added to `TEMPORARY_CANDIDATE_RULES`.
- **One formula (O4):** every hour count (`first_send_at` within an hour, `hour_start = H`, `hour_start < H`, pending fresh) lives in `lib/drip/hourly-room.ts`. `hourly-maintenance.ts` and routing import it; no other file re-derives it (source guard).
- `hourCommitted = sentH + assigned + pendingFresh + queued`; full ⇔ `committed >= hourly_cap`. Detail text exactly `hour full (${committed}/${cap} this hour)`.
- Hour key = UTC hour (`hourStartOf`), as in the hourly cap.
- `overflowed_from` entries add `kind: "day" | "hour"`; existing day entries keep their exact `detail` text.
- Required params (§11b): any new input that changes who is routed is required on internal types.
- Drizzle flattens JS arrays: pass id lists as one `'{…}'::int[]` / `::uuid[]` string.
- Migration 0211 hand-authored: SQL with `SET LOCAL lock_timeout = '5s'`, cloned 0210 snapshot (new id, prevId = 0210's id), journal idx 211 with `when` = 0210's + 86400000.
- `.env.local` is PRODUCTION. DB tests import `./_env-preload` then `./_require-preview-db`, run via `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/<name>.ts`. Any helper/fixture that imports `@/db/client` must import the guard too (`npm run check:guards`).
- Lint changed files only (`npx eslint <files>`); `npx tsc --noEmit -p .` clean.
- Docs part of done: `docs/04-features/drip-campaigns-routing.md` (rule, O3, recording, race, **operator guideline**), `docs/03-data-model.md` (+ERD), `docs/07-conventions.md`, `docs/CHANGELOG.md`, "last updated".
- Migration ⇒ owner gate before prod `db:migrate` and merge.

## File structure

| File | Responsibility |
|---|---|
| `lib/drip/hourly-room.ts` (new) | `HourCounts`, `loadHourCounts`, `hourCommitted`, `hourFullness`, `routedInWindowSql` |
| `lib/drip/hourly-maintenance.ts` | Reads counts through `hourly-room.ts` (no behaviour change) |
| `scripts/test-drip-hourly-room.ts` (new) | Pure + DB parity + source guard |
| `db/migrations/0211_drip_routing_hour_overflow.sql` + meta | Flag column |
| `db/schema.ts` | `drip_routing_hour_overflow` |
| `lib/drip/routing-eval.ts` | `hour_capacity` rule, O3 fallback, `overflowSkips` kinds, hour counts in the per-run cache |
| `lib/drip/routing.ts` | Load hour counts once per run; in-tick `pendingFresh` increment; store `hour_fallback` |
| `scripts/test-drip-hour-overflow.ts` (new) | H-O1…H-O11 |
| `components/drip/why-not-routed.tsx`, `app/api/drip/why-not-routed/route.ts` | Show kinds + fallback |

---

### Task 1: Shared hourly-room helper; maintenance reads through it

**Files:** Create `lib/drip/hourly-room.ts`, `scripts/test-drip-hourly-room.ts`. Modify `lib/drip/hourly-maintenance.ts`.

**Interfaces — Produces:**
```ts
export interface HourCounts { sentH: number; assigned: number; queued: number; pendingFresh: number }
export interface HourCampaign { id: number; windows: StageWindow[] }
export async function loadHourCounts(dbc: DripTx, i: { campaigns: HourCampaign[]; hourStart: Date }): Promise<Map<number, HourCounts>>
export function hourCommitted(c: HourCounts): number
export function hourFullness(cap: number, c: HourCounts): { full: boolean; committed: number; detail: string | null }
export function routedInWindowSql(windows: StageWindow[]): SQL   // moved from hourly-maintenance.ts (routedInAnyWindow); alias j
export async function loadOpenWindowCampaigns(dbc: DripTx, i: { campaignIds: number[] }): Promise<Map<number, StageWindow[]>>  // active first-send windows per campaign
```
`loadHourCounts` = ONE grouped query over `drip_journeys` for the given campaign ids: `count(*) FILTER (first_send_at ∈ [H,H+1h))`, `FILTER (state='routed' AND first_send_at IS NULL AND hour_start = H)`, `FILTER (… hour_start < H)`, `FILTER (… hour_start IS NULL AND routed_at ∈ [H,H+1h) AND <in-window for that campaign>)`. For the per-campaign window test use `CASE j.campaign_id WHEN <id> THEN (<routedInWindowSql(windows)>) … END` (campaigns without windows ⇒ `false`). Every campaign id in the input gets an entry (zeros when absent).

- [ ] **Step 1: Failing test** `scripts/test-drip-hourly-room.ts` (guard imports first; uses `scripts/_drip-hourly-fixture.ts`):
  - P1 `hourCommitted({sentH:2,assigned:1,queued:3,pendingFresh:4}) === 10`; P2 `hourFullness(10, …)` full with detail `hour full (10/10 this hour)`; P3 `hourFullness(11, …)` not full, detail null.
  - D1 fixture campaign cap 5 carry ON, window 09:00–18:00 ET; at fixed hour H (in-window, e.g. 2026-10-13T18:00Z): 2 journeys first-sent in H, 1 assigned to H, 2 assigned to H−1h (queued), 3 routed in-window in H with hour_start NULL (pending), 1 routed in H outside any window (NOT pending) ⇒ `loadHourCounts` = `{sentH:2, assigned:1, queued:2, pendingFresh:3}`.
  - D2 parity: `prepareHourly` room for that campaign at H equals `cap − sentH` from the same `loadHourCounts` (after its own assignFresh moves the 3 pending to assigned, `hourCommitted` is unchanged — assert committed before == after).
  - G1 source guard: in `lib/drip/*.ts` excluding `hourly-room.ts`, no occurrence of the hour-count SQL shapes: regex `/first_send_at\s*>=[^;]*HOUR_MS|hour_start\s*=\s*\$\{|hour_start\s*<\s*\$\{/` — tune the patterns to the code you write so the guard catches a re-derivation; prove it can go red by checking it against a mutated string in memory.
- [ ] **Step 2: RED** (module missing).
- [ ] **Step 3: Implement** `hourly-room.ts`; in `hourly-maintenance.ts` replace `routedInAnyWindow` with `routedInWindowSql` (import), and rewrite `sentBetween(…, false)` / `hourCounts` to call `loadHourCounts` (the `backlogOnly=true` variant — backlog first sends in H with `hour_fresh IS FALSE` — moves into `hourly-room.ts` as `loadBacklogSentInHour(dbc, campaignId, H)` so G1 holds). `HourCounts` in `hourly-cap.ts` (maintenance's own shape: sentInHour/freshUnsentInHour/backlogUnsentInHour/queuedUnsent) stays; map from the new counts where needed — do not change `backlogRoom`/`planHourEnd` semantics.
- [ ] **Step 4: GREEN** + existing suites unchanged: `test-drip-hourly-maintenance.ts`, `test-drip-hourly-config.ts`, `test-drip-scheduler-fairness.ts`, `test-drip-hourly-cap-pure.ts`, `test-drip-scheduler-manual-lease.ts` — all green.
- [ ] **Step 5:** `npx eslint` changed files, `npx tsc --noEmit -p .`, `npm run check:guards`; commit `refactor(drip): one hourly-room formula shared by maintenance (and soon routing)`.

### Task 2: Migration 0211 + schema

**Files:** `db/migrations/0211_drip_routing_hour_overflow.sql`, `meta/0211_snapshot.json`, `meta/_journal.json`, `db/schema.ts`, `scripts/test-drip-hour-overflow-schema.ts`.

- [ ] Failing schema test (column exists, boolean NOT NULL DEFAULT false) → RED.
- [ ] SQL:
```sql
-- 0211: drip routing hour-level overflow. Additive only; ships dark.
--   org_settings.drip_routing_hour_overflow — when on (and drip_routing_send_capacity
--   on), routing also skips a candidate whose CURRENT HOUR is full (hourly cap,
--   window open) and diverts the lead to the next same-tag candidate with room.
--   Divert only, never defer: if every candidate is only hour-full the lead goes to
--   the best-ranked one anyway (it queues, as before). Off = day-level only.
-- Re-runnable: ADD COLUMN IF NOT EXISTS. Constant default: no rewrite.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_routing_hour_overflow boolean NOT NULL DEFAULT false;--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_routing_hour_overflow IS
  'Drip routing hour-level overflow (0211): divert a lead from a candidate whose current hour is full to the next same-tag candidate with hourly room. Never defers. Needs drip_routing_send_capacity. Off = day-level only.';
```
- [ ] Snapshot = clone of 0210 (new uuid id, prevId = 0210's id; org_settings not tracked). Journal idx 211, when = 0210 when + 86400000. Schema field next to `drip_routing_send_capacity`.
- [ ] Apply to PREVIEW only (`node scripts/with-preview-env.mjs npm run db:migrate`), schema test GREEN, tsc, commit.

### Task 3: Routing rule, O3 fallback, recording

**Files:** `lib/drip/routing-eval.ts`, `lib/drip/routing.ts`, `scripts/test-drip-hour-overflow.ts`.

**Interfaces:**
- `CampaignCounts` gains REQUIRED `hour: { counts: HourCounts; cap: number } | null` (null ⇒ rule inactive for that campaign this run). `ZERO_COUNTS.hour = null`. `loadCampaignJourneyCounts` populates it: reads the org flags (`drip_routing_hour_overflow`, `drip_routing_send_capacity`, `drip_hourly_cap_enabled`); if all on, loads hourly-capped active/paused campaigns' open windows NOW (`loadOpenWindowCampaigns` then filter to windows covering the current ET minute — `inAnyWindow` from `hourly-cap.ts`), then `loadHourCounts` for those with an open window. One extra grouped query + one windows query per run, only when the flags are on.
- Without a cache (why-not-routed live evaluation) `evaluateLeadRouting` computes the same via the same helpers for the candidate campaigns.
- `OverflowSkip` gains `kind: "day" | "hour"`. `LeadRoutingEvaluation` gains `hour_fallback: boolean`.

Rule (after `send_capacity`): if `hour` non-null for the candidate ⇒ `const h = hourFullness(hour.cap, hour.counts); rules.hour_capacity = h.full ? "blocked" : "pass"; if (h.detail) detail.hour_capacity = h.detail;`. Absent otherwise.

Winner: normal; if none, O3 fallback = best `byRoutingRank` among candidates whose failing rules are exactly `["hour_capacity"]` ⇒ winner, `hour_fallback: true`. `overflowSkips(candidates, winner)`: include higher-ranked candidates whose failures ⊆ day rules ∪ {hour_capacity}; `kind = failures include any day rule ? "day" : "hour"`; detail = joined details of the failing rules (day text unchanged when kind day). With the flag off no candidate has `hour_capacity`, so output is identical.

routing.ts: store `hour_fallback: true` in `reason` only when true (absence keeps byte identity); after a successful insert, if the winner had `hour` non-null (window open now ⇒ the lead is fresh-in-window), increment `counts.get(id).hour.counts.pendingFresh`.

- [ ] Failing DB test `scripts/test-drip-hour-overflow.ts` with H-O1…H-O10 from the spec (use `_drip-hourly-fixture.ts`; give campaigns the same interest tag and priorities; drive `evaluateLeadRouting` / `runDripRoutingBatch({ onlyOrgId, now })` with an injected `now`). H-O1 compares the stored `reason` JSON of a flag-off run against the same scenario computed by the function on origin/main semantics — implement as: run once with `drip_routing_hour_overflow=false` and assert no `hour_capacity` key anywhere in verdicts/reasons and no `kind`/`hour_fallback` keys added to day entries beyond what day-level emits (compare against a snapshot of the verdict shape produced with the hour flag off and the day flag on/off). H-O7: run `prepareHourly` release between a routing evaluation that read counts and its insert (call the pieces in that order) and assert `hourCommitted` over-commit ≤ number of leads routed in that run, and that the scheduler's room (`cap − sentH`) is unaffected. H-O9 and H-O10 are owner-mandated — keep them exactly as the spec words them.
- [ ] RED → implement → GREEN; regressions: `test-drip-routing-overflow.ts`, `test-drip-send-capacity.ts`, `test-drip-routing-queue.ts`, `test-drip-carry-over.ts`, `test-drip-geo-exclude-mode.ts`, `test-drip-hourly-maintenance.ts`, `test-drip-hourly-room.ts`.
- [ ] eslint, tsc, check:guards, commit.

### Task 4: Why-not-routed + docs

- [ ] `missedHour`-style helper for overflow lines: `kind:"hour"` entries render `"<name>: hour full (N/cap this hour), overflowed to <winner>"`; missing kind ⇒ day (existing text). `hour_fallback` renders `"routed to <winner> although its hour is full — every same-tag candidate was hour-full (queues)"`. Live evaluation shows `hour_capacity` verdicts like other rules.
- [ ] Docs per Global Constraints; the operator guideline verbatim in spirit: "Turn on hour-level overflow for a tag only where the combined hourly caps of its same-tag siblings ≈ the tag's hourly arrival rate. Far below it, every sibling fills each hour and the divert-never-defer fallback simply queues as before." Include the race bound and that it never defers. CHANGELOG line.
- [ ] tsc/eslint/check:docs, commit.

### Task 5: Verify, PR, owner gate

- [ ] Full sweep on preview (all suites above + scheduler-fairness, poke-chain, stop-controls, regular-unaffected). `verify-migration-integrity` vs prod (only 0211-not-applied new).
- [ ] PR with rulings O1–O6, test evidence, race bound, operator guideline, rollback target. STOP at the owner gate (prod migrate 0211, then merge, then prove inert: flag false, no `hour_capacity` in reasons, routing mix unchanged).
