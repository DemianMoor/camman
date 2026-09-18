# Behavioral lanes (campaign behavioral branching)

_Last updated: 2026-09-18_

Behavioral branching lets one campaign send a different message to a contact
depending on how that contact has behaved **so far in this campaign**. A stage
("position") is split into **lane-stages**, one per behavioral tier the operator
picks (up to four; `Ignored` and `Registered` are off by default — see
[Lane picker](#operator-ui-campaign-detail-page)); at send time each
still-in-sequence recipient is routed into exactly one lane by their current
high-water tier.

> **Status: LIVE and heavily used.** Measured on production 2026-08-27: **569
> lane stages**, **551 of them fired**, **860,323 messages** sent through lanes
> (tier 0: 815,227 / tier 1: 40,146 / tier 2: 4,950). An earlier revision of this
> doc said "no live send has fired" -- that was written 2026-07-07 and was stale.

> **Since migration 0174 the split is CAMPAIGN-LEVEL.** A lane's audience is
> everyone who received **any COMPLETED stage** of the campaign, not just the one
> chosen predecessor. The tier was already campaign-wide (`campaignTierExpr` never
> looked at ancestry); only the *aliveness anchor* was per-stage. The ~569
> pre-0174 lanes keep `split_group_id IS NULL` = legacy single-parent semantics and
> were deliberately **not** backfilled.

## The tier model

A contact's tier within a campaign is a **high-water mark** (only goes up):

| Tier | Name | Signal (campaign-scoped) |
|------|------|--------------------------|
| 0 | Ignored | no qualifying click |
| 1 | Clicked | a CLEAN click (not bot/prefetch/suspect) on a link in this campaign |
| 2 | Reached offer | a `stage_sends` row with `offer_reached_at` set |
| 3 | Registered | a counted REGISTRATION in the `conversion_events` ledger — `registeredClause()` in [`lib/sale-attribution.ts`](../../lib/sale-attribution.ts) — **and** no purchase-type event of any known status on this campaign |
| 4 | Purchased | a counted PURCHASE in the `conversion_events` ledger — `purchasedClause()` in [`lib/sale-attribution.ts`](../../lib/sale-attribution.ts) |

Tier 4 (**purchased**) **exits** the sequence — there is no tier-4 lane. Lanes
match on **exact** tier (a contact at tier 2 is in the tier-2 lane only), so the
lanes are mutually exclusive by construction.

> **The exit moved from 3 to 4 on 2026-09-18** (conversion-events Phase 4), so
> the scale stays monotonic in behavioural rank: the ranking function is
> `MAX(tier)`, so a contact who registered **and** bought must read as the
> HIGHER value. Appending Registered as 4 instead would have made `MAX` rank a
> $0 registration above a real sale and messaged a buyer again. Nothing was back
> filled — the tier is computed by [`lib/campaign-tier.ts`](../../lib/campaign-tier.ts)
> and never stored. A **rejected** purchase does not return a contact to
> Registered; they fall back to their click / offer-reach tier. A purchase row
> whose status is UNMAPPED (NULL) counts as nothing and does not evict them.
> **Tier 3 became SELECTABLE on 2026-09-18** (Phase 4 Task 3): `LANE_TIERS` now
> lists `{0,1,2,3}`, so the picker's **Registered** row can be ticked and the
> split creates a tier-3 lane. `DEFAULT_LANE_TIERS` is **unchanged at `[1, 2]`** —
> the new lane starts UNTICKED, so no existing workflow changes shape until an
> operator picks it deliberately. Tier 4 is still refused by both `resolveLaneTiers`
> and migration 0184's CHECK. (The dialog's `Registered` row existed before the
> picker did — `previewSplitLanes` reports one row per `LANE_TIER_VALUES` entry —
> and ticking it used to fail the whole split with `400 invalid_lane_tier`; before
> the label existed it rendered BLANK. Every lane tier now has a label, asserted by
> `P16` in `scripts/test-campaign-tier-scale.ts`, and the two registries are
> asserted equal by the `LANE_TIERS is exactly LANE_TIER_VALUES` bar in
> `scripts/test-behavioral-split.ts`.)
>
> **The operator-visible consequence of the ordering.** `Registered` (3) outranks
> `Reached offer` (2), and lanes match on EXACT tier — so a contact who registered
> is no longer in the tier-2 lane. Leaving `Registered` unticked means those
> contacts get **no message at that position**. The confirm dialog and the stages
> explainer both say so. The change can therefore only ever REDUCE who is
> messaged, never add someone.

## Data model

- `campaign_stages.behavioral_tier` (`0|1|2|3` since migration 0184, nullable) + `parent_stage_id`
  (self-FK, `ON DELETE CASCADE`, nullable). Both NULL ⇒ an ordinary stage. Set
  together for a lane (DB CHECK `campaign_stages_behavioral_lane_check`). Migration
  `0071_stage_behavioral_lanes.sql`. See [03-data-model](../03-data-model.md).
- Both fields are **immutable** after creation: not in `stageUpdateSchema` (Zod
  strips them) and listed in the PATCH route's `NON_UPDATABLE` backstop.
- `parent_stage_id` is an **anchor**, never a "was in this lane before" link, and
  the tier is read campaign-wide, not from the parent's recipient list. What it
  anchors depends on the lane:
  - **legacy lane** (`split_group_id IS NULL`) — the ALIVENESS anchor
    ("received the prior position"). Unchanged.
  - **grouped lane** (0174) — the **P4 slip anchor only**. Aliveness comes from
    the group's `source_stage_ids`.
- `campaign_stages.split_group_id` (0174, nullable, `ON DELETE SET NULL`) and
  `skipped_empty_at`. See [03-data-model](../03-data-model.md).

## Campaign-level splits (migration 0174)

### What changed

Before 0174 a lane's audience was `frozen pool INTERSECT received THAT ONE parent
INTERSECT tier`. Now it is `frozen pool INTERSECT received ANY COMPLETED STAGE
INTERSECT tier`. Nothing about the tier changed.

Widening is safe by construction: materialization only ever draws from
`campaign_audience_pool`, so `sent(parent)` is a subset of `sent(all completed
stages)`. Verified against production 2026-08-27 across **203 legacy lane
parents** -- `old EXCEPT new = 0` in every case.

> **The one exception.** If a campaign's completed stages reached nobody, the new
> source set is empty and a new lane would be SMALLER, not larger (3 of 206 real
> lane parents: campaigns 119, 120, 478). The cause is always the same -- the
> stage that actually sent still carries stranded `pending` rows, so it is not
> "complete". The confirm modal reports `0 contacts reached` with an amber warning
> before the operator commits.

### "Completed stage" -- and why it is NOT `status`

The source set uses the SHARED predicate in
[lib/sends/stage-complete.ts](../../lib/sends/stage-complete.ts):

```
sent_at IS NOT NULL
AND NOT EXISTS (stage_sends WHERE stage_id = s.id AND status IN ('pending','sending'))
```

the same one `getParentState()` uses for the P4 parent-complete gate, hoisted so
the two cannot drift. **`campaign_stages.status` is the wrong axis**: it is the
operator's manual record of results. Measured on production -- of 1,231 tracked
stages, **1,183 have `sent_at` but only 957 carry a status in
(`success`,`sent`)**, so filtering on `status` would silently drop 227 stages that
really sent. Lanes and archived stages are excluded from the source set.

### The group

`campaign_stage_split_groups` owns one split's three lanes. Its state machine:

```
pending --recompute--> materializing --all lanes done--> materialized
                            |
                            +--any lane permanently refused--> failed
```

- **`source_stage_ids` is written at RECOMPUTE time, not at split creation.** A
  stage that finishes sending between the split being created and the recompute
  MUST be in the source set, so freezing it early would be wrong. `recomputed_at`
  is what the UI renders as "resolved at".
- **The recompute runs on the `send-preflight` cron** (`*/5`,
  `PREFLIGHT_LEAD_MS = 15 min`) -- it already leads each `send-scheduled` tick by
  exactly one lead time, is read-mostly, is per-stage best-effort, and carries the
  operator abort. It deliberately does **not** ride on `preflight_notified_at`,
  which is a post-once marker.
- **But the cron is not the only way in: `kickoffStageSend` resolves the group
  itself.** That covers EVERY path that can materialize — the manual Prepare
  button, approve-send, and Phase A — so "the source set is resolved before any
  row is written" holds in one place instead of three, and it is what makes the
  Prepare button work at all. `ensureGroupSourceResolved()` is idempotent and
  guarded on `state = 'pending'`, so all callers race harmlessly. The cron sweep
  is an OPTIMISATION (resolve early, so the T−15 digest reports the real
  audience), not the mechanism.

  > This shipped broken and was fixed 2026-08-28. Kickoff originally only
  > *checked* the group state and refused a `pending` one. A group leaves
  > `pending` only when the sweep or Phase A resolves it, and both require the lane
  > to be approved AND due (or inside the lead window) — neither of which an
  > operator clicking Prepare right after creating a split satisfies. So Prepare
  > was a dead end, and its error copy ("it will prepare itself on the next
  > scheduler tick") was wrong too: with no date set, no tick would ever pick it
  > up. Regression test:
  > [scripts/test-split-manual-prepare.ts](../../scripts/test-split-manual-prepare.ts).
  >
  > The subtle half: after resolving, kickoff must take `source_stage_ids` from the
  > RESOLVE, not from the row it read beforehand — that row still carries the empty
  > array the group was created with, and using it would silently fall through to
  > the single-parent aliveness and materialize the narrower audience.
- **LANES ARE INDEPENDENT (2026-09-07). There is no group-state release gate.**
  Each lane materializes and sends on its own schedule; an unprepared,
  unscheduled, or permanently `failed` sibling holds nobody back.

  > **What this replaced, and why.** 0174 released a split all-or-nothing:
  > **Phase B refused to release a grouped lane until the whole group was
  > `materialized`.** That coupling had no timeout and no
  > escape: Phase A only selects `send_approved AND scheduled_at IS NOT NULL`, so
  > ONE never-scheduled sibling could never materialize, the group could never
  > settle, and every other lane was held forever **without even being marked
  > missed** (Phase B never selected them, so nothing stamped
  > `schedule_missed_at` -- the stages neither sent nor expired). On 2026-09-05
  > that froze **650 built messages for ~13h** across campaigns 1151/1152/1171
  > while the drain was healthy: 13,225 messages went out on the same provider,
  > on the same two numbers, in that hour. The only signal was the hourly
  > backlog-stall alert, which fires 60 min AFTER the last lane's due time.
  >
  > A group can still go `failed` and the state machine still runs -- it is now
  > **observability only** and gates nothing.

- **Disjointness is structural, not timing-based.** Removing the gate removed
  something load-bearing that was never its stated purpose: it was also the only
  reason lanes could not double-message. A lane's audience is an EXACT match on a
  HIGH-WATER tier that only ever rises, and each lane snapshots when IT
  materializes -- so a contact who is tier 0 when the Ignored lane materializes
  and tier 2 an hour later, when another lane materializes, lands in BOTH
  snapshots. Simultaneous release kept every such collision inside the drain's
  1-hour dedup window, which is why it never happened (measured 2026-09-06 across
  all 77 groups: 73 scheduled every lane at the IDENTICAL time, 76 materialized
  within 5 minutes, and ZERO contacts had ever appeared in two lanes). Deliberate
  staggering is now the POINT, so `stageRecipientsSql` **"Block 3"** excludes any
  contact already claimed by a SIBLING lane of the same group: first lane to
  materialize a contact owns them, at any stagger. `rejected` rows do NOT hold a
  claim (they are the cancel audit trail). **This is duplicated in
  `computeLaneAudienceCountsBatch`** so the displayed lane count keeps predicting
  what materializes; [scripts/verify-lane-batch.ts](../../scripts/verify-lane-batch.ts)
  compares the two on real production campaigns and is the only thing preventing
  them from drifting -- it must keep passing `splitGroupId` on BOTH sides.
- **`parent_stage_id` STAYS on a grouped lane**, pointing at the group's
  `anchor_stage_id` (the latest completed stage at creation). It is the P4 slip
  anchor only. Widening the parent-complete gate to wait on ALL source stages
  would let one stalled stage hold the whole group for 24h and then HOLD it.

### Overlapping ticks, and the per-group timeout

The `send-scheduled` cron takes no group-level lease (a tick that overruns its
300s `maxDuration` overlaps the next), so two ticks CAN reach the same group.
Three independent guards hold, each exercised by firing the real function
concurrently in `scripts/verify-campaign-level-split.ts`:

| Race | Guard |
|------|-------|
| two recomputes of one group | `ensureGroupSourceResolved`'s `UPDATE ... WHERE state = 'pending'` — one wins, the loser re-reads the winner's row, so only ONE source set is ever written |
| two materializations of one lane | the pre-existing `stage_sends_active_contact_uniq` partial unique index + `ON CONFLICT DO NOTHING` — 3 concurrent inserts produce exactly 1 row |
| two settles of one group | `UPDATE ... WHERE state = 'materializing' ... RETURNING` — exactly one returns true, so counters can't double |

**Per-group timeout.** A group that never leaves `materializing` holds its
siblings' already-written rows unreleased forever, and nothing else would say so
— silent non-delivery, the worst failure this design can have.
`sweepStuckSplitGroups()` runs on the same `send-preflight` cron and raises a
**Tier-1** alert when a group has an outstanding lane more than
`SPLIT_GROUP_STUCK_MS` (60 min) past its **last lane's due time**.

It is **alert-only** — auto-failing would discard real work and could itself
cause the non-delivery it is meant to catch, so a human decides. `last_error`
doubles as the post-once marker (no re-alert every 5 minutes) and
`settleSplitGroup` clears it.

> **Measuring from the LAST lane's due time is load-bearing.** Lanes are created
> with `scheduled_at = null` and the operator sets each one's time SEPARATELY, so
> a group legitimately sits in `materializing` from the first lane's slot until
> the last one's. Anchoring the clock on `recomputed_at` would fire on every
> normal staggered split. A lane whose time was never set contributes no due time,
> so the clock runs from the last lane that has one — which is exactly the "you
> never scheduled lane 3" case worth flagging.

> ✅ **Staggered lanes now fire on their own times (changed 2026-09-07).** Lane 1
> scheduled 10:00 and lane 3 at 14:00 each send at their own slot. Until
> 2026-09-07 lane 1 materialized at 10:00 but did NOT send until the group settled
> at 14:00, because Phase B gated on group state — staggering silently collapsed
> to "everything at the last lane's time". Contacts stay non-overlapping across
> the stagger via the sibling exclusion, not via simultaneous release.

> ✅ **FIXED 2026-09-07 — kept here as the reason the gate is gone.** The text
> below described live behaviour until lanes were made independent; a
> never-scheduled lane can no longer hold anything back.
>
> 🚨 ~~A lane that is never scheduled freezes its siblings FOREVER.~~ The gate
> above has no timeout. Phase A only selects stages with `send_approved = true`
> AND `scheduled_at IS NOT NULL`, so an unscheduled, unapproved lane can never
> materialize, so `settleSplitGroup` can never flip the group, so Phase B holds
> every sibling indefinitely — `schedule_missed_at` is never stamped either,
> because Phase B never selects them. **This happened on 2026-09-05**: three
> campaigns (1151/1152/1171) kept a tier-0 lane the operator normally deletes by
> hand, and **650 fully-materialized messages sat undelivered for ~13 hours**
> while the drain was healthy (13,225 messages went out on the same provider, on
> the same two numbers, in the same hour). The only signal was the hourly
> backlog-stall alert, which fires 60 min AFTER the last lane's due time — too
> late to save that evening's window. Recovery is: reschedule the stuck lanes to
> a future in-window time **first**, then delete or archive the blocking lane
> (order matters — settling the group while the old date is in the past makes
> Phase B stamp `schedule_missed_at` and write the send off). The picker below is
> the structural fix.

### An empty lane is skipped, not burned

`no_recipients` is a PERMANENT kickoff refusal, so before 0174 a zero-recipient
stage was stamped `schedule_missed_at` and rendered Red "needs attention". Under
campaign-level classification an empty tier is **routine** -- tier 2 measures just
28-323 contacts on the widest production campaigns and is genuinely 0 on smaller
ones. A grouped lane that resolves to zero therefore gets
`campaign_stages.skipped_empty_at` (a pipeline marker, not a `status` value),
reads as the Grey `skipped_empty` operational status, SATISFIES its group so the
siblings still release, and posts an informational (Tier-3) Telegram note. An
ordinary stage with no recipients keeps today's louder behaviour -- for a plain
stage that really is a surprise.

### Operator UI

The **"Behavioral split..."** button lives at CAMPAIGN level, beside "Add stage",
enabled only when at least one stage is complete. It opens a confirm modal
showing the **source scope** (which completed stages, how many contacts they
reached) and **provisional per-tier lane counts**, plus the
`Purchased (exits — no lane)` / opted-out exclusions. The counts are a live scan (measured 1.0-3.5s on the widest
production campaigns) fetched on open -- never inline in a list.

The A/B split stays inside the stage editor because it genuinely IS per-stage.
Two entry points for two different actions; deliberately not two for one action.

## Where the logic lives

- **Tier fragment:** `campaignTierExpr(campaignId, orgId)` in
  [lib/campaign-tier.ts](../../lib/campaign-tier.ts) — a subquery yielding
  `(contact_id, tier)` (high-water via MAX over a per-signal UNION; absence ⇒ 0).
  Read live; swappable for a materialized table at the single call site.
- **Recipient resolution:** `stageRecipientsSql()` in
  [lib/sends/recipients.ts](../../lib/sends/recipients.ts) gains two NULL-guarded
  overlays for lanes — **aliveness** (`EXISTS` a `stage_sends` row for
  `parent_stage_id` with `status='sent'`; manual-mode `stage_result_rows` source
  unions in later) and **exact tier match** (`LEFT JOIN campaignTierExpr`,
  `coalesce(tier,0) = behavioral_tier`, plus a global `<> 4` purchased-exit guard
  — it was `<> 3` until the exit moved on 2026-09-18).
  For ordinary stages the emitted SQL is byte-identical to before. The frozen
  `campaign_audience_pool` stays the universe; tier + aliveness are live overlays.
- **Sending (through the existing pipeline):** `kickoffStageSend()` and
  `preflightStageSend()` in [lib/sends/](../../lib/sends/) pass the stage's
  `behavioral_tier` + `parent_stage_id` into the same `stageRecipientsSql` the
  preview count uses, so the people SENT (materialized into `stage_sends`) are
  byte-identical to the people PREVIEWED. There is **no parallel send path** — a
  lane is just a stage with a narrower recipient set. Every gate lives downstream
  in `runStageDrain()` and still applies unchanged: `send_approved`, the
  `SEND_ENABLED` env backstop, the per-org `sends_enabled` switch, provider
  `send_paused`, credentials, the pacing/minute/24h circuit breakers, opt-out
  suppression (inside `stageRecipientsSql`), and `stage_sends` at-most-once (the
  kickoff `already_pending` guard + the `stage_sends_active_contact_uniq` partial
  unique index). A lane's `stage_sends`/links rows are written identically, so the
  campaign-wide tier + aliveness reads feed the next position automatically.
- **Completed-stage predicate:** `stageCompleteExpr()` / `resolveCompletedStages()` in
  [lib/sends/stage-complete.ts](../../lib/sends/stage-complete.ts) -- shared by the
  split's source set AND the P4 parent-complete gate, so the two cannot drift.
- **Drip journey completion (a SECOND, INLINE copy of the scale — twice):**
  `closeCompletedJourneys()` and `expireJourneysPastEndDate()` in
  [lib/drip/lifecycle.ts](../../lib/drip/lifecycle.ts) ask whether any active
  behavioural child is still owed a send; a child BELOW the contact's tier can
  never be owed, because the tier is high-water. That test needs the tier
  correlated **per journey row** (`j.campaign_id` / `j.contact_id`) while
  `campaignTierExpr` takes a literal campaign id, so the scale is inlined rather
  than imported. **Phase 4 (2026-09-18) gave both copies the tier-3 (registered)
  and tier-4 (purchased) branches.** Until then they topped out at 2, so a
  registrant's real tier of 3 matched no drip child (0/1/2) while the tier-2
  child was still judged reachable: the journey hung for ever and held the
  contact's only live-journey slot. The tier-3 branch carries the same
  `NOT EXISTS` over purchase events at any KNOWN status as `campaign-tier.ts`,
  so a rejected purchase evicts a registrant here identically and an unmapped one
  does not. **No Registered drip follow-up exists** — `FOLLOWUP_TIERS` /
  `FollowupTier` stay `0 | 1 | 2`, a registrant matches no child and simply
  completes. One ⭐ bar per copy in
  [scripts/test-drip-lifecycle.ts](../../scripts/test-drip-lifecycle.ts).
- **Group state machine + recompute + preview:**
  [lib/stages/split-group.ts](../../lib/stages/split-group.ts).
- **Lane creation:** `performBehavioralSplit()` in
  [lib/stages/behavioral-split.ts](../../lib/stages/behavioral-split.ts), exposed
  at `POST /api/campaigns/[campaignId]/behavioral-split` (the old per-stage
  endpoint was REMOVED in 0174 -- one action, one entry point; the provisional
  preview is `GET /api/campaigns/[campaignId]/behavioral-split/preview`). Stamps
  **the selected** lane-stages cloning the parent's config, sets tier + parent, regenerates
  each lane's stage `tracking_id`, and rewrites only `sub_id3` in the cloned
  `full_url` to that new tracking id (preserving `sub_id1`/other params). Like
  every copy path, each lane starts with **`scheduled_at = null`** (never inherits
  the parent's date — a stale date would auto-fire on approval; see
  [conventions](../07-conventions.md)), leaves `split_index/split_total` NULL. Guards:
  rejects a source that is itself a lane (`already_lane`), archived, or already
  split (`already_behaviorally_split` — checked against **live**, non-archived
  lanes only, so archiving or deleting all three lanes unblocks a re-split on the
  original stage; see [campaigns-stages-creatives.md](campaigns-stages-creatives.md#deleting-stages)).
  Transactional. **No draft/status gate** — lanes are created post-activation by
  design (the A/B split route has none either).

## Operator UI (campaign detail page)

- **Entry point:** a **"Behavioral split…"** button inside the stage editor's
  audience block, directly beside the A/B "Split for A/B test…" button — both
  split actions live in the same place. Shown only when editing an ordinary
  stage (hidden on lanes — a "this stage is a behavioral lane" note shows
  instead — and on stages that already have lanes, where the parent's
  `onBehavioralSplit` callback is withheld). It closes the editor and opens a
  shared confirm dialog → endpoint → refetch; the selected lanes then appear in
  the stages table.
- **Lane picker (2026-09-06).** The confirm dialog's lane list is a **picker**,
  not just a preview: each tier row is a checkbox alongside its provisional
  count, and only ticked tiers are created. **Tier 0 (`Ignored`) and tier 3
  (`Registered`) are OFF by default** — `DEFAULT_LANE_TIERS = [1, 2]` in
  [lib/stages/behavioral-split.ts](../../lib/stages/behavioral-split.ts). The
  confirm button reads "Create N lanes" and is disabled at zero.
  - **The client keeps its own copy of the default.** `DEFAULT_SELECTED_TIERS` in
    [app/(protected)/campaigns/[id]/page.tsx](<../../app/(protected)/campaigns/[id]/page.tsx>)
    — the module that owns `DEFAULT_LANE_TIERS` pulls in the db client and cannot
    be imported into a client component. It is named once (it used to be the
    literal `[1, 2]` inline twice), so changing the default is a two-file edit:
    the server's value is what an omitted request body gets, the client's is what
    the picker ticks.
  - **Why the default is two, not three.** Measured 2026-09-06: of the first 77
    split groups, **73 had only two lanes** because the operator deleted the
    tier-0 lane by hand every time (`campaign_events` held 124 `stage_deleted`
    rows in 30 days; 24 of the 25 most recent were "Stage 3 deleted" right after
    a split). Only 4 tier-0 lanes ever survived and exactly **1** ever fired —
    and 3 of the other 3 were the ones that caused the 2026-09-05 freeze above.
    The manual delete was load-bearing and nothing enforced it; not creating the
    lane removes the trap at the source.
  - `tiers` is an **optional** body field. Absent body / unparseable JSON ⇒ the
    default; a body carrying a malformed `tiers` ⇒ `400 invalid_lane_tier` (never
    a silent fallback to the default). `[]` ⇒ `400 no_lanes_selected`; any tier
    outside `{0,1,2,3}` ⇒ `400 invalid_lane_tier`, and the refusal message DERIVES
    its valid list from `LANE_TIERS` rather than restating it (a hard-coded
    "0, 1, 2" would have gone stale silently in Phase 4). Validation lives in
    `resolveLaneTiers` in the lib, not only the route, so the script harnesses
    that call `performBehavioralSplit` directly exercise the same rules. A
    refused selection writes **nothing** — no group row, no lane rows — because
    an orphan group would permanently block the campaign via its own
    `split_already_pending` guard.
  - Tier 4 (`purchased`) stays unrepresentable: it exits the sequence and never
    gets a lane. Tier 3 (`registered`) became **selectable on 2026-09-18** —
    `LANE_TIERS` lists `{0,1,2,3}` and a tier-3 lane persists against migration
    0184's widened CHECK.
- **Lane display:** each lane row shows a tier chip (`↳ Ignored` / `Clicked` /
  `Reached offer` / `Registered`) with `· from #N` pointing at the parent
  position; the parent row shows an `N behavioral lanes` badge. The chip registry
  (`BEHAVIORAL_TIER_META`) is a deliberate client-side duplicate of `LANE_TIERS`
  for the same import reason as the default above.
- **Live preview counts (deferred + batched):** the **Audience** column for a
  lane row is the live lane count. Each lane's count is a seconds-long live-tier
  scan (`links⋈clicks` + `stage_sends`), and a split has 3 lanes — computing them
  inline made a 3-lane campaign's stages list take 30–60s (3× the same scan,
  fired in parallel and CPU-contending). So the work is **deferred off the main
  list**: the stages list returns lanes with `audience_count = null`, the table
  paints immediately, and the client then fetches
  `GET /api/campaigns/[campaignId]/stages/lane-counts` — which computes **all** of
  a campaign's lanes in **one** query via `computeLaneAudienceCountsBatch()`
  ([lib/audience-snapshot.ts](../../lib/audience-snapshot.ts): the campaign tier
  map is a single `MATERIALIZED` CTE reused across every lane, and the parent
  "alive" set is built once) — and patches the numbers into the null placeholders.
  While a lane count is null the cell shows `computing…`. The batched counts are
  proven byte-identical to the former per-lane `countStageRecipients()` path by
  [scripts/verify-lane-batch.ts](../../scripts/verify-lane-batch.ts). Lane rows
  always show the number (even `0`) tagged `live`. An explainer above the table
  notes that **Purchased** contacts exit and opted-out are suppressed, so lane
  counts won't sum to the full pool, that the numbers change until send, and —
  since 2026-09-18 — that **Registered outranks Reached offer**, so a registrant
  is not in the Reached-offer lane and gets nothing unless a Registered lane
  exists.
- **Per-lane copy:** a lane is an ordinary editable stage — edit its message via
  the normal stage editor. Tier/parent are not editable.

## Tests (synthetic data under a throwaway org; real-data counts asserted unchanged)

- [scripts/test-campaign-tier.ts](../../scripts/test-campaign-tier.ts) — tier fragment.
- [scripts/test-recipients-lanes.ts](../../scripts/test-recipients-lanes.ts) — lane recipient sets + ordinary-SQL-unchanged.
- [scripts/test-behavioral-split.ts](../../scripts/test-behavioral-split.ts) — the split endpoint + guards + rollback. Its call sites pass `tiers: [0, 1, 2]` explicitly so they keep exercising the three-lane path after the default changed to `[1, 2]`. Also carries the registry-coupling bar: `LANE_TIERS` (what the picker offers) must be exactly `LANE_TIER_VALUES` (the scale's lane set = migration 0184's CHECK) and must exclude `EXIT_TIER`. Those two lists having drifted is how tier 3 reached the confirm dialog as a row that 400'd when ticked.
- [scripts/test-behavioral-split-lane-picker.ts](../../scripts/test-behavioral-split-lane-picker.ts) — the lane picker: the `[1,2]` default, the explicit trio, a single lane, de-duplication, both refusal codes writing nothing, and — the regression guard for 2026-09-05 — that a **default two-lane group can reach `materialized`** with no tier-0 lane present. Asserts against the group it just created, never a global "no tier-0 lanes exist" count, which would go red the first time someone legitimately ticks `Ignored`. Case 2b (Phase 4) adds tier 3: `LANE_TIERS` carries it labelled `Registered`, `resolveLaneTiers` accepts `[2,3]` and still refuses `4`, the refusal message lists the valid tiers derived from `LANE_TIERS`, a `[2,3]` split persists lanes at tiers 2 **and** 3, and — the bar that must not be allowed to drift — the default is **still `[1,2]`**, so the new lane does not start ticked.
- [scripts/test-lane-preview-count.ts](../../scripts/test-lane-preview-count.ts) — the live preview counts (incl. zero-data).
- [scripts/verify-campaign-level-split.ts](../../scripts/verify-campaign-level-split.ts) — **the 0174 enforcement proof.** Scope is printed and an empty scope FAILS; the three lanes partition the source set; cross-stage precedence (Offer > Clicked > Ignored); a stage completing between the split and the recompute is included; a click before materialization re-routes the contact; frozen after materialization; a failed group releases nothing; an empty lane is skipped not burned; plus old-is-a-subset-of-new against REAL production lanes. Run with `--conditions=react-server`.
