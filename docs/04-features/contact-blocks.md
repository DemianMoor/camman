# Contact Blocks + Soft Delete

_Last updated: 2026-11-06 (PR 1: schema 0237 + scripts; no app code reads or writes it yet)_

Spec: [docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md](../superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md) (approved 2026-11-06, with amendments).

## What it is

- **Delete is a soft delete.** `contacts.archived_at` is set; the row and all its history stay. The UI still says "Delete". No hard delete remains in the app (Phase 1 end state). Erase (a real hard delete, owner-only, batched in the morning window) is Phase 2.
- **Block / Unblock** is phone-keyed. The `contact_blocks` ledger holds one *active* row per (org, phone). Reasons: `provider_list`, `manual`, `deleted`, `complaint`, `carrier_block`.
- **Every import checks the ledger.** A blocked or deleted phone is skipped and counted as "blocked" in the import summary. No contact is created for a blocked phone that has none. STOP handlers and the opt-out upload are never blocked.
- **Every forward-looking selection excludes** blocked and deleted contacts. Historical reports are unchanged.

## Precedence

`opt_out > blocked > archived (deleted) > active`. Unblock never releases an opt-out: the opt_outs row stays and keeps the contact excluded.

## How exclusion works (D1)

`contacts.messaging_status` is derived by the trigger `contacts_derive_messaging_status` (migration 0096, rewritten in 0237):

| State | messaging_status |
|---|---|
| `blocked_at` or `archived_at` set | `blocked` |
| landline | `not_applicable` |
| otherwise | `eligible` |

Almost every audience path already requires `messaging_status = 'eligible'`, so blocked and deleted contacts drop out of all of them with no SQL change. That covers:
- segment and group sources, the snapshot and the previews;
- the frozen reference copy (the kill switch);
- the three offer-group matviews, on their next refresh;
- group-lifecycle and lookup stats.

The rest are listed path by path in spec §6.

⚠️ "Not eligible" no longer means "landline". A reader that tests `= 'not_applicable'` or `!= 'not_applicable'` to mean "can (not) be messaged" is wrong. See [07-conventions.md](../07-conventions.md).

## Invariants

1. `contacts.blocked_at IS NOT NULL` ⇔ there is an active `contact_blocks` row for (org, phone) whose reason is not `deleted`. `block_reason` mirrors that row's reason, and the two columns are set and cleared together (enforced by a CHECK).
2. **An archived contact always has an active ledger row**, either `deleted` or a block reason. Unblocking an archived contact therefore releases the block row and inserts a `deleted` row in the same transaction.
3. Only `lib/contacts/blocks.ts` (PR 2) writes `contact_blocks`, `contacts.blocked_at` / `block_reason` or `contacts.archived_at`. The exception is the one-off backfill script.

## Rollout

| Step | What | Status |
|---|---|---|
| PR 0 (#439) | Batch draft count applies the lifecycle layers | LIVE 2026-11-06 |
| PR 1 | Migration 0237, the concurrent index script, the backfill script, the normalizer guard | built; prod apply awaits "go now" |
| PR 2 | `lib/contacts/blocks.ts`, the 8 import paths, drip intake, the drain re-check, readers that assumed "not eligible = landline" | — |
| PR 3 | Selection paths, lookups, counts, the `is_archived` → `archived_at` reader migration | — |
| PR 4 | Routes, permissions, UI (`/contacts`, contact detail, `/blocked-numbers`) | — |
| Backfill | 89,484 `provider_list` phones from `opt_outs` (`suppressed` / `scrubbed`) | after PR 2; awaits "go now" |
| PR 5 | Migration 0238 drops `contacts.is_archived` | — |

### Prod apply (0237), attended

1. `npx tsx scripts/apply-contact-blocks-indexes-concurrent.ts --apply` (05:00–05:50 UTC, or `--off-window` with the owner's approval). It adds the two nullable columns, then builds the two partial indexes CONCURRENTLY.
2. `npm run db:migrate`, then `npx tsx scripts/verify-migration-integrity.ts`.
3. `npx tsx scripts/apply-contact-blocks-indexes-concurrent.ts --verify`.

What happens at the moment of apply:
- No existing row changes value: 0 contacts are archived and the new columns are empty.
- The CHECK validations scan `contacts` while it is locked, for about a second each.

One behaviour changes at once: archiving a contact through the existing archive route now excludes it from every eligible-gated audience. Archive is unused today (0 rows). It gets its ledger row and send cancellation in PR 2.

### Backfill, attended, after PR 2

1. `npx tsx scripts/backfill-contact-blocks-from-opt-outs.ts --hot` (HOT before).
2. A dry run.
3. `--apply` in the window.
4. `--hot` again a few minutes later. Stats flush asynchronously, so the "after" line printed at the end of the run can lag.

It has no send effect: every contact it touches already has an opt_outs row.

## Bars

| Script | Checks |
|---|---|
| [scripts/test-contact-blocks-schema.ts](../../scripts/test-contact-blocks-schema.ts) (preview DB) | trigger derivation across 12 transitions, constraints, the one-active-row ledger rule, counters, indexes |
| [scripts/test-contact-blocks-backfill.ts](../../scripts/test-contact-blocks-backfill.ts) (preview DB) | runs the real backfill with `--apply` on a fixture: duplicate collapse, earliest `created_at`, `opt_out`-only phones untouched, an existing block kept, idempotent re-run |
| [scripts/test-phone-normalizer-agreement.ts](../../scripts/test-phone-normalizer-agreement.ts) (in `check:guards`) | no STOP normalizer yields a different E.164 than `validatePhone`; `parse-csv` uses `validatePhone` |
