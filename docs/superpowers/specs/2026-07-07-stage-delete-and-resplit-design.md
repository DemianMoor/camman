# Stage hard-delete + re-split unblock — design

**Date:** 2026-07-07
**Status:** Approved (pending spec review)
**Author:** Claude + Demian

## Problem

1. **No way to delete a stage.** Stages only have soft-delete (`status='archived'`).
   A stage created by a typo, an accidental duplicate, or a wrong split lingers
   in the campaign forever. The user wants to *remove* such stages — and their DB
   records — when they hold no real send data.
2. **Re-split is permanently blocked after a split.** Splitting stage A into A/B/C
   stamps `split_total` on the source A. Even after the extra variants (B, C) are
   archived, A still reports "Split 1/3", so
   [`/split`](../../../app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts)
   rejects any re-split with `already_split`. The user is stuck.

The two are connected: removing the accidental variants should let the original
stage become a normal, re-splittable stage again.

## Decisions (confirmed with user)

- **Delete gate = "no send data at all."** A stage is deletable only if it was
  never sent, never marked-as-sent (`sent_at IS NULL`), and carries no imported
  or manual result records. Sent/result-bearing stages stay archive-only.
- **Archiving OR deleting the extra variants unblocks re-split.** Once a stage has
  no remaining *live* (non-archived) split partners it reverts to normal and can
  be re-split.
- **Permission tier: manager+** (`stages.delete`), matching every other `.delete`
  in the project.

## Non-goals

- No schema change / migration. Delete uses existing `ON DELETE CASCADE` /
  `SET NULL` FKs; split-reset reuses existing `split_index` / `split_total`
  columns; the permission is code-only.
- No change to how sent stages are handled — they remain archive-only.
- No explicit `split_group_id` linkage. Sibling identification stays heuristic
  (see Limitations).

## Design

### 1. Permission — `stages.delete`

[lib/permissions.ts](../../../lib/permissions.ts): add `"stages.delete"` to the
`Permission` union and to `managerPerms`. `can("stages.delete")` gates both the
server handler and the UI action.

### 2. `DELETE` handler on the existing stage route

Add a `DELETE` export to
[app/api/campaigns/[campaignId]/stages/[stageId]/route.ts](../../../app/api/campaigns/[campaignId]/stages/[stageId]/route.ts).
Mirrors the segment hard-delete pattern
([app/api/segments/[id]/route.ts](../../../app/api/segments/[id]/route.ts) `DELETE`).

1. `requireApiMembership` + `can(role, "stages.delete")` (403 otherwise).
2. Parse/validate `campaignId` + `stageId`.
3. Load the stage (org- and campaign-scoped): `id`, `stage_number`, `sent_at`,
   `split_total`, `status`. 404 if not found.
4. **Delete gate.** Reject `409` with code `STAGE_HAS_SEND_DATA`
   ("This stage has send or result data and can't be deleted — archive it
   instead.") if any of:
   - `sent_at IS NOT NULL`, OR
   - a row exists in `stage_sends`, `stage_results_imports`,
     `stage_manual_sales`, or `keitaro_stage_results` for this `stage_id`.
   (These four cover all real send/result data; `links`, `stage_result_rows`,
   and `opt_out_attributions` only ever exist alongside one of them, so they need
   no separate check. A single query with four `EXISTS` sub-selects.)
5. In one transaction:
   - `DELETE FROM campaign_stages WHERE id = sid AND campaign_id = cid AND org_id`
     `RETURNING id`. Cascade removes any child rows; `campaign_events.stage_id`
     is `SET NULL`, preserving campaign history.
   - **Split-reset.** If the deleted stage had `split_total IS NOT NULL`, count
     remaining stages in the campaign with `split_total IS NOT NULL AND status <>
     'archived'`. If exactly **one** remains, `UPDATE` it to
     `split_index = NULL, split_total = NULL` (revert to a normal stage). Zero or
     >1 remaining → leave untouched.
6. Log a `stage_deleted` campaign event via `logCampaignEvent` (stageId `null`
   since the row is gone; `stage_number` in the summary + metadata).
7. Return `200 { deleted: true, id }`.

### 3. Re-split guard fix

In [split/route.ts](../../../app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts),
replace the blanket `if (source.split_total !== null)` rejection:

- Keep the existing archived-source check ("Restore the stage first").
- When `source.split_total !== null`, run a cheap count of **live partners** —
  other stages in the same campaign/org with `id <> sid`,
  `split_total IS NOT NULL`, `status <> 'archived'`. Reject `409 already_split`
  **only if that count > 0**. Otherwise allow: the source stands alone (its
  variants were archived or deleted), and the existing transaction overwrites its
  `split_index`/`split_total` to the new count cleanly.

### 4. UI

[app/(protected)/campaigns/[id]/page.tsx](<../../../app/(protected)/campaigns/[id]/page.tsx>):

- `const canDeleteStage = can("stages.delete");`
- Add a destructive **Delete** `DropdownMenuItem` (Trash2 icon,
  `text-destructive` styling) in the stage row's actions menu, after the
  Archive/Restore group. Show it when `canDeleteStage` and the row is plausibly
  deletable (`!s.sent_at` and no send/result counts) — the server gate is
  authoritative, so an unexpected 409 surfaces via `toastApiError`.
- Add `stageDeleteConfirm` state + a destructive `AlertDialog`
  ("Permanently removes this stage and all of its records. This can't be
  undone.") mirroring the existing `stageArchiveConfirm` flow.
- `handleStageDelete`: `DELETE /api/campaigns/{cid}/stages/{sid}` → on success
  toast "Stage deleted", `refetchStages()` + `refetchCampaign()`.

### 5. Docs (mandatory per CLAUDE.md)

- `docs/04-features/` — stage delete + re-split behavior.
- `docs/07-conventions.md` — delete gate rule + split-reset rule.
- `docs/CHANGELOG.md` — one-line entry.
- "last updated" dates on every touched doc. No `docs/03-data-model.md` change
  (no schema change).

## Verification criteria

- **Delete happy path:** a fresh draft stage → Delete → row gone from
  `campaign_stages`; campaign still loads; a related `campaign_events` row (if
  any) survives with `stage_id = NULL`.
- **Delete gate:** a stage with `sent_at` set, or with an import / manual-sales /
  keitaro / send row, returns `409 STAGE_HAS_SEND_DATA` and is NOT deleted.
- **Cascade:** deleting a stage that *is* deletable but happens to have a
  behavioral-lane child removes the child too (child is itself never-sent).
- **Split-reset on delete:** split A/B/C → delete B and C → A reverts to
  `split_index = NULL, split_total = NULL` and shows no "Split" badge.
- **Re-split after archive:** split A/B/C → archive B and C → re-split A succeeds
  (no `already_split` 409); A becomes 1/N of the new split.
- **Re-split still blocked with live partners:** split A/B/C (all live) →
  re-split A → `409 already_split`.
- **Permission:** an `operator` gets 403 on DELETE; `manager+` succeeds.
- Typecheck + existing stage API tests pass; docs updated.

## Limitations

- Sibling identification is heuristic (no `split_group_id`). A campaign running
  **two independent live splits simultaneously** would conservatively block
  re-split of either, and delete-reset would not fire while >1 live split member
  remains. This never corrupts data — it only errs toward "blocked", matching
  today's behavior. Single-split campaigns (the real use case) work exactly as
  intended.
