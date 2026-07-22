# Move a Provider Phone to Another Provider — Design

**Date:** 2026-07-22
**Status:** Approved, pending implementation plan

## Problem

A phone number can only exist under one provider at a time. The user needs to
shift a number from provider A to provider B (e.g. porting a number between SMS
vendors). Today the only path is archive-then-recreate, which fails: the unique
constraint `provider_phones_org_id_phone_number_unique` on `(org_id,
phone_number)` counts **archived** rows too, so recreating the same number under
another provider returns `409 DUPLICATE` — "this phone number already exists".

## Chosen approach: Move (reassign provider) — NOT delete

Instead of deleting and recreating, **move the existing row**: change
`provider_phones.provider_id` in place. The row's `(org_id, phone_number)` never
changes, so the unique constraint is never re-triggered — which is exactly the
block being removed. The number is never duplicated and its history stays
attached to the same row.

Rejected alternatives:
- **Hard delete + recreate** — matches the literal request but loses the old
  provider's per-number reporting link (FKs are `set null`) and is more
  destructive than needed.
- **Partial unique index** (`WHERE status <> 'archived'`) — would make
  archive-then-recreate work but leaves a lingering archived duplicate row and
  splits one number's history across two rows.

## Reporting consequence (accepted)

Number-level reports resolve a send's provider by joining the phone row and
reading its **current** `provider_id`:
- [lib/reporting/performance-report.ts:597-598](../../../lib/reporting/performance-report.ts#L597-L598)
- [lib/reporting/rollup.ts:82](../../../lib/reporting/rollup.ts#L82)

So after a move, past sends through that number re-attribute to the **new**
provider in number-keyed reports. Reports keyed off the stage's own
`campaign_stages.sms_provider_id` snapshot are unaffected. The user accepted this
trade-off when choosing Move over a hard delete. The Edit dialog will state it
explicitly.

## Data model — no migration

Everything needed already exists:
- `provider_phones.provider_id` is a normal updatable column (FK to
  `sms_providers`, `onDelete: cascade`).
- `provider_phones.credential_id` (account link) FK is `onDelete: set null`.
- Every FK pointing at `provider_phones.id` (`campaign_stages`, `stage_sends`,
  link destinations, contacts) is `onDelete: set null` — none are touched by a
  move; the row's `id` is stable.

**No schema change, no migration.**

## API — extend the existing PATCH

`PATCH /api/providers/[providerId]/phones/[phoneId]`

Add two optional fields to `providerPhoneUpdateSchema`:
- `provider_id: number` — the target provider.
- `confirm_move: boolean` — bypasses the live-stage warning.

Behavior when `provider_id` is present **and differs** from the current provider
(the URL's `providerId`):

1. Verify the target provider exists in the caller's org and is not the current
   provider. On failure → `400 VALIDATION` (`field: provider_id`) or `404
   NOT_FOUND` for an unknown/other-org target.
2. Query **not-yet-sent** stages referencing this phone:
   `campaign_stages` where `provider_phone_id = phoneId`, `org_id = orgId`, and
   `status IN ('draft','pending')`. (Already-`sent`/`success`/`cancelled`/
   `failed`/`archived` stages are terminal — a move only affects their reporting,
   which is accepted, so they don't warn.)
3. If any such stages exist **and** `confirm_move !== true` → return `409` with
   `code: MOVE_NEEDS_CONFIRMATION` and
   `details: { stages: [{ campaign_id, campaign_human_id, campaign_name,
   stage_number, status }], target_provider_name }`.
4. Otherwise perform the move in a single `UPDATE ... RETURNING`:
   - `provider_id = target`
   - `credential_id = NULL` (the account link belonged to the old provider)
   - Keep `brand_id`, `cost_per_sms`, `max_sends_per_second`, `status`,
     `phone_number`, geo columns unchanged.
   - Any `cost_per_sms` / `brand_id` / `max_sends_per_second` edits made in the
     same Edit dialog submission apply in the same update.

The existing `WHERE provider_id = <URL pid>` on the update still matches the row
before the change (URL pid = current provider), so the same statement can set the
new `provider_id`.

When `provider_id` is absent or equals the current provider, PATCH behaves
exactly as today (a normal cost/brand/rate edit; no confirm handshake).

**Permission:** the provider change stays under `provider_phones.update`
(operator+). Move is reversible (move back), so it is not gated at manager level.

## UI — Provider field in the Edit dialog

`components/providers/phone-form.tsx` (edit mode only):
- Add a **Provider** `<Select>` defaulting to the current provider, listing the
  org's other **active** providers (fetch `/api/providers/list`, exclude the
  current provider and archived ones). Gate the fetch on edit mode.
- Include the selected `provider_id` in the submitted values.
- Helper text under the field: *"Moving clears this number's account link and
  re-attributes its past sends to the new provider in number-level reports."*

`app/(protected)/providers/[id]/page.tsx` edit-submit handler:
- On a `409` with `code: MOVE_NEEDS_CONFIRMATION`, open an `AlertDialog`
  (confirmation dialog — default dismiss behavior is fine here) listing the
  affected stages from `details.stages`. "Move anyway" resubmits the same PATCH
  with `confirm_move: true`. "Cancel" leaves the Edit dialog open unchanged.
- On success: toast *"Number moved to <provider name>"*, close the Edit dialog,
  and refetch phones — the moved number drops out of the current provider's list.

## Out of scope

- No hard-delete endpoint.
- No schema/migration change.
- No new permission.
- No changes to reporting queries (re-attribution is inherent and accepted).
- No row-action "Move" menu item (the field lives in the Edit dialog per the
  chosen UI).

## Verification criteria

1. Move a phone with no live stages → succeeds; it appears under the target
   provider, disappears from the source provider's list, and `credential_id` is
   null.
2. Move a phone referenced by a `draft`/`pending` stage → first PATCH returns
   `409 MOVE_NEEDS_CONFIRMATION`; the confirm dialog lists the stage(s);
   "Move anyway" (PATCH with `confirm_move: true`) succeeds.
3. After moving a number from A to B, it appears on B's detail page and is gone
   from A's list; moving it back (B→A) works symmetrically. (The number is never
   recreated — the same row is reassigned — so the `(org_id, phone_number)`
   unique constraint is never hit. It correctly still blocks creating a genuine
   *duplicate* of the number elsewhere in the org.)
4. Selecting the same provider (no change) and saving → treated as a normal edit;
   no confirm handshake.
5. A `viewer` (no `provider_phones.update`) is blocked (403).
6. Cost/brand/rate edits made in the same Edit submission as a move are applied
   together.

## Docs to update on implementation

- `docs/04-features/` — provider phones feature doc (add Move).
- `docs/07-conventions.md` — note the move-clears-credential-link + reporting
  re-attribution behavior, if a conventions entry fits.
- `docs/CHANGELOG.md` — one-line entry.
- "Last updated" dates on touched docs.
