# Conversion events (multi-event conversions)

_Last updated: 2026-09-18_

**Status:** Phase 3 in progress — the ledger is kept live on the `*/5` Keitaro poll tick, with Tier-2 Telegram alerts. `purchasedClause`, the campaign tier, segment purchase rules, drip and the audience pools now read the ledger (Phase 3 Tasks 1–2). `keitaro_stage_results`' CONVERSION columns (checkouts/sales/revenue/pending_revenue/payout_at_conversion) are now a projection of the ledger, dated by `occurred_at` — see [Stage-day projection](#stage-day-projection-phase-3-task-3) below; every stage-grain reader (reports, the campaign page, the offer report, …) inherits this with zero code changes since they all read `keitaro_stage_results`. The per-RECIPIENT readers (partner report, the by-group `sale` weight basis, the hourly sales/revenue pair, Rule F's rescue, the dormant rollup, the campaign-activity badge) now read the ledger too — see [Per-recipient reporting readers](#per-recipient-reporting-readers-phase-3-task-4) below. **Revenue and EPC now count APPROVED conversions only, with pending revenue its own column** (Task 6) — see [Revenue and EPC](#revenue-and-epc-phase-3-task-6) below; this also closes Rule F's numerator/denominator window (§ Per-recipient reporting readers). ⚠️ **Migrations 0181/0182 are not yet applied to production** — `conversion_events`/`event_types` do not exist there yet; every reader switched in Tasks 1–4 and 6 is verified on camman-v2 (preview, auto-migrated) and by read-only checks against prod's still-live `stage_sends`/`counted_clickers` columns, not by running the new code against prod (it would 42P01). Applying 0181–0183 is gated on the Task 7 STOP approval.

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
- One-shot repair for stage-days frozen before this shipped: `npx tsx scripts/resync-stage-day-conversions.ts` (dry-run by default, prints the coverage floor and every diff; `--apply` writes inside one transaction, prod needs approval). Both paths pre-flight `readProjectionCoverage` and refuse on `empty_ledger` / `ledger_behind_history` before printing anything. The dry run lists exactly the rows `--apply` would change, each tagged `insert` / `rewrite` / `zero`: it applies the same per-stage coverage floor and the same org join, and its diff predicate includes `payout_at_conversion` (a row whose payout ALONE is stale is rewritten) and `pending_revenue` (a `zero` resets it, so a row whose only non-zero column is pending is a real change). **The Phase 1 backfill must have run on prod before the projecting code is live** — the first tick after the ledger is populated re-derives all of history in its scope (Task 8's precondition list).
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
  `evtfunnel:<signalKey>:<purchaseKey>` per signal × purchase pair.
- Tier **b** (behind the Event-breakdown toggle) and only for a `counts_revenue`
  type: `evt:<key>:revenue`, `evt:<key>:pending_revenue`, `evt:<key>:epc`. They
  sit behind the toggle precisely because each duplicates an aggregate column
  already on screen while exactly one `counts_revenue` type exists. Nothing the
  owner named is ever behind the toggle.

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

Checks: [`scripts/test-event-columns.ts`](../../scripts/test-event-columns.ts)
(pure, 45 bars; its registry holds a `deposit` type and a second signal that
exist in no database, so a generator that hard-coded the two seeded keys fails)
and [`scripts/test-event-columns-db.ts`](../../scripts/test-event-columns-db.ts)
(15 bars on camman-v2 inside a transaction that always rolls back).

## Not built yet

- **Phase 5 beyond Task 1 — proposed, not built.** Task 1's generator above
  exists and is exercised, but **no reader, endpoint, matview column or table
  consumes it yet**, and the `keitaro_stage_results.events` jsonb column that
  `parseEventMap()` is written against arrives in a later task's migration.
  Nothing downstream of the generator should be relied on as decided.
