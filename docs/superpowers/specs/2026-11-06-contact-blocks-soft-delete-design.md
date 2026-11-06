# Contact blocks + soft delete — Phase 1 design

**Status:** APPROVED 2026-11-06 with amendments (D2 archived invariant, D8 reason list, §14 rulings — see §15). Build order: PR 0, then PR 1.
**Date:** 2026-11-06
**Inputs:**
- Recon: `.claude/recon-soft-delete-suppression.md`, read at origin/main b8a20b34.
- Owner decisions of 2026-11-06, recorded in §1.

**Phase 2 (Erase) is a separate card.** It ships after Phase 1. Its decisions are recorded in §12 so this design doesn't contradict them.

---

## 0. Problem

Deleting a contact today is a hard `DELETE`, and it has three problems:

1. **It is slow.** It cascades through about 30 tables, some of them unindexed at the second level.
2. **It destroys history.** Sends, exposures and lead events go with the contact.
3. **It is unsafe.** `opt_outs.contact_id` cascades, so a deleted STOP number becomes sendable again when it is re-imported.

The fix replaces hard delete with two mechanisms:
- **Soft delete**, using the existing `contacts.archived_at`.
- **A phone-keyed block ledger.** Every import checks it, and every forward-looking selection excludes blocked and deleted contacts.

## 1. Owner decisions (2026-11-06)

| # | Decision |
|---|---|
| O1 | The soft delete reuses archive. **`archived_at` is the single source of truth.** `is_archived` is retired: readers are migrated first, and the column is dropped in a later destructive migration. The UI label stays "Delete". There is no `deleted_at`. |
| O2 | Copy the 74,411 `opt_outs` rows with reason `suppressed` and the 15,075 with reason `scrubbed` into the ledger as `provider_list`, with source `'opt_outs backfill'`. The opt_outs rows stay where they are. |
| O3 | Ledger table `contact_blocks`. Contacts get `blocked_at` and `block_reason`. The UI says "Block / Unblock". Reasons (amended by D8): `provider_list \| manual \| deleted \| complaint \| carrier_block`. Delete writes `reason = deleted`. |
| O4 | `/opt-outs` delete and import revert are unchanged and never touch `contact_blocks`. |
| O5 | At block or delete time, cancel pending `stage_sends` (modelled on `lib/telnyx/sync-contacts.ts:41`, batched for bulk). The drain re-check also gains blocked and archived. |
| O6 | A blocked phone on import: skip the group membership, and count it as "blocked" in every import summary (all 8 paths). Drip intake discards it like a landline and counts it in intake stats. STOP handlers and opt-out uploads are never blocked. |
| O7 | Erase is Phase 2 (see §12). |
| O8 | Paid lookups skip contacts that are opted out, blocked or archived. |
| O9 | One normalizer: `validatePhone` only. Replace the other normalizers only if they can produce a *different* E.164; see §9 for the finding. |
| O10 | Fix the batch-draft-count mismatch first, in its own PR (PR 0). |
| O11 | Precedence is `opt_out > blocked > archived > active`. Unblock never releases an opt-out. |
| O12 | Forward-looking counts exclude blocked and archived contacts. Historical reports stay unchanged. Every twin is updated in lockstep, including `audience-preview-reference`, and the guard scripts are updated with them. |
| O13 | UI: the bulk bar gets Block / Unblock / Delete. The contact detail page gets the same actions plus a badge and the block history. A new "Blocked numbers" screen under Audience has batch history and release. |

## 2. Design choices that need approval

These came out of writing the spec. Each has a recommendation; nothing below is built until they are settled.

### D1 — Gate through `messaging_status` (recommended), not a new predicate on every path

`contacts.messaging_status` is already derived by trigger `contacts_derive_messaging_status` (`db/migrations/0096…sql:55`). Today the rule is landline → `not_applicable`, everything else → `eligible`.

These read paths already require `messaging_status = 'eligible'`:
- `gateEligible` (`lib/segment-rules-eval.ts:801`) and `buildGroupMembershipClause` (`lib/audience-snapshot.ts:104`). Between them they feed the snapshot, all three previews, both draft counts and the segment pages.
- The fresh-pool CTE in all three matviews: `offer_group_lifecycle_v2_mv` (0226:64), `offer_group_exposure_mv` (0227:54) and `offer_group_report_v2_mv` (0231:302).
- Group-lifecycle (`lib/reporting/group-lifecycle.ts`) and lookup stats (`lib/telnyx/lookup-stats.ts`).
- The frozen reference copy `lib/audience-preview-reference`.
- The three `*_eligible` partial indexes.

**Proposal:** extend the derivation.

```
messaging_status :=
  CASE WHEN NEW.blocked_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN 'blocked'
       WHEN NEW.line_type = 'landline'                               THEN 'not_applicable'
       ELSE 'eligible' END
```

This needs three supporting changes:
- The trigger column list grows to `UPDATE OF line_type, messaging_status, blocked_at, archived_at`.
- The CHECK grows to `('eligible','not_applicable','blocked')`.
- A **landline that is blocked shows `blocked`.** That is correct by precedence: blocked outranks not-applicable.

What it gives:
- Every `= 'eligible'` gate excludes blocked and deleted contacts with **no SQL change**. That includes the frozen reference copy, which is the kill switch, so the twins cannot drift on this rule.
- **No matview migration.** The three views pick up the change on their next twice-daily refresh. O12's "matviews 0226/0231 with migrations" becomes "refresh only". The alternative, three new view versions plus attended fills plus a reader switch plus drops, is roughly 3 extra migrations and 3 attended fills.
- The `*_eligible` partial indexes shrink automatically.

What it costs:
- About 5 readers equate "not eligible" with "landline" and must change: `lib/contact-stats.ts:244-245` (`!= 'not_applicable'` would count blocked contacts as eligible), `app/api/contacts/carrier-stats/route.ts:67-76`, the send guard in `lib/sends/recipients.ts:350-364`, `app/(protected)/contacts/page.tsx:170/371` and `app/(protected)/contacts/[id]/page.tsx:177`. All are listed in §6.
- **HOT:** a block, unblock, delete or restore changes an indexed column, so that one UPDATE is not HOT. These are rare, user-driven events. Today HOT is 22.6% over 4.99M updates.

**Alternative (the owner's O12 as written):** add `blocked_at IS NULL AND archived_at IS NULL` to every gate and every twin by hand, and ship three new matview versions.

**Recommendation: D1.** One derivation replaces about 15 copies of the predicate, and the matview work goes away.

### D2 — Ledger ⇄ contact invariant

- **Invariant:** `contacts.blocked_at IS NOT NULL` exactly when an *active* (`released_at IS NULL`) `contact_blocks` row exists for `(org_id, phone_number)` with `reason <> 'deleted'`. `block_reason` mirrors that row's reason.
- **What `deleted` does:**
  - It writes a ledger row, so a re-import is blocked by phone.
  - It sets `archived_at`, but does **not** set `blocked_at`. The contact shows as "Deleted", not "Blocked".
- **One active row per phone**, enforced by the partial unique index. The interactions:

| Action | Existing active row | Result |
|---|---|---|
| Block | none | insert the row; set `blocked_at` |
| Block | `deleted` | release `deleted` and insert the new reason, in one transaction, so history is kept. The contact stays archived. |
| Block | another block reason | no-op; counted `already_blocked` |
| Delete | none | insert `deleted`; set `archived_at` |
| Delete | a block reason | keep the block row; set `archived_at` only |
| Unblock | a block reason, contact NOT archived | release it; clear `blocked_at` / `block_reason`. **opt_outs untouched (O11).** |
| Unblock | a block reason, contact archived | release it AND insert a `deleted` row in the same transaction; clear `blocked_at` / `block_reason`; `archived_at` stays (amendment A1). |
| Restore (undelete) | `deleted` | release it; clear `archived_at` |
| Restore | a block reason | clear `archived_at` only; the contact stays blocked |

- **A ledger row with no contact is allowed.** For example, a block-list upload of numbers the org has never seen. The phone is blocked at import time, and no contact is created (see D3).
- **Archived invariant (amendment A1):** a contact with `archived_at` set ALWAYS has an active ledger row — `deleted` or a block reason. No transition may leave an archived contact without one.
- **Belt and braces in `findActiveBlocks`:** a phone whose existing contact has `archived_at` or `blocked_at` set is treated as blocked even when the ledger has no active row. That mismatch is logged as an invariant violation (`console.error` with the tag `[contact-blocks] invariant`, org and contact id, never the phone).
- **Write rule:** every write goes through one helper module, `lib/contacts/blocks.ts`. No route writes `contact_blocks`, `blocked_at` or `archived_at` directly. A guard enforces this.

### D3 — Importing a blocked phone that has no contact row

**Recommendation:** do not create the contact. Count it as `blocked`.
- The alternative is to create the contact with `blocked_at` set.
- That would grow `contacts` with rows that can never be messaged.
- It would also mean every block-list upload writes into contacts.

### D4 — Drip journeys of a contact that is blocked or deleted

Close the journey in the same transaction as the block, the way `closeJourneyOnOptOut` does (`lib/drip/lifecycle.ts:78`). This adds a new `closeJourneyOnBlock` with outcome `exited` and reason `contact_blocked` / `contact_deleted`.
- Without it, a blocked lead stays `active` and follow-ups keep being materialized, only to be cancelled by the drain.
- Confirm the outcome value: `exited` is the existing terminal state that is not an opt-out.

### D5 — The backfilled `provider_list` rows also set `contacts.blocked_at`

The D2 invariant requires it. In practice that is about 89K contacts, each also covered by its opt_outs row.
- **Send effect: none.** These contacts are already excluded by opt_outs.
- **Visible effect:** the badge shows "Opted out", because of precedence.
- **The one side effect:** unblocking one of these releases the ledger row, but the number stays suppressed by its opt_outs row. The Unblock dialog must say "still opted out (provider list) — unblocking does not release an opt-out".
- **How it runs:** a batched, attended backfill (§3).
- **Alternative:** ledger rows only, and relax the invariant. Not recommended, because the contacts page and the ledger would disagree.

### D6 — Status code for cancelled pending sends

Reuse `status = 'filtered'` with `last_error = 'contact_blocked' | 'contact_deleted'`, as the landline cancel does (`sync-contacts.ts:44`). The drain writes the same values.
- **Alternative:** a new terminal status `skipped_blocked`, parallel to `skipped_opted_out`. That would need a CHECK change and new buckets in reporting.
- **Recommendation:** reuse `filtered`.

### D7 — Permissions

| Permission | Roles | Covers |
|---|---|---|
| `contact_blocks.view` (new) | viewer and up | the Blocked numbers screen, block history |
| `contact_blocks.manage` (new) | manager and up | block, unblock, upload, release a batch. Mirrors `contacts.delete`. |
| `contacts.delete` (existing) | manager and up | soft delete and restore |
| `contacts.archive` (existing) | — | retired. The archive and restore routes become aliases of delete and restore, gated by `contacts.delete`. |

Operator gets none of these. In `lib/authz/route-map.ts` every new route is `null`, like the rest of the contacts block.

### D8 — Ledger reason `opt_out` — DROPPED (owner, 2026-11-06)

The reason list is `provider_list | manual | deleted | complaint | carrier_block`. Off-platform opt-outs are recorded as `manual` with a note, or through the opt-out upload.

## 3. Migrations

`0234` is reserved by `origin/feat/partner-postback-events`. `0235` is live. `0236` is taken by PR #440 (`0236_delivery_alert_toggle`, another workstream; it also uses journal idx 231 — whichever of #440/#441 merges second renumbers its journal entry). The cascade-tree indexes (0236-A) take the next free number when built. Phase 1 uses 0237 and 0238. 0237's journal `when` (1797206400000) is set after #440's (1797120000000) so 0237 still applies if #440 lands first. Every migration follows the existing patterns:
- hand-authored;
- snapshot cloned forward;
- journal `when` greater than origin/main's;
- `SET LOCAL lock_timeout = '5s'`;
- large indexes built `CONCURRENTLY` by a script first, then plain `IF NOT EXISTS` in the migration.

Each prod apply is attended: the owner types "go now" within 30 minutes (§14).

### 0237_contact_blocks (additive; applied before the code that uses it)

1. **`contact_block_batches`.** Modelled on `stage_results_imports`, `db/schema.ts:2717`.
   - Columns: `id serial PK`, `org_id uuid NOT NULL` (FK organizations, cascade), `filename text`, `reason text NOT NULL`, `source text`, `note text`, `submitted_rows int NOT NULL`, `valid_rows int NOT NULL`, `invalid_rows int NOT NULL`, `blocked_added int NOT NULL default 0`, `already_blocked int NOT NULL default 0`, `created_by uuid` (FK auth.users, set null), `created_at timestamptz NOT NULL default now()`, `released_at timestamptz`, `released_by uuid` (FK auth.users, set null), `released_count int`.
   - Index: `(org_id, created_at DESC)`.
2. **`contact_blocks`.**
   - Columns: `id bigserial PK`, `org_id uuid NOT NULL` (FK organizations, cascade), `phone_number text NOT NULL`, `reason text NOT NULL`, `source text`, `note text`, `batch_id int` (FK `contact_block_batches`, ON DELETE RESTRICT), `created_at timestamptz NOT NULL default now()`, `created_by uuid` (set null), `released_at timestamptz`, `released_by uuid` (set null).
   - CHECK on `reason` with the 5 values (D8).
   - Partial unique `(org_id, phone_number) WHERE released_at IS NULL`. This index serves the import check.
   - Index `(org_id, phone_number, created_at DESC)` for history.
   - Partial index `(batch_id) WHERE batch_id IS NOT NULL` for release.
   - **No FK to contacts, on purpose.** A row can exist with no contact (D2/D3), and it must survive Phase 2 erase. The cascade-tree guard therefore sees no new FK into `contacts`.
3. **`contacts`:** add `blocked_at timestamptz` and `block_reason text` (with the same CHECK). Both are nullable with no default, so this is metadata-only.
4. **Partial indexes on contacts**, built CONCURRENTLY by `scripts/apply-contact-blocks-indexes-concurrent.ts` (the 0235 pattern):
   - `contacts_org_blocked_idx (org_id, blocked_at DESC) WHERE blocked_at IS NOT NULL`.
   - `contacts_org_archived_idx (org_id, archived_at DESC) WHERE archived_at IS NOT NULL`. This replaces `contacts_org_id_is_archived_idx`, which is dropped in 0238.
5. **D1 changes:**
   - `contacts_messaging_status_check` → `('eligible','not_applicable','blocked')`, added as `NOT VALID` then `VALIDATE`.
   - `CREATE OR REPLACE FUNCTION contacts_derive_messaging_status()` with the CASE from §2.
   - Drop and re-create `contacts_messaging_status_trg` with the column list `line_type, messaging_status, blocked_at, archived_at`.
   - **No backfill is needed:** 0 contacts are archived and 0 are blocked today, so no existing row changes value.
6. `lead_intake_daily` and `lead_intake_hourly`: add `blocked int NOT NULL DEFAULT 0`. This is metadata-only on PG ≥ 11.
7. RLS on both new tables, org-scoped, following the `opt_outs` policies (`0013`). It is defense in depth (§3); application filtering stays the primary control.

### Backfill script (attended, after 0237 and before the UI ships)

`scripts/backfill-contact-blocks-from-opt-outs.ts`. It defaults to dry-run, runs with `--apply`, is idempotent and processes batches of 5,000.
1. Insert one ledger row per distinct `(org_id, phone_number)` among `opt_outs` rows with reason `suppressed` or `scrubbed`. Reason `provider_list`, source `'opt_outs backfill'`, `created_at` = the earliest matching opt_outs row. Uses `ON CONFLICT DO NOTHING` on the partial unique index.
2. Set `contacts.blocked_at` and `block_reason = 'provider_list'` for the matching contacts (D5). The trigger flips `messaging_status` to `'blocked'`. These contacts are already excluded by opt-out, so there is no send effect.
3. Prints counts before and after. The expected counts are a few thousand fewer than 89,486, because of duplicate rows per phone; the dry-run reports the exact figure.

HOT is measured before and after this backfill and recorded in the PR (rule in `docs/07-conventions.md`).

### 0238_drop_contacts_is_archived (destructive; only after every reader has moved and deployed)

- Drop `contacts.is_archived` and `contacts_org_id_is_archived_idx`.
- Code first, migration after (`feedback_migration_ordering`).
- Gate: a source guard shows zero `is_archived` references for contacts, and prod has been on the new code for at least one day.

## 4. Shared module — `lib/contacts/blocks.ts`

This is the only writer of `contact_blocks`, `contacts.blocked_at` / `block_reason` and `contacts.archived_at`. Every function takes `tx` and does its work inside the caller's transaction.

| Function | Does |
|---|---|
| `findActiveBlocks(tx, orgId, phones[]) → Map<phone, reason>` | Import check. One query against the partial unique index, unioned with existing contacts whose `archived_at` or `blocked_at` is set (A1 belt and braces; mismatches logged as invariant violations). Chunked at 5,000. |
| `blockPhones(tx, {orgId, phones[], reason, source, note, actorId, batchId?})` | Applies the D2 rules, sets `blocked_at` on matching contacts, then calls `cancelForContacts` and `closeJourneysForContacts`. Returns `{blocked_added, already_blocked, contacts_updated, sends_cancelled, pool_removed, journeys_closed}`. |
| `unblockPhones(tx, {orgId, phones[] \| blockIds[], actorId})` | Releases rows and clears `blocked_at` where no other active non-deleted row exists. Never touches `opt_outs`. |
| `softDeleteContacts(tx, {orgId, contactIds[], actorId})` | D2 rules for delete; sets `archived_at`, cancels sends, closes journeys. |
| `restoreContacts(tx, {orgId, contactIds[], actorId})` | Releases `deleted` rows and clears `archived_at`. |
| `cancelForContacts(tx, orgId, contactIds[], code)` | The `sync-contacts.ts:41` model, chunked at 5,000 ids. Sets `stage_sends` with `status='pending'` to `filtered` with `last_error = code` (D6). Never touches `sending`. Deletes the contacts from `campaign_audience_pool`. |
| `closeJourneysForContacts(tx, orgId, contactIds[], reason)` | Through a new `closeJourneyOnBlock` in `lib/drip/lifecycle.ts` (D4). |
| `releaseBatch(tx, {orgId, batchId, actorId})` | Releases every still-active row of the batch, through `unblockPhones`, and stamps `released_at`, `released_by` and `released_count` on the batch. |

- **Phone keys:** every key passes through `validatePhone(…, 'US', 'strict').normalized`. Invalid input is rejected before the DB, so the ledger only ever holds normalized E.164.
- **Audit:** each action writes one `audit_log` row with `entity_type 'contact'` or `'contact_block_batch'`. The metadata holds counts only, never phone lists.

## 5. Write paths (O6) — the 8 import paths and their summaries

**One rule for every path:** after in-input dedupe and validation, and before any upsert, call `findActiveBlocks`. A blocked phone gets:
- no contact insert or update;
- no group or segment membership;
- no attributes;
- a count in `summary.blocked`, split as `blocked_by_reason: { deleted, blocked }`, with `blocked_samples` holding up to 10 phones;
- no other effect.

**Required parameter (§11b).** `lib/upload/audience-upload.ts` gains a **required** `blockCheck: boolean`.
- opt-out upload → `false`, with a comment (O6: never blocked).
- opt-in, clicker and segment uploads → `true`.

| # | Path | Insert point | Check goes | Summary type |
|---|---|---|---|---|
| 1 | `app/api/contacts/upload/route.ts` | :177 / :200 | after dedupe :143 | `UploadResultSummary` :23 (+`blocked`, `blocked_by_reason`, `blocked_samples`) |
| 2 | `lib/upload/audience-upload.ts` (opt-ins `:76`, clickers `:122`, segment contacts `:70`; opt-outs `:136` exempt) | :123 | after :98 | `AudienceUploadSummary` :9 |
| 3 | `app/api/contact-groups/[id]/contacts/add/route.ts` | :120 | after :102 | inline :161 |
| 4 | `app/api/campaigns/[campaignId]/upload-contacts/route.ts` | :174 | after :149 | :235 |
| 5 | `app/api/campaigns/[campaignId]/stages/[stageId]/import/route.ts` | :216 | after :183 | `stage_results_imports` gets no new column; blocked count goes in the response only. Results for a blocked phone are still recorded against an *existing* contact (they are history), but no contact is created. ⚠️ Confirm. |
| 6 | `app/api/contacts/statuses/import/route.ts` | :152 | :146 | `ContactStatusImportSummary` :20. This path writes opt-out statuses. A blocked phone still gets its status row (a suppression is never blocked); only creating a *new* contact is skipped. |
| 7 | `lib/sends/import-optout-attribution.ts` | :209 | n/a | **Exempt.** It is an opt-out writer (O6). |
| 8 | `lib/drip/enrichment.ts` (contains a NUL byte; audit with `grep -a`) | :407 | before :406, beside the landline discard :392 | `res.blocked++` and `bumpIntakeCounters(… { received:1, blocked:1 })`. The lead is marked discarded the same way a landline is. |

- Paths 7 and 9 (the five STOP ingesters) and paths 10 (the two scripts) are untouched.
- In the UI, every place that renders an upload summary gets a "Blocked: N (deleted X, blocked Y)" line. These are `components/phone-upload-form.tsx` (`UploadResultSummary` :58), the group-add dialog, the status-import form, the campaign upload, and the stage-import result.

## 6. Selection paths (O12) — one row per path

"Covered (D1)" means the path already requires `messaging_status = 'eligible'`. It needs no SQL change, only a verification row in §10.

### A. Campaign audience

| Path | File | Change |
|---|---|---|
| Segment source gate | `lib/segment-rules-eval.ts:801` `gateEligible` | Covered (D1) |
| Group source | `lib/audience-snapshot.ts:104` | Covered (D1) |
| Snapshot | `snapshotAudience` :2513 | Covered (via source) |
| Preview ×3 | `previewAudience` :1870, `previewAudienceBase` :2122, `previewAudienceNarrowed` :2315 | Covered |
| Draft counts | :936 / :1217 | Covered (after PR 0) |
| Frozen reference | `lib/audience-preview-reference/index.ts` | Covered (it has its own `buildGroupMembershipClause` with the eligible gate). Verify. |

### B. Frozen pools

These are already gated at snapshot time; the risk is rows frozen *before* a block. `cancelForContacts` removes the contacts from the pool at block time (O5), and the drain re-checks at send time.

| Path | File | Change |
|---|---|---|
| Recipients base | `lib/sends/recipients.ts:262` | No change. Pool rows are removed at block time. |
| Send guard | `recipients.ts:350-364` | `=== 'not_applicable'` → `!== 'eligible'`. The alert text says "non-eligible (landline/blocked/deleted)". |
| Reconcile | `lib/sends/reconcile.ts:97,160` | No change (it reads the same pool). Verify there is no gap. |
| Active-pool counts | `computeStageAudienceCount` :843, `…Batch` :1166, `computeLaneAudienceCountsBatch` :1411 | No change (pool) |
| All-phones export | `app/api/campaigns/[campaignId]/export-all-phones/route.ts:126` | Add a join to contacts with `messaging_status='eligible'`. The CSV goes straight to a provider, so it gets its own check, like opt-outs do. |
| Stage export | `stages/[stageId]/export-phones/route.ts:177` | Via `stageRecipientsSql` (pool). Same addition as all-phones, for the same reason. |
| Split preview | `lib/stages/split-group.ts:392` | No change (pool) |

### C. Drain — the last line of defence for regular and drip sends

`lib/sends/drain.ts:670-707`. Widen the claim-time re-check from opt_outs only to:

```
… FROM opt_outs …  UNION  SELECT id FROM contacts
  WHERE org_id = $org AND id IN (claimed) AND messaging_status <> 'eligible'
```

- Opt-out hits stay `skipped_opted_out`.
- Hits on the new branch become `filtered` with `last_error = 'blocked_cancel'` (D6).
- This catches a block that lands between materialization and claim.
- One more PK lookup per batch.
- Landlines that leak are now also cancelled here, which only makes the guard stronger.

### D. Drip

| Path | File | Change |
|---|---|---|
| Routing / carry-over / overflow / why-not-routed | `lib/drip/routing-eval.ts:334-517` | Add `c.messaging_status <> 'eligible' AS is_blocked` beside `is_opted_out` (:361) as a permanent block, in the same place as the opt-out branch (:489). This also closes the existing gap: no `messaging_status` check. |
| Intake | `lib/drip/enrichment.ts:392-410` | §5 row 8 |
| First send / follow-ups | `scheduler.ts:540`, `followups.ts:208` | No change. The journey is closed at block time (D4) and the drain catches the rest. |
| In-use | `lib/drip/in-use.ts` | No change. A blocked contact's pool rows are deleted, so it no longer reserves the contact. |

### E. Segments

| Path | Change |
|---|---|
| Audience tab, export, rules preview, `refresh-stats` (rule-based) | Covered (D1) |
| Manual-membership stats: `refresh-stats/route.ts:72-103` and `segment-stats/refresh-all/route.ts:28-51` | Count only `messaging_status = 'eligible'` members, forward-looking. ⚠️ `segment_stats.total_count` (a trigger on `segment_contacts`) stays raw membership; the page labels it "members". |
| Segment contacts list and CSV (`segments/[id]/contacts`, `contacts/export/route.ts:94`) | Show the Blocked and Deleted status columns; do not hide the rows. It is an admin listing. |

### F. Counts and pools (forward-looking per recon §8)

| Surface | File | Change |
|---|---|---|
| `/api/audience/pools` | `lib/audience/pools.ts:131` | `is_archived = false` → `messaging_status = 'eligible'` |
| Fresh counts | `lib/audience/fresh-counts.ts:128` | same |
| Group lifecycle sendable / available-today | `lib/reporting/group-lifecycle.ts:130,236` | Covered (already `archived_at IS NULL` plus eligible) |
| Matviews 0226 / 0227 / 0231 fresh pools | — | Covered (D1); the next refresh applies it. Verify with a before/after diff. |
| Contact group size | `app/api/contact-groups/list/route.ts:97` | Add a `sendable_count` (eligible, not opted out) next to the raw `member_count`. The list shows both. ⚠️ Confirm the column naming. |
| Lookup "sendable" | `lib/telnyx/lookup-stats.ts:102,153` | Covered (D1) |
| Contacts org stats | `lib/contact-stats.ts:223-255` | `is_archived` → `archived_at`. `eligible` = `messaging_status = 'eligible'` (it was `!= 'not_applicable'`). Add `blocked_count` and `deleted_count`. |
| Base stats tiles | `app/api/contacts/base-stats/route.ts:74,80` | `is_archived` → `archived_at IS NULL / NOT NULL`. Add a Blocked tile. |
| Carrier stats | `app/api/contacts/carrier-stats/route.ts:67-76` | Add a `blocked` bucket |
| Partner report "carrier rejected" | `lib/reporting/partner-report.ts:294` | Historical; no change |

### G. Paid lookups (O8)

| Path | File | Change |
|---|---|---|
| Enqueue for a group | `lib/telnyx/enqueue.ts:136-185` | Exclude `messaging_status = 'blocked'` and contacts with opt-outs |
| Preview | `lib/telnyx/preview.ts:97-110` | Same; reports `skipped_blocked` and `skipped_opted_out` |
| Match list | `lib/telnyx/match-list.ts:46` | Same |

Landlines (`not_applicable`) are left as they are today: re-looking them up is an existing behaviour and out of scope.

### H. Contacts admin surfaces

| Path | Change |
|---|---|
| `app/api/contacts/list/route.ts:118-153,218` | `is_archived` → `archived_at`. New views `blocked` and `deleted`; the `archived` view is renamed `deleted`. Return `blocked_at`, `block_reason`, `archived_at`. |
| `app/api/contacts/export/route.ts:86-120` | Same. The export of the `active` view excludes blocked and deleted contacts (it goes to providers). |
| `app/api/contacts/[id]/route.ts` | GET returns block fields and block history. PATCH `is_archived` is removed (validator `lib/validators/contacts.ts:15`); use the dedicated routes. **DELETE becomes a soft delete** through `softDeleteContacts`. No hard delete remains in any route. |
| `contacts/[id]/archive` and `restore` routes | Become aliases of soft delete and restore (D7) |
| `contact-groups/[id]/contacts/route.ts:103`, `segments/[id]/contacts/route.ts:93` | `is_archived` → `archived_at` / `blocked_at` in the selected columns |

### I. Historical — explicitly unchanged

These read sends and events. Blocked and deleted contacts keep their rows, so nothing moves:
- the dashboard stat strip;
- Overview and the per-dimension tabs;
- Delivery, LP results, Opt-outs/Tails;
- the Lifecycle report;
- Drip Daily;
- partner lead counts;
- matview economics.

The hybrid group attribution keeps its group rows, so it is stable as well.

## 7. API routes (all `null` in `OPERATOR_ROUTE_MAP`)

| Route | Method | Permission |
|---|---|---|
| `contacts/bulk-block` `{contact_ids[≤10,000], reason, note}` | POST | `contact_blocks.manage` |
| `contacts/bulk-unblock` `{contact_ids[]}` | POST | `contact_blocks.manage` |
| `contacts/bulk-delete` `{contact_ids[]}` | POST | `contacts.delete` |
| `contacts/bulk-restore` `{contact_ids[]}` | POST | `contacts.delete` |
| `contacts/[id]/block`, `contacts/[id]/unblock` | POST | `contact_blocks.manage` |
| `contacts/[id]` | DELETE (soft) | `contacts.delete` |
| `contact-blocks/list` (filters: reason, active/released, search, batch) | GET | `contact_blocks.view` |
| `contact-blocks/upload` (phone-only CSV; reason, source, note) | POST | `contact_blocks.manage` |
| `contact-blocks/batches` | GET | `contact_blocks.view` |
| `contact-blocks/batches/[batchId]/release` | POST | `contact_blocks.manage` |
| `contact-blocks/[blockId]/release` | POST | `contact_blocks.manage` |

Each route needs the following:
- `getOrgId` (org filter);
- Zod input validation;
- the `{ error, code }` error shape;
- `maxDuration = 60` on the bulk routes and the upload.

Above 10,000 ids, or for uploads with more than 50,000 rows, the work runs in 5,000-row transactions, and the batch counters are updated per chunk. Registration covers:
- `lib/authz/route-map.ts`;
- the `Permission` union and role sets in `lib/permissions.ts`;
- `PHASE2_ADDITIONS` in `scripts/test-operator-permission-matrix.ts`;
- `npm run check:authz`, which must be green.

## 8. UI

**`/contacts`** (`app/(protected)/contacts/page.tsx`):
- The bulk bar (:1103) gains Block, Unblock, Delete and Restore, each gated by permission. Block opens a `FormDialog` asking for reason and note; Delete opens an `AlertDialog`.
- The row menu replaces Archive/Restore with Delete/Restore and adds Block/Unblock.
- View tiles: active, **blocked**, **deleted** (was archived), opt_outs, opt_ins, clickers.
- The status column shows the precedence badge: `Opted out > Blocked (reason) > Deleted`.
- An "Excluded" tile counts blocked contacts.

**`/contacts/[id]`:**
- An actions row with Block/Unblock and Delete/Restore.
- The precedence badge.
- A **Block history** card: ledger rows for this phone, including released ones and rows that predate the contact.
- For a contact with an opt-out, the Unblock dialog warns: "still opted out — unblock does not release an opt-out" (O11/D5).

**`/blocked-numbers`** (new):
- Nav: under Audience next to Opt-Outs (`components/protected/nav-config.ts:154-200`). A `layout.tsx` calls `requirePagePermission("contact_blocks.view")`. Entity flag `blocked_numbers` in `lib/feature-flags.ts`, **flipped last** (§7 of `CLAUDE.md`).
- Copied from `app/(protected)/opt-outs/page.tsx`:
  - a list of the active ledger, with filters for reason, active/released and search;
  - multi-select with "Release selected";
  - an upload dialog: `FormDialog` + `PhoneUploadForm` with `endpoint="/api/contact-blocks/upload"`, `additionalFields={{reason, source, note}}`, a phone-only CSV and no group picker.
- A **Batch history** dialog modelled on `components/campaigns/import-history-dialog.tsx`. It lists batches with counts, and Release does a soft revert, stamping `released_at`.

## 9. Normalizer finding (O9)

| Normalizer | Same input → same E.164 as `validatePhone`? | Difference |
|---|---|---|
| `lib/imports/parse-csv.ts:49-55` | **Yes.** It is the same code: `parsePhoneNumberFromString(raw,'US')`, then `isValid()`, then `.number`. | None. Replace it with a call to `validatePhone` for hygiene; no behaviour change. |
| `ahoiSourceToE164` `providers/ahoi.ts:33`, `tellsPhoneToE164` `tells.ts:78`, `textrequestPhoneToE164` `textrequest.ts:52` | **Never a different E.164.** For a valid NANP number all four give `+1XXXXXXXXXX`. | They are *looser*: they accept unassigned NANP numbers (555, area code starting with 0 or 1), where strict `validatePhone` returns nothing, and they reject non-NANP numbers. They only run on STOP paths (O6: never blocked), and the contact they create uses the same key. |

**Recommendation:** do not replace the STOP normalizers in Phase 1.
- The ahoi comment says libphonenumber "throws under tsx", which is a test-harness risk.
- Making STOP intake stricter would drop real STOPs from unassigned-looking numbers. That is a compliance regression with no effect on blocks.
- Only `parse-csv` gets swapped.

**Guard:** `scripts/test-phone-normalizer-agreement.ts` runs about 40 fixture spellings through all four normalizers and asserts that whenever `validatePhone` is non-null, the others are null or equal.

## 10. Verification plan

**Environment:** the preview DB (`_require-preview-db` for every script that writes). Prod checks are read-only only (`withReadOnlyDb`).

**Fixture org:** one contact in each state.
- A: active
- B: blocked, manual
- C: deleted
- D: opted out and blocked
- E: landline
- F: landline and blocked
- G: blocked with pending sends and a drip journey
- H: a ledger row only, with no contact

| # | Check | Bar |
|---|---|---|
| V1 | Trigger derivation | For each fixture after each transition (block, unblock, delete, restore, landline): `messaging_status` matches the table in §2/D1. That is 12 transitions. |
| V2 | D2 interaction table | All 9 rows of the table (incl. A1 unblock-on-archived), the archived invariant holds after every transition, partial-unique violations rejected, and `findActiveBlocks` flags a contact with `archived_at` but no ledger row |
| V3 | Unblock never releases an opt-out | D unblocked → still excluded by every path in §6 |
| V4 | Every selection path in §6 A–G | A counted; B, C, D, F, G excluded; E excluded only where landlines are excluded today. One script, `scripts/test-contact-block-exclusion.ts`, calls each function directly **and** a source bar per call site (§11b pairing) |
| V5 | Twins | `test-preview-matches-snapshot`, `verify-preview-parity` (live vs reference, which must be equal on the fixture), `test-draft-stage-counts-batch`, `verify-lane-batch`, `test-eligibility-layers-identical` (rebaselined only if its SQL text changes; under D1 it should not) |
| V6 | Cancel at block time | G: pending → `filtered` / `contact_blocked`; `sending` is untouched; pool rows are gone; the journey is `exited`. Bulk with 12,000 ids runs in 3 chunks, and the counts add up. |
| V7 | Drain re-check | Block after materialization: the claimed row becomes `filtered` / `blocked_cancel` and is never dispatched. `test-send-optout-invariant` is extended. |
| V8 | Import summaries, all 8 paths | Upload the phones of B, C and H. `blocked = 3` (`deleted 1`, `blocked 2`); no group rows; no contact for H. The opt-out upload and the STOP ingester still write for B. |
| V9 | Drip intake | A lead for B is discarded; `lead_intake_daily.blocked +1`; no `lead_events` routing |
| V10 | Batch release | Upload 100 numbers, then release: 100 rows released, `contacts.blocked_at` cleared for those with no other active row, and `released_count = 100` |
| V11 | Paid lookups | Enqueue and preview skip B, C and D; the preview reports the skip counts |
| V12 | Backfill (prod, attended) | Dry-run count = distinct `(org, phone)` over the 89,486 rows. After apply: ledger rows = that count; contacts with `blocked_at` = matched contacts; **the campaign audience preview for 3 live campaigns is unchanged** (already opted out); HOT recorded before and after |
| V13 | Matviews (prod, after refresh) | `fresh_pool` per (offer, group) before minus after equals the blocked or deleted eligible members of that group. At go-live that should be 0, since the backfilled contacts were already excluded. |
| V14 | Perf | EXPLAIN on the prod clone of `gateEligible` and the snapshot source: the plan is unchanged and the `*_eligible` partial indexes are still used. The import check is one index probe per 5,000 phones. Contacts HOT % is recorded before 0237 and 7 days after. |
| V15 | No hard delete | A source guard: no `delete(contacts)` and no `DELETE FROM contacts` under `app/` or `lib/` |
| V16 | Single writer | A source guard: `contact_blocks`, `blocked_at` and `archived_at` (contacts) are written only in `lib/contacts/blocks.ts` |
| V17 | `is_archived` retirement | A source guard: zero contact `is_archived` reads before 0238 is allowed |
| V18 | authz | `check:authz` green; every new route is in the map |
| V19 | Normalizers | `test-phone-normalizer-agreement` |

All new guards are added to `check:guards`.

## 11. PR sequence

| PR | Content | Migration | Gate |
|---|---|---|---|
| **0** | Batch draft count matches the single-stage count: `computeStageAudienceCountsBatchForDraft` (`lib/audience-snapshot.ts:1217`) gains a **required** `offerId` and `lifecycleRules` (§11b) and applies `lifecycleExclusionLayers` like :974-982. Update the caller `app/api/campaigns/[campaignId]/stages/route.ts:311`, `scripts/test-draft-stage-counts-batch.ts` (add a lifecycle fixture with a cap) and `test-carrier-rejection-eligibility.ts:191`. | none | batch == single on a lifecycle fixture |
| 1 | 0237 + the concurrent-index script + the backfill script (dry-run only) + the normalizer guard + the `parse-csv` swap | 0237 | go now (apply), V1, V2 |
| 2 | `lib/contacts/blocks.ts` + `closeJourneyOnBlock` + the 8 import paths + summaries + drip intake + the drain re-check + the D1 reader fixes (`contact-stats`, `carrier-stats`, send guard) | — | V3, V6–V9 |
| 3 | Selection §6 B–H + lookups + counts + `is_archived` → `archived_at` reader migration | — | V4, V5, V11, V14, V17 |
| 4 | Routes + permissions + UI (contacts, detail, `/blocked-numbers`) + flag flipped last | — | V10, V15, V16, V18; operator verify on the preview |
| — | Backfill `--apply` on prod | — | go now, V12, then V13 after the next matview refresh |
| 5 | 0238 drop `is_archived` | 0238 | go now, ≥ 1 day after PR 3 or 4 is live |

**Docs, updated per PR:**
- `docs/03-data-model.md` + ERD (0237, 0238).
- New `docs/04-features/contact-blocks.md`.
- `docs/05-flows.md`: sequence diagrams for block, delete, import and drain.
- `docs/07-conventions.md`: precedence, single writer, the D1 derivation, "no hard delete".
- `CHANGELOG`.
- `CLAUDE.md` §10e note: segment counts exclude blocked.

## 12. Phase 2 — Erase (separate card; recorded so Phase 1 doesn't contradict it)

These are owner decisions. Phase 1 leaves room for them:
- `contact_blocks` has no FK to contacts.
- The ledger survives an erase.
- `phone_number` can be NULL'd in favour of a hash column later.

The decisions:
- An HMAC-SHA256 tombstone with a server-side env key, following the `PROVIDER_CREDENTIALS_KEY` pattern. Pseudonymized; accepted.
- `phone_lookups` and `lookup_queue` are global across the 3 prod orgs: delete only when no other org holds the number.
- Freeze `campaign_stages.total_cost` before the erase.
- Delete `partner_postbacks` before `conversion_events` (it is RESTRICT).
- Write the tombstone in the same transaction, before the cascade.
- A batched background job, morning window only, owner-only action on the contact page.

Erase is blocked on 0236-A/B for speed, or must clear the DLR rows set-based itself.

## 13. Risks

1. **D1 changes what "not eligible" means.** Every reader that equates it with "landline" must change. Mitigation: the reader list in §2/§6, the V1 and V4 bars, and a grep guard on `'not_applicable'` comparisons outside an allowlist.
2. **Upsert revival.** If any path is missed, a re-import silently re-attaches a deleted or blocked contact to groups. Mitigation: a single check helper, plus a guard that enumerates every contacts insert site with `grep -a`. It fails on any site not in the allowlist {checked, STOP/opt-out exempt}.
3. **Bulk block of a large set inside a request.** 10,000 contacts × cancel + pool delete + journeys. Mitigation: 5,000-row chunks, `maxDuration = 60`, and sizes beyond that go through upload batching. V6 measures on the preview with 12,000.
4. **The backfill touches about 89K contacts (non-HOT updates).** It is attended, batched, done in the morning window, with HOT measured before and after.
5. **The provider_list ledger rows duplicate opt_outs.** The two sources can diverge: an `/opt-outs` delete (O4) lifts the opt-out but leaves the block. That is deliberate (O4) and documented in the feature doc.
6. **The matview refresh after go-live** must still fit the refresh budget. The filter it adds is the existing predicate, so there is no new work, but verify the timing on the first refresh.

## 14. Open items for the owner (beyond D1–D8)

- §5 row 5: confirm that stage-results rows for an existing blocked contact are still recorded (they are history), and that only creating a contact is skipped.
- §6 E/F: naming of the raw vs sendable counts on segments and contact groups ("members" vs "sendable").
- Should the `/contacts` default `active` view hide blocked contacts (recommended), or show them with a badge?

## 15. Approval record (owner, 2026-11-06)

- D1 approved; the grep guard on `'not_applicable'` comparisons (with an allowlist) ships.
- D2 approved with amendment A1 (archived invariant + `findActiveBlocks` belt and braces), reflected in §2 and V2.
- D3, D4 (`exited`; reasons `contact_blocked` / `contact_deleted`), D5, D7 approved as written.
- D6 approved: `filtered` with `last_error` `contact_blocked` / `contact_deleted` / `blocked_cancel`.
- D8: `opt_out` dropped from the reason list.
- O9: only `parse-csv` is swapped; STOP normalizers untouched; the agreement guard ships.
- §14: stage-results rows for an existing blocked contact are still recorded (only contact creation is skipped); segment and contact-group counts are labelled **Members** (raw) and **Sendable** (eligible, not opted out); the default `/contacts` active view hides blocked and deleted contacts, which live in their own tiles.
- Prod applies: the owner gives "go now" separately for the 0237 apply and for the backfill. HOT is reported before and after the backfill.
