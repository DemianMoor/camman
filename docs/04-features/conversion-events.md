# Conversion events (multi-event conversions)

_Last updated: 2026-09-17_

**Status:** Phase 1 — ledger + backfill. **Nothing reads the ledger yet.** Revenue, EPC, the purchased tier, segment purchase rules, drip and reports still read `stage_sends.sale_*` and `keitaro_stage_results` until Phase 3.

## Why

A click can now produce several conversions: Psycho Book (Affise) fires a $0 **registration** and a paid **purchase**, each with its own transaction id. Before this, CamMan held one sale per recipient (`stage_sends.sale_status`, latest wins), and every `lead` counted as a purchase. A registration arriving as `lead` would have been a buyer everywhere. Recon: [specs/2026-09-17-multi-event-conversions-recon.md](../superpowers/specs/2026-09-17-multi-event-conversions-recon.md).

## Model (migration 0181)

| Table | One row per | Key facts |
|---|---|---|
| `event_types` | org × event | `key`, `label`, `display_order`, flags `is_purchase`, `counts_revenue`, `is_retarget_signal`. Seeded: `purchase` (is_purchase, counts_revenue), `registration` (is_retarget_signal) |
| `conversion_event_mappings` | org × (network **or** offer) × Keitaro type | `keitaro_type` → `event_type_id` + `conversion_status` (`pending`/`approved`/`rejected`). An offer rule beats a network rule. `event_type_id` NULL = status transition only |
| `conversion_events` | Keitaro conversion | unique `keitaro_event_id`; `tid`; attribution `stage_send_id`/`contact_id`/`campaign_id`/`stage_id`/`offer_id` (all SET NULL); `event_type_id` (locked once set) + `status` (NULL = unmapped); `conflicting_event_type_id` + `event_type_conflict_at`; `revenue`, `currency`; `occurred_at` (original time, never moves), `last_postback_at`; `keitaro_status`, `keitaro_type`, `keitaro_version`, `status_history`, `raw_params` |
| `offers.keitaro_offer_id` | — | Keitaro's offer id (Psycho Book = 41), for conversions with no resolvable click |

Flags, not keys, carry meaning. A future `deposit` is a new `event_types` row with the right flags plus mapping rows. No code change.

## How a Keitaro conversion becomes a row

`lib/conversions/ingest.ts` → `ingestKeitaroConversions(db, { range })`:

1. `fetchKeitaroConversionLedger` pulls **all** conversion types. It fails (`ok:false`, nothing handed back) on a malformed response — a 200 that isn't JSON with a `rows` array **and** a numeric `total`, e.g. an HTML bot challenge — and on a truncated page (`rows < total`).
2. `parseKeitaroLedgerRow` (pure) normalises the row. The mapping key is the lowercased **conversion type** name, not the raw status. `occurred_at` is the earliest `status_history` stamp.
3. `buildConversionEventRows` (pure) attributes it:
   - `sub_id_1` = `stage_sends.id` → recipient
   - else `sub_id_3` = stage tracking id → stage
   - else `offers.keitaro_offer_id` → offer
   - else **unresolved**: reported, not stored
4. `resolveMapping` classifies it. No rule means NULL event type + status: stored, never a purchase.
5. `upsertConversionEvents` upserts on `keitaro_event_id`:
   - `occurred_at` never updates
   - event type is locked and attribution is sticky (`COALESCE`)
   - status/revenue and the raw Keitaro status/type take the newest values
   - no-op writes are skipped
   - `org_id` is fixed at insert. A row whose stored org differs from the org this run resolved is **not written** (its sticky fills would mix orgs): it is skipped and counted in `orgMismatch`, with up to 5 samples `event_id existing_org→new_org`. `setWhere` also requires the same org, so a row a concurrent run inserted under another org is left untouched
   - rows are sorted by `keitaro_event_id` before chunking, so concurrent runs lock rows in the same order

## Event-type conflicts

A conversion's event type is **locked** once set, so a declined registration stays a registration. If Keitaro later reports a type whose mapping names a *different* event type — e.g. Registration → Sale because the advertiser reused a `tid` — the row keeps its locked type and stores the new raw type. It also records `conflicting_event_type_id` (the event the new type maps to) and `event_type_conflict_at` (first seen). The conflict is never silent:
- the ingest result counts it (`typeConflicts`, rows written this run)
- `backfill-conversion-events.ts --apply` exits 1: its post-apply table check counts every conflicted row. That check runs only with `--apply`; a dry run reports per-run counts only
- `verify-conversion-events.ts` fails V5
- Phase 2 alerts on it

A status-only mapping (NULL event type, e.g. Affise `rejected`) neither raises nor clears a conflict; a mapping that agrees again clears it. To resolve one: decide which event is right. If the lock is wrong, correct the row by SQL (`UPDATE conversion_events SET event_type_id = <right>, conflicting_event_type_id = NULL, event_type_conflict_at = NULL WHERE keitaro_event_id = '…'`) after approval.

## Seeded mappings (network level)

| Network (code) | Keitaro type | Event | Status | Why |
|---|---|---|---|---|
| Property Leads (`pl`) | lead | purchase | approved | Keitaro network #4 has a bare postback template (no status mapping), so the seed mirrors today's treatment: lead-gen CPA, the lead is payable |
| Property Leads (`pl`) | sale | purchase | approved | |
| Property Leads (`pl`) | rejected | purchase | rejected | |
| Sweeply (`swp`) | lead | purchase | approved | template hardcodes `status=lead` for paid conversions |
| Sweeply (`swp`) | rejected | purchase | rejected | |
| Secco (`scc`) | sale | purchase | approved | Everflow template `status={status}` |
| Secco (`scc`) | rejected | purchase | rejected | |
| PsychoBook (`psb`) | lead | **registration** | approved | the advertiser can only send `lead`/`sale`, on two separate postback URLs: `lead` = registration ($0) |
| PsychoBook (`psb`) | sale | purchase | approved | sent only after the customer pays; no hold |
| PsychoBook (`psb`) | rejected | — (keeps existing) | rejected | declines either event |
| PsychoBook (`psb`) | registration | registration | approved | Keitaro built-in type; unused today |

> `lead` does **not** mean the same thing across networks: paid on Sweeply, registration on PsychoBook. That is why mappings are per network. PsychoBook conversions arrive under Keitaro network #5 ("Affise.com PsychoBook", offer #41), but the mapping keys on the CamMan network reached through the offer, never on Keitaro's network id.

## How to add an event type or a mapping

```sql
-- New event type (per org)
INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
VALUES ('<org uuid>', 'deposit', 'Deposit', 30, false, true, false);

-- Network-level rule
INSERT INTO conversion_event_mappings (org_id, affiliate_network_id, keitaro_type, event_type_id, conversion_status)
SELECT n.org_id, n.id, 'deposit', et.id, 'approved'
FROM affiliate_networks n JOIN event_types et ON et.org_id = n.org_id AND et.key = 'deposit'
WHERE n.network_id = 'psb';

-- Offer-level override (beats the network rule for this offer only)
INSERT INTO conversion_event_mappings (org_id, offer_id, keitaro_type, event_type_id, conversion_status)
SELECT o.org_id, o.id, 'lead', et.id, 'approved'
FROM offers o JOIN event_types et ON et.org_id = o.org_id AND et.key = 'purchase'
WHERE o.id = <offer id>;

-- Link a CamMan offer to its Keitaro offer id
UPDATE offers SET keitaro_offer_id = 41 WHERE id = 134;
```

To retire a rule, set `status = 'archived', archived_at = now()`; the unique indexes only cover active rules. Rows stored before a rule existed are healed on the next ingest of their window (sticky `COALESCE` fills NULLs). Re-run the backfill to heal older windows.

## Backfill and verification

```bash
npx tsx scripts/backfill-conversion-events.ts            # dry run
npx tsx scripts/backfill-conversion-events.ts --apply    # write (prod needs approval)
npx tsx scripts/verify-conversion-events.ts              # read-only
```

`verify-conversion-events.ts` asserts the ledger against a fresh Keitaro pull: every conversion present, per-type count and revenue to 4dp, no unmapped rows, no event-type conflicts, every currency USD, `occurred_at` = original time. It then prints the deltas against the old sources. The following three deltas were recorded at recon and are accepted as corrections:

- **+$715** per recipient: 14 recipients' second conversions that latest-wins dropped
- **26 conversions / $1,463** known at stage level but with no recipient (blank `sub_id_1`)
- **−$100** stage-day: one conversion `keitaro_stage_results` counted on two days after a re-post

`verify-conversion-events.ts` dedupes the live pull by `event_id` (last wins) before its checks — a conversion re-posted while the pull walks the windows can appear twice — and prints how many duplicates it collapsed.

**Fail-loud rules.**
- **Truncated or malformed fetch:** a page with fewer rows than its own `total`, or a 200 whose body isn't JSON with a `rows` array and a numeric `total`, is refused. The window writes nothing and the backfill exits 1; re-run (with a smaller `BACKFILL_WINDOW_DAYS` if truncated).
- **Unparseable rows** (missing event_id / conversion_type / revenue, malformed datetime): counted and sampled in the ingest result. The backfill prints them and exits 1.
- **Unresolved** (no stage, no `offers.keitaro_offer_id`): printed with `sub_id_1`/`sub_id_3`/Keitaro offer; the backfill exits 1.
- **Unmapped and event-type conflicts:** a non-zero per-run `unmappedInBatch` (status NULL in this run's rows) fails the run; `typeConflicts` (rows written this run) is printed. After `--apply` the backfill also checks the **table** (any row with NULL `event_type_id` or `status`, any `conflicting_event_type_id`) and exits 1 on either. That table check runs **only with `--apply`**; a dry run reports per-run counts only.
- **Status-only rows** (`statusOnlyInBatch`: resolved through a status-only mapping such as PsychoBook `rejected`, so no event type): not unmapped if the row already exists with a type; a brand-new one is unmapped. A dry run prints a **WARNING** (not a failure), because only `--apply`'s table check can tell.
- **Org mismatch** (`orgMismatch`, `--apply` only — a dry run doesn't upsert): an existing row resolved in a different org this run is not written. The backfill prints the samples and exits 1.
- **Currency:** `revenue` is USD. Every conversion to date carries `params.currency` USD or none, and `revenue` equals the postback payout. `currency` stores the postback's claim; a non-USD one fails verify V6.

Checks: `scripts/test-conversion-ledger-rows.ts` (pure, 38), `scripts/test-conversion-events-upsert.ts` (camman-v2 only, rolled back, 17), `scripts/test-conversion-lookups.ts` (camman-v2 only, rolled back, 7: `loadLookups` recipient chain, archived and other-org rules excluded, Keitaro offer id / tracking id in two orgs dropped).

Migration 0181 starts with `SET LOCAL lock_timeout = '5s'` and takes the `offers` lock before any foreign-key lock: Drizzle applies every pending migration in one transaction, so a blocked lock fails the migration (retry) instead of queueing the drain behind it.

## Not built yet

- **Phase 2:** the ledger is written on the Keitaro poll tick. Telegram alerts for unmapped conversions and event-type conflicts, plus a monitor with heartbeat.
- **Bug-2 PR:** `keitaro_stage_results` conversion side aggregated from the ledger by `occurred_at`, not Keitaro's moving `datetime`.
- **Phase 3:** readers switch.
  - `purchasedClause` → purchase events in `pending`/`approved`
  - revenue and EPC → `counts_revenue` and `approved` only, with pending revenue as its own column
- **Phase 4:** Registered lane (tier 3; converted becomes 4; CHECK widened then).
- **Phase 5:** per-event report columns.
