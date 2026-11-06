# Contact Blocks + Soft Delete

_Last updated: 2026-11-06 (PR 2: lib/contacts/blocks.ts, import checks on 8 paths, drip intake, drain re-check, reader fixes); 2026-11-06 (PR 1: schema 0237 + scripts)_

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
3. Only `lib/contacts/blocks.ts` writes `contact_blocks`, `contacts.blocked_at` / `block_reason` or `contacts.archived_at`. The exception is the one-off backfill script. Enforced by `scripts/test-contact-blocks-source-guards.ts`.

## The module — `lib/contacts/blocks.ts` (PR 2)

Every function takes the caller's transaction.

| Function | Does |
|---|---|
| `findActiveBlocks(tx, orgId, phones)` | The import check. Returns active ledger rows, plus existing contacts that are archived or blocked with no row (logged as an invariant violation). Chunked at 5,000. |
| `partitionBlocked(tx, orgId, items, phoneOf)` | Splits validated, deduped import items into allowed and blocked, and builds the summary fields. |
| `blockPhones` | The D2 "Block" rows. Sets `blocked_at`, cancels sends, closes journeys. |
| `unblockPhones` | Releases block rows and clears `blocked_at`. An archived contact gets a `deleted` row (A1). Never touches `opt_outs`. |
| `softDeleteContacts` / `restoreContacts` | The D2 "Delete" / "Restore" rows. Keep the legacy `is_archived` in step until 0238. |
| `cancelForContacts` | Pending `stage_sends` → `filtered` / `contact_blocked` or `contact_deleted`; deletes `campaign_audience_pool` rows. |
| `closeJourneysForContacts` | Live drip journeys → `exited` (`closeJourneyOnBlock` in `lib/drip/lifecycle.ts`). |
| `releaseBatch` | Releases a batch's active rows through `unblockPhones` and stamps the batch. |

Audit rows are written by the routes that call these, which arrive in PR 4. In PR 2 the only callers are the import paths, and the archive / restore / `PATCH is_archived` routes.

## Import paths (PR 2)

| # | Path | Behaviour |
|---|---|---|
| 1 | `app/api/contacts/upload/route.ts` | blocked skipped; attributes filtered |
| 2 | `lib/upload/audience-upload.ts`: opt-ins, clickers and segment contacts (`blockCheck: true`); opt-outs (`blockCheck: false`) | blocked skipped, except on the opt-out upload |
| 3 | `app/api/contact-groups/[id]/contacts/add/route.ts` | blocked skipped; attributes filtered |
| 4 | `app/api/campaigns/[campaignId]/upload-contacts/route.ts` | blocked skipped |
| 5 | `app/api/campaigns/[campaignId]/stages/[stageId]/import/route.ts` | existing blocked contact: result recorded, contact not upserted. No contact: row skipped and counted. |
| 6 | `app/api/contacts/statuses/import/route.ts` | existing blocked contact: status recorded. No contact: skipped and counted. |
| 7 | `lib/sends/import-optout-attribution.ts` | exempt (an opt-out writer) |
| 8 | `lib/drip/enrichment.ts` | blocked lead discarded before the lookup; `lead_intake_daily` / `hourly.blocked` +1 |

The result screens (`components/phone-upload-form.tsx`, the status-import form, the results-import form) show "Blocked (deleted X, blocked Y)" when the count is non-zero.

## Rollout

| Step | What | Status |
|---|---|---|
| PR 0 (#439) | Batch draft count applies the lifecycle layers | LIVE 2026-11-06 |
| PR 1 | Migration 0237, the concurrent index script, the backfill script, the normalizer guard | built; prod apply awaits "go now" |
| PR 2 | `lib/contacts/blocks.ts`, the 8 import paths, drip intake, the drain re-check, readers that assumed "not eligible = landline" (incl. lookup-stats), archive / restore through the module | built, stacked on PR 1 |
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

One behaviour changes at once: archiving a contact through the existing archive route now excludes it from every eligible-gated audience. Archive is unused today (0 rows). From PR 2 the archive route also writes the `deleted` ledger row and cancels sends.

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
| [scripts/test-contact-blocks-helpers.ts](../../scripts/test-contact-blocks-helpers.ts) (preview DB) | V2: all 9 D2 rows, both invariants after each, A1 belt and braces. V3. V6: cancel / pool / journey, and a 12,000-phone block in 3 chunks. V8: `processAudienceUpload` plus a source bar per import path. V9: drip intake. Lookup-stats and contact-stats with blocked contacts. |
| [scripts/test-send-optout-invariant.ts](../../scripts/test-send-optout-invariant.ts) (preview DB) | V7: blocked or deleted after materialization → `filtered` / `blocked_cancel`; opted out and blocked → `skipped_opted_out` |
| [scripts/test-contact-blocks-source-guards.ts](../../scripts/test-contact-blocks-source-guards.ts) (in `check:guards`) | G1: `'not_applicable'` comparisons are allowlisted. G2: single writer. |
