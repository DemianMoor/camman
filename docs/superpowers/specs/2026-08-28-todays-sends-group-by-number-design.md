# Today's Sends — group stages by sending number

**Date:** 2026-08-28
**Status:** Approved (design), pending implementation
**Surfaces:** `app/(protected)/sends/today/page.tsx`, `app/api/sends/today/route.ts`

## Problem

Today's Sends is one flat cross-campaign list of every tracked stage in play
today (ET). It answers "what needs action?" but not "which sending number is
doing the work, and which one is unhappy?". Operators run 3–7 numbers across
2–5 providers on a given day (measured over the last 21 ET days; 18–42 stages
per day), and per-number posture is currently invisible except as an aggregate
message count in the "Prepared for today" card.

## Goal

Group the stage list by the number that sends it, exposed as tabs, without
regressing the triage properties of the existing screen.

## Data model facts this rests on

- A stage has exactly ONE `campaign_stages.provider_phone_id`. It is stamped
  onto every `stage_sends` row at materialization (migration 0112), so
  "the number a stage sends from" is unambiguous and known BEFORE the stage is
  prepared. Grouping does not depend on materialization.
- Measured 2026-08-28: 0 stages with a NULL `provider_phone_id` in 21 days.
  The FK is nullable, so the UI still handles the case — it just never renders
  an empty bucket.
- `provider_phones` is unique on `(org_id, phone_number)`, but the group key is
  `provider_phone_id` regardless — stable across relabeling.

## Design

### 1. API — `app/api/sends/today/route.ts`

Add `LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id AND pp.org_id = :orgId`
to the existing candidate-stage query and return three new per-stage fields:
`provider_phone_id`, `phone_number`, `number_type`. No new query, no new round
trip — one join on an already-filtered row set.

Also select `s.skipped_empty_at` and `s.slip_hold_at` and pass them into
`deriveStageOperationalStatus`. See "Correctness fix" below — this is required
BY the grouping work, not incidental to it.

The existing `prepared_by_phone` aggregate is untouched.

### 2. Grouping + sort — `lib/sends/group-stages-by-phone.ts` (new, pure)

A pure function, no React, so the ordering rules are testable in isolation.

- **Group key:** `provider_phone_id` (`null` → a trailing "No number assigned"
  group, rendered only when non-empty).
- **Within a group:** the whole *needs-action* band first — every status with
  `STAGE_STATUS_META[...].sortWeight === 0`, i.e. `scheduled_unprepared`
  (orange), `missed_failed` (red), `blocked` (rose), `held` (amber) — then
  everything else. Ascending `scheduled_at` WITHIN each band; stages with no
  schedule sort last.
- **Group order:** groups holding a needs-action stage first, then by that
  group's earliest `scheduled_at`. The number that needs attention is leftmost
  in the tab bar and topmost on the All tab.

Deriving the band from `sortWeight === 0` rather than listing statuses means a
future attention state joins the band automatically. Notably `skipped_empty`
(`sortWeight: 90`, benign) and `draft` (40) correctly stay out of it.

### 3. UI — tabs

The top block is UNCHANGED and stays global: hard-stop banner, paused-campaign
banner, status tiles, "Prepared for today" + its "By number" list, volume
meter, stuck callout. Only the stage list below it changes.

Tab bar: `All (n)` first and default, then one tab per number, ordered as above.

Each number tab's label is the formatted number, the provider in parentheses,
the stage count, and a small colored dot when that number holds a needs-action
stage — so a problem announces itself from the bar without clicking in.

- **All tab** — every group stacked as labeled sections.
- **Number tab** — that one section.

Both render the same `PhoneStageGroup` component, so the two views cannot drift.

Section header carries: formatted number · provider · number-type badge
(`10DLC` / `TF` / `SC`, reusing the abbreviations already used by the "By
number" card) · stage count · aggregate `sent / prepared` for the group, plus
`(paused)` when the provider is paused.

The per-row provider chip is dropped — the header now owns number/provider
identity, and repeating it on every row is noise.

Tab selection is NOT persisted to localStorage. A number in play today may not
be in play tomorrow; restoring a stale tab onto an empty day is worse than
defaulting to All.

### 4. Correctness fix pulled in by this work

The candidate query never selected `skipped_empty_at` or `slip_hold_at`, so
`deriveStageOperationalStatus` received `undefined` for both and could never
return `skipped_empty` or `held` on this screen.

Consequence for an empty behavioural lane (migration 0174, shipped 2026-08-27):
`materialized_at IS NULL` + no live rows + `scheduled_at` set falls through to
`scheduled_unprepared` — it renders ORANGE with a Prepare button. Under this
design that false alarm would be pinned to the top of its phone block
permanently. Measured 2026-08-28: 0 such stages today and 0 in 14 days, so this
is latent rather than live — but the feature that produces them shipped
yesterday, so it will activate.

Selecting both columns and passing them through is the fix.

## Verification criteria

1. Group stage counts sum to the flat total; no stage duplicated or dropped.
2. A number tab's rows are identical to that number's section on the All tab.
3. Every tab holding an orange/red/rose/amber stage shows its dot; clean tabs
   do not.
4. Within a block: needs-action band on top, ascending time inside each band.
5. `skipped_empty` stays OUT of the needs-action band and sorts by time
   with the rest of the block. It is benign and terminal, but the brief was
   "sort by time" with exactly one exception (the band) -- sinking finished
   states would be a second, unrequested exception. Noted as an open
   question rather than decided unilaterally.
6. `npx tsc --noEmit` clean; `npx eslint` on changed files adds no new problems.
7. Renders on localhost against real data.

## Out of scope

- Any change to the top block's content or behavior.
- Persisting tab selection.
- Per-number filtering on any other screen.
