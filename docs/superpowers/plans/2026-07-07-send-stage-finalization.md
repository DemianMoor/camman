# Send-stage finalization: partial failures don't fail the whole stage — plan

**Date:** 2026-07-07
**Branch:** `fix/send-stage-finalization` (isolated worktree)
**Status:** Approved (all 4 fixes), design refined during investigation

## Problem (evidenced)

Campaign `8_62_070726_2`, stage "Stage 1 (B)" (id 740): 2,500/2,529 sent, **29 stranded in `sending`** (interrupted drain), so:
- `campaign_stages.sent_at` is NULL → cost is $0 (cost is gated on `sent_at`; the recompute *ran* 97× via the opt-out poller but returned 0 each time). Expected cost: **$25.97**.
- Derived operational status reads **red "Missed / Failed"** because `sending > 0` with `pending = 0` ([stage-status.ts:211](../../../lib/stages/stage-status.ts)).

The stage has **0 `pending` rows**, so `selectDrainableStages` ([scheduled.ts:152](../../../lib/sends/scheduled.ts)) never re-selects it — it can never self-heal from the drain path.

## Design decisions

- **Stuck `sending` → `failed` (terminal), never auto-retried.** A row can be stuck *after* TextHub accepted it (process died before recording), so re-sending risks double-texting. The drain's at-most-once design ([drain.ts:130-133](../../../lib/sends/drain.ts)) is deliberate. Marking `failed` reaches a terminal state safely; the operator can use the existing **retry-failed** flow if they choose.
- **Reconciliation runs as its own pass** (not in the drain), because stranded stages have no `pending` rows and are invisible to the drain selector.
- **No schema change / no migration.** All fixes use existing columns.
- **Staleness threshold = 15 min.** Far above the drain route's 300s `maxDuration`, so reconciliation can never touch a row a live drain is actively holding (a live drain produces `sent` rows with recent `sent_at`; a stranded stage's last activity is minutes old).

## Fixes

### Fix A — Cost reflects sent messages, not `sent_at`
**File:** [lib/stages/total-cost.ts](../../../lib/stages/total-cost.ts)
Change the `recomputeStageTotalCost` CASE gate. Today: `WHEN cs.sent_at IS NOT NULL OR cs.sms_count > 0`. New: compute whenever there is something to bill — `sms_count > 0` OR at least one `sent` stage_sends row. Cost stays `cost_per_sms × (GREATEST(sms_count, sent_count) + opt_out_count)`. Decouples cost from the `sent_at` fire-lock; a few failed/stuck sends never zero it (they're not `sent`, so they don't add cost either). The pure `stageTotalCost(costPerSms, sends, optOut)` helper is unchanged.

### Fix B — Status: partial failures are a warning, not whole-stage "Failed"
**File:** [lib/stages/stage-status.ts](../../../lib/stages/stage-status.ts)
In `deriveStageOperationalStatus`, when `hasRows`:
- If `sent > 0` → `sending_sent` (green) **even if** some `failed`/`sending`/`skippedDuplicate` remain. The bulk sent; the stragglers are a warning, not a stage failure.
- Reserve `missed_failed` (red) for: `scheduleMissedAt` set (unchanged), OR the drain reached a terminal state with **nothing sent** (`sent === 0`) yet has `failed`/`sending`/`skippedDuplicate` (a genuinely dead stage).
- Keep the "actively sending" green case.
Add a pure helper `stageSendWarningCount(counts)` = `failed + sending + skippedDuplicate` so surfaces can show a warning chip ("N not delivered") next to a green stage. (Wiring the chip into the UI is a small follow-on; the derivation change alone fixes the red-Failed misread.)

### Fix C — Reclaim stale `sending` rows safely (terminal, no re-send)
Part of the reconciliation pass (Fix D). Rows in `sending` on a *stale* stage (see threshold) → `UPDATE ... SET status='failed', last_error='stranded in sending — drain interrupted; not retried (at-most-once)', attempts = attempts` (attempts unchanged; they were never attempted-and-recorded). Terminal, no dispatch → no double-text.

### Fix D — Reconciliation / finalization pass (the glue)
**New file:** `lib/sends/reconcile-stages.ts` → `reconcileStuckStages(dbc, { now, orgId?, staleMinutes? })`.
Selects `tracked` + `active` + `send_approved` + `materialized_at IS NOT NULL` stages that are **stale** (no `pending` rows; newest activity — `max(sent_at)` across sent rows, or `max(created_at)` among `sending` rows — older than `staleMinutes`, default 15) AND need finalization (has `sending` rows OR (`sent_at IS NULL` and ≥1 `sent` row)). For each, in order:
1. Mark stale `sending` → `failed` (Fix C).
2. `UPDATE campaign_stages SET sent_at = COALESCE(sent_at, now())` when the stage has ≥1 `sent` row (robust fire-lock stamp).
3. `recomputeStageTotalCost(dbc, stageId)` (now unblocked by Fix A).
Returns `{ scanned, reclaimed, stampedSentAt, recomputed }`.
**Wire into** `runScheduledSends` ([scheduled.ts](../../../lib/sends/scheduled.ts)): call `reconcileStuckStages` once per tick (respecting `orgId` scope), after the drain loop. Cheap: one selection query + a few small updates per stranded stage. Add its counters to `ScheduledRunResult`.

This heals stage 740 on the next tick: 29 `sending` → `failed`, `sent_at` stamped, cost → **$25.97**, status → green with a "29 not delivered" warning.

## Verification criteria

- **total-cost:** `test-total-cost-gate.ts` (DB, throwaway org) — a stage with `sent` rows but `sent_at IS NULL` gets a non-zero cost after recompute; a stage with 0 sent + 0 sms_count stays 0.
- **stage-status:** `test-stage-status.ts` (pure) — `{sent:2500, sending:29, pending:0}` → `sending_sent` (NOT `missed_failed`); `{sent:0, failed:5, pending:0}` → `missed_failed`; `scheduleMissedAt` still → `missed_failed`; `stageSendWarningCount` sums correctly.
- **reconcile:** `test-reconcile-stages.ts` (DB, throwaway org) — seed a stage mirroring 740 (2 sent, 1 stale `sending`, `sent_at` NULL); after `reconcileStuckStages`: the `sending` row is `failed`, `sent_at` set, `total_cost` = rate×(2+optOut); a stage with a *fresh* `sending` row (recent activity) is left untouched (no live-drain interference); a fully-`sent` finalized stage is a no-op.
- Typecheck clean; lint clean; existing `test-scheduled-*` still pass.
- Docs updated (`04-features/sms-send-pipeline.md`, `07-conventions.md`, CHANGELOG).

## One-off remediation (after merge, separate)
Run one `reconcileStuckStages` (or wait one cron tick) to heal stage 740 in prod. Not part of the code change.

## Coordination note
Touches `lib/sends/*` and `lib/stages/stage-status.ts`. The other active chat has been in `lib/audience-snapshot.ts` / stages-list / telegram. Mild overlap risk on `stage-status.ts` — done in an isolated worktree; rebase on `main` before merge.
