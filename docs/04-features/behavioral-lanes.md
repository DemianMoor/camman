# Behavioral lanes (campaign behavioral branching)

_Last updated: 2026-06-17_

Behavioral branching lets one campaign send a different message to a contact
depending on how that contact has behaved **so far in this campaign**. A stage
("position") is split into three **lane-stages**, one per behavioral tier; at
send time each still-in-sequence recipient is routed into exactly one lane by
their current high-water tier.

> **Status:** preview + composition are built and operator-facing. **Sending is
> unchanged** — the global send switch (`SEND_ENABLED`) is untouched and no live
> send has fired, so lane preview counts are 0 until real sends accumulate.

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
- **Lane creation:** `performBehavioralSplit()` in
  [lib/stages/behavioral-split.ts](../../lib/stages/behavioral-split.ts), exposed
  at `POST /api/campaigns/[campaignId]/stages/[stageId]/behavioral-split`. Stamps
  three lane-stages cloning the parent's config, sets tier + parent, regenerates
  each lane's stage `tracking_id`, leaves `split_index/split_total` NULL. Guards:
  rejects a source that is itself a lane (`already_lane`), archived, or already
  split (`already_behaviorally_split`). Transactional. **No draft/status gate** —
  lanes are created post-activation by design (the A/B split route has none either).

## Operator UI (campaign detail page)

- **Entry point:** the stage row's actions menu → **"Behavioral split…"**, shown
  only on an ordinary stage (not a lane, and not one that already has lanes). It
  opens a confirm dialog (mirroring the A/B split confirm), then calls the
  endpoint and the three lanes appear in the stages table.
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
