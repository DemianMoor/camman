# Behavioural split — pick which lanes get created

**Date:** 2026-09-06
**Status:** Implemented 2026-09-06. Body validation came out stricter than
designed — a body carrying a malformed `tiers` is a 400 rather than a silent
fallback to the default (see §2), because `{"tiers":["0","1","2"]}` quietly
producing 2 lanes is a wrong answer dressed as a success.
**Surfaces:** `lib/stages/behavioral-split.ts`, `app/api/campaigns/[campaignId]/behavioral-split/route.ts`, `app/(protected)/campaigns/[id]/page.tsx`

## Problem

A campaign-level behavioural split always stamps **three** lanes — `Ignored`
(tier 0), `Clicked` (tier 1), `Reached offer` (tier 2) — because
`LANE_TIERS` in [lib/stages/behavioral-split.ts](../../../lib/stages/behavioral-split.ts)
is a hard-coded three-element const and the lane rows are `LANE_TIERS.map(...)`.

Operators do not want the `Ignored` lane. Their established routine is: create
the split, **delete the tier-0 lane by hand**, then schedule and approve the
other two.

That manual delete is load-bearing, and nothing enforces it. A split group
releases all-or-nothing: `selectDrainableStages` refuses to drain any lane while
its group is not `materialized`, and `settleSplitGroup` only reaches
`materialized` once **every** non-archived lane has `materialized_at` or
`skipped_empty_at`. A tier-0 lane left in place is never scheduled and never
approved, so Phase A (`send_approved = true AND scheduled_at IS NOT NULL`) can
never select it, so it can never materialize, so the group can never settle —
and the two lanes the operator *did* schedule are frozen with it, silently.

**Live incident, 2026-09-05.** The operator ran a delete pass across 14
campaigns between 17:07 and 17:28 UTC, then created three more splits at 17:30,
17:31 and 17:32, scheduled their tier-1/tier-2 lanes, and never went back to
delete their tier-0 lanes. Result: campaigns 1151, 1152 and 1171 had **650
fully-materialized messages frozen for ~13 hours** across 6 lanes. The drain
itself was healthy throughout — 13,225 Text Request messages went out in the
same hour, including on the *same two sending numbers*. The only signal was the
hourly backlog-stall alert, which fires 60 minutes *after* the last lane's due
time, by which point that evening's send window was effectively gone.
Recovered by rescheduling the six lanes and deleting the three tier-0 lanes.

## Goal

Let the operator choose which lanes a split creates, defaulting to the two they
actually use, so the trap row is never created and the manual delete step
disappears.

## Facts this rests on (measured on production, 2026-09-06, pre-fix)

- **77 split groups exist. 73 of them have exactly 2 lanes**, because the tier-0
  row was hard-deleted. Only 4 groups ever kept 3 lanes.
- **Only 4 tier-0 lane rows have ever survived creation, and exactly 1 ever
  fired.** Against 77 tier-1 and 77 tier-2 lanes, 74 fired each.
- Of the 4 surviving tier-0 lanes, **3 were the ones wedging the incident**.
- `campaign_events` holds **124 `stage_deleted` events in 30 days**; 24 of the
  25 most recent are `Stage 3 deleted`, one per campaign, a minute or two apart
  — the tier-0 lane being thrown away immediately after each split.
- A two-lane group is therefore already the overwhelmingly normal shape. This
  change introduces no new group topology, only a different default.

## Design

### 1. `lib/stages/behavioral-split.ts` — create only the requested tiers

`LANE_TIERS` stays exactly as it is — the full 0/1/2 registry. It is consumed by
the lane insert here and asserted by
`scripts/test-behavioral-split.ts:281` (`LANE_TIERS = tiers 0,1,2 (no tier-3
lane)`); leaving it intact keeps that existing assertion green. Selection is a
filter applied *over* the registry, never a change to it.
`performBehavioralSplit` gains one optional field:

```ts
opts: { orgId; campaignId; actorUserId?; tiers?: number[] }
```

`DEFAULT_LANE_TIERS = [1, 2]` is exported alongside `LANE_TIERS`. Resolution:

- `tiers` omitted or `undefined` → `DEFAULT_LANE_TIERS`.
- Otherwise the given list, de-duplicated, ordered ascending by tier so lane
  `stage_number` assignment stays deterministic.

The lane rows become `LANE_TIERS.filter(t => selected.has(t.tier)).map(...)` —
every other field in the insert is untouched. Validation lives here, not only in
the route, so the test harnesses that call `performBehavioralSplit` directly
exercise the same rules:

- empty after de-duplication → `{ ok: false, status: 400, code: "no_lanes_selected" }`
- any value outside `{0, 1, 2}` → `{ ok: false, status: 400, code: "invalid_lane_tier" }`

Tier 3 (`converted`) remains deliberately unrepresentable — it exits the
sequence and never gets a lane.

### 2. API — `POST /api/campaigns/[campaignId]/behavioral-split`

The route currently reads no body. It gains an **optional** JSON body validated
with Zod:

```ts
z.object({ tiers: z.array(z.number().int()).min(1).max(3).optional() })
```

An absent body, an empty body, or unparseable JSON is treated as "no `tiers`
supplied" and falls through to the default `[1, 2]` — so an old client cannot
silently resurrect the three-lane behaviour, and a malformed body cannot 500.
Explicit invalid values (`[]`, `[5]`) are rejected by the lib with the codes
above, mapped through the existing `apiError` path.

The response is unchanged in shape: `lane_stage_ids` and `tiers` simply come
back with the length the operator asked for. Permission (`stages.create`), the
"one live split per campaign" gate, and the `no_completed_source_stages` gate
are all untouched.

### 3. UI — the confirm modal in `app/(protected)/campaigns/[id]/page.tsx`

The modal already renders a **Lane counts (provisional)** block that lists all
three tiers with their live counts from `previewSplitLanes`. That list becomes
the picker — the smallest change that delivers the feature, with no new
component and no new dependency:

```
Lane counts (provisional)
  ☐  Ignored                    1,204
  ☑  Clicked                      438
  ☑  Reached offer                 30
  ────────────────────────────────────
     Converted (exits — no lane)    12
     Opted out (suppressed)         31
```

- New state `selectedTiers`, initialised to `[1, 2]`, **reset on every modal
  open** (in `openBehavioralSplit`, not in an effect — keeps the file clear of
  new `react-hooks/set-state-in-effect` violations).
- Each lane row becomes a clickable toggle. **There is no shadcn `Checkbox`
  primitive in this repo** (`components/ui/` has `switch.tsx` only), so reuse
  the codebase's existing checkbox-row idiom from
  [components/multi-select-picker.tsx](../../../components/multi-select-picker.tsx):
  a `size-4` bordered `<span aria-hidden>` holding a lucide `<Check
  className="size-3" />` when selected, inside a `<button>` row. Three fixed
  options stays inline per the `CLAUDE.md` §9 rule — `MultiSelectPicker` is for
  >10 options and would be friction here. The count stays on the right,
  unchanged.
- The confirm button reads **"Create N lanes"** and is `disabled` when
  `selectedTiers.length === 0`.
- The intro sentence stops hard-coding "three"; it names the lanes currently
  ticked.
- `handleBehavioralSplit` posts `{ tiers: selectedTiers }`, and the success
  toast names the lanes actually created instead of always saying "3 lanes".
- The `converted` / `opted out` footer rows stay informational — they are not
  lanes and get no checkbox.

### 4. What deliberately does not change

The all-or-nothing release rule, `settleSplitGroup`, `sweepStuckSplitGroups`,
`selectDrainableStages`, and the Phase A selection predicate are all untouched.
This change removes the row that springs the trap; it does not relax the trap.
Relaxing it — letting an unscheduled lane not block its group — was considered
and **rejected**: lanes are created with `scheduled_at = null` by design and the
operator schedules each one separately, so that rule would settle a group the
moment the first lane materialised and release it before its siblings were even
scheduled. That is the premature release the atomicity exists to prevent.

## Edge cases

| Case | Behaviour |
|---|---|
| Operator unticks everything | Confirm button disabled; direct API call gets 400 `no_lanes_selected` |
| Operator ticks all three | 3 lanes — today's behaviour exactly, still supported |
| Operator ticks only `Ignored` | 1 lane. Allowed; a single-lane group settles normally |
| Body absent / not JSON | Defaults to `[1, 2]`, no error |
| `tiers: [1, 1, 2]` | De-duplicated to `[1, 2]` |
| `tiers: [3]` or `[7]` | 400 `invalid_lane_tier` |
| Lane resolves to zero recipients | Unchanged — `skipped_empty_at`, which satisfies the group |

## Existing call sites that MUST be updated with the default change

Changing the default from "all three" to `[1, 2]` silently changes what every
existing caller gets. There are **11 call sites across 5 scripts**, all calling
`performBehavioralSplit({ orgId, campaignId })` with no tiers:

| File | Call sites |
|---|---|
| `scripts/test-behavioral-split.ts` | 134, 146, 185, 199, 266 |
| `scripts/test-split-manual-prepare.ts` | 115, 210 |
| `scripts/test-stage-copy-invariants.ts` | 115 |
| `scripts/verify-campaign-level-split.ts` | 348, 530 |
| `app/api/campaigns/[campaignId]/behavioral-split/route.ts` | 54 (the real one — passes the operator's choice) |

`scripts/test-behavioral-split.ts` alone has **five assertions that hard-code 3
lanes** (lines 147, 149, 182, 192, and the case comment at 122). Left alone they
go red the moment the default changes.

**Every script call site gets an explicit `tiers: [0, 1, 2]`.** Those cases are
testing group linkage, rollback, no-stacking and the group state machine — not
the default — so pinning them to the trio keeps each assertion testing what it
was written to test, and keeps the change's blast radius inside the new script.
This is deliberate: silently rewriting those assertions to expect 2 would delete
the only coverage the three-lane path has.

`npx tsc --noEmit` will NOT catch any of this — `tiers` is optional, so every
one of these calls still type-checks. Only running the scripts finds it.

## Verification

New script `scripts/test-behavioral-split-lane-picker.ts`, following the
existing `scripts/test-behavioral-split.ts` harness, asserting against a
throwaway campaign:

1. Default (no `tiers`) creates exactly 2 lanes, tiers `[1, 2]`, and no tier-0
   row exists for the group.
2. `tiers: [0, 1, 2]` creates 3 lanes — today's behaviour preserved.
3. `tiers: [1]` creates 1 lane.
4. `tiers: []` → `no_lanes_selected`; `tiers: [3]` → `invalid_lane_tier`; neither
   creates a group or any stage row (transaction rolled back).
5. `tiers: [2, 1, 1]` → 2 lanes in ascending tier order.
6. A default-created 2-lane group whose lanes both materialise reaches
   `state = 'materialized'` — the regression guard for the incident: it proves
   the group can settle without a tier-0 lane present.

Plus a green re-run of **all four** existing scripts that call
`performBehavioralSplit`, after their call sites are pinned to `[0, 1, 2]`:
`scripts/test-behavioral-split.ts`, `scripts/test-split-manual-prepare.ts`,
`scripts/test-stage-copy-invariants.ts`, and
`scripts/verify-campaign-level-split.ts` (56 assertions). Then `npx tsc
--noEmit`.

Baseline recorded 2026-09-06 on `origin/main` @ `837784d`: `tsc --noEmit`
exits 0. Any type error after this change is ours.

⚠️ These scripts write to the SHARED production database. They scope themselves
to a marked test org (`ORG_MARKER`) and clean up in a `finally` block — run them
one at a time and confirm each cleanup block reported success before moving on,
so no fixture rows are left behind in the live database.

**A guard that must not be written as an absolute.** Assertion 1 checks the
lanes *this call* created, keyed on the returned `split_group_id` — never a
global "no tier-0 lanes exist" count, which would go red the first time someone
legitimately ticks the `Ignored` box.

## Docs to update

- `docs/04-features/` — the behavioural-split feature doc: lanes are now chosen
  at creation, `Ignored` off by default.
- `docs/07-conventions.md` — record the default and *why* (the tier-0 lane was
  deleted by hand 73 times out of 77 and froze 650 messages when it wasn't).
- `docs/CHANGELOG.md` — one-line entry.

## Out of scope (stated, not silently dropped)

If an operator deliberately ticks all three lanes and then schedules only two,
the same freeze is still possible. The discussed mitigation — moving the
blocked-group warning into the T−15 `send-preflight` digest so it arrives
*before* the send instead of an hour after — was considered and deferred by the
operator in this round. The late `sweepStuckSplitGroups` alert remains the only
net for that case.
