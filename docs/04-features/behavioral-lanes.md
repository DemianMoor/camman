# Behavioral lanes (campaign behavioral branching)

_Last updated: 2026-08-27_

Behavioral branching lets one campaign send a different message to a contact
depending on how that contact has behaved **so far in this campaign**. A stage
("position") is split into three **lane-stages**, one per behavioral tier; at
send time each still-in-sequence recipient is routed into exactly one lane by
their current high-water tier.

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
| 3 | Converted | a `stage_sends` row with a non-rejected conversion — `purchasedClause()` in [`lib/sale-attribution.ts`](../../lib/sale-attribution.ts), i.e. `sale_status IN ('lead','sale')` |

Tier 3 (**converted**) **exits** the sequence — there is no tier-3 lane. Lanes
match on **exact** tier (a contact at tier 2 is in the tier-2 lane only), so the
three lanes are mutually exclusive by construction.

## Data model

- `campaign_stages.behavioral_tier` (`0|1|2`, nullable) + `parent_stage_id`
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
  operator abort. Phase A calls the same idempotent
  `ensureGroupSourceResolved()` as a lazy backstop; both are guarded on
  `state = 'pending'` so they race harmlessly. It deliberately does **not** ride on
  `preflight_notified_at`, which is a post-once marker.
- **Atomicity is at the RELEASE boundary, not the insert boundary.** Lanes
  materialize independently (windowed, per-window commit, resumable -- unchanged);
  **Phase B refuses to release a grouped lane until the whole group is
  `materialized`**. One transaction for the trio was measured at ~30-65s for the
  largest real trio (18,755 combined rows at ~500-900 rows/s): it would hold one
  transaction-pooler connection that long, breach the 300s route ceiling at ~3x
  today's size, and discard the resumability that exists because a 60s timeout used
  to roll back ~17K recipients. On failure the group goes `failed`, no lane
  releases, a Tier-1 Telegram alert fires, and rows already written stay in place
  unreleased -- the abort route is how an operator clears them.
- **`parent_stage_id` STAYS on a grouped lane**, pointing at the group's
  `anchor_stage_id` (the latest completed stage at creation). It is the P4 slip
  anchor only. Widening the parent-complete gate to wait on ALL source stages
  would let one stalled stage hold the whole group for 24h and then HOLD it.

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
reached) and **provisional per-tier lane counts**, plus the converted/opted-out
exclusions. The counts are a live scan (measured 1.0-3.5s on the widest
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
  `coalesce(tier,0) = behavioral_tier`, plus a global `<> 3` converted guard).
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
- **Group state machine + recompute + preview:**
  [lib/stages/split-group.ts](../../lib/stages/split-group.ts).
- **Lane creation:** `performBehavioralSplit()` in
  [lib/stages/behavioral-split.ts](../../lib/stages/behavioral-split.ts), exposed
  at `POST /api/campaigns/[campaignId]/behavioral-split` (the old per-stage
  endpoint was REMOVED in 0174 -- one action, one entry point; the provisional
  preview is `GET /api/campaigns/[campaignId]/behavioral-split/preview`). Stamps
  three lane-stages cloning the parent's config, sets tier + parent, regenerates
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
  shared confirm dialog → endpoint → refetch; the three lanes then appear in the
  stages table.
- **Lane display:** each lane row shows a tier chip (`↳ Ignored` / `Clicked` /
  `Reached offer`) with `· from #N` pointing at the parent position; the parent
  row shows an `N behavioral lanes` badge.
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
  notes that converted contacts exit and opted-out are suppressed, so lane counts
  won't sum to the full pool, and that the numbers change until send.
- **Per-lane copy:** a lane is an ordinary editable stage — edit its message via
  the normal stage editor. Tier/parent are not editable.

## Tests (synthetic data under a throwaway org; real-data counts asserted unchanged)

- [scripts/test-campaign-tier.ts](../../scripts/test-campaign-tier.ts) — tier fragment.
- [scripts/test-recipients-lanes.ts](../../scripts/test-recipients-lanes.ts) — lane recipient sets + ordinary-SQL-unchanged.
- [scripts/test-behavioral-split.ts](../../scripts/test-behavioral-split.ts) — the split endpoint + guards + rollback.
- [scripts/test-lane-preview-count.ts](../../scripts/test-lane-preview-count.ts) — the live preview counts (incl. zero-data).
- [scripts/verify-campaign-level-split.ts](../../scripts/verify-campaign-level-split.ts) — **the 0174 enforcement proof.** Scope is printed and an empty scope FAILS; the three lanes partition the source set; cross-stage precedence (Offer > Clicked > Ignored); a stage completing between the split and the recompute is included; a click before materialization re-routes the contact; frozen after materialization; a failed group releases nothing; an empty lane is skipped not burned; plus old-is-a-subset-of-new against REAL production lanes. Run with `--conditions=react-server`.
