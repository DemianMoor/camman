# Conversion events (multi-event conversions)

_Last updated: 2026-09-20_

**Status:** Phase 3 in progress — the ledger is kept live on the `*/5` Keitaro poll tick, with Tier-2 Telegram alerts. `purchasedClause`, the campaign tier, segment purchase rules, drip and the audience pools now read the ledger (Phase 3 Tasks 1–2). `keitaro_stage_results`' CONVERSION columns (checkouts/sales/revenue/pending_revenue/payout_at_conversion) are now a projection of the ledger, dated by `occurred_at` — see [Stage-day projection](#stage-day-projection-phase-3-task-3) below; every stage-grain reader (reports, the campaign page, the offer report, …) inherits this with zero code changes since they all read `keitaro_stage_results`. The per-RECIPIENT readers (partner report, the by-group `sale` weight basis, the hourly sales/revenue pair, Rule F's rescue, the dormant rollup, the campaign-activity badge) now read the ledger too — see [Per-recipient reporting readers](#per-recipient-reporting-readers-phase-3-task-4) below. **Revenue and EPC now count APPROVED conversions only, with pending revenue its own column** (Task 6) — see [Revenue and EPC](#revenue-and-epc-phase-3-task-6) below; this also closes Rule F's numerator/denominator window (§ Per-recipient reporting readers). ⚠️ **Migrations 0181/0182 are not yet applied to production** — `conversion_events`/`event_types` do not exist there yet; every reader switched in Tasks 1–4 and 6 is verified on camman-v2 (preview, auto-migrated) and by read-only checks against prod's still-live `stage_sends`/`counted_clickers` columns, not by running the new code against prod (it would 42P01). Applying 0181–0183 is gated on the Task 7 STOP approval. The same holds for **0184 and 0185** (Phase 4's lane tier and Phase 5 Task 2's per-event columns): both are applied on camman-v2 only and neither is applied to production.

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
- the live poll tick pages Telegram once per new problem combo (`conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`, see [Live ingest and alerts](#live-ingest-and-alerts-phase-2)). More conflicts of the same combo don't re-page, and the key clears once that combo has no conflicting rows left — unless more than 10 conflict combos exist, where no conflict combo key clears until the count is back to 10 or fewer
- after a row's conflicting type changes again (say `purchase` then `lead` against the same locked type), `event_type_conflict_at` is kept, so the new combo's page reports the ORIGINAL conflict time as its first seen — `COALESCE(conversion_events.event_type_conflict_at, now())` only fills a NULL. That page's `last_24h` count (by `event_type_conflict_at`) can then read **0** in the same breath as an older "First seen" date, because the kept timestamp is outside the last 24h — that is not stale news: the combo (this locked→conflicting pair) is brand new and paging for the first time, it just inherited an old first-seen time from the row's earlier conflict

A status-only mapping (NULL event type, e.g. Affise `rejected`) neither raises nor clears a conflict; a mapping that agrees again clears it. On a conversion with no row yet it has nothing to keep — see [A status-only rule on a conversion we have never seen](#a-status-only-rule-on-a-conversion-we-have-never-seen). To resolve one: decide which event is right. If the lock is wrong, correct the row by SQL (`UPDATE conversion_events SET event_type_id = <right>, conflicting_event_type_id = NULL, event_type_conflict_at = NULL WHERE keitaro_event_id = '…'`) after approval.

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

To retire a rule, set `status = 'archived', archived_at = now()`; the unique indexes only cover active rules. Rows stored before a rule existed are healed on the next ingest of their window (sticky `COALESCE` fills NULLs). The live poll tick re-ingests the last 7 ET days every 5 minutes, so recent rows heal on their own, and a combo's `conversion_events:unmapped:<offer>:<keitaro_type>` alert clears once none of its rows remain (while more than 10 unmapped combos exist, clears wait until the count is back to 10 or fewer). Re-run the backfill to heal older windows.

### A status-only rule on a conversion we have never seen

A mapping row with `event_type_id` NULL is a **status-only rule**: "keep this conversion's existing event type and only move its status". PsychoBook's `rejected` is seeded that way, and that is right for the rejection of a conversion already in the ledger.

**If the rejection is the FIRST postback for that `keitaro_event_id`, there is no row and so no event type to keep.** The conversion is stored with a status and `event_type_id` NULL — the unmapped shape — and counts as nothing: not a purchase, not a registration, no revenue. **No later postback heals it**, because the rule that classified it has no event type to give. The sticky `COALESCE` only fills a NULL from a mapping that names a type.

It is detected and reported, never dropped:

| Where | What |
|---|---|
| ingest result | `statusOnlyFirstSeenInBatch` + up to 10 `statusOnlyFirstSeenSamples` (`event_id offer=… type=… status=…`), computed by `findStatusOnlyFirstSeen` ([lib/conversions/ingest.ts](../../lib/conversions/ingest.ts)) BEFORE the write, so a dry run reports it too. In the poll response under `conversion_events` |
| Telegram | `conversion_events:status_only_unmapped:<offer>:<keitaro_type>` — its own Tier-2 alert, separate from `unmapped` (below) |
| backfill | a per-window count, a totals field, and a `PROBLEM:` line → exit 1, on the dry run and on `--apply`; `--apply`'s table check counts the rows separately from the ordinary unmapped ones |
| verify | `scripts/verify-conversion-events.ts` fails **V3b** (V3 is the ordinary unmapped case) |

**What an operator does.** The fix is a config row, not code:

1. Give the Keitaro type that should arrive **first** for that offer or its network a `conversion_event_mappings` row that names an `event_type_id`, so the conversion is typed on its first postback. This is the usual cause: `lead` / `sale` / `registration` is mapped for one network but not for this one, so the first postback CamMan classifies is the rejection.
2. Decide which event the rows that already landed are, and set their `event_type_id` by SQL (approval required in prod) — nothing else will:
   ```sql
   UPDATE conversion_events SET event_type_id = <event type>, updated_at = now()
   WHERE event_type_id IS NULL AND status IS NOT NULL AND keitaro_event_id = '…';
   ```
   The status is kept. The next tick clears the alert.
3. Do **not** put an event type on the status-only rule itself unless a first `rejected` (or whatever the type is) always means that one event. On a conversion that already has a row, the rule would then disagree with the locked type and be recorded as an [event-type conflict](#event-type-conflicts).

Nothing about any mapping's meaning changes with this detection: PsychoBook's `rejected` stays status-only.

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

## Live ingest and alerts (Phase 2)

**Where it runs.** `/api/keitaro/poll` (`*/5`), after `pollKeitaro` and the counted-clicker refresh ([app/api/keitaro/poll/route.ts](../../app/api/keitaro/poll/route.ts)):

1. `ingestKeitaroConversions(db, { range: liveIngestRange(now) })`. The window is the last **7 ET calendar days**: today minus 6 days at 00:00:00 through now ([lib/conversions/keitaro-row.ts](../../lib/conversions/keitaro-row.ts)).
   - Calendar arithmetic, so a DST week never shortens it.
   - Independent of `?windowDays`, which stays the aggregate poll's knob.
   - Keitaro filters by a conversion's *current* `datetime`, and a re-post moves that forward, so an in-place update of an older conversion comes back into the window.
2. Its own try/catch. A throw is reported as `conversion_events_error` and never fails the poll, its response or `keitaro_stage_results`. On the cron path the throw also counts as a failed tick for the debounced `fetch_failed` alert (below). The ledger step writes only `conversion_events`. **A refused window (`ok:false`) is not a throw**, so it leaves `conversion_events_error` NULL — the reason is in `conversion_events.error` instead. Don't grep only `conversion_events_error` to answer "did the ledger fail this tick".
3. **Cron path only:** `evaluateConversionAlerts` ([lib/conversions/monitor.ts](../../lib/conversions/monitor.ts)). Then, last and only for a complete window (`ok:true`), `recordHeartbeat("conversion-events-ingest")`. The manual "Refresh from Keitaro" path ingests but never pages or stamps — and its toast reads only the aggregate poll's `degraded`/`error` fields ([components/reports/keitaro-report.tsx](../../components/reports/keitaro-report.tsx)), never `conversion_events`/`conversion_events_error`, so a ledger failure on a manual sync is silent in the UI.

**Multi-tenancy note.** The manual sync's raw JSON response is not org-scoped the way the UI toast is: `conversion_events.orgMismatchSamples` (raw org UUIDs) and `unresolvedSamples` (`sub_id_1`/`sub_id_3`) come back to whichever manager/admin/owner triggered `POST /api/keitaro/poll`, for whatever org they belong to (the route checks `result_imports.create`, which the operator role does not hold). This mirrors the pre-existing `unmatched_samples` field the aggregate poll's own response already exposes the same way.

The poll response gains `conversion_events` (the `IngestResult`, or `null` when the ingest threw) and `conversion_events_error`, plus (Phase 3 Task 3) `stage_day_conversions` (the `StageDayConversionSync` the projection wrote, or `null` when it was skipped/threw) and `stage_day_conversions_error`. See [keitaro-poll.md §5](keitaro-poll.md).

**Route budget.** `/api/keitaro/poll`'s `maxDuration` is 230s — below the 240s `CRON_LEASE_MS` cron lease ([lib/cron/lease.ts](../../lib/cron/lease.ts)) so a slow tick dies before the next one could overlap it. Typical runs are single-digit seconds; a killed tick's ledger transaction rolls back and retries next tick.

**Alerts.** Tier-2, plain text, prefixed `🟠 Tier-2 conversions:`. Each is latched in `alert_state` through `notifyOnTransition` / `clearAlert`: a standing condition pages once, and the key re-arms after it clears. The alerts are cross-org, so `alert_state.org_id` is NULL.
- `fetch_failed`, `invalid_rows`, `org_mismatch`, the two `combo_cap_exceeded` keys and the heartbeat use **fixed** keys.
- `unmapped`, `status_only_unmapped` and `type_conflicts` read the whole ledger, all-time, and use **one key per problem combo**.
  - A fixed key would stay firing on one old unfixed row and hide every later problem.
  - A key on the newest problem row's id would miss conflicts, which only arise when an existing row is updated. It would also miss existing rows that turn unmapped, and page on every tick for a stream of new unmapped rows.
- The combo keys:
  - `conversion_events:unmapped:<offer>:<keitaro_type>`
  - `conversion_events:status_only_unmapped:<offer>:<keitaro_type>`
  - `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`
  - `<offer>` is the CamMan `offer_id`, else `k<keitaro_offer_id>`, else `none`.
  - No prefix is a prefix of another — `conversion_events:status_only_unmapped:` does **not** start with `conversion_events:unmapped:` — so the per-prefix firing-key read and the stale-combo clear never cross kinds.
  - **`unmapped` and `status_only_unmapped` partition** the rows `conversion_events_unmapped_idx` covers (`event_type_id IS NULL OR status IS NULL`): `status IS NULL` is "no mapping rule matched the Keitaro type at all" (including a typed row whose newest type maps to nothing), `event_type_id IS NULL AND status IS NOT NULL` is the status-only first sighting above. Disjoint, so no row pages twice; total, so no row goes unreported. Each half still implies the index predicate, so both read the same partial index and **no migration was needed**. The predicates live as `UNMAPPED_WHERE` / `STATUS_ONLY_WHERE` / `CONFLICT_WHERE` in [lib/conversions/monitor.ts](../../lib/conversions/monitor.ts), and the statements are built from them.
  - Other parts are lowercased, with anything outside `[a-z0-9_-]` turned into `_` and clipped to 40 characters. When any of that changed the raw part, `~` plus the first 6 hex characters of its sha256 is appended, so two Keitaro types that sanitise alike (`First Deposit` and `first:deposit`) never share one alert. An already-clean part carries no suffix.
  - **Not org-scoped.** `offer_id` is a global serial, so a combo keyed by it is implicitly org-unique — but `none:<type>` and `k<keitaro_offer_id>:<type>` are not, and `event_types.key` is per-org. Two orgs hitting the same `none`/`k<keitaro_offer_id>` combo, or the same locked→conflicting event key pair, page as ONE alert: one page, a summed count, samples mixed across orgs, and the key clears only once **every** org's rows for that combo are gone. Inert today (one real org sends Keitaro traffic). Follow-up before a second org does: add `ce.org_id` to both combo statements' `GROUP BY` and as the leading key part, and clear the existing firing rows under both prefixes in the same deploy.
  - A combo key can MOVE when attribution fills in: a combo keyed `k41:trash` becomes `<offer>:trash` once `offers.keitaro_offer_id` is set on the CamMan offer and the next tick refreshes the rows. That is one extra page (the new key) and one clear (the old key), not a new problem.
- Each tick:
  - **A new problem combo pages once**, including one created by an UPDATE (a conflict, or an existing row turning unmapped). More rows of the same combo **don't re-page**, so a steady stream of one unmapped type sends one page.
  - **A combo that disappears is cleared** (its key goes to `ok`), unless its kind is past the cap (next bullet). If it comes back, it pages again.
  - At most **10 combos per kind** (`LEDGER_MAX_COMBOS`) are listed and paged, the **most recently changed first** (`max(updated_at)`, which the ingest moves on every insert and every real update). So a brand-new combo pages even when it is the smallest and 10 others are already firing.
  - Past the cap, every page of the kind says how many more combos exist, that kind's `conversion_events:combo_cap_exceeded:*` key pages once, and no **combo** key of that kind clears until the count is back to 10 or fewer.
  - See `CONVERSION_ALERT_KEY_PREFIXES` / `unmappedAlertKey` / `typeConflictAlertKey` / `decideLedgerAlerts` in [lib/conversions/monitor.ts](../../lib/conversions/monitor.ts).
- Each combo page names:
  - the offer and the Keitaro type (or the locked → conflicting event pair). A `status_only_unmapped` page also names the offer's **network**, because the mapping row that is missing is usually the network's
  - the combo's row count and how many were created in the last 24h (for a conflict, first seen in the last 24h), plus the first-seen time in ET for a conflict
  - up to 3 sample `keitaro_event_id`s, and the fix

| Key | Fires when | Clears when | What to do |
|---|---|---|---|
| `conversion_events:fetch_failed` | a **failed tick** — the window was refused (Keitaro HTTP error, timeout, a **malformed** 200 that isn't JSON with a `rows` array and a numeric `total` such as an HTML bot challenge, or a **truncated** page, `rows < total`) or the ingest **threw** (its message is the error text) — **and** the last complete ingest (the heartbeat) is older than `FETCH_FAILED_DEBOUNCE_MINUTES` (15) or was never recorded. A failed tick inside the 15 minutes does nothing: no fire, no clear. So one transient failure never pages; with `*/5` ticks the page lands on the 3rd–4th consecutive failure (the heartbeat age is read at 0.1h resolution). Nothing from a failed window is written | the next complete window | Repeated timeouts or 5xx: Keitaro or the network is down. Malformed: something other than the Keitaro API answered (bot challenge, proxy, error page). A truncation means 7 days of conversions no longer fit one Keitaro page, and the live window needs splitting (code change) — **the window has no pagination to fall back on, so treat a truncation alert as urgent, not a transient blip that resolves itself.** A throw is also in `conversion_events_error` and the Vercel logs |
| `conversion_events:invalid_rows` | a complete window held rows `parseKeitaroLedgerRow` rejected. Those conversions are **not** in the ledger | a complete window with 0 invalid rows. A failed tick leaves it unchanged | Compare the samples with `KEITARO_LEDGER_COLUMNS` / `parseKeitaroLedgerRow` |
| `conversion_events:org_mismatch` | a complete window had `orgMismatch > 0`: existing ledger rows this run resolved to a **different org** than they were stored under. Those rows were **not written** (`org_id` is fixed at insert). The alert carries the count and up to 3 samples `event_id stored_org→resolved_org`. **No debounce**: this is a data-integrity signal | a complete window with `orgMismatch = 0`. A failed tick leaves it unchanged | Find which lookup now points into another org (stage tracking id, `stage_sends` id or `offers.keitaro_offer_id`) and fix that. Correct the ledger row by SQL only after deciding which org is right (approval required) |
| `conversion_events:unmapped:<offer>:<keitaro_type>` (one key per combo) | ledger rows, all-time, with **`status` NULL** — no mapping rule matched their Keitaro type at all (read via `conversion_events_unmapped_idx`), grouped by offer and Keitaro type. **Pages once per new problem combo**, whether the rows were inserted or an existing row turned unmapped (its Keitaro type changed, or its rule was archived). **Repeats don't re-page**: more rows of the same combo never send another page | **the combo disappears**: none of its rows is unmapped any more. If it reappears, it pages again. While more than 10 unmapped combos exist, no unmapped combo key clears (the `combo_cap_exceeded:unmapped` key is firing then) | Add the mapping for that offer or network and Keitaro type (see above). Rows inside the 7-day window heal on the next tick. Older rows need `scripts/backfill-conversion-events.ts --apply` (prod write, needs approval) |
| `conversion_events:status_only_unmapped:<offer>:<keitaro_type>` (one key per combo) | ledger rows, all-time, with **`event_type_id` NULL and a `status`**: a [status-only rule classified a conversion we had never seen](#a-status-only-rule-on-a-conversion-we-have-never-seen), so there was no event type to keep. Grouped by offer and Keitaro type; the page names the offer, its network, the type, the counts, 3 sample event ids and the fix. **Pages once per new problem combo; repeats don't re-page.** Zero such rows today — the alert exists so the first one is not invisible | **the combo disappears**: every one of its rows has an event type (or is gone). While more than 10 status-only combos exist, no status-only combo key clears (`combo_cap_exceeded:status_only_unmapped` is firing then) | A missing config row, not a bug. Give the Keitaro type that should arrive FIRST a mapping with an `event_type_id`, then set the stored rows' `event_type_id` by SQL — **no mapping and no later postback will heal them**. See the section above |
| `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>` (one key per combo) | rows with `conflicting_event_type_id` set (via `conversion_events_type_conflict_idx`), grouped by offer and locked → conflicting event type. A conflict only arises when an existing row is updated. **Pages once per new problem combo**; **repeats don't re-page**: another conflict of the same combo sends nothing | **the combo disappears**: none of its rows still conflicts. If it reappears, it pages again. While more than 10 conflict combos exist, no conflict combo key clears (the `combo_cap_exceeded:type_conflicts` key is firing then) | See [Event-type conflicts](#event-type-conflicts) |
| `conversion_events:combo_cap_exceeded:unmapped` / `:status_only_unmapped` / `:type_conflicts` (fixed, one per kind) | that kind has more than 10 problem combos, so only its 10 most recently changed are listed and paged. The page names the kind, the combo count, the cap and the SQL that lists every combo of the kind. Neither key is under a combo prefix, so the stale-combo clear never touches them | the kind is back to 10 or fewer combos. Combo clears of that kind resume at the same moment | Read the whole list with the page's SQL and work it down. A new combo still pages while capped (recency ranking), unless more than 10 combos change in the same tick |
| `heartbeat:conversion-events-ingest` | no complete ingest for over **1h** (`HEARTBEAT_JOBS.conversionEventsIngest`). Checked hourly by `/api/cron/tracking-monitors`, never by the poll itself | the heartbeat is fresh again | Check the poll cron: `conversion_events_error` in its response, the Vercel logs, and any `fetch_failed` alert. A long outage pages twice by design: `fetch_failed` after ~15 min, the heartbeat within ~2h |

**Not alerted:**
- `unresolved` conversions (no stage, no `offers.keitaro_offer_id`). They include legitimate non-CamMan traffic, so they are only counted in the poll response.
- A complete window with zero conversions, which is a quiet week.
- `statusOnlyInBatch` on its own. A status-only mapping landing on a conversion that already has a locked event type is the normal, correct case. Only its first-sighting subset is a problem — counted as `statusOnlyFirstSeenInBatch` and paged as `conversion_events:status_only_unmapped:<offer>:<keitaro_type>`.

**Inspect state (read-only):**

```sql
SELECT alert_key, state, since, last_notified_at FROM alert_state
WHERE alert_key LIKE 'conversion_events:%' OR alert_key = 'heartbeat:conversion-events-ingest'
ORDER BY alert_key;
SELECT watermark, now() - watermark AS age FROM cron_locks WHERE job_name = 'conversion-events-ingest';
```

Don't flip a key to `ok` by hand; that hides a real condition. Fix the cause, and the next tick clears it (the next hourly run, for the heartbeat). A firing `unmapped:<offer>:<keitaro_type>` / `status_only_unmapped:<offer>:<keitaro_type>` / `type_conflicts:<offer>:<locked_key>><conflicting_key>` row names one problem combo. It stays firing until **none** of that combo's rows is a problem any more — and, while its kind's `combo_cap_exceeded` key is firing, until that kind is back to 10 or fewer combos as well.

**While Telegram is down:** a combo that appears and self-heals entirely inside the outage still latches and clears normally in `alert_state` — its page is simply never delivered (`notifyOnTransition`/`clearAlert` write the state regardless of whether the Telegram send succeeded, the same latch semantics as the tracking-gap monitor). Don't conclude the monitor "missed" it; check `alert_state.since` / `last_notified_at` for the outage window, not just what arrived in the channel.

**Before merging.** The first cron tick after merge reads the whole ledger, all-time, so it can page a burst on top of whatever Phase 1's backfill already left unresolved: up to 10 unmapped combos + 10 conflict combos + 2 cap alerts, plus (if the hourly `tracking-monitors` tick lands before the first `*/5` tick stamps the heartbeat) one "heartbeat never recorded" page. Before merging, run the exported `UNMAPPED_COMBOS_SQL` / `CONFLICT_COMBOS_SQL` ([lib/conversions/monitor.ts](../../lib/conversions/monitor.ts)) read-only against prod to know the burst size ahead of time.

**Checks:**
- `scripts/test-conversion-monitor.ts` (pure, 53):
  - the window, including DST and a year boundary
  - every decision, including the `fetch_failed` debounce (fresh / stale / never / exactly 15 min), a malformed response and a thrown ingest
  - the `fetch_failed` age text (`N min ago` under 120 min, `X.Y h ago` from 120 min)
  - the stage-day projection's decisions (J1-J5): a successful run clears, a throw names the error and the watermark, the empty-ledger refusal fires the same key and names the Phase 1 backfill, an unbounded error is clipped
  - `org_mismatch` fire/clear with samples
  - combo keys: the format and offer rule, sanitisation and clipping, the `~<hash>` suffix (parts that sanitise alike get different keys; a clean part gets no suffix), and that counts and samples never change a key
  - combo decisions: a new combo fires, the same combo fires on the same key, a stale firing key clears, keys outside the prefixes are ignored, and the 10-combo cap (named on each page, no combo clears past it, the `combo_cap_exceeded` key firing over the cap and clearing at it)
  - the combo statements rank by `max(ce.updated_at) DESC`, not by size
  - per-combo text facts, samples capped at 3, no markup, the seven fixed keys and the three prefixes
  - `status_only_unmapped` (SO1–SO6): its key shape and prefix disjointness, the page's operator wording (offer, network, Keitaro type, "counts as nothing", "a later postback will NOT fix them", "a missing config row"), the no-offer/no-network form, that the two statements' WHERE clauses **partition** the index predicate, its own cap key and past-cap line, and that a status-only combo produces no `unmapped` decision
- `scripts/test-conversion-monitor-db.ts` (camman-v2 only, rolled back, 58):
  - pre-existing problem rows are neutralised inside the transaction
  - combo reads: counts, the offer rule, samples, a first-seen status-only row (`event_type_id` NULL, `status` `rejected`) read as **status-only, not unmapped**, with a SQL recount proving the two predicates cover the index's rows exactly once each; a conflict set by UPDATE; partial-index use per predicate; the cap with the combo count and row total over every combo, listed by recency
  - `findStatusOnlyFirstSeen` against a one-sided fixture: of a status-only row whose ledger row exists, one whose row does not, a typed row and a rule-less row, it returns exactly the second (G1); storing that conversion pages once on `status_only_unmapped` and never on `unmapped` (G2), doesn't re-page (G3), and clears when its `event_type_id` is set by SQL (G4)
  - the same combo on successive ticks pages once; a new combo pages; an existing row turned unmapped by UPDATE pages; a conflict set on an existing row by UPDATE pages, and a second one of the same combo doesn't
  - a resolved combo's key clears and pages again when the combo reappears; leftover in-prefix keys clear; decoy keys outside the prefixes stay untouched
  - a new 1-row combo pages against ten bigger firing combos, crossing the cap pages the `combo_cap_exceeded` key once, the combo that drops off the listing is not cleared, and clears resume when the kind is back at the cap
  - a failed tick still pages a new combo
  - the debounce against a real `cron_locks` watermark (5 min / 20 min / NULL; a debounced failure never clears; a throw pages)
  - the projection alert's latch (C1-C5): a throw pages once, a repeat doesn't, a successful run clears silently, the refusal re-arms the same key and pages, and the row stays global (`org_id` NULL)

## Stage-day projection (Phase 3 Task 3)

`keitaro_stage_results` holds two kinds of column on one row: CLICK columns (dated by click day, written by `pollKeitaro`'s `report/build` fold) and CONVERSION columns (dated by conversion day, written by [`lib/keitaro/stage-day-conversions.ts`](../../lib/keitaro/stage-day-conversions.ts) from this ledger). The aggregate poll no longer fetches `conversions/log` at all — the ledger ingest above is the tick's only conversion fetch.

- `syncStageDayConversions(dbc, { stageIds })` re-derives every (stage, ET day) in scope from a fresh `GROUP BY conversion_events` (semantics as of Task 6: sales = `purchasedClause()` — a counted PURCHASE event, pending or approved; `rejected` is a refund, not a sale — checkouts = `keitaro_type = 'lead'` unchanged, revenue = `approvedRevenueClause()` — approved only — and pending_revenue = `pendingRevenueClause()`, the same held payout kept out of revenue/EPC/ROI/profit), INSERT/UPDATEs the rows that differ (including a row whose `payout_at_conversion` alone is stale), then **zeroes** any existing row's conversion columns — `checkouts`, `sales`, `revenue`, `pending_revenue`, `payout_at_conversion`, never the click columns — for a day the ledger no longer explains. `stageIds: []` is a no-op; omitted = every stage (the one-shot resync). `stagesInScope` reports the scope it was GIVEN (`"all"` when unscoped).
- ⭐ **Neither the zeroing nor the rewrite can outrun the ledger's coverage.** A full re-derivation would otherwise wipe months of real sales on a ledger that has not been backfilled, because the live ingest window is only 7 ET days. Three bounds, all read once per run by the shared `readProjectionCoverage(dbc, { stageIds })` **before any write** — the same function `scripts/resync-stage-day-conversions.ts` pre-flights, so the script and the `*/5` tick cannot disagree about what is safe:
  - **Empty-ledger refusal** — no stage-attributed ledger row anywhere ⇒ the run writes NOTHING and returns `refused: "empty_ledger"` (the poll response and the `conversion_events:projection_failed` alert both say so).
  - **Global coverage guard** (`refused: "ledger_behind_history"`) — `keitaro_stage_results` still reports a non-zero conversion column on a day OLDER than the ledger's earliest stage-attributed day ⇒ refuse the whole projection, write and zero. The per-stage floor below protects a day the ledger has no floor for; it cannot protect a day the ledger covers only PARTIALLY, where `ON CONFLICT DO UPDATE SET … = EXCLUDED` REDUCES a real total to the partial sum — the same damage as zeroing it. An interrupted backfill, or one old re-posted conversion dragging a single stage's floor back months, is exactly that state. The result carries both dates (`reportedHistoryFloor`, `ledgerFloor`) and the alert names them plus the fix: run the Phase 1 backfill, then the resync. **This is the state prod is in today** (no ledger at all ⇒ the empty-ledger refusal), and it is checked globally, not per scope: a partially-backfilled ledger is a whole-table condition, and a scoped run would otherwise happily reduce the stages it happens to name.
  - **Per-stage coverage floor** — a stage-day is only zeroable when that stage's own earliest ledger conversion is on or before it (an inner join to `min((occurred_at AT TIME ZONE ET)::date) GROUP BY org_id, stage_id`). So a stage with no ledger rows at all is never touched, and nothing before a stage's first ledger conversion is. The floor counts ALL stage-attributed rows, not just the ones the sales/revenue filters match — coverage means "the ingest reached this day for this stage". `coverageFloor` in the result is the minimum floor across the scope (reporting only; the enforced bound is per stage).
- **The projected row's org is the stage's org.** The INSERT takes `org_id` from the ledger row, so it joins `campaign_stages` on `cs.id = l.stage_id AND cs.org_id = l.org_id`, and the zeroing joins its floor subquery on `(org_id, stage_id)`. A ledger row whose `org_id` doesn't match its stage's therefore joins to nothing: it can never create a `keitaro_stage_results` row under the wrong org (which would then mirror another org's stage counters into it) and never establishes a coverage floor for another org's rows. The ingest's own `conversion_events:org_mismatch` alert is what reports such a row.
- **Deliberate trades, all three checked by `scripts/test-stage-day-conversions.ts`:**
  - A coverage **GAP inside** `[per-stage floor, now]` — the ledger reaches back far enough but is missing rows in the middle — is still zeroable and reducible. Nothing the projection can read distinguishes "no conversion happened that day" from "the ingest lost that day", so the guard against a gap is the backfill's own verify (`scripts/verify-conversion-events.ts`: every Keitaro conversion present), not the projection.
  - A stage whose ledger rows were **ALL deleted** is never corrected — safety over freshness. It has no floor, so its stored numbers stay exactly as they were, stale, until a ledger row for it exists again.
  - The **Checkout Clicks mirror now overwrites a hand-entered value** within 5 minutes on any stage the projection has in scope, and sets it to **0** when that stage has no ledger conversions at all (the field belongs to the projection — see [keitaro-poll.md §2a](keitaro-poll.md)). `scripts/resync-stage-day-conversions.ts --apply` does this for every stage with any `keitaro_stage_results` row, in one run.
- `discoverChangedLedgerStages(dbc)` finds stages whose ledger rows changed, via `conversion_events.updated_at` (migration 0182's `conversion_events_updated_at_idx`). `occurred_at` never moves, so this is the only way to find a re-posted OLD conversion whose stage-day sits outside the current click window.
  - **Resumable.** The window is `[min(watermark − 5 min, now − LEDGER_CHANGE_LOOKBACK_MINUTES), now]`: the 30-minute lookback is a FLOOR (and the whole window on a first run), and an older watermark EXTENDS the window back. A fixed lookback stranded changed stage-days forever after ~6 consecutive failed ticks. The cursor is `cron_locks.watermark` under `job_name = 'conversion-stage-day-projection'` (the same column `propagate-clickers` uses; not a lease — the route's `keitaro-poll` lease is the single-runner guard), advanced by `advanceProjectionWatermark` and never backwards.
  - **Capped** at `MAX_CHANGED_STAGE_IDS` (20000) stage ids, because each id is a bind parameter in the statements below and the zeroing UPDATE binds every id twice (40000 against Postgres's 65535 ceiling). That is comfortably more stages than the dataset holds, so only a full-ledger re-touch can reach it. Oldest change first, so the ids kept are the ones that have waited longest — but that is NOT a progress claim: a truncated run **holds** the cursor and pages. The earlier version advanced to the last id it KEPT, which strands the remainder whenever more stages share one `max(updated_at)` than the cap allows (a backfill's single-statement re-touch is exactly that — every stage carries the same timestamp, so the resume point equals the window start and the tick claims progress it did not make).
- `runStageDayProjection(dbc, { extraStageIds })` is what the route calls: discover → project `extraStageIds ∪ discovered` → advance the watermark **only** when the run finished its window: not on a throw (the UPDATE is simply never reached — and in production `dbc` is the pool, so no transaction is rolling anything back), not on either refusal, and not on a truncated discovery. `watermarkHeld: true` says the cursor stayed put. A killed tick therefore re-reads the same window.
- **Order in the `*/5` tick** ([app/api/keitaro/poll/route.ts](../../app/api/keitaro/poll/route.ts) `pollAndRefresh`): `pollKeitaro` (clicks) → counted-clicker refresh → `ingestConversionLedger` → **only if that ingest was `ok`**, `runStageDayProjection` over `pollKeitaro`'s `stage_ids` (this tick's click-touched stages) ∪ the discovered stages. A refused or thrown ingest skips the projection entirely for that tick — re-deriving against an incomplete ledger would zero real revenue inside the covered range — and the stage-days keep their previous values until the next good tick.
- **Alert:** `conversion_events:projection_failed` (fixed key, latched, plain text) fires when the projection throws, refuses (`empty_ledger` or `ledger_behind_history`, which names both dates) or leaves its discovery window unfinished (`truncated`, which says the cursor was held and points at the resync), and clears on the next run that finished a window. `projectionOutcomeFor(run)` in [lib/conversions/monitor.ts](../../lib/conversions/monitor.ts) owns the run → outcome mapping, so a new refusal reason cannot reach the route without an alert text; a refusal outranks a truncation. Because it is ONE key, a second condition appearing while the first is firing does not re-page (accepted: one standing page per condition is the contract). Evaluated on the CRON path only, and only when the projection actually ran — a skipped projection gets no decision, because the ingest's own `fetch_failed` alert already covers that tick.
- A stage-day with conversions but no click row: `syncStageDayConversions`'s INSERT creates the row (click columns default 0 — a conversion with no matching click is legitimate, e.g. `sub_id_1`/`sub_id_3` resolved via `offers.keitaro_offer_id` with no click).
- One-shot repair for stage-days frozen before this shipped: `npx tsx scripts/resync-stage-day-conversions.ts` (dry-run by default, prints the target host, the coverage floor and every diff; `--apply` writes inside one transaction, prod needs approval). Both paths pre-flight `readProjectionCoverage` and refuse on `empty_ledger` / `ledger_behind_history` before printing anything. The dry run lists exactly the rows `--apply` would change, each tagged `insert` / `rewrite` / `zero`. ⭐ **That is now STRUCTURAL rather than a promise in the script's header (2026-09-19).** The script holds no SQL at all: the preview is `readStageDayResyncDiff()` and the write is `syncStageDayConversions()`, both in [lib/keitaro/stage-day-conversions.ts](../../lib/keitaro/stage-day-conversions.ts), built from the same CTEs (`stageDayLedgerCtes`), the same change test (`projectionChangedClause` over `PROJECTED_COLUMNS` — the upsert's own `WHERE`) and the same content test (`projectionNonEmptyClause` — the zeroing UPDATE's own), beside a verbatim copy of its anti-join and its `cov` floor subquery. The retyped copies that used to live in the script fell behind **twice**: Task 6 redefined a sale and the script kept counting refunds (`keitaro_type IN ('lead','sale','rejected')`); Phase 5 added `events` / `unmapped_conversions` to both write predicates and the script listed neither. For a while the run an operator approved was not the run that happened. Bars **R0–R10** execute the diff and the write against one world and require the row sets to be EQUAL in both directions. **The Phase 1 backfill must have run on prod before the projecting code is live** — the first tick after the ledger is populated re-derives all of history in its scope (Task 8's precondition list).
- `mirrorStageCountersFromResults` (exported from `lib/keitaro/poll.ts`) runs after BOTH the click upsert and the conversion projection, so `campaign_stages.checkout_click_count` never lags a tick. The projection calls it with `exactCheckoutClicks: true`: the projection is non-monotonic, so that one field takes the recomputed sum even when it DECREASES (0 included) — otherwise a zeroed day would leave a stale higher counter on the campaign page and in the creatives metrics cache forever. `click_count` and `sales_payout_each` keep their positive-only/COALESCE guard, `sales_count` is never touched. It also THROWS now instead of swallowing: the swallow lives at `pollKeitaro`'s call site (the pool), because swallowing inside would poison a caller-supplied transaction (`--apply`, the DB tests). See [keitaro-poll.md §2a](keitaro-poll.md).

Checks: `scripts/test-stage-day-conversions.ts` (camman-v2 only, rolled back, 66) — the projection's semantics; all three coverage bounds alongside the bug-2 correction that must survive them; the org join; the payout-only rewrite; the exact downward mirror; the watermark (first run, out-of-window, an old watermark extending the window, the cap, advance-only-on-a-finished-window, no advance on a refusal or a truncation, and — against a recording fake `dbc`, because a rolled-back savepoint could never prove it — no watermark UPDATE issued at all when the write throws). The fixture is built so a GLOBAL floor cannot pass: stage A is covered from 2026-05-01, stage Y only from 2026-09-14, and Y carries a stale non-zero row on 2026-06-01 — inside the global coverage, outside its own. Proven red on 2026-09-17 by two temporary variants of [lib/keitaro/stage-day-conversions.ts](../../lib/keitaro/stage-day-conversions.ts) (restored byte-identically, `cmp`-verified): a global-floor zeroing subquery ⇒ 3 failures incl. Y's row zeroed to 0/$0, and the guard removed ⇒ the pre-coverage case writes 3 rows, zeroes 1 and advances the cursor silently. The alert's decisions are in `scripts/test-conversion-monitor.ts` (J1-J5, J4b-J4d) and its latch in `scripts/test-conversion-monitor-db.ts` (C1-C9). ⚠️ The route guards in the test file (G1-G3) are SOURCE assertions — they read the route's text, so they go red on a rename and cannot see what the branch does at runtime.

The closing check (RF1-RF4, added Task 6) proves Rule F's numerator/denominator invariant directly rather than inferring it from "0 rejected/unmapped rows today": a dedicated stage + five real `stage_sends` recipients (one each: approved purchase, rejected purchase, $0 registration, unmapped shape (a), unmapped shape (b)) are projected for real, then RF3b asserts the stored stage-day's sales/revenue equal an independent recomputation restricted to ONLY the recipients `rescueSendIds()` rescues. RF4 is a permanent embedded red-proof control (the retyped pre-Task-6 filter does violate the invariant on this fixture). Additionally, `lib/keitaro/stage-day-conversions.ts`'s `SALES_FILTER`/`REVENUE_FILTER` were manually reverted to the pre-Task-6 literal, which failed RF1 and RF3b (sales 2/$119 vs the correct 1/$42), then restored byte-identically (`md5sum`-verified).

## Per-recipient reporting readers (Phase 3 Task 4)

The readers that work at RECIPIENT (send-row) grain rather than stage-day grain switched from `stage_sends.sale_status` / `converted_at` / `sale_revenue` onto `conversion_events`:

| Reader | File | What changed |
|---|---|---|
| Partner report sales/revenue | [`lib/reporting/partner-report.ts`](../../lib/reporting/partner-report.ts) `purchases` CTE | Counts ledger `purchasedClause()` events per `stage_send_id`, sums `approvedRevenueClause()` revenue, `LEFT JOIN`ed onto the existing `attributed` CTE. A recipient with two purchases is now two sales and both payouts — the old column kept only the latest (measured: 14 recipients, $715 dropped) |
| By-group `sale` weight basis | [`lib/reporting/performance-report.ts`](../../lib/reporting/performance-report.ts) `trackedWeights` | The `basis === "sale"` candidate set now joins `conversion_events` → `stage_sends` filtered by `purchasedClause()`, instead of `ss.converted_at IS NOT NULL` |
| Hourly sales/revenue pair | same file, `getHourlyReport`'s `ledgerHourAgg` | Bucketed by the CONVERSION's own ET hour (`ce.occurred_at`), not the send row — so a stage-attributable conversion whose recipient never resolved (26 of them, $1,463) is now countable, and a second conversion on one send is no longer invisible |
| Rule F rescue | [`lib/reporting/counted-clickers.ts`](../../lib/reporting/counted-clickers.ts) `refreshCountedClickers` | The rescue INSERT joins `rescueSendIds(null, convWindow)` (purchase OR revenue-bearing, not rejected) instead of `ss.converted_at IS NOT NULL` — Rule F no longer rescues a REJECTED conversion, and will not rescue a $0 registration once those arrive. The incremental window moved from `ss.converted_at` (event time) to `ce.updated_at` (when we learned) |
| Dormant reports rollup | [`lib/reporting/rollup.ts`](../../lib/reporting/rollup.ts) `sentCte`'s `conv_sends` CTE | Same shape as the partner report's `purchases` CTE, `LEFT JOIN`ed into `sent`. `report_stage_hour`/`report_group_hour` have no readers and their cron is unscheduled, but they were the last app-side reader of the legacy columns |
| Campaign-activity badge | [`app/api/campaigns/[campaignId]/activity/messages/route.ts`](../../app/api/campaigns/[campaignId]/activity/messages/route.ts) | `ss.sale_status`/`ss.sale_revenue` replaced by a `LEFT JOIN LATERAL` to the recipient's LATEST `conversion_events` row (by `occurred_at DESC, id DESC`), exposed as `conversion_event`/`conversion_status`/`conversion_revenue`. [`components/campaigns/campaign-activity-section.tsx`](../../components/campaigns/campaign-activity-section.tsx) renders the event label + lifecycle status (`approved`/`pending`/`rejected`) instead of the raw Keitaro `sale`/`lead`/`rejected` read, which used to show a $0 registration as "lead · $0.00" |

`purchasedSendIds` / `rescueSendIds` ([`lib/sale-attribution.ts`](../../lib/sale-attribution.ts)) now take `orgId: string | null` — `null` drops the org filter for the two CROSS-ORG cache rebuilds above (`refreshCountedClickers`, `refreshReportRollup`), which write every org's rows in one statement and carry `org_id` from the send row; a real org id is still required for anything serving a request (`lib/audience/pools.ts`).

Guard: [`scripts/test-p3-task4-reader-switch-db.ts`](../../scripts/test-p3-task4-reader-switch-db.ts) — preview DB only, rolled back. Runs each reader's actual query text against **eight** one-sided fixtures, and the OLD `stage_sends`-column query text against the same rows, proving the switch: the new query counts the real ledger purchase and ignores the legacy column, the old query does the reverse (and would have wrongly rescued the rejected conversion). The fixtures are `ledger_only`, `legacy_only`, `rejected_ledger`, `two_conversions`, `unmapped` (shape a: no mapping rule ⇒ `event_type_id` AND `status` both NULL), `unmapped_status_only` (shape b: a STATUS-ONLY mapping rule ⇒ `event_type_id` NULL but `status = 'approved'`), `mapped_status_null` (a mapped purchase type whose status did not map) and `registration_0`.

### Review fixes (2026-09-18)

- **One definition per fragment, not two copies.** The partner report's `purchases` CTE and the rollup's `conv_sends` CTE are both built from `purchasesBySendSelect()` ([`lib/sale-attribution.ts`](../../lib/sale-attribution.ts)); the activity badge's LATERAL is `latestConversionForSend()` there too (a Next.js route may only export route fields, so a fragment a test must execute cannot live in `route.ts`); the `sale` weight basis is `saleWeightCandidates()` and the hourly query `ledgerHourQuery()`, both exported from [`lib/reporting/performance-report.ts`](../../lib/reporting/performance-report.ts). The badge's colour + amount decisions are [`lib/conversion-badge.ts`](../../lib/conversion-badge.ts). Every one of these exists so the guard runs the REAL text instead of a retyped lookalike.
- **The whole-ledger aggregates are bounded.** `purchasesBySendSelect()` takes a `restrict` predicate: the partner report passes `ce.stage_send_id IN (SELECT a.id FROM attributed a)` and the rollup an `EXISTS` on `stage_sends.sent_at >= since`. Both can only drop rows the call site's own `LEFT JOIN` would discard, so no number moves — which an `occurred_at` range filter would **not** guarantee: a conversion arrives days after its send, so an upper bound would silently drop real payouts.
- **The badge distinguishes a signal from a sale.** `conversion_is_purchase` (from `event_types.is_purchase`) travels with the row, because status alone cannot tell an approved $0 registration from an approved sale — both were painted purchase-green. A registration now gets its own sky badge, an unmapped row a neutral one, and a $0 amount is suppressed (`"0.0000"` is truthy, which is why the tooltip printed `· $0.00`). An unmapped row still shows its uncounted amount — that is the operator's cue that money is sitting in a row no report counts.
- **The activity LATERAL is org-scoped** (`ce.org_id = ss.org_id`) on top of the `stage_send_id` match.
- **`verify-counted-clickers.ts` asserts the rescue rule the cache uses.** Both its independent recomputation and its "every buyer is in the denominator" invariant take the predicate from `rescueSendIds()` instead of hand-coding `ss.converted_at IS NOT NULL` — which post-switch asserted the OLD rule and would have gone red on the first rejected or unmapped conversion, for correct behaviour. The recomputation stays independent (base tables, one pass, different aggregation); only the definition is shared.
- **⚠️ The hourly's instant changed, and it can move a number today** — correction class **D**. It buckets by `ce.occurred_at` (the conversion's original time, which never moves) where it used `ss.converted_at` (Keitaro's latest re-post time, latest-wins per recipient). A re-post used to carry revenue into a later hour and out of the range entirely once it crossed ET midnight; Task 7's before/after table must classify any hourly difference as class D rather than as a regression.
- **Rule F's invariant window, closed by Task 6.** The rescue is mapped-purchase-or-revenue and not rejected; the EPC numerator (the stage-day projection) was still type-based until Task 6 flipped `SALES_FILTER`/`REVENUE_FILTER` to `purchasedClause()`/`approvedRevenueClause()` — the same shared definitions the rescue reads — so a rejected or unmapped conversion can no longer contribute revenue while its recipient sits outside `counted_clickers`. 0 rejected and 0 unmapped rows at cutover, so no number moved. See [epc-denominator.md](epc-denominator.md) §2 and [Revenue and EPC](#revenue-and-epc-phase-3-task-6) below.
- **The guard grew from three fixtures to six**, adding the three classes the first version could not see: a recipient with TWO ledger conversions (both must count — the +$715 class), an UNMAPPED row (a class that SHRINKS a number: the legacy columns read it as a $55 sale), and a $0 registration (not rescued, not a purchase, rendered with no money). It also executes the real `refreshCountedClickers()` inside the rolled-back transaction, so Rule F is proven by the rows it actually writes. Proven RED against the pre-switch definitions (39 of 62 checks fail, including every new fixture's), restored byte-identically and `cmp`-verified. The re-review below took it to eight.

### Re-review fixes (2026-09-18)

- **A check that could never fail.** The `F5` source guard's negative half was a string literal containing an escaped newline (`\n`), and this checkout is CRLF (`core.autocrlf=true`; `.gitattributes` pins only `db/migrations/**`) — so it matched nothing, the negation was always true, and restoring the `.tsx`'s old inline style map **verbatim** would have kept the check green. It is now a regex over a whitespace-collapsed copy of the source, keyed on two tells only a re-inlined copy carries (a `CONVERSION_*` style constant declared in the `.tsx`, and `bg-red-100 text-red-700` — the conversion map's rejected colour; the SEND-status map beside it uses `text-red-800`). Proven red by restoring the old map, then restored `cmp`-clean. ⚠️ A blanket `/bg-(emerald|amber|sky|slate)-\d00/` would have been the opposite defect — it matches that send-status map, so negating it is permanently RED. The remaining five source greps were audited: all single-line, and each negated needle is a string the pre-switch code really contained.
- **Two unmapped SHAPES, because one was over-determined.** The `unmapped` fixture set `event_type_id` AND `status` to NULL, so a reader keyed on `status IS NOT NULL` alone passed it by accident. The ingest really produces two shapes ([lib/conversions/build-rows.ts](../../lib/conversions/build-rows.ts)): (a) no mapping rule ⇒ both NULL, and (b) a STATUS-ONLY rule (`MappingRule.eventTypeId` null) ⇒ `event_type_id` NULL with `status = 'approved'`. Shape (b) is the dangerous one — a status-keyed reader counts it as real money. Both are fixtures now, and neither is a purchase, in approved or pending revenue, a `sale`-weight candidate, or rescued into `counted_clickers`. A status-only variant of the predicates turns exactly those assertions red (14 failures).
- **A mapped type with a NULL status is reachable, and now has a colour.** `build-rows` sets `status: mapping?.status ?? null` while the upsert keeps `event_type_id` sticky (`COALESCE(conversion_events.event_type_id, excluded.event_type_id)`), so an unrecognised Keitaro status on an already-mapped event leaves the type set and nulls the status. `conversionBadgeClass` returned **no class at all** for that row; it now returns `CONVERSION_STATUS_UNKNOWN_STYLE` (neutral + ring — distinct from the plain unmapped badge, never a purchase colour), which is also the fallback for any status the map has not been taught. Fixture `mapped_status_null` covers it, and counts as nothing in every reader.
- **An uncounted amount says so.** The badge printed a bare `· $55.00` on money no report counts. `conversionAmountLabel()` ([lib/conversion-badge.ts](../../lib/conversion-badge.ts)) renders `· $55.00 uncounted` when the row cannot be placed (unmapped type or NULL status) and is the ONE definition used by both the cell and its tooltip. The `$0.00` and rejected suppressions are unchanged.
- **`verify-counted-clickers.ts`'s comment no longer oversells its guard.** It claimed none of the cache's machinery was repeated in the independent recomputation; the rescue half runs the same `stage_sends JOIN rescueSendIds(…)` shape the cache itself runs. The comment now separates the click half (genuinely re-derived: one pass over base tables vs a `DISTINCT ON` + window function + `ON CONFLICT`), the rescue half (same shape — what it still catches is that the check passes NO `window` while the incremental pass narrows by `ce.updated_at`) and the two deliberately shared definitions. The check itself is unchanged.
- **Two loose ends named rather than re-engineered:** `hourlyEtRange` is also the non-hourly `manualRangeRow`'s range (comment added, no rename), and the partner report's `restrict` bound carries a comment saying it is inert by construction and executed by no test — `getPartnerReport` runs against the module-level `db` — instead of a test that could not fail.

## Revenue and EPC (Phase 3 Task 6)

The stage-day projection's `SALES_FILTER` / `REVENUE_FILTER` now read the shared [`lib/sale-attribution.ts`](../../lib/sale-attribution.ts) definitions instead of a type-based literal:

- **Sales** = `purchasedClause()` — a counted PURCHASE event, `pending` or `approved`. A `rejected` conversion is a refund/chargeback/fraud screen and is no longer counted (the old aggregate poll counted every fetched `lead`/`sale`/`rejected` row as a sale).
- **Checkouts** is unchanged — Keitaro's `leads` metric, `keitaro_type = 'lead'` — because `campaign_stages.checkout_click_count` mirrors it and its meaning ("reached checkout") is distinct from "purchased". Phase 5's per-event columns supersede it.
- **Revenue** = `approvedRevenueClause()` — `counts_revenue` events in status `approved` only.
- **`pending_revenue`** (migration 0182) = `pendingRevenueClause()` — the same money in status `pending`. A SEPARATE figure: it rides the funnel tally (`FunnelTally.pending_revenue`) through `stage-funnel.ts` into `/reports` (Overview's `Pending $` column and every By-X tab except Hourly, which does not compute it) and through the stages API (`keitaro_pending_revenue`) into the campaign page (a per-stage cell suffix and a "Pending revenue" totals tile) — never summed into revenue, EPC, sales CR, ROI or profit.
- **This also closes Rule F's numerator/denominator window** (§ Per-recipient reporting readers, and [epc-denominator.md](epc-denominator.md) §2): the numerator (this projection) and Rule F's rescue (`lib/reporting/counted-clickers.ts`) now read the same purchase/revenue definitions, so a rejected or unmapped conversion can never put revenue in the numerator while its recipient sits outside `counted_clickers`.

Zero numbers moved at cutover: the corpus held 0 pending and 0 rejected conversions.

⚠️ **The zeroing UPDATE's "explained" test must name ALL FOUR written columns** (review fix, 2026-09-18). Before Task 6 `SALES_FILTER` was `keitaro_type IN ('lead','sale','rejected')` — a strict SUPERSET of `CHECKOUT_FILTER` (`keitaro_type = 'lead'`) — so testing `SALES ∨ REVENUE ∨ PENDING` covered the checkout side for free. Flipping `SALES_FILTER` to `purchasedClause()` broke that containment, and a stage-day whose ONLY ledger rows are lead-TYPE **non-purchases** — a $0 registration posted as `lead`, or an UNMAPPED row — had `checkouts` written by the INSERT and zeroed by the UPDATE **in the same run**, then rewritten and re-zeroed on every `*/5` tick forever, dragging `campaign_stages.checkout_click_count` with it. The test is now `SALES ∨ CHECKOUT ∨ REVENUE ∨ PENDING`, i.e. the exact set the INSERT writes from, so the UPDATE is the complement of the INSERT. Zero impact until a registration is mapped — it would have fired on the first one.

**`payout_at_conversion` has a MIXED BASIS**, deliberately unfixed: numerator = APPROVED revenue, denominator = `sales`, which counts pending purchases too. On a row with a held purchase the per-unit rate understates. The column has no reader anywhere in `app/`, `lib/` or `components/`; changing the divisor would rewrite stored values to satisfy nobody. Recorded at the column definition in [`db/schema.ts`](../../db/schema.ts) — any future consumer decides which basis it wants there.

**Rendering rule for held money** (three surfaces, one rule): pending is shown where it EXISTS and reads `—` where it does not — the campaign page's "Pending revenue" tile, `/reports`' totals card (a `Pending $` tile, added 2026-09-18) and the `Pending $` table column all follow it, and the campaign page's per-stage cell appends `· pending $X` only when there is some. And when approved revenue is 0 while pending money exists, **ROI renders `—`, not `-100%`** ([`lib/stage-results.ts`](../../lib/stage-results.ts) `stageRoi`'s third argument): the payout is undecided, not lost, and `-100%` is the number that gets a live campaign killed. Pending is never IN the ratio.

Checks:
- `scripts/test-stage-day-conversions.ts` (camman-v2 only, rolled back) — S2/S3/S4/S5 assert the new sales/checkouts/revenue/payout semantics on a fixture carrying a lead, a sale and a rejected purchase on one stage-day; S5b/S5c/S5d add a `pending`-status purchase to the same day and assert it counts as a sale, is excluded from revenue, and lands in `pending_revenue` alone. **PB1–PB4** hold the zeroing fix: a stage-day whose only ledger rows are a lead-typed $0 registration and an unmapped lead-typed row keeps its `checkouts` across TWO consecutive projection runs (byte-identical, non-zero, second run writes 0 / zeroes 0) and `campaign_stages.checkout_click_count` holds at the same value. Proven RED against the pre-fix filter (4 failed, `rowsWritten: 1, rowsZeroed: 1` on every run).
- `scripts/test-funnel-pending-exclusion.ts` — PURE, no DB. Held money is carried and never spent: a pending-only tally must produce the same `epc`, `sales_cr` and `profit` as a tally with no money at all, and the check is a whole-object diff (every derived field but `pending_revenue`), so a metric added later cannot quietly start spending it. F5/F6 anchor it — the same $500 APPROVED does move EPC and profit — so "nothing changed" cannot pass by the derivation having stopped reading revenue. Proven RED against a `funnel.ts` mutated to fold pending into all three (6 failed), restored `cmp`-identical.

## Who reads `registeredClause()` (Phase 4)

`registeredClause()` ([`lib/sale-attribution.ts`](../../lib/sale-attribution.ts)) is
`event_type_id IN <retarget-signal types> AND status IN ('pending','approved')` —
a counted registration. It had no consumer until Phase 4. It now has three, and
**all three are behavioural; none is a reporting reader.** A registration is not a
sale, not revenue and not a counted clicker, so nothing in
[reports-rollup.md](reports-rollup.md) or [epc-denominator.md](epc-denominator.md)
reads it.

| Consumer | File | What it does with it |
|---|---|---|
| Behavioural tier 3 (the Registered lane) | [`lib/campaign-tier.ts`](../../lib/campaign-tier.ts) — the tier-3 branch of `campaignTierExpr` | The one definition of a Registered lane's audience. **Paired with a `NOT EXISTS` over `PURCHASE_EVENT_TYPE_IDS` at any KNOWN status** (`pending`/`approved`/`rejected`) |
| Drip journey completion | [`lib/drip/lifecycle.ts`](../../lib/drip/lifecycle.ts) — `closeCompletedJourneys()` | Same shape, inlined: the reachability ladder must reach 3 or a registrant's journey never completes |
| Drip end-date expiry | [`lib/drip/lifecycle.ts`](../../lib/drip/lifecycle.ts) — `expireJourneysPastEndDate()` | The second inline copy of the same ladder |

⚠️ **The clause is HALF of a definition, never the whole of one.** "Registered" as
a tier means *registered **and** has not bought* — and a `rejected` purchase
yields no tier row of its own, so `MAX(tier)` alone would read a registrant whose
purchase was rejected as 3. Each consumer therefore carries the explicit
`NOT EXISTS`; see [behavioral-lanes.md](behavioral-lanes.md) and
[07-conventions.md](../07-conventions.md). A future consumer that wants only "a
registration happened" is asserting something different and should say so at the
call site.

⚠️ **An UNMAPPED purchase row does NOT evict a registrant.** The `NOT EXISTS`
requires `pe.status IS NOT NULL`, matching the rule everywhere else in this
codebase — an unmapped row is *stored, alerted, never counted*.

The two `lib/drip/lifecycle.ts` copies exist because they need the tier
**correlated per journey row** (`j.campaign_id` / `j.contact_id`) while
`campaignTierExpr` takes a literal campaign id. They are inline copies, not
imports, and the coupling is pinned by bars `P20`–`P26` in
[`scripts/test-campaign-tier-scale.ts`](../../scripts/test-campaign-tier-scale.ts).

## Per-event report columns (Phase 5 Task 1)

[`lib/reporting/event-columns.ts`](../../lib/reporting/event-columns.ts) turns the
`event_types` registry into a report column set. It is the one place that knows
what such a column set looks like; everything later in Phase 5 consumes it rather
than re-deriving it. **It is inert — nothing imports it yet.**

⭐ **Adding an event type is CONFIG, not code.** Nothing in the module, and
nothing that may consume it, branches on the string `purchase` or `registration`.
Every decision comes off an `event_types` row:

| flag | what it decides |
| --- | --- |
| `is_retarget_signal` | ranks the type ahead of purchases, and makes it the LEFT (denominator) side of a funnel ratio |
| `is_purchase` | makes it the RIGHT (numerator) side of a funnel ratio |
| `counts_revenue` | earns the type a Revenue / Pending $ / EPC column — and only then |
| `display_order`, `key` | break ties, so the order is TOTAL and a re-render cannot shuffle columns |

**Order.** `orderEventTypes()` sorts signals, then everything else, then
purchases, with `display_order` and then `key` as tie-breaks. That deliberately
diverges from `display_order` alone: 0181 seeds `purchase=10, registration=20`,
but the funnel reads registration → purchase. Rather than rewrite the seed and
its copy inside `handle_new_user()` (0183), the class rank leads and
`display_order` only tie-breaks within a class.

**Generated columns**, per type, from `buildEventColumns()`:

- Tier **a** (always visible, the owner's specified list): `evt:<key>:count`,
  `evt:<key>:rate`, `evt:<key>:pending_n`, plus one
  `evtfunnel:<signalKey>:<purchaseKey>` per signal × purchase pair **where the two
  are different types**. A row may carry both `is_purchase` and
  `is_retarget_signal` — no CHECK in 0181 forbids it — and the self-pair
  `evtfunnel:<k>:<k>` would be a "X→X %" column reading `n/n = 1` for every row
  that has one, constant by construction. The generator skips it; the type's other
  pairings still generate, in both directions.
- Tier **b** (behind the Event-breakdown toggle) and only for a `counts_revenue`
  type: `evt:<key>:revenue`, `evt:<key>:pending_revenue`, `evt:<key>:epc`. They
  sit behind the toggle precisely because each duplicates an aggregate column
  already on screen while exactly one `counts_revenue` type exists. Nothing the
  owner named is ever behind the toggle.

⭐ **That tier-B premise is pinned, not assumed.** Bar **R1** in
[`scripts/test-event-columns-db.ts`](../../scripts/test-event-columns-db.ts) fails
the moment a second `counts_revenue` type is configured, in any org, and its
message names what to reconsider. It has to: `REVENUE_EVENT_TYPE_IDS` /
`approvedRevenueClause` ([lib/sale-attribution.ts](../../lib/sale-attribution.ts))
carry **no per-type filter**, so with two revenue types the aggregate these columns
"duplicate" is their SUM and the per-type columns become its only decomposition —
while still hidden behind a toggle.

A non-`counts_revenue` type gets no money column at all: `approvedRevenueClause`
([lib/sale-attribution.ts](../../lib/sale-attribution.ts)) is gated on the same
flag, so its revenue is 0 everywhere by construction, and a permanently-$0.00
column would read as "this earned nothing" rather than "this does not carry
money".

**A type with zero conversions still gets its column and reads 0** — the spec
comes from the registry, not from the data. `visibleEventTypes()` drops a column
only for an **archived** type, and only while no displayed row still carries a
non-zero number for it, so archiving retires a column without erasing history.
The loader deliberately has **no `status = 'active'` filter** for the same reason.

**Headers** are pluralised in the generator and only for the count column
(`Registration` ⇒ `Registrations`); everything else keeps the singular stem
(`Registration rate`). 0181 seeds the labels singular and the same label is what
the campaign-activity badge renders for ONE conversion, where the singular is
right. `pluralizeLabel()` is deliberately dumb and total — `event_types.label` is
`text NOT NULL` with no CHECK and no UI, so it may be empty, an emoji or a
sentence. It does not double consonants (`Quiz` ⇒ `Quizes`) and knows no
irregulars; a label that pluralises badly is fixed with one UPDATE on a config
row, which is the point of a registry.

**Ratios return `null` (rendered "—") over a zero denominator, and are NOT
clamped at 100%.** Both can legitimately exceed 1: the EPC denominator
(`counted_clickers`) rescues purchase- or revenue-bearing recipients only, so a
registrant whose click was never scored human is in the numerator and not the
denominator; and a purchase can arrive with no preceding registration (two
independent postback URLs, or a lost registration postback). Clamping would hide
a real signal behind a plausible number.

**Per-org and cross-org.** `loadEventTypes(dbc, orgId)` reads one org's registry.
`orgId = null` serves exactly one caller — the scheduled Telegram report, which
has no user session and reports the whole business — and merges **by `key`**,
because `event_types.id` is a global serial while the natural key is
`(org_id, key)`. Two orgs' rows for the same key collapse to one spec: lowest
`display_order` wins and carries its label, the flags are OR-ed (a key that
counts revenue in ANY org earns its revenue column) and `archived` is true only
when EVERY org has archived it. Inert today — one org sends tracker traffic — and
stated so it is a rule rather than an accident the second org discovers.

**The all-zero tally is READ-ONLY.** `EMPTY_TALLY` is what a missing key is worth,
it is shared, and it is `Object.freeze`d and typed `Readonly<EventTally>` because
of it: seeding an accumulator with it and then calling `addEventMaps()` used to
mutate that one object process-wide, so an unrelated missing-key cell started
reporting another row's numbers instead of 0 — silently, with every bar green
(found in review, 2026-09-18). `emptyTally()` hands out a fresh mutable zero;
reach for that, never the constant. ⚠️ The **freeze** is the load-bearing half:
TypeScript ignores `readonly` modifiers when checking assignability, so
`Readonly<EventTally>` assigns into an `EventMap` with no error and only rejects a
direct write.

Checks: [`scripts/test-event-columns.ts`](../../scripts/test-event-columns.ts)
(pure, 53 bars; its registry holds a `deposit` type and a second signal that
exist in no database, so a generator that hard-coded the two seeded keys fails)
and [`scripts/test-event-columns-db.ts`](../../scripts/test-event-columns-db.ts)
(16 bars on camman-v2 inside a transaction that always rolls back).

## Per-event storage on the stage-day projection (Phase 5 Task 2)

Migration [`0185_stage_event_breakdown.sql`](../../db/migrations/0185_stage_event_breakdown.sql)
gives the projection somewhere to put the numbers Task 1's generator reads.
Two additive columns on `keitaro_stage_results`, **both inert**: nothing writes
or reads them until a later task.

| column | type | what it holds |
| --- | --- | --- |
| `events` | `jsonb NOT NULL DEFAULT '{}'::jsonb` | the SAME numbers as `sales` / `revenue` / `pending_revenue`, split per `event_types.key` |
| `unmapped_conversions` | `integer NOT NULL DEFAULT 0` | rows on this stage-day the org-scoped `event_types` join could not place: `et.key IS NULL OR ce.status IS NULL`. ⚠️ **Broader than `conversion_events_unmapped_idx`'s predicate** (`event_type_id IS NULL OR status IS NULL`) — see the divergence note under Task 3 |

```json
{"purchase":     {"n": 12, "pending_n": 1, "revenue": 540.0000, "pending_revenue": 60.0000},
 "registration": {"n": 40, "pending_n": 0, "revenue": 0.0000,   "pending_revenue": 0.0000}}
```

`n` counts status `pending` + `approved`; `pending_n` is a SUBSET of `n`, never
added to it; the two money fields exist for `counts_revenue` types only and are 0
elsewhere by construction. The projection writes them (Task 3, below) in the same
`INSERT … ON CONFLICT` as the scalars, from the same single pass over the ledger.
⚠️ **The scalars are the sum of this object's entries PLUS a residual, and the two
CAN differ** — an earlier version of this line said they could not. See the
corrected identity under Task 3.

Four decisions worth not re-litigating:

- **Keyed by `key`, never `id`.** `event_types.id` is a global serial while the
  natural key is `(org_id, key)` (`event_types_org_key_uniq`, 0181), and the one
  cross-org reader — the scheduled Telegram report — needs a key that means the
  same thing in two organizations.
- **`unmapped_conversions` is a scalar OUTSIDE the object**, deliberately: inside
  it, some future loop over `events` would sum it into a total, and an unmapped
  conversion must count as nothing everywhere. Keeping it out makes that
  structural rather than a convention.
- **No index.** The table is read by `(org_id, stage_id, stat_date)` and
  `(campaign_id, stat_date)`, both already indexed, and neither new column is ever
  a predicate. A GIN index on `events` would cost writes on every 5-minute tick.
- **Existing rows get `'{}'` / `0`** and stay empty-but-not-null until the
  projection next covers their stage — the same catch-up `pending_revenue` (0182)
  had.

⚠️ **The money inside the object is a JSON number, not a string.** See
[07-conventions.md](../07-conventions.md): `jsonb` keeps the numeric's scale
(`540.0000`) and postgres-js `JSON.parse`s the column, so a reader gets a **number**
there and a **string** from a top-level `numeric` column — which is exactly why
`parseEventMap()` takes both and neither of its branches is dead. That claim is now
measured against the real column (bars S13–S15) instead of a hand-built object.

Checks:
[`scripts/test-stage-event-columns-db.ts`](../../scripts/test-stage-event-columns-db.ts)
— 18 bars on camman-v2 inside a transaction that always rolls back. S1–S7 read the
catalog; **S8/S8b replay the migration's own statements, read off disk, over three
rows that predate them** (the live table is empty on preview, so the obvious
"no row is NULL" bar would have passed for the wrong reason) and prove the file
re-runnable; S9 covers a new row; S10–S15 the round trip including exact
`numeric(12,4)` money at `1234567.8901` and `0.0001`; S16/S17 that the probe was
rolled back, the second asking the DATABASE rather than this process.

## The projection writes the per-event block (Phase 5 Task 3)

[`lib/keitaro/stage-day-conversions.ts`](../../lib/keitaro/stage-day-conversions.ts)
now groups its single pass over `conversion_events` **one level finer** — by
`event_types.key` — in a `per_event` CTE, and rolls it back up in a `ledger` CTE
that builds the `events` object with `jsonb_object_agg`. The scalars and the
object come out of the SAME statement, so there is no second statement to drift
from. Still **inert for the UI** — nothing selects the two columns yet.

⚠️ **THE FOOTING IS AN IDENTITY WITH A RESIDUAL, NOT "THE SCALARS ARE THE SUM".**
`db/schema.ts`, migration 0185's header and the CHANGELOG all said the scalars
were *literally* the sum of the object's entries and "the two cannot drift"
(corrected 2026-09-19; the migration file's header is left alone deliberately, see
below). They can, and the difference is designed in: `sales` / `revenue` resolve
`is_purchase` / `counts_revenue` through the **non-org-scoped**
`PURCHASE_EVENT_TYPE_IDS` / `REVENUE_EVENT_TYPE_IDS` subqueries
([lib/sale-attribution.ts](../../lib/sale-attribution.ts)) while the per-event
entries come from the **org-scoped** join, so a ledger row carrying another org's
`event_type_id` is counted by the scalar and placed under no key. What holds is

```
sales   = Σ entries[t].n over is_purchase types + strays
revenue = Σ entries[t].revenue                  + stray revenue
```

with the strays reported in `unmapped_conversions`. Bars **P23c / P14b** assert it
WITH the residual and **P23d / P14c** pin the residual **non-zero** (1 row / $70)
against a fixture, so neither can start passing because the residual quietly went
to 0. ⇒ **A screen must not render `events` as an explanation of the Sales number
without showing `unmapped_conversions` beside it**: on a stage-day with a stray
they do not add up, and that is correct.

⚠️ **`unmapped_conversions` and the Telegram alert disagree by the stray, on
purpose.** The column keys on the JOIN RESULT; `lib/conversions/monitor.ts`'s
`unmapped` / `status_only_unmapped` combos key on the RAW columns, because that is
what `conversion_events_unmapped_idx` is predicated on and what keeps those reads
index-only however large the ledger grows. So a cross-org `event_type_id` appears
in the column and **not** in the alert. The column is the more truthful of the two;
reconcile by teaching the monitor the join (and paying for it), never by narrowing
the column back to the raw predicate. Zero such rows in production today. The note
is carried at both definitions so neither side gets "fixed" into agreement.

📌 **Migration `0185_stage_event_breakdown.sql`'s header still carries the old
claim, and is deliberately not edited.** The file is already applied on camman-v2
and drizzle records a hash of its content; editing even a comment changes that
hash, which is a false "drift" for `scripts/verify-migration-integrity.ts` and
makes `PgDialect.migrate` treat it as unapplied. The authoritative text is
`db/schema.ts` + this page.

The two CTEs are separate because there is no `min(jsonb)`/aggregate-of-aggregate
shortcut: the scalars group in `per_event`, the object builds in `ledger`, and
the join happens after grouping.

Four things that are load-bearing rather than stylistic:

- **The `event_types` join carries `org_id` as well as the id, and it is a LEFT
  JOIN.** `event_types.id` is a global serial; joining on the id alone would let
  one org's registry name another org's column. LEFT, because an UNMAPPED row has
  to REACH the statement: it lands in the `event_key IS NULL` group, is counted
  into `unmapped_conversions`, and is FILTERed out of the object — stored,
  surfaced, counted as nothing.
- ⭐ **The unmapped bucket keys on the JOIN RESULT (`et.key IS NULL`), not on the
  raw column (`ce.event_type_id IS NULL`).** `purchasedClause` resolves
  `is_purchase` through a **non-org-scoped** subquery while this join is
  org-scoped, so a ledger row carrying ANOTHER org's `event_type_id` — which the
  FK permits, there being no composite `(id, org_id)` FK — would otherwise be
  counted in `sales`/`revenue`, placed in no `events` entry, and counted unmapped
  nowhere: invisible on every surface Phase 5 adds, including the badge that
  exists to reveal exactly that. Keying on `et.key` makes the two buckets a
  **partition** — every ledger row on a stage-day is PLACED or UNMAPPED, never
  both and never neither.
- **An all-zero entry is omitted from the object**, so a stage-day whose only row
  is a rejected purchase reads `'{}'` rather than a row of zeros that looks like a
  configured-but-idle event type.
- **The upsert's `WHERE` gained both columns.** Without them a stage-day whose
  SCALARS did not move but whose BREAKDOWN did — a registration arriving where a
  purchase already sat, a mapping healing an unmapped row — would never be
  rewritten and the new columns would freeze at their first value.

⚠️ **The zeroing anti-join widened from "no row that makes a number" to "no row at
all", and that is not tidying.** Every ledger row now makes a number: a counted
event of ANY type lands in `events`, an unmapped row lands in
`unmapped_conversions`. Left as the four-filter list it was, a stage-day whose only
conversions are REGISTRATIONS satisfies "nothing here" and the UPDATE would wipe a
non-empty breakdown on a day the ledger fully explains. The widening strictly
REDUCES the set of rows the statement touches, so it can only preserve a value,
never invent one; the one shape it stops zeroing — a day whose only rows are
rejected — needs no zeroing, because the INSERT already writes an all-zero row for
it. `SET` and the change test gained `events`/`unmapped_conversions` with it.

⚠️ **`readProjectionCoverage`'s `ledger_behind_history` probe learned the two
columns in the same commit.** It asks whether `keitaro_stage_results` still
REPORTS a conversion older than the ledger reaches; without the two new disjuncts a
historical stage-day carrying only registrations, or only unmapped rows, could
never trip the global refusal and the projection would happily zero it. Moot on day
one (every pre-0185 row is `'{}'` / `0`) and asymmetric for ever after. **The other
two bounds — the empty-ledger refusal and the per-stage coverage floor — are
untouched**, and all three are red-proved against this version of the file.
📌 Its cost note was wrong and is corrected (2026-09-19): the `stat_date < ledger_floor`
range is **a sequential scan plus filter**, not an index probe.
`keitaro_stage_results_campaign_date_idx` is `(campaign_id, stat_date)` and
`keitaro_stage_results_stage_date_uniq` is `(org_id, stage_id, stat_date)` — `stat_date`
leads neither, so nothing serves the range. Cheap at ~17.6K rows, which is why no index
is being added, but it is a scan and it grows with the table.

Checks:
[`scripts/test-stage-day-conversions.ts`](../../scripts/test-stage-day-conversions.ts)
— **119/0** on camman-v2 inside a transaction that always rolls back (70 before 0185, 108 before the resync bars).
Eleven one-sided fixtures, **each on its OWN `stat_date`** so no shape can be read
through another: registration-only; approved / pending / rejected purchase each
ALONE; one deliberate mixed day; all three unmapped shapes (no type + no status, no
type + a real status, a mapped type + a NULL status); a **cross-org
`event_type_id`**; and a THIRD event type (`deposit`) that exists in no other
database, which goes red if any key is hard-coded. Plus the partition bars, the
footing identity `sales = Σ (is_purchase) n + strays` with `strays` computed
independently and made **non-zero (1)** by the cross-org fixture, its money twin
`revenue = Σ per-event revenue + strays` (**$70**), a flat independently-shaped
recomputation of every scalar, `parseEventMap` against a REAL jsonb row, and the two
`ledger_behind_history` bars. **R0–R10 (added 2026-09-19)** run
`readStageDayResyncDiff` and `syncStageDayConversions` against ONE world and require
the changed-row sets to match in both directions: R0 pins an empty diff on an
already-projected scope, then six one-sided breakages (a pre-0185 row whose scalars
are right and whose breakdown is empty, an `unmapped_conversions`-only difference, a
`pending_revenue`-only difference, a rejected-purchase day carrying the pre-Task-6
sale count, and two covered days the ledger cannot explain whose only content is one
of the two new columns) make R1/R2 non-vacuous at six rows a side. **P12 now reads
its `is_purchase` key set from the registry** instead of testing `k === "purchase"`,
and **P23 names the stored day it requires to be unexplained** rather than relying on
`every` over a possibly empty array. Six red proofs, each restored byte-identically
(`cmp` + md5): the raw-column unmapped predicate loses the cross-org row from both
buckets (P18, P23b); the old zeroing anti-join wipes a registration-only day (P1,
P3, P6); an inner join loses every unmapped row (12 bars); dropping `counts_revenue`
from the per-event revenue filter breaks the corpus footing (P14b); dropping the
per-stage floor zeroes stage Y's protected row (C1b); and defeating the
empty-ledger test lets an empty ledger proceed (C1c).
[`scripts/test-ledger-predicates.ts`](../../scripts/test-ledger-predicates.ts)
**17/0** — P16 asserts `purchasedClause()` still CONTAINS `countedClause()`, so the
status rule cannot separate into two copies.

## The report tables render the generated columns (Phase 5 Task 5)

**This is the first task of the phase that is on a screen.** Both report tables —
the Overview tab ([`components/reports/keitaro-report.tsx`](../../components/reports/keitaro-report.tsx))
and the five performance tabs
([`components/reports/performance-report.tsx`](../../components/reports/performance-report.tsx))
— now render a column per event type, GENERATED from the registry the API
returns. Both endpoints emit `event_types` (the `EventTypeSpec[]` from
`loadEventTypes`) beside the rows; `/api/reports/performance` emits it on **all
three** response bodies, including the two `dimension=creative` ones, which serve
no screen — see "Why the creative bodies keep the registry" below.
`/api/keitaro/reports` reads it **in parallel with the funnel** (one
`Promise.all` beside `getStageMetricsInRange`): it depends on nothing that read
produces, and awaiting it at the response literal added a round trip to a request
that already carries a multi-second aggregate.

The shared client half is
[`components/reports/event-columns-view.tsx`](../../components/reports/event-columns-view.tsx):
`eventColumnBlock()`, `fmtEventCell()`, `sortColumnOrFallback()` and
`EventColumnsBar`. Both tables build their column list from it, so they cannot
disagree about what a "Registrations" column is.

**Rendered order.** The generated block is spliced in **after `Redir %` and
before `Sales`**, found by the neighbouring column's *id* rather than by an index,
so the row reads as one funnel and no existing column moves relative to its
neighbours. With production's registry (migration 0181: `purchase` =
is_purchase + counts_revenue, `registration` = is_retarget_signal) the block is
seven columns: Registrations · Registration rate · Registration pending ·
Purchases · Purchase rate · Purchase pending · Registration→Purchase %.

**Tier A is always visible; the toggle governs only tier B.** Tier B is the three
per-event money columns of a `counts_revenue` type (Purchase $ · Purchase pending
$ · Purchase EPC), each of which duplicates an aggregate column already on screen
while exactly one revenue type exists. Everything the owner named is visible
without the toggle: the aggregate `Revenue`, `Pending $` and `EPC` /
`EPC (all time)` columns were already default-visible, and the generated counts
and rates are tier A. The toggle is per-browser (`showEvents` in the persisted
filters), off by default.

⭐ **The toggle's governed count is computed with a literal `true`, never with
the toggle's own state.** A state-dependent count reads `0` while the toggle is
ON, which trips `EventBreakdownToggle`'s `count === 0` early return, unmounts the
control and leaves tier B switched on with no way to switch it off. Task 5 made
that unrepresentable by giving `tierBColumnCount()` no `showTierB` parameter;
`eventColumnBlock()` has to see the toggle (the columns depend on it), so the
property is now held by **bar W12**, which builds the block twice — once with the
toggle on, once off — and fails if the two counts differ. The old W12 compared
one call with a second call on the same arguments and could not fail; it was
red-proved by making the count follow `showEvents` (it reads `off=0 on=3`).

⭐ **A persisted sort can name a column the registry no longer has.** `sortBy`
lives in `localStorage` while a generated id (`evt:<key>:<kind>`) belongs to a
registry row that can be archived or configured away. The id then matches no
column, every comparison ties, and the table renders in API order with no arrow
anywhere — which looks exactly like a sorted table.
`sortColumnOrFallback(columnIds, persisted, fallback)` falls back to the
dimension's default column instead, and the sort INDICATOR reads the effective
sort, so the arrow sits where the ordering actually is (bars W22/W23). Server
side the same class is handled by `eventColumnById()` rejecting a key that the
`event_types_key_format_check` constraint could never hold (bars B6/B7): the
Overview route accepts a sort id by SHAPE, so a parse is an acceptance, and
`evt:PURCHASE:count` used to be accepted and sort every row on 0. Rejected, the
route falls back to `revenue`, which is visible.

⭐ **A fetch error clears the response.** The error block replaces the table, but
the stat cards and the unmapped badge sit ABOVE it, so a failed fetch used to
leave "12 unmapped" and a full set of totals beside "Couldn't load report",
describing a range the screen is no longer showing. Both tables now drop the
stale response with the error; Retry refills it.

### ⭐ The unmapped badge cannot be hidden while the breakdown is shown

A screen may not present the per-event breakdown as an explanation of `Sales`
without the unclassified count beside it. `sales` and `revenue` resolve their
flags through non-org-scoped id lists while the `events` entries come from an
org-scoped join, so a cross-organisation event type is counted by the SCALAR and
placed under no key — it surfaces only as `unmapped`. The invariant the table
must keep honest is

```
sales = Σ over is_purchase types of events[key].n  +  manual_topup  +  strays
```

so a readable breakdown beside an unreadable stray count silently under-explains
its own total.

That is wired **structurally, not by convention**: `EventBreakdownToggle` and
`UnmappedBadge` are **not exported**. The only export is `EventColumnsBar`, which
renders both, so a surface that wants the toggle takes the badge with it. Tier A
is always rendered, so "the breakdown is shown" is true on every tab, and the bar
is mounted unconditionally beside the filters — never inside a `showEvents`
branch, and **outside the empty state**, because a wholly unmapped conversion
resolves to no stage, appears in no row, and can therefore exist in a range whose
table is empty. (On a fetch ERROR the response is cleared, so there is nothing
left to under-explain and the bar renders nothing.)

**…and the COLUMNS cannot be obtained without it either (review fix,
2026-09-19).** Task 5 still exported the column builder on its own, so a new
table could render tier-A per-event columns and simply never mount the bar, and
`unmapped` was a number the caller assembled — it could differ from the response
the columns came from, or be `0`. Both holes are closed:

- `eventColsFor()` and `tierBColumnCount()` are **module-private**. The one entry
  point is `eventColumnBlock(spec, rows, totals, showEvents)`, which returns
  `{ columns, bar }` from ONE call over ONE `totals`, and `EventColumnsBar` takes
  the whole `block` rather than four loose numbers. `bar.unmapped` is read off
  the same `totals` the columns were built from, so the residual always describes
  the response on screen. Bar **W16** now also asserts that neither builder name
  is exported.
- Mounting the bar is the one step left to the caller, and it is held by a
  **discovered** gate rather than a list: bars **X8–X11** walk every `.ts`/`.tsx`
  under `app/` and `components/`, classify a file as a per-event surface if it
  calls any column builder, and fail if such a file mounts none of
  `<EventColumnsBar>` / `<StageEventBreakdown>` / `<EventTotalsTiles>`. A table
  written tomorrow is covered the day it is written. X8 is the positive control
  (a scan that finds nothing fails THERE, not vacuously in X9), X10 controls the
  classifier's discrimination, and X11 checks every needle separately against a
  hand-written sample of the call it names — added because a dead
  `buildEventColumns(` needle survived X8, X9 and X10 in the red proof.

This is a gate, not a type: a structural version (a context provider, or a
render-prop that hands the columns out only inside the bar's subtree) would mean
splitting both 500–800-line report components across a hook boundary, since the
columns are consumed inside `useMemo`s that sort and splice them. That was judged
a disruptive rewrite for a property a scanning gate already holds, with the
export shape doing the rest.

The badge renders nothing at zero (a permanent "0 unmapped" chip is furniture).
It carries an explanatory `title` and **no link**: `conversion_event_mappings`
has no admin screen yet. Give it an `href` the day that page exists.

### Why the creative bodies keep the registry

`dimension=creative` (both the ranged body and `range=lifetime`) is operator-API
only — `API_ONLY_DIMENSIONS`, no Reports tab — so its `event_types` serves no
screen. It is **kept deliberately**, and the reason is the same one that makes
the breakdown worth having: its rows carry `events` and `unmapped` like every
other dimension, and a key is not a label. Without the registry a client holds a
map of `event_types.key` it cannot name, order, or tell "counts revenue" from
"signal" — and this is the one dimension whose consumer has no UI to fall back
on. Documented for consumers in [operator-api.md](../operator-api.md) under
"Creative bank".

### Hourly had two answers for pending money — FIXED 2026-09-19

On `dimension=hourly` the SCALAR `pending_revenue` used to be set to `0` by hand
([`lib/reporting/performance-report.ts`](../../lib/reporting/performance-report.ts),
the hourly row map) because hourly never ran a pending query — a NOT-COMPUTED
sentinel, not a measurement. Meanwhile `ledgerHourEventQuery()` **did** compute
`pending_n` and `pending_revenue` into `m.events`, off `conversion_events`,
bucketed on the same `ce.occurred_at` ET hour as hourly's own `sales` and
`revenue`. Nothing rendered the scalar, so nothing on SCREEN was wrong — but the
API body said `totals.pending_revenue: 0` beside a non-zero
`events[k].pending_revenue`, and no consumer could tell that 0 from a real one.

**Fixed in the aggregation layer: the scalar is now computed.** `getHourlyReport`
runs a pending series off the same ledger, the same hour bucket and the same
shared clause family as its approved revenue — `pendingRevenueClause()` beside
`approvedRevenueClause()` — so the two answers agree by construction and a zero
is always a measured zero. It is defined exactly as its stage-path twin, so
`pending_revenue = Σ events[k].pending_revenue + cross-org strays` holds on
hourly as it does on the projection.

The hourly tab still renders no pending COLUMN (its columns are activity-time
rates); that is now a display choice with no bearing on the payload's
consistency. Bars: **R13** (a fixture hour with `$40` held and `$0` approved),
**R13b** (scalar = Σ map, on every row and the totals, with an explicit
non-vacuity clause), **R13c** (held money is not revenue) in
[`scripts/test-report-event-columns-db.ts`](../../scripts/test-report-event-columns-db.ts),
plus **W19**, a cheap source bar that fails if the literal override comes back.

Related, fixed at the same time: the hourly path used to emit **all-zero**
per-event entries where the stage-day projection FILTERs the key out entirely (a
type whose rows in the hour were all rejected). It now applies the same test — in
JS, after the row's `unmapped` count is taken, since that count comes off the
same rows — so identical data yields identical keys on both paths (bar **R14**,
one-sided against R9). The rendered column set already agreed either way, because
`visibleEventTypes()` keys on a non-zero field rather than on key presence (bar
**W21**, one-sided against W4), which is exactly why the payload disagreement was
invisible.

### Nothing may name an event key

[`scripts/test-reports-no-hardcoded-event-keys.ts`](../../scripts/test-reports-no-hardcoded-event-keys.ts)
is the gate on the phase's central claim, over 20 files — all four rendering
surfaces plus everything between the registry and them (Task 6 added
`lib/reporting/stage-keitaro-aggregate.ts`). Three needles per key
(quoted literal, dot/optional-chain property access, and object-literal key or
generated-id segment), matched against **whitespace-collapsed** source so CRLF
and LF files are treated alike and no needle can contain a newline it would never
find. Comments are stripped first, so prose may name the keys freely. `\b` on the
property and key needles is load-bearing in both directions: it spares
`t.is_purchase` and `is_purchase:` — the registry FLAGS every module here is
supposed to read — and G0g pins that it also spares `repurchaseRate`.

Bars **G0a–G0h** are negative controls on the matcher itself, because every other
bar asserts an ABSENCE and a typo in a regex would make them all pass. **G1**
fails when a listed path does not exist, so a renamed module cannot drop out of
coverage silently. **G3b** keeps any rendering surface from fetching
`/api/keitaro/results`, whose explicit projection omits `events` — its `{}` means
"not selected", not "zero of everything" — with G3a as the positive control.

⭐ **G1 alone is one-directional, which is how a producer goes missing (review
fix, 2026-09-19).** It proves every LISTED file exists and says nothing about a
file that exists and is not listed — which is exactly what
`lib/reporting/stage-keitaro-aggregate.ts` was until a reviewer added it by hand.
**G1b** walks `app/`, `lib/` and `components/` and fails on any module that
imports `@/lib/reporting/event-columns` or names the `unmapped_conversions`
column while being in neither `FILES` nor the (deliberately tiny, documented)
`EXEMPT` list. Both needles are CODE — an import specifier and a SQL identifier —
and comments are stripped first, so prose about the breakdown drags nothing in.
**G1c** is its positive control: the walk must still reach the known producers,
or a scanner pointed at the wrong root would report "nothing missing" forever.
Red-proved with a new unlisted producer in BOTH line endings, and with the
discovery needles broken (G1b then passes over 0 files and G1c is what fails).

Deliberate omissions: `lib/sale-attribution.ts` (the ledger's definition file,
whose frozen legacy section quotes `'lead'`/`'sale'`) and everything under
`scripts/` (the tests MUST name keys — that is how they assert).

## The campaign page splits its Results cell and its totals (Phase 5 Task 6)

The stages table on `/campaigns/[id]` now carries the same split, generated from
the same registry. `GET /api/campaigns/[campaignId]/stages` returns
`event_types` once per response (`loadEventTypes`) and, per stage,
`keitaro_events` + `keitaro_unmapped` beside the existing `keitaro_sales_count` /
`keitaro_revenue` / `keitaro_pending_revenue`.

**The Results cell** reads
`Clicks: … · Checkout: … · Registrations: N · Purchases: M · [⚠ K unmapped ·] Sales: … · CTR: … · OptOut: …`
— the generated segments spliced between `Checkout` and `Sales`, and the stray
marker immediately after them, beside the numbers it is about. **`Checkout` stays
and is NOT the registration segment**: it is `keitaro_type = 'lead'`, which means
a registration for one network and a paid purchase for two others (0181's mapping
seed). The registry-driven counts land beside it, and where the two disagree that
disagreement is the point. Retiring `checkout_click_count` is a separate card —
it is hand-editable (`manual-results-form.tsx`) and exact-mirrored from the
projection every five minutes.

**The totals card** gains one `TotalsMetric` per event type after `Sales`, plus
the shared unmapped badge. The tiles reflow in the existing responsive grid, so N
types need no layout change.

**Both residuals, not one (2026-09-19).** Sales on both surfaces is
`max(manual tally, tracker)` per stage while the segments and tiles count TRACKER
events only, so a hand-entered sale was in the total and in nothing that explains
it — a second residual, invisible where the first one was already guarded. The
line now carries `Manual: +N ·` and the card a `Manual tally` tile, from the same
component and the same object. The number is `manualSalesTopup()`
([lib/stage-results.ts](../../lib/stage-results.ts)), defined THROUGH
`combineSales()` so "what Sales carries that the tracker did not report" cannot
drift from the rule that produced Sales. Bars **X4b–X4d**, **X5b/X5c**.

**And the figures come from ONE source object.** `StageEventBreakdown` /
`EventTotalsTiles` take a single `source: EventBreakdownSource`
(`{ events, unmapped, manual_topup }`, every field required) instead of three
loose props — the same fix `eventColumnBlock()` made for the report tables, where
a caller could pass a residual belonging to a different response. `stageEventSource(stage)`
is the one adapter, reading all three off one row. Bar **X7b** pins the call
sites; the required fields are what tsc enforces.

**Both surfaces come from `components/reports/event-columns-view.tsx`** —
`StageEventBreakdown` and `EventTotalsTiles`, each rendering its figures AND its
residual, neither half separately exported. See
[07-conventions.md](../07-conventions.md) for why that is structural rather than
conventional, and bars **X1–X7** of
[`scripts/test-event-columns-view.ts`](../../scripts/test-event-columns-view.ts).
A configured type with zero conversions renders `Purchases: 0`, never a blank
(`visibleEventTypes` keeps active types and drops an archived one only once no
stage on screen has a non-zero entry for it). The cell's `hasResults` test now
includes `keitaro_events` / `keitaro_unmapped`, so a stray cannot be swallowed by
the em dash on an API-sent stage whose `sms_count` is 0.

### The stage aggregate: no aggregate over jsonb, ever

The endpoint's single grouped `keitaro_stage_results` query moved to
[`lib/reporting/stage-keitaro-aggregate.ts`](../../lib/reporting/stage-keitaro-aggregate.ts)
(`getStageKeitaroTotals`) so its bars can execute the REAL statement without
standing up `requireApiMembership` and the auth chain — a bar that retypes a query
proves only that the typist agreed with themselves. It is still ONE query keyed on
`campaign_id`, served by `keitaro_stage_results_campaign_date_idx`.

Its shape is load-bearing:

- **The scalars are grouped in their own CTE (`scal`), off `ksr`** — never off the
  `jsonb_each` lateral. `jsonb_each('{}')` yields NO rows, so a stage with clicks
  and no conversions would vanish entirely and its cell would read as *no data*
  rather than *no conversions* (bar **K2**).
- **The per-event object is re-aggregated separately (`ev` → `ev_obj`) and
  LEFT JOINed back.** jsonb has no `sum()`, and it has no `min()`/`max()` either:
  PostgreSQL defines those for `anyarray`, `anyenum` and the scalar types only,
  with no implicit `jsonb → text` cast, so `min(o.events)` fails at EXECUTION time
  with `42883 function min(jsonb) does not exist` (bar **K5**, red-proved).
- **`pending_revenue` (0182) stays among the scalars.** It feeds the per-stage
  `pending $…` segment and the "Pending revenue" tile, and deleting it is SILENT —
  the figure simply becomes 0. Bar **K4** is the one that notices; K1/K2/K3/K5 all
  stay green without it.

Bars **K1–K5** in
[`scripts/test-report-event-columns-db.ts`](../../scripts/test-report-event-columns-db.ts)
run against a throwaway org on camman-v2, with stage A's event key spread over
**two** `stat_date`s (2 + 3) and its strays over the same two days (1 + 2) — a
one-day fixture would pass against an aggregate that merely picked one row's
object. The second day sits OUTSIDE the range the R bars read, so the same
fixture cannot move them.

## `/creatives` gains per-event counts beside Checkout Rate (Phase 5 Task 7)

**Why this screen, when an earlier draft excluded it.** `CHECKOUT_FILTER` in
[`lib/keitaro/stage-day-conversions.ts`](../../lib/keitaro/stage-day-conversions.ts)
is `ce.keitaro_type = 'lead'` — the only conversion metric in the product keyed
on a RAW tracker type. On most of this account's networks `lead` is a paid
purchase; on one it is the free registration. `/creatives` shows that number as
**"Checkout Rate"** and creatives are **sorted and ranked by this table**, so on
that offer the screen has been ranking by free signups with nothing beside it to
disagree. The exclusion rested on a factual error — that a per-event count here
would need a new data source. It does not: `computeCreativeMetrics`'s `k_stage`
CTE already reads `keitaro_stage_results`.

**Counts only.** No per-creative rate, revenue or EPC split. The money split
belongs on the reports' `dimension=creative`, which has a denominator and a range
picker; this table is already ~20 columns wide.

| Layer | What it does |
| --- | --- |
| [`lib/creatives/metrics-cache.ts`](../../lib/creatives/metrics-cache.ts) | `k_stage_ev` unrolls `keitaro_stage_results.events` per stage; `creative_ev` rolls it to the creative and emits one `jsonb_object_agg` per creative. `k_stage` also sums `unmapped_conversions`, which `stage_agg` carries as `unmapped`. `CreativeMetricsRow` gains `events: EventCountMap` and `unmapped: number`. |
| [`app/api/creatives/list/route.ts`](../../app/api/creatives/list/route.ts) | `events jsonb, unmapped int, manual_topup int` on the `jsonb_to_recordset` column list; `events` / `unmapped` / `manual_topup` on the `metrics` object; `event_types` at the top level of the response. `RATIO_SQL` is untouched — no new ratio is computed. |
| [`app/(protected)/creatives/page.tsx`](../../app/(protected)/creatives/page.tsx) | One generated column per event type, spliced **immediately after `checkout_rate`**, through `eventCountColumns()`. |

### ⭐ The 30-day window is copied from `stage_agg`, deliberately

`creative_ev`'s inner select carries `cs.created_at >= now() - interval '30 days'`
because the column it sits beside — "Checkout Rate", whose numerator is
`stage_agg.checkouts` — has exactly that bound. Two different windows would make
the comparison the columns exist to enable meaningless. The residual rides
`k_stage` into `stage_agg` for the same reason: it is bounded by the very
aggregate it qualifies. Bars **C3** and **C6**.

### ⭐ A count-only grain gets its own type, and its own renderer

`EventCountMap` (`Record<string, number>`,
[`lib/reporting/event-columns.ts`](../../lib/reporting/event-columns.ts)) is
deliberately narrower than `EventMap`: carrying the four-field tally here would
hand a later reader `revenue` fields that were never summed at this grain and
read as a measured $0.00.

`visibleEventTypesByCount()` is now the primitive and `visibleEventTypes()` the
wrapper, so "which types are on screen" has ONE definition across both grains.

The screen cannot mount `EventColumnsBar` (its toggle governs per-event money
columns this screen does not have), nor `StageEventBreakdown` / `EventTotalsTiles`
(a `·`-joined line and a tile grid, not a column set). So the RULE carries over
rather than the markup: **`eventCountColumns()` returns the count columns and
BOTH residual columns in ONE array**, and no half is separately exported. Each
residual column appears only while some row on the page has one — the same
"nothing at zero" rule `UnmappedBadge` renders by — and the stray column stays
LAST, because it is the one the operator can act on. Bars **Y1–Y9b**; the scan
bars **X8–X12** discover the surface rather than listing it (`eventCountColumns(`
is in BOTH the builder and the residual needle lists, because a file that calls
it has discharged the rule by construction).

**`Manual`, the second residual (2026-09-19).** This table shows
`Sales = max(manual tally, tracker)` per stage while its counts are tracker-only,
so manual sales — which exist in production today — were in Sales and in no
column. `manual_topup` is summed in `stage_agg` as
`greatest(cs.sales_count - coalesce(ks.sales, 0), 0)` over the SAME 30-day
stages, travels the recordset and the response beside `events`/`unmapped`, and
renders as its own generated column. Bars **C13/C13b** — the second foots the row
identity `Σ (is_purchase) counts + manual top-up + strays = Sales` with all three
parts non-zero.

⚠️ **And the residual fields are REQUIRED on `EventCountRow`, not optional.**
With `unmapped?: number`, a caller mapping its rows to `{ events }` rendered the
counts with no residual column at all — the column is emitted only when some row
HAS one, so a row shape that cannot carry one suppresses it silently — and it
compiled clean and left every scan bar green. Bar **Y9** asserts the
DECLARATION, because an optional field is not something tsc can fail.

### ⚠️ `jsonb_each` on a non-object kills the whole statement

`jsonb_each` raises **22023** on a jsonb scalar or array, and the error is not
scoped to the offending row — it aborts the statement, so ONE malformed stage-day
row would blank every number on `/creatives` for the entire org. `events` is
`jsonb NOT NULL DEFAULT '{}'` with **no CHECK constraint** (migration 0185), so
object-ness is a convention of the writer, not a guarantee of the database —
which is why `parseEventMap()` already defends against the same shapes in JS.
`k_stage_ev` therefore filters on `jsonb_typeof(ksr.events) = 'object'`. Found by
opening the page, not by reading the code: a hand-written fixture stored a JSON
string and the creatives list 22023'd on the spot. Bar **C11**.

The other two `jsonb_each` readers of that column —
[`lib/reporting/stage-keitaro-aggregate.ts`](../../lib/reporting/stage-keitaro-aggregate.ts)
`ev` (Task 6's stages aggregate, where the same row would have blanked every stage on a
campaign page) and [`lib/reporting/attribution.ts`](../../lib/reporting/attribution.ts)
`ev` (Task 8's Telegram rollup, where it 500s the cron every hour) — carry the
same guard. Bars **K6** and **T19** cover them.

⭐ **The VALUE level is a second, identical hazard (2026-09-19).** The guard above
is about the top level. `{"k":"abc"}` IS an object, so it passes — and
`(e.value ->> 'n')::numeric` then raises **22P02**, also statement-wide. All three
readers take their numbers through `eventNum()`
([lib/reporting/event-columns.ts](../../lib/reporting/event-columns.ts)): a JSON
number or a strict numeric string is used, anything else reads 0 for that field
only. Bars **C12/C12b/C12c** here, **K7** and **T19b/T19c** on the other two.

### Interaction with the lifetime-driven row set

The final SELECT is driven by the LIFETIME aggregates, so a creative idle 30+ days
still gets a row and keeps its all-time columns. Its 30-day event counts read `{}`
— correctly, because the counts ARE 30-day — and `creative_ev` is LEFT JOINed so a
creative with conversions and an all-`{}` breakdown keeps its row rather than
vanishing. Bars **C2** and **C7**.

### Bars

**C1–C13b** in
[`scripts/test-creative-event-counts-db.ts`](../../scripts/test-creative-event-counts-db.ts),
against camman-v2 inside a transaction that always rolls back.
`computeCreativeMetrics(orgId, dbc)` now takes a connection so the bars can hand
it the fixture transaction; `readCreativeCtr(orgId, dbc)` was threaded for the
same reason.

⚠️ The Phase 5 plan said `scripts/test-creatives-list-metrics.ts` "already
exercises `computeCreativeMetrics`". It does not — it signs in with `.env.local`
(**production**) and fetches a running dev server over HTTP, and the aggregate it
would read sits behind a 15-minute in-memory cache. The new bars follow the
execution model every other Phase 5 DB suite uses instead.

## The Telegram report carries the split (Phase 5 Task 8)

The scheduled report ([`/api/cron/telegram-report`](../../app/api/cron/telegram-report/route.ts))
prints one line per event type immediately under `Sales`, generated from the
registry. Both formats carry it:

```
📊 <b>CamMan — Wed 1 Jul</b> (final, ET)
Sales: 12
Registrations: 214
Purchases: 11 · $880.00 ($120.00 pending)
Manual tally: +1 (not in the lines above)
⚠ 3 unmapped — in no line above, but Sales/Revenue may already count them
Revenue: $900.00
Spend: $392.26
ROI: +129.4%
Net Profit: $507.74
Opt-outs: 853 (2.2% of 38,502 delivered)
```

- **Cross-org by construction.** The cron has no session and reports the whole
  business, so the split is keyed by `event_types.key` and the labels come from
  `loadEventTypes(db, null)` — merged by key, lowest `display_order` winning the
  label, flags OR-ed, archived only when EVERY org archived it. This is that
  branch's only caller.
- **Which types get a line** is the same question the columns ask, so it gets the
  same answer: `visibleEventTypesByCount()` in
  [`computeReportMetrics`](../../lib/reporting/report-snapshot.ts). An ACTIVE type
  prints even at zero (a configured type reading 0 at 22:00 is information);
  an ARCHIVED type prints only while the window still holds a number for it.
- **The rollup is the same query as the headline.** `salesRevenueTotals`
  ([lib/reporting/attribution.ts](../../lib/reporting/attribution.ts)) gained an
  `ev` CTE over the same window with the same `archived_at IS NULL` join, so the
  split cannot describe a different set of stages from the number beside it. It
  also returns `unmapped` and `manual_topup`. The additions are new keys; the
  dashboard reads `.sales`/`.revenue` by name and is unaffected.

### ⭐ The residual travels with the breakdown, structurally

`sales` is **not** Σ (is_purchase) n. It is that sum plus the manual top-up plus
anything the registry could not place:

```
sales = Σ events[t].n over is_purchase types + manual_topup + strays
```

`eventLines(m)` returns **one array** containing the per-type lines, the `+N more`
marker and both residual lines; `eventBlock()` — the only thing that can separate
them — is module-private. There is no exported way to take the breakdown without
the lines that explain the gap, the same rule `eventColumnBlock()` enforces for the
report tables. The residual lines are also **not droppable**: truncation takes
per-type lines only (bar T15).

⚠️ **The unmapped line used to say "counted nowhere", and that was false**
(corrected 2026-09-19). `sales` and `revenue` resolve `is_purchase` /
`counts_revenue` through NON-org-scoped id lists while the per-event map comes
from an org-scoped join, so a conversion carrying **another organisation's**
event type is already inside the `Sales` and `Revenue` lines of the same message
while sitting under no key — which is precisely why the lines above fall short.
Bar **T20** of [scripts/test-telegram-report-metrics.ts](../../scripts/test-telegram-report-metrics.ts)
seeds exactly that case and measures it (`sales=3`, Σ purchases `=2`, top-up `0`,
unmapped `1`). The rest of the bucket (no mapping at all, or no status) really is
counted nowhere and nothing at this grain separates the two, so the line says
**"may already count them"**. **T10b** fails on the property — a line that claims
they are counted nowhere, or that never names Sales — rather than on today's
wording, so the old sentence cannot come back as a tidy-up.

**The event lines are PLURALISED** with the same `pluralizeLabel()` the report
tables and the campaign tiles use (`Registrations: 214`, not `Registration: 214`)
— one function, so the phone and the screen cannot disagree about a label.
Pluralise **before** escaping: a label ending in `&` escapes to `&amp;` and an
`s` appended after that is `&amps;`, a malformed entity, which is a 400, which is
permanent (bar T4a2).

### ⭐⭐ Escaping and the cap are the difference between a report and an outage

This is not the best-effort alert path. `sendTelegramHtml` posts with
`parse_mode: "HTML"` and **throws** on any non-2xx; `classify()` calls a 400
**permanent**, so the cron returns 500 — and does the same thing the next hour,
and every hour after, because nothing about the input changes. Telegram answers
400 both for malformed markup and for text over 4096 characters, and
`event_types.label` is free text with **no CHECK constraint and no UI**. So:

- **Every registry-derived string is escaped at the point of interpolation**, in
  the one helper `eventLabel()`, which also collapses whitespace (a newline inside
  a label would otherwise forge an extra line that can read like a money line) and
  falls back to the key when the label is empty. Bar **T22** scans the formatter
  and fails if `.label` is referenced anywhere else — T4/T5 only prove today's
  call site; a new `${t.label}` written tomorrow is what takes the report down.
- **The cap is counted on the ASSEMBLED, POST-ESCAPE message.** Escaping lengthens
  a string (one `&` becomes five characters), so a cap counted before escaping is
  simply the wrong number. `assemble()` renders the real candidate and measures it.
- **Lines are dropped WHOLE, so an entity can never be cut in half.** `&amp;`
  sliced to `&am` is a 400, and a 400 is permanent. Measured: at 40 of 101
  candidate cut points a blind `slice()` on an `&`-dense document lands inside an
  entity (bar T8f).
- **Money is never what gets dropped.** `assemble()` fits the message by popping
  per-type lines off the tail and announcing them as `+N more event types`; the
  header, `Sales`, the residual, the five money lines and hourly's
  Yesterday-spend line are not candidates. The obvious implementation — join
  everything and tail-cut — drops exactly the money lines, which is what bars
  T7b/T15/T16/T17 exist to forbid.
- **`capped()` is the floor, not the mechanism.** It cuts at the last newline
  before the limit (never mid-entity) and REPLACES a single enormous line rather
  than slicing it. With a bounded `dayLabel` it never fires.
- **The cron's carrier-triage line is passed IN, not concatenated on.** It used to
  be appended to the returned string, which put it outside every length guarantee
  the formatter makes — the cap would have been enforced against a message that is
  not the one Telegram receives.

`MAX_EVENT_LINES = 6` (readability) and `MAX_MESSAGE_CHARS = 3500` (safety) are
enforced **independently**: raising the first cannot breach the second.

### ⚠️ `jsonb_each` on a non-object, again — and here it is worst

The `ev` CTE filters `jsonb_typeof(ksr.events) = 'object'`, the same guard as
[`stage-keitaro-aggregate.ts`](../../lib/reporting/stage-keitaro-aggregate.ts) and
[`metrics-cache.ts`](../../lib/creatives/metrics-cache.ts). There is no CHECK
constraint on the column, and 22023 aborts the **whole statement** — on the other
surfaces that blanks a page until someone reloads; here it 500s the cron every
hour for ever. Bar **T19** seeds a row with `events = '5'::jsonb` and proves the
numbers still come out.

⭐ **And the same failure one level down (2026-09-19).** That guard covers the
TOP level only. A row whose `events` is a perfectly good object holding a rotten
VALUE — `{"k":{"n":"abc"}}` — passes it, and `(e.value ->> 'n')::numeric` then
raises **22P02**, also statement-wide, for exactly the same blast radius.
Measured on camman-v2, including the mixed case (one good row and one bad in the
same statement returns nothing at all). All three readers now pull their numbers
through `eventNum()` ([lib/reporting/event-columns.ts](../../lib/reporting/event-columns.ts)),
the SQL-side twin of `parseEventMap()`: a JSON number or a strict numeric string
is taken, anything else reads **0 for that field only**, so a key with a good `n`
and a rotten `revenue` still contributes its count. Bars **T19b/T19c** here,
**K7** on the campaign page's aggregate, **C12/C12b/C12c** on /creatives.

### Bars

- [`scripts/test-telegram-report-format.ts`](../../scripts/test-telegram-report-format.ts)
  — 42 pure (3 whole-message goldens + T1–T26b). The three goldens are unchanged
  and still pass with an empty registry, which is what proves the splice landed in
  the right place. **T8c is what makes T8 mean anything**: it asserts the 200-type
  × 600-char fixture exceeds the cap *before* trimming. Shortening those labels
  leaves T8 and T7b green while T8c and T8b go red — demonstrated, not assumed.
- [`scripts/test-telegram-report-metrics.ts`](../../scripts/test-telegram-report-metrics.ts)
  — 16 on camman-v2 (T13–T24). It seeds a throwaway org because
  `computeReportMetrics` binds the module-level `db`, and asserts DELTAS against a
  pre-seed baseline. T13z/T14z pin both sides non-zero: an identity only ever
  satisfied by zeros is a countdown. T20/T20b seed a deliberate stray so the
  residual is proved to have a job. T23/T24 capture the real `sendTelegramReport`
  payload with **global fetch stubbed and the bot token replaced by a fake** — no
  message is ever sent to the real chat — and assert `parse_mode: "HTML"`, the
  exact text, ≤4096 chars, and that a `<b>Buy</b> & <win> 💰` label leaves exactly
  one `<b>…</b>` pair (the header) in the payload.

  ⚠️ That script previously called dotenv's `config()` as a statement positioned
  *after* its imports, so `@/db/client` was evaluated first and every run died
  with 32P01 as the local OS user. Fixed to `import "./_env-preload"` first. It
  now writes fixtures, so it also carries `_require-preview-db` second; the
  production eyeball it used to offer is deliberately gone.

## ⭐ The residual rule, and the THREE different mechanisms that enforce it (Phase 5 Task 9)

This is the one thing a reader who was not here has to take away, so it is stated
once, whole, rather than left distributed across the task sections above.

**The identity.** For any window and any stage set:

```
sales = Σ over is_purchase types of events[key].n  +  manual_topup  +  strays
```

- **`strays`** exist because the two sides resolve event types differently. The
  scalars (`sales`, `revenue`, `pending_revenue`) resolve `is_purchase` /
  `counts_revenue` through **non-org-scoped** id lists in
  [lib/sale-attribution.ts](../../lib/sale-attribution.ts), while the per-event
  entries come from an **org-scoped** `LEFT JOIN event_types … AND et.org_id =
  ce.org_id`. A conversion carrying **another organisation's** `event_type_id` is
  therefore **inside `sales` and `revenue`** while sitting **under no key** of
  `events`. It surfaces only as `unmapped_conversions`.
- **`manual_topup`** is the **second residual**: `sales` is
  `max(manual tally, tracker)` per stage, and the per-event entries count tracker
  events only, so the excess of the manual figure over the tracker's is in `sales`
  and in no event key either. It is shown on **all four surfaces** as of
  2026-09-19 (both report tables, the campaign page, `/creatives`, and the
  Telegram report's `Manual tally: +N` line).

**Therefore: any surface that shows the breakdown must show the residuals beside
it**, or it presents a number that is provably short of the `Sales` column next to
it and offers no explanation. That is not a convention anybody has to remember —
the three surface shapes each make it **structurally impossible to take one
without the other**, and each does it a *different* way, because the three have
different shapes:

| Surface | Mechanism | Why this one |
|---|---|---|
| **The two report tables** (`/reports` Overview + Keitaro) | **One call returns both.** `eventColsFor()` and `tierBColumnCount()` are **module-private**; the only export is `eventColumnBlock(spec, rows, totals, showEvents)`, which returns `{ columns, bar }` from ONE pass over ONE `totals`. `EventColumnsBar` takes the whole `block`. | These are column sets with a filter row, so the residual can be a real UI control (`UnmappedBadge`) — and `bar.unmapped` is read off the *same* `totals` the columns were built from, so it cannot describe a different response. |
| **The campaign page** (stages Results cell + totals card) | **The TYPE.** `StageEventBreakdown` and `EventTotalsTiles` each take ONE required `source` object carrying the counts and both residuals. There is no `unmapped={…}` prop to pass separately — and bar **X7b** fails if a loose one reappears. | There is no column set here: one is a `·`-joined line inside a cell, the other a tile grid. There is nothing to attach a bar to, so the enforcement moves into the prop shape and tsc holds it. |
| **`/creatives`** | **The residual IS a column in the returned array.** `eventCountColumns()` hands back the per-type count columns and the `Manual` / `unmapped` columns in ONE array; the caller never sees two lists. `EventCountRow`'s residual fields are **required, not optional** — an optional field detached the residual *by type alone*, compiled clean, and left every scan bar green. | A TanStack table consumes a `columns` array. Bundling the residual into that array is the only shape the consumer cannot decompose. |

⭐ **The column-visibility toggle (2026-09-20) does not reopen any of this.** Both
tables now open on a curated default view and reveal the rest behind a per-browser
**Show all columns** switch, and the residual is out of its reach in both shapes:

- On the report tables, `showAllColumns` is a parameter of
  `eventColumnBlock(spec, rows, totals, showEvents, showAllColumns)` and it reaches
  `columns` only. `bar` is assembled from `totals` on lines where no toggle state
  is in scope, and the bar is still mounted unconditionally beside the filters.
- On `/creatives`, `eventCountColumns(types, rows, showAllColumns, render)` applies
  it to the **manual top-up alone**. The per-type counts are never held back (they
  ARE the breakdown), and the stray-count column is appended by a statement that
  does not take the flag as an argument — `if (rows.some((r) => r.unmapped > 0))
  cols.push(UNMAPPED_COLUMN);`, with bar **V8** reading that statement's own text
  and its neighbour's as a positive control. The page's by-id filter runs over the
  built array, but the roster it filters by holds no `evt:` id and bar **V12**
  keeps it that way, so it cannot reach a generated column either.

Measured on screen, not inferred: `/reports` showed its amber `20 unmapped` badge
in **all four** toggle states, and `/creatives`' default view rendered
`Regs · Purchases · Unmapped` with `Manual` hidden. Bars **V1–V9**.

And **across all three**, one cross-cutting gate that covers a surface nobody has
written yet: bars **X8–X11** of
[scripts/test-event-columns-view.ts](../../scripts/test-event-columns-view.ts)
walk every `.ts`/`.tsx` under `app/` and `components/`, classify a file as a
per-event surface if it calls any column builder, and fail if such a file mounts
none of the three residual-bearing components. **Discovered, not listed** — a new
table is covered the day it is written.

### ⚠️ The jsonb hazards, at BOTH levels — and `->>` is not one of them

`keitaro_stage_results.events` has **no CHECK constraint** (see
[03-data-model.md](../03-data-model.md)), so object-ness and number-ness are
conventions of the writer, not guarantees of the database. Two distinct failures,
and **neither is scoped to the offending row — both abort the whole STATEMENT**:

| Level | Trigger | Error | Guard |
|---|---|---|---|
| **Top** | `jsonb_each(events)` where `events` is not an object (`'5'::jsonb`, an array, a string) | **22023** | `WHERE jsonb_typeof(ksr.events) = 'object'` at every unrolling reader |
| **Value** | `(e.value ->> 'n')::numeric` where the value is not a numeric literal (`{"k":{"n":"abc"}}`, `{"k":{"n":{"a":1}}}`) | **22P02** | `eventNum()` in [lib/reporting/event-columns.ts](../../lib/reporting/event-columns.ts) |

Statement-wide means exactly what it says: **measured on camman-v2 with a 2-row
set where one row was malformed, the good row's `7` was lost with it.** In
[lib/reporting/attribution.ts](../../lib/reporting/attribution.ts) — which backs
the hourly Telegram cron — that is a 500 **every hour** until a human edits a row.

⭐ **The top-level guard does NOT cover the value level.** `{"k":"abc"}` *is* an
object, so `jsonb_each` is perfectly happy; it is the value inside that is
malformed. They are two guards, not one applied twice.

⭐ **And `->>` itself never raises.** `'5'::jsonb ->> 'n'` returns `NULL`
(measured) rather than erroring — **the hazard is the `::numeric` cast**, not the
extraction operator. This matters when reading the code: an expression that only
extracts is safe, and the guard belongs on the cast. `eventNum()` is written
accordingly — it degrades **per field**, so a key with a good `n` and a rotten
`revenue` still contributes its count, rather than the whole map reading zero.

### ⭐ Adding an event type is CONFIG, and that is executed, not asserted

"The columns are generated from the registry" would be a claim if the only
registry ever exercised were production's two seeded rows — a generator that
hard-coded `registration` and `purchase` would look identical.

So [scripts/test-event-columns.ts](../../scripts/test-event-columns.ts) runs the
real generator against a **synthetic registry that exists in no database
anywhere**: `purchase`, `registration`, plus `deposit` (a second `is_purchase`,
`counts_revenue` type) and `trial` (a second `is_retarget_signal`). Bar **C6**
asserts the funnel columns come out as the full signal × purchase **cross
product** over those four —
`evtfunnel:trial:purchase | evtfunnel:trial:deposit | evtfunnel:registration:purchase | evtfunnel:registration:deposit`
— which no hard-coded column array produces. **C7** (a registry with no signal
generates no funnel column), **C8** (an empty registry generates no columns at
all) and **C9/C10** (a type that is both a signal and a purchase is never paired
with itself) close the shape.

**Adding an event type is rows in `event_types`, not a code change. If you find
yourself editing a column array to add one, something upstream has been broken.**
[scripts/test-reports-no-hardcoded-event-keys.ts](../../scripts/test-reports-no-hardcoded-event-keys.ts)
is the gate that says so, over all four rendering surfaces and everything between
the registry and them.

## Not built yet

- **Phase 5 is built through Task 9.** The generator, the storage, the projection,
  the read layer, the two report tables, the campaign page, the creatives page,
  the Telegram report and the docs all exist.
- **Deliberately out of scope, each with its reason in its own doc:** the
  matview-backed [offer group report](offer-group-report.md) and
  [Audience Stats](audience-report.md) (**not** contaminated — registrations
  contribute $0 there, including in their CSV exports); the partner report; the
  dashboard; `/creatives`' rate / revenue / EPC split; and `checkouts` itself.
- **Open, and recorded rather than done:**
  - a **CHECK constraint** on `events` — top level only
    (`jsonb_typeof(events) = 'object'`), in a LATER migration, `NOT VALID` then
    `VALIDATE`, and only after a production violation sweep. The **value**-level
    form is **refused by Postgres** (`0A000: cannot use subquery in check
    constraint`) and would need an `IMMUTABLE` helper or a trigger. Measured
    shape, the refusal and the three sweep queries: [03-data-model.md](../03-data-model.md).
  - **widening the EPC rescue to registrations**, which would lower every EPC on
    the platform — see [epc-denominator.md §9b](epc-denominator.md).
  - a **`/reports/unmapped` drill-down**. The unmapped badge is per page, scoped
    to the range and filters, and **links nowhere**: there is no unmapped screen
    to link to. Give the badge an `href` the day one exists.
  - ✅ **DONE 2026-09-20 — `Clicks` / `Clicks (all time)` are now `Human clicks`
    / `Human clicks (all time)`**, matching the Operator-API's `clicks_human`
    alias (owner: *"Matches what the Operator API already ships as
    clicks_human."*). Applied on the four By-X tables and Overview
    (`counted_clickers`, `lifetime_clickers`) and on `/creatives`
    (`clean_clicks_lifetime`), with the By-X explainer's *"Rates divide by
    Clicks"* and the two lifetime tooltips moved to the same wording. **No API
    field changed** — `counted_clickers` / `clicks_human` are unchanged, and
    `sortBy` persists by column **id**, so no saved sort moved.
    **Bar V23** in [scripts/test-event-columns-view.ts](../../scripts/test-event-columns-view.ts)
    pins all five columns in one place, and pins that the word never lands on
    `clickers`. **Re-measured after applying** — see the width note below.
    The history that produced the card is kept because it is the reason the
    rename went on this column and not the one next to it:
    half of it moved on 2026-09-20 for a different reason (the owner dropped the
    `(period)` suffix from `Clicks` and `EPC` on both report tables — "the page
    has a date filter; the suffix is redundant"), leaving `Clicks` four columns
    from **`Clickers`** in the default view with nothing separating them.
    ⚠️ **THE TWO HEADERS ARE CROSSED IN KIND, WHICH IS WHY THIS NAMED
    `Clicks` AND NOT `Clickers`.** Established from the source 2026-09-20.
    *(`Clickers` is written throughout this passage because that was its header
    at the time; it became **`Landing visits`** later the same day — see the
    applied card below. The crossing described here is exactly what that second
    rename removed.)*
      - **`Clickers`** ← `s.tally.visit_clicks_clean`
        ([lib/reporting/performance-report.ts](../../lib/reporting/performance-report.ts)),
        Keitaro's clean landing-page **VISITS** — *"Clickers = landing-page
        visits (visit_clicks_clean)"*, [lib/keitaro/poll.ts](../../lib/keitaro/poll.ts).
        Bot-filtered by Keitaro, **not** CamMan-human-scored, and explicitly
        display-only: *"`clickers` above is the Keitaro landing-visit count and
        is display-only"*.
      - **`Clicks`** ← `counted_clickers`, deduplicated **PEOPLE** with a click
        scored `human` (or a Rule-F conversion) — the single EPC denominator,
        which the Operator API already ships as **`clicks_human`**
        ([operator-api.md](../operator-api.md) prints `"counted_clickers": 4480,
        "clicks_human": 4480` on one row).
    So the column named for people counts clicks, and the column named for
    clicks counts people. **Anything spelled "human" belongs on `counted_clickers`
    and on nothing else**: putting it on `Clickers` would attach the word to the
    one metric it is false of, four columns from the metric it is true of, and
    collide with an API field name that is already taken.
    **Width, RE-MEASURED AFTER APPLYING** (2026-09-20, real Chromium against
    camman-v2, 1440px viewport, `table.scrollWidth` vs the container, By Offer
    default view, 15 columns). Before/after taken in ONE session on ONE fixture,
    and the "before" restored from a byte copy afterwards and re-read to prove
    the restore took:

    | By Offer, default view | `table.scrollWidth` | container | overflow | `Offer` col | the renamed col |
    | --- | --- | --- | --- | --- | --- |
    | before — `Clicks` | **1126px** | 1126px | **0** | 127px | `Clicks` 60px |
    | **after — `Human clicks`** | **1126px** | 1126px | **0 — still fits** | 86px | `Human clicks` 101px |

    **It still fits.** The renamed header grows **41px** (60 → 101) and the
    flexible `Offer` column gives up exactly that much (127 → 86). The
    all-columns view goes to **2061px in 1126px** and scrolls, as it always did.
    `/creatives` is untouched in its default view (the renamed column is one of
    the ten the toggle holds back) — **1126px / overflow 0** there too, with
    `Human clicks (all time)` visible under *Show all columns* (2115px).

    ⚠️ **"FITS" IS ONE LONG OFFER NAME AWAY FROM NOT FITTING, AND THAT IS NOW
    MEASURED RATHER THAN ASSERTED.** The slack comes from the `Offer` cell, so it
    depends on the data. The same 2×2, same session, with offer 5 renamed to a
    49-character name (*"Nutra Weight Management Q4 Evergreen — US Desktop"*):

    | offer name | header | width | container | overflow | `Offer` col |
    | --- | --- | --- | --- | --- | --- |
    | 20 chars | `Clicks` | 1126px | 1126px | 0 | 127px |
    | 20 chars | `Human clicks` | 1126px | 1126px | **0** | 86px |
    | 49 chars | `Clicks` | 1126px | 1126px | 0 | 127px |
    | **49 chars** | **`Human clicks`** | **1138px** | 1126px | **+12px** | 97px |

    A long name raises the `Offer` column's floor to ~97px, so only ~30px of the
    41px the rename needs can be found and the table overflows by 12px. **The
    rename is what tips it**: the same long name under the old header still fits.
    This is not a reason to undo it — 12px of horizontal scroll on one tab is a
    far smaller cost than a denominator whose header contradicts the API — but
    **treat this table as "at zero slack", not as "it fits"**, and re-measure on
    a LONG dimension value before adding or widening any column here. The same
    caveat is written at the convention in
    [07-conventions.md](../07-conventions.md) and in
    [reports-rollup.md](reports-rollup.md), so it is met wherever the width is
    read about.
  - **✅ RENAMING `Clickers` → `Landing visits` — PROPOSED AND APPLIED
    2026-09-20, owner-approved.** The flag that produced it: *"Leave `Clickers`
    alone for now, but flag it: a people-word for a display-only Keitaro visit
    count, sitting near the real denominator, is a trap waiting to catch
    someone."* **What it genuinely counts:** `visit_clicks_clean` — landing-page
    **visits** that Keitaro's own bot filter let through, counted as visits and
    not as people, display-only, and **not** a denominator of anything EPC
    touches. It is the divisor of `Redir %` and the numerator of `CR %`.
    **Why it was a trap even after the denominator said `Human clicks`:** the two
    sit four columns apart in the default view; a reader wanting "how many humans
    clicked" reached left, landed on `Clickers`, and got a number that is neither
    deduplicated nor human-scored — and on a healthy tracked stage the two differ
    by only ~1.35×
    ([app/api/keitaro/reports/route.ts](<../../app/api/keitaro/reports/route.ts>)),
    which is plausible enough to pass unnoticed and wrong enough to matter.
    **Why this name:** `Visits` was shortest but bare beside `Redirects`;
    `Tracker visits` named the source but is jargon; **`Landing visits` is the
    only candidate true in both halves** — *landing* separates it from
    `Redirects`, *visits* stops it claiming to be people.
    **Applied at all six label sites** — `FULL_COLS`, `HOURLY_COLS` and two
    `StatCard`s in
    [components/reports/performance-report.tsx](../../components/reports/performance-report.tsx),
    the column header and a `StatCard` in
    [components/reports/keitaro-report.tsx](../../components/reports/keitaro-report.tsx)
    — plus two prose sentences (the Overview funnel line and the Hourly rates
    line) and bar V13's roster. **Nothing else moved, re-confirmed on applying:**
    the column `id` is still `clickers` on all three tables, the Operator API
    field is still `clickers` (§7 of [operator-api.md](../operator-api.md)), and a
    live read of `localStorage["reports.performance"]` after the rename returned
    `"sortBy":"sent"` — an **id**, never header text, so no saved sort moved.
    **New bar V24** ([scripts/test-event-columns-view.ts](../../scripts/test-event-columns-view.ts))
    transcribes the result: the header on all three tables, all three totals
    tiles, the funnel sentence, and the unchanged `id`. V23 (a PROPERTY bar)
    stayed green through the rename while V13 (a transcription bar) went red and
    was updated — which is the pair working as designed.

    **⚠️ WIDTH: FITS ON AN ORDINARY OFFER NAME, 18px OVER ON A LONG ONE.**
    Re-measured after applying (real Chromium, 1440px viewport, camman-v2,
    `table.scrollWidth` vs the same 1126px container, By Offer default view,
    15 columns). All four cells read back in ONE session on ONE fixture:

    | offer name | header | `table.scrollWidth` | container | overflow | `Offer` col | the renamed col |
    | --- | --- | --- | --- | --- | --- | --- |
    | 20 chars | `Clickers` | 1126px | 1126px | 0 | 112.7px | 70.7px |
    | 49 chars | `Clickers` | 1126px | 1126px | 0 | 112.7px | 70.7px |
    | 20 chars | **`Landing visits`** | **1126px** | 1126px | **0 — fits** | 79.7px | 103.7px |
    | **49 chars** | **`Landing visits`** | **1144px** | 1126px | **+18px — OVER** | 97.1px | 103.7px |

    The header grows **33px**; on a short name the flexible `Offer` column gives
    up exactly that and the table still fits, on a 49-character name `Offer`
    cannot fall below ~97px so only ~15px of the 33 can be found. **Nothing was
    shortened and no column was dropped to hide it — the owner decides whether
    18px of scroll on long offer names is worth the name.** **Method control,
    same session:** *Show all columns* read **2056px in 1126px (overflow 930)**,
    so the method detects overflow and 1126/0 is a real fit.
    - ⚠️ **AND IT CONTRADICTS THE 2×2 RECORDED ABOVE FOR THE PREVIOUS RENAME.**
      That table records 49 chars + `Human clicks` = **1138px / +12px**; the same
      fixture (offer 5, camman-v2), re-measured on 2026-09-20, read **1126px /
      0**. Both are read-backs from a real browser, so neither is "the wrong
      one" — what differs is the fixture's rendered content (this session had a
      single data row), and the `Offer` column's floor evidently depends on it
      more than either measurement assumed. **The lesson stands and is now
      doubly earned: re-measure on the real data, never quote a width from a
      doc.**
  - **⚠️ `/creatives` DOES NOT OBEY THE TIME-BASIS CONVENTION — CARDED
    2026-09-20, NOT FIXED** (owner: *"card it, don't fix it now"*).
    **Current state.** The convention is *"on a date-filtered page an
    unqualified header means THAT filter's range, and a column the filter does
    not drive must name its own basis in the header"*
    ([07-conventions.md](../07-conventions.md)). `/reports` obeys it on all
    **47** fixed columns, pinned by bar V21. **`/creatives` has no date picker
    at all**, so nothing on it can inherit a range — and its headers are mixed.
    **Exactly which columns are affected** (all in
    [app/(protected)/creatives/page.tsx](<../../app/(protected)/creatives/page.tsx>)):
      - **Unqualified, but 30-day figures** — `CTR`, `Checkout Rate`,
        `Sales CR`, and **every generated per-event count** (`Regs`,
        `Purchases`, … — one per `event_types` row, so the set grows whenever
        the operator adds a type) plus the two residual columns beside them
        (`Unmapped`, `Manual`). Their basis lives **only** in a `title`
        tooltip — e.g. *"N sales / M clean clicks (30d)"* — which is invisible
        to anyone who does not hover, absent on touch, and absent from a
        screenshot or a copy-paste.
      - **Qualified, and correct** — `EPC (30d)`, `EPC (all time)`,
        `Human clicks (all time)`, `Sales, qty (all time)`.
    **Why it matters.** The two kinds sit in one row with nothing to tell them
    apart: `Sales CR` (30 days) is two columns from `Sales, qty (all time)`, and
    `Purchases` (30 days) is four from `EPC (all time)`. **A reader cannot tell a
    30-day figure from an all-time one**, and the page's whole purpose is
    ranking creatives against each other — a comparison that silently mixes two
    windows is worse than one that is slower to read. It is also the page that
    now opens ranked by `EPC (30d)`, so the window is load-bearing.
    **What a fix would involve** (none of it built):
      1. Decide the shape: **(a)** add a date picker and let the convention
         apply as written — the largest change, because every metric on the page
         comes from `lib/creatives/metrics-cache.ts`, whose windows are
         **hard-coded 30-day intervals** in SQL, not parameters; or **(b)** keep
         the fixed window and suffix the unqualified headers `(30d)`, which is
         copy-only but widens the table.
      2. Under (b), suffix `CTR` / `Checkout Rate` / `Sales CR` **and** every
         generated count. The three hand-written ones are one-line edits. The
         generated ones come from `eventCountColumns()` in
         [components/reports/event-columns-view.tsx](<../../components/reports/event-columns-view.tsx>),
         which — **checked, not assumed (2026-09-20)** — is called from
         **`/creatives` alone** (`/reports` uses `eventColumnBlock`, the campaign
         page `StageEventBreakdown`), and it **already hard-codes the 30-day
         basis in the column's `title`**. So the window is not in doubt in the
         code; it simply never reaches the header. Appending the basis to
         `pluralizeLabel(t.label)` there is a small, contained change and does
         **not** branch on any event key. ⚠️ It would, however, put the suffix on
         the two residual columns' siblings too, so `Unmapped` / `Manual` need a
         decision of their own — and the unclassified badge's
         "no toggle on that line" invariant must survive untouched (bars V6/V7).
      3. Re-measure: the default view is at **1126px in a 1126px container**
         (zero slack), so four or more `(30d)` suffixes need a width decision,
         probably by moving something into the toggle's hidden set.
      4. Extend V21 — today it is scoped to the three `/reports` tables by
         construction — or add a `/creatives` sibling, with the generated
         columns exempted the same way (their labels are operator config).
  - **merging the two adjacent toggles on `/reports`.** The tab now carries
    **Event breakdown** and **Show all columns** side by side in one control
    row, and the owner wants them merged — *"card it, not now"* (2026-09-20).
    **Current state.** Both are per-browser `usePersistedFilters` booleans on
    the same `reports.performance` key, both default off, both change only what
    is RENDERED, and each prints the count of columns it would add. They are
    **not** duplicates: `Show all columns` governs the FIXED columns in the
    roster above plus each event type's tier-A `rate` and `pending_n`;
    `Event breakdown` governs each revenue-bearing type's tier-B MONEY columns
    (`revenue`, `pending_revenue`, `epc`).
    **Why there are two.** The breakdown toggle is not a column control that
    happens to sit there — it is half of `EventColumnsBar`, which carries the
    **unclassified (amber) badge** in the same component precisely so the money
    split cannot be on screen while the count of conversions it fails to explain
    is hidden. It is also the Overview tab's ONLY route to the money split, and
    Overview has no curated view at all (`showAllColumns` is a literal `true`
    there). Folding it into the column toggle would either delete that control
    on Overview or leave it governing nothing and unmounting itself — which is
    why tier B is exempt from `isDefaultViewEventColumn()` rather than merged.
    **What merging would need,** in order: (1) a decision on what ONE control
    means on Overview, where the curated view does not exist; (2) keeping the
    unmapped badge mounted unconditionally and provably un-hideable — the bars
    that pin that today (V1, V2, V9, X7) assert it across all FOUR toggle
    states, so a single toggle re-states rather than removes that obligation;
    (3) a migration path for the two persisted keys (`showEvents`,
    `showAllColumns`) already in operators' browsers, since a merged control
    reading neither would silently reset both; (4) one combined "(N more
    columns)" count, which today is computed separately per control and
    deliberately from LITERAL `true`/`false` rather than from the live flag.
    Not started. No code was written for this.
