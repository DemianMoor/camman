# Behavioral lanes (campaign behavioral branching)

_Last updated: 2026-06-23_

Behavioral branching lets one campaign send a different message to a contact
depending on how that contact has behaved **so far in this campaign**. A stage
("position") is split into three **lane-stages**, one per behavioral tier; at
send time each still-in-sequence recipient is routed into exactly one lane by
their current high-water tier.

> **Status:** preview, composition, AND send-resolution are built. A lane now
> resolves and materializes its recipients through the **existing** kickoff +
> drain pipeline (no parallel send path), but sending stays **fully behind the
> `SEND_ENABLED` gate** (and the per-org `sends_enabled` switch) — no live send
> has fired, so lane preview counts are 0 until real sends accumulate.

## The tier model

A contact's tier within a campaign is a **high-water mark** (only goes up):

| Tier | Name | Signal (campaign-scoped) |
|------|------|--------------------------|
| 0 | Ignored | no qualifying click |
| 1 | Clicked | a CLEAN click (not bot/prefetch/suspect) on a link in this campaign |
| 2 | Reached offer | a `stage_sends` row with `offer_reached_at` set |
| 3 | Converted | a `stage_sends` row with `sale_status = 'sale'` |

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
- `parent_stage_id` is the **aliveness anchor** only ("received the prior
  position") — NOT a "was in this lane before" link. The tier is read
  campaign-wide, not from the parent's recipient list.

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
- **Lane creation:** `performBehavioralSplit()` in
  [lib/stages/behavioral-split.ts](../../lib/stages/behavioral-split.ts), exposed
  at `POST /api/campaigns/[campaignId]/stages/[stageId]/behavioral-split`. Stamps
  three lane-stages cloning the parent's config, sets tier + parent, regenerates
  each lane's stage `tracking_id`, and rewrites only `sub_id3` in the cloned
  `full_url` to that new tracking id (preserving `sub_id1`/other params). Like
  every copy path, each lane starts with **`scheduled_at = null`** (never inherits
  the parent's date — a stale date would auto-fire on approval; see
  [conventions](../07-conventions.md)), leaves `split_index/split_total` NULL. Guards:
  rejects a source that is itself a lane (`already_lane`), archived, or already
  split (`already_behaviorally_split`). Transactional. **No draft/status gate** —
  lanes are created post-activation by design (the A/B split route has none either).

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
- **Live preview counts:** the **Audience** column for a lane row is the live
  lane count, computed via `countStageRecipients()` (wraps `stageRecipientsSql`)
  in the stages list route — the same recipient query, not a second one. Lane
  rows always show the number (even `0`) tagged `live`. An explainer above the
  table notes that converted contacts exit and opted-out are suppressed, so lane
  counts won't sum to the full pool, and that the numbers change until send.
- **Per-lane copy:** a lane is an ordinary editable stage — edit its message via
  the normal stage editor. Tier/parent are not editable.

## Tests (synthetic data under a throwaway org; real-data counts asserted unchanged)

- [scripts/test-campaign-tier.ts](../../scripts/test-campaign-tier.ts) — tier fragment.
- [scripts/test-recipients-lanes.ts](../../scripts/test-recipients-lanes.ts) — lane recipient sets + ordinary-SQL-unchanged.
- [scripts/test-behavioral-split.ts](../../scripts/test-behavioral-split.ts) — the split endpoint + guards + rollback.
- [scripts/test-lane-preview-count.ts](../../scripts/test-lane-preview-count.ts) — the live preview counts (incl. zero-data).
