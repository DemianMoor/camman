# Manual TextHub opt-out import + attribution (July 2026)

**Date:** 2026-07-20
**Status:** approved, implementing
**Owner:** Demian (operator) + Claude

## Problem

TextHub STOP replies are normally ingested by the live poller (`lib/sends/poll-opt-outs.ts`,
`*/5` cron), which (a) writes an org-wide `opt_outs` row and (b) attributes the STOP to the
single most-recent `stage_sends` row for that number within a 72h window
(`opt_out_attributions`). Reports read opt-outs from the hourly rollup fact tables, which
derive them from `opt_out_attributions.stage_send_id`.

Some July STOPs never got ingested (200-cap inbox scroll-off before the poll grabbed them),
so their opt-outs are missing from suppression **and** from `/reports`. We have a TextHub
export (`Opt_Outs 072026.csv`, columns `From,Received`) covering **Jul 1 – Jul 20 2026** and
want those missed STOPs recorded and attributed so per-stage/campaign report figures reflect
them.

## Input data

- Format: `From,Received`. `From` = 11-digit E.164 without `+`. `Received` = `M/D/YYYY H:MM`.
- **Timezone of `Received`: Eastern (EST/EDT).** Operator-confirmed. Parsed as
  `America/New_York` wall-clock (DST-aware; July = UTC−4) → UTC. This matches CamMan's
  campaign timezone. NOTE: the live poller parsed TextHub's *raw* value as **Mountain**
  (`America/Denver`); the export is a reformatted/converted Eastern view of the same instants.
- Large (tens of thousands of rows). Contains exact `(number, same-minute)` duplicates
  (multi-segment / export artifacts) and numbers on multiple days (separate STOPs).

## Decisions (locked with operator)

1. **Approach:** dedicated idempotent backfill script reusing the live attribution rule.
2. **Dedup:** skip any STOP already handled by the poller — never double-count.
3. **Range:** calendar month to date (Jul 1 → today).
4. **Unattributed STOPs** (no send in the 72h window): suppress org-wide only, **no** stage
   credit — identical to the live poller. Won't appear in `/reports`.
5. **Execution:** Claude runs the full flow against prod (same DB the app uses), dry-run first,
   then apply, then verifies live in `/reports`.

## Pipeline

Script: `scripts/import-texthub-optouts.ts`. Default = **dry-run (read-only)**; `--apply` writes.
Bypasses RLS via the privileged DB connection (same pattern as `backfill-optout-attributions.ts`).

0. **Resolve org_id** — the single org that owns the TextHub sending infra (confirm exactly one
   in the dry-run; abort if ambiguous).
1. **Parse + dedup CSV** (TS): normalize `From` → E.164; collapse exact `(phone, minute)`
   dupes to one STOP; convert `Received` (America/New_York) → UTC anchor. Result: deduped
   `(phone, anchor_utc)` events.
2. **Calibrate offset (read-only)** — for ~20 numbers already in `opt_outs`, compare their
   stored `created_at` to the CSV anchor. Expect ~0 (both are the same real instant). Report the
   measured offset; it sets the dedup tolerance and confirms the Eastern assumption before any write.
3. **Stage** events into a `TEMP TABLE ... ON COMMIT DROP` (or a filtered CTE per batch).
4. **Dedup gate** — drop any event with an existing `opt_outs` row for the same phone whose
   `created_at` is within tolerance of the anchor (covers both poller-`sms_inbound` rows and a
   prior run of this script). Makes opt-out creation idempotent.
5. **Insert opt_outs** (apply only) — `source='texthub_manual_import'`, `created_at = anchor`,
   contact upserted (`ON CONFLICT (org_id, phone_number)`), no brand junction (= universal
   suppression). Distinct source keeps the import identifiable/reversible; reports and
   suppression both ignore `source`, so it changes neither.
6. **Attribute** — reuse the exact set-based rule from `backfill-optout-attributions.ts`:
   `INSERT INTO opt_out_attributions ... SELECT DISTINCT ON (oo.id, ss.stage_id) ...` joining
   `stage_sends` (`status='sent'`) in `[created_at − 72h, created_at + 5min]`, `ORDER BY
   sent_at DESC`, `ON CONFLICT (opt_out_id, stage_id) DO NOTHING`. Scoped to the newly-inserted
   opt_outs. Uses `OPT_OUT_ATTRIBUTION_WINDOW_HOURS`.
7. **Recompute counters** — rewrite `campaign_stages.inbound_opt_out_count` from the junction
   (idempotent full recompute, as the existing backfill does), mirror `opt_out_count` upward,
   and call `recomputeStageTotalCost` for each affected stage (opt-outs bill like sends).
8. **Refresh reports** — `refreshReportRollup(db, { recomputeSinceDays: 60 })`. The UPSERT
   recomputes and overwrites every send-hour bucket in the window (incl. early-July, >14d old)
   from the fresh attributions, then re-freezes old buckets. 60d comfortably covers the earliest
   affected send (~late June, 72h before Jul 1).

Steps 5–8 run inside one transaction in the apply pass; step 2/4 dry-run counts run read-only.

## Dry-run output (operator reviews before apply)

- org_id resolved; total CSV rows; exact-dup collapses; deduped events.
- Measured CSV↔stored offset (timezone sanity).
- Already-handled skips; new opt-outs to insert.
- Matched-to-stage vs unattributed counts.
- Per-campaign / per-stage breakdown of new attributions.

## Verification criteria

- Dry-run event total reconciles against the bare-number list first pasted (count sanity).
- After apply: 3–4 sample numbers each have an `opt_outs` row + attribution to the expected stage.
- A chosen stage's `/reports` opt-out count rose by exactly its predicted new-attribution count.
- Idempotent: re-running the dry-run reports **0 new** opt-outs and **0 new** attributions.
- `npx tsx scripts/verify-migration-integrity.ts` not required (no schema change), but the app
  builds/typechecks clean.

## Out of scope

No re-sending; no change to any campaign's audience, status, or existing (poller-ingested)
opt-outs; no schema/migration change.

## Reuse / references

- `scripts/backfill-optout-attributions.ts` — set-based attribution + counter recompute (copy the SQL).
- `scripts/backfill-report-rollup.ts` + `lib/reporting/rollup.ts` `refreshReportRollup` — reports refresh.
- `lib/sends/poll-opt-outs.ts` — `OPT_OUT_ATTRIBUTION_WINDOW_HOURS`, `latestSendForAttribution`,
  `parseProviderReceivedAt`, the live per-STOP behavior this mirrors.
- `lib/stages/total-cost.ts` — `recomputeStageTotalCost`.
