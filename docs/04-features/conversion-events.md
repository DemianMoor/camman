# Conversion events (multi-event conversions)

_Last updated: 2026-09-17_

**Status:** Phase 3 in progress — the ledger is kept live on the `*/5` Keitaro poll tick, with Tier-2 Telegram alerts. `purchasedClause`, the campaign tier, segment purchase rules, drip and the audience pools now read the ledger (Phase 3 Tasks 1–2). `keitaro_stage_results`' CONVERSION columns (checkouts/sales/revenue/payout_at_conversion) are now a projection of the ledger, dated by `occurred_at` — see [Stage-day projection](#stage-day-projection-phase-3-task-3) below; every stage-grain reader (reports, the campaign page, the offer report, …) inherits this with zero code changes since they all read `keitaro_stage_results`. **Semantics unchanged at this step** (sales = lead+sale+rejected, checkouts = lead) — the only numeric delta is bug 2's −$100 double count. The per-RECIPIENT readers (partner report, the by-group `sale` weight basis, the hourly sales/revenue pair, Rule F's rescue, the dormant rollup, the campaign-activity badge) now read the ledger too — see [Per-recipient reporting readers](#per-recipient-reporting-readers-phase-3-task-4) below. Approved-only revenue + pending revenue (Task 6) are next. ⚠️ **Migrations 0181/0182 are not yet applied to production** — `conversion_events`/`event_types` do not exist there yet; every reader switched in Tasks 1–4 is verified on camman-v2 (preview, auto-migrated) and by read-only checks against prod's still-live `stage_sends`/`counted_clickers` columns, not by running the new code against prod (it would 42P01). Applying 0181–0183 is gated on the Task 7 STOP approval.

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

To retire a rule, set `status = 'archived', archived_at = now()`; the unique indexes only cover active rules. Rows stored before a rule existed are healed on the next ingest of their window (sticky `COALESCE` fills NULLs). The live poll tick re-ingests the last 7 ET days every 5 minutes, so recent rows heal on their own, and a combo's `conversion_events:unmapped:<offer>:<keitaro_type>` alert clears once none of its rows remain (while more than 10 unmapped combos exist, clears wait until the count is back to 10 or fewer). Re-run the backfill to heal older windows. A row first seen through a status-only rule (e.g. PsychoBook `rejected`) has a status but no event type, and no mapping can heal it. Set its event type by SQL after deciding which event it is.

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
- `unmapped` and `type_conflicts` read the whole ledger, all-time, and use **one key per problem combo**.
  - A fixed key would stay firing on one old unfixed row and hide every later problem.
  - A key on the newest problem row's id would miss conflicts, which only arise when an existing row is updated. It would also miss existing rows that turn unmapped, and page on every tick for a stream of new unmapped rows.
- The combo keys:
  - `conversion_events:unmapped:<offer>:<keitaro_type>`
  - `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`
  - `<offer>` is the CamMan `offer_id`, else `k<keitaro_offer_id>`, else `none`.
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
  - the offer and the Keitaro type (or the locked → conflicting event pair)
  - the combo's row count and how many were created in the last 24h (for a conflict, first seen in the last 24h), plus the first-seen time in ET for a conflict
  - up to 3 sample `keitaro_event_id`s, and the fix

| Key | Fires when | Clears when | What to do |
|---|---|---|---|
| `conversion_events:fetch_failed` | a **failed tick** — the window was refused (Keitaro HTTP error, timeout, a **malformed** 200 that isn't JSON with a `rows` array and a numeric `total` such as an HTML bot challenge, or a **truncated** page, `rows < total`) or the ingest **threw** (its message is the error text) — **and** the last complete ingest (the heartbeat) is older than `FETCH_FAILED_DEBOUNCE_MINUTES` (15) or was never recorded. A failed tick inside the 15 minutes does nothing: no fire, no clear. So one transient failure never pages; with `*/5` ticks the page lands on the 3rd–4th consecutive failure (the heartbeat age is read at 0.1h resolution). Nothing from a failed window is written | the next complete window | Repeated timeouts or 5xx: Keitaro or the network is down. Malformed: something other than the Keitaro API answered (bot challenge, proxy, error page). A truncation means 7 days of conversions no longer fit one Keitaro page, and the live window needs splitting (code change) — **the window has no pagination to fall back on, so treat a truncation alert as urgent, not a transient blip that resolves itself.** A throw is also in `conversion_events_error` and the Vercel logs |
| `conversion_events:invalid_rows` | a complete window held rows `parseKeitaroLedgerRow` rejected. Those conversions are **not** in the ledger | a complete window with 0 invalid rows. A failed tick leaves it unchanged | Compare the samples with `KEITARO_LEDGER_COLUMNS` / `parseKeitaroLedgerRow` |
| `conversion_events:org_mismatch` | a complete window had `orgMismatch > 0`: existing ledger rows this run resolved to a **different org** than they were stored under. Those rows were **not written** (`org_id` is fixed at insert). The alert carries the count and up to 3 samples `event_id stored_org→resolved_org`. **No debounce**: this is a data-integrity signal | a complete window with `orgMismatch = 0`. A failed tick leaves it unchanged | Find which lookup now points into another org (stage tracking id, `stage_sends` id or `offers.keitaro_offer_id`) and fix that. Correct the ledger row by SQL only after deciding which org is right (approval required) |
| `conversion_events:unmapped:<offer>:<keitaro_type>` (one key per combo) | ledger rows, all-time, with `event_type_id` or `status` NULL (read via `conversion_events_unmapped_idx`), grouped by offer and Keitaro type. **Pages once per new problem combo**, whether the rows were inserted or an existing row turned unmapped (its Keitaro type changed, or its rule was archived). **Repeats don't re-page**: more rows of the same combo never send another page | **the combo disappears**: none of its rows is unmapped any more. If it reappears, it pages again. While more than 10 unmapped combos exist, no unmapped combo key clears (the `combo_cap_exceeded:unmapped` key is firing then) | Add the mapping for that offer or network and Keitaro type (see above). Rows inside the 7-day window heal on the next tick. Older rows need `scripts/backfill-conversion-events.ts --apply` (prod write, needs approval). A status-only row needs its event type set by SQL |
| `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>` (one key per combo) | rows with `conflicting_event_type_id` set (via `conversion_events_type_conflict_idx`), grouped by offer and locked → conflicting event type. A conflict only arises when an existing row is updated. **Pages once per new problem combo**; **repeats don't re-page**: another conflict of the same combo sends nothing | **the combo disappears**: none of its rows still conflicts. If it reappears, it pages again. While more than 10 conflict combos exist, no conflict combo key clears (the `combo_cap_exceeded:type_conflicts` key is firing then) | See [Event-type conflicts](#event-type-conflicts) |
| `conversion_events:combo_cap_exceeded:unmapped` / `:type_conflicts` (fixed, one per kind) | that kind has more than 10 problem combos, so only its 10 most recently changed are listed and paged. The page names the kind, the combo count, the cap and the SQL that lists every combo of the kind. Neither key is under a combo prefix, so the stale-combo clear never touches them | the kind is back to 10 or fewer combos. Combo clears of that kind resume at the same moment | Read the whole list with the page's SQL and work it down. A new combo still pages while capped (recency ranking), unless more than 10 combos change in the same tick |
| `heartbeat:conversion-events-ingest` | no complete ingest for over **1h** (`HEARTBEAT_JOBS.conversionEventsIngest`). Checked hourly by `/api/cron/tracking-monitors`, never by the poll itself | the heartbeat is fresh again | Check the poll cron: `conversion_events_error` in its response, the Vercel logs, and any `fetch_failed` alert. A long outage pages twice by design: `fetch_failed` after ~15 min, the heartbeat within ~2h |

**Not alerted:**
- `unresolved` conversions (no stage, no `offers.keitaro_offer_id`). They include legitimate non-CamMan traffic, so they are only counted in the poll response.
- A complete window with zero conversions, which is a quiet week.
- `statusOnlyInBatch`. A status-only row that already has a locked event type is fine. A brand-new one has a NULL event type, so it is an unmapped row in the table, and its combo's `conversion_events:unmapped:<offer>:<keitaro_type>` key already reports it.

**Inspect state (read-only):**

```sql
SELECT alert_key, state, since, last_notified_at FROM alert_state
WHERE alert_key LIKE 'conversion_events:%' OR alert_key = 'heartbeat:conversion-events-ingest'
ORDER BY alert_key;
SELECT watermark, now() - watermark AS age FROM cron_locks WHERE job_name = 'conversion-events-ingest';
```

Don't flip a key to `ok` by hand; that hides a real condition. Fix the cause, and the next tick clears it (the next hourly run, for the heartbeat). A firing `unmapped:<offer>:<keitaro_type>` / `type_conflicts:<offer>:<locked_key>><conflicting_key>` row names one problem combo. It stays firing until **none** of that combo's rows is a problem any more — and, while its kind's `combo_cap_exceeded` key is firing, until that kind is back to 10 or fewer combos as well.

**While Telegram is down:** a combo that appears and self-heals entirely inside the outage still latches and clears normally in `alert_state` — its page is simply never delivered (`notifyOnTransition`/`clearAlert` write the state regardless of whether the Telegram send succeeded, the same latch semantics as the tracking-gap monitor). Don't conclude the monitor "missed" it; check `alert_state.since` / `last_notified_at` for the outage window, not just what arrived in the channel.

**Before merging.** The first cron tick after merge reads the whole ledger, all-time, so it can page a burst on top of whatever Phase 1's backfill already left unresolved: up to 10 unmapped combos + 10 conflict combos + 2 cap alerts, plus (if the hourly `tracking-monitors` tick lands before the first `*/5` tick stamps the heartbeat) one "heartbeat never recorded" page. Before merging, run the exported `UNMAPPED_COMBOS_SQL` / `CONFLICT_COMBOS_SQL` ([lib/conversions/monitor.ts](../../lib/conversions/monitor.ts)) read-only against prod to know the burst size ahead of time.

**Checks:**
- `scripts/test-conversion-monitor.ts` (pure, 44):
  - the window, including DST and a year boundary
  - every decision, including the `fetch_failed` debounce (fresh / stale / never / exactly 15 min), a malformed response and a thrown ingest
  - the `fetch_failed` age text (`N min ago` under 120 min, `X.Y h ago` from 120 min)
  - the stage-day projection's decisions (J1-J5): a successful run clears, a throw names the error and the watermark, the empty-ledger refusal fires the same key and names the Phase 1 backfill, an unbounded error is clipped
  - `org_mismatch` fire/clear with samples
  - combo keys: the format and offer rule, sanitisation and clipping, the `~<hash>` suffix (parts that sanitise alike get different keys; a clean part gets no suffix), and that counts and samples never change a key
  - combo decisions: a new combo fires, the same combo fires on the same key, a stale firing key clears, keys outside the prefixes are ignored, and the 10-combo cap (named on each page, no combo clears past it, the `combo_cap_exceeded` key firing over the cap and clearing at it)
  - the combo statements rank by `max(ce.updated_at) DESC`, not by size
  - per-combo text facts, samples capped at 3, no markup, the five fixed keys and the prefixes
- `scripts/test-conversion-monitor-db.ts` (camman-v2 only, rolled back, 48):
  - pre-existing problem rows are neutralised inside the transaction
  - combo reads: counts, the offer rule, samples, a status-only row (`event_type_id` NULL, `status` `rejected`) read as unmapped, a conflict set by UPDATE; partial-index use; the cap with the combo count and row total over every combo, listed by recency
  - the same combo on successive ticks pages once; a new combo pages; an existing row turned unmapped by UPDATE pages; a conflict set on an existing row by UPDATE pages, and a second one of the same combo doesn't
  - a resolved combo's key clears and pages again when the combo reappears; leftover in-prefix keys clear; decoy keys outside the prefixes stay untouched
  - a new 1-row combo pages against ten bigger firing combos, crossing the cap pages the `combo_cap_exceeded` key once, the combo that drops off the listing is not cleared, and clears resume when the kind is back at the cap
  - a failed tick still pages a new combo
  - the debounce against a real `cron_locks` watermark (5 min / 20 min / NULL; a debounced failure never clears; a throw pages)
  - the projection alert's latch (C1-C5): a throw pages once, a repeat doesn't, a successful run clears silently, the refusal re-arms the same key and pages, and the row stays global (`org_id` NULL)

## Stage-day projection (Phase 3 Task 3)

`keitaro_stage_results` holds two kinds of column on one row: CLICK columns (dated by click day, written by `pollKeitaro`'s `report/build` fold) and CONVERSION columns (dated by conversion day, written by [`lib/keitaro/stage-day-conversions.ts`](../../lib/keitaro/stage-day-conversions.ts) from this ledger). The aggregate poll no longer fetches `conversions/log` at all — the ledger ingest above is the tick's only conversion fetch.

- `syncStageDayConversions(dbc, { stageIds })` re-derives every (stage, ET day) in scope from a fresh `GROUP BY conversion_events` (today's semantics: sales = `keitaro_type IN (lead, sale, rejected)`, checkouts = `keitaro_type = 'lead'`, revenue = the same set summed), INSERT/UPDATEs the rows that differ (including a row whose `payout_at_conversion` alone is stale), then **zeroes** any existing row's conversion columns — `checkouts`, `sales`, `revenue`, `pending_revenue`, `payout_at_conversion`, never the click columns — for a day the ledger no longer explains. `stageIds: []` is a no-op; omitted = every stage (the one-shot resync). `stagesInScope` reports the scope it was GIVEN (`"all"` when unscoped).
- ⭐ **The zeroing can never outrun the ledger's coverage.** A full re-derivation would otherwise wipe months of real sales on a ledger that has not been backfilled, because the live ingest window is only 7 ET days. Two bounds:
  - **Empty-ledger refusal** — no stage-attributed ledger row anywhere ⇒ the run writes NOTHING and returns `refused: "empty_ledger"` (the poll response and the `conversion_events:projection_failed` alert both say so). The same refusal `scripts/resync-stage-day-conversions.ts` carries, moved into the function so the `*/5` route cannot outrun it.
  - **Per-stage coverage floor** — a stage-day is only zeroable when that stage's own earliest ledger conversion is on or before it (an inner join to `min((occurred_at AT TIME ZONE ET)::date) GROUP BY stage_id`). So a stage with no ledger rows at all is never touched, and nothing before a stage's first ledger conversion is. The floor counts ALL stage-attributed rows, not just the ones the sales/revenue filters match — coverage means "the ingest reached this day for this stage". `coverageFloor` in the result is the minimum floor across the scope (reporting only; the enforced bound is per stage).
- `discoverChangedLedgerStages(dbc)` finds stages whose ledger rows changed, via `conversion_events.updated_at` (migration 0182's `conversion_events_updated_at_idx`). `occurred_at` never moves, so this is the only way to find a re-posted OLD conversion whose stage-day sits outside the current click window.
  - **Resumable.** The window is `[min(watermark − 5 min, now − LEDGER_CHANGE_LOOKBACK_MINUTES), now]`: the 30-minute lookback is a FLOOR (and the whole window on a first run), and an older watermark EXTENDS the window back. A fixed lookback stranded changed stage-days forever after ~6 consecutive failed ticks. The cursor is `cron_locks.watermark` under `job_name = 'conversion-stage-day-projection'` (the same column `propagate-clickers` uses; not a lease — the route's `keitaro-poll` lease is the single-runner guard), advanced by `advanceProjectionWatermark` and never backwards.
  - **Capped** at `MAX_CHANGED_STAGE_IDS` (2000) stage ids, because each id is a bind parameter in three statements. Oldest change first, so a capped run still makes progress: the cursor advances only to the last id it KEPT and `truncated: true` says the rest come next tick.
- `runStageDayProjection(dbc, { extraStageIds })` is what the route calls: discover → project `extraStageIds ∪ discovered` → advance the watermark **only** when the projection neither threw nor refused. A killed tick therefore re-reads the same window.
- **Order in the `*/5` tick** ([app/api/keitaro/poll/route.ts](../../app/api/keitaro/poll/route.ts) `pollAndRefresh`): `pollKeitaro` (clicks) → counted-clicker refresh → `ingestConversionLedger` → **only if that ingest was `ok`**, `runStageDayProjection` over `pollKeitaro`'s `stage_ids` (this tick's click-touched stages) ∪ the discovered stages. A refused or thrown ingest skips the projection entirely for that tick — re-deriving against an incomplete ledger would zero real revenue inside the covered range — and the stage-days keep their previous values until the next good tick.
- **Alert:** `conversion_events:projection_failed` (fixed key, latched, plain text) fires when the projection throws or refuses and clears on the next successful run. Evaluated on the CRON path only, and only when the projection actually ran — a skipped projection gets no decision, because the ingest's own `fetch_failed` alert already covers that tick.
- A stage-day with conversions but no click row: `syncStageDayConversions`'s INSERT creates the row (click columns default 0 — a conversion with no matching click is legitimate, e.g. `sub_id_1`/`sub_id_3` resolved via `offers.keitaro_offer_id` with no click).
- One-shot repair for stage-days frozen before this shipped: `npx tsx scripts/resync-stage-day-conversions.ts` (dry-run by default, prints the coverage floor and every diff; `--apply` writes inside one transaction, prod needs approval). Refuses to run if the ledger is empty (would zero every row), and the dry run applies the same per-stage coverage floor `--apply` does, so the diff it prints is what would actually be written. **The Phase 1 backfill must have run on prod before the projecting code is live** — the first tick after the ledger is populated re-derives all of history in its scope (Task 8's precondition list).
- `mirrorStageCountersFromResults` (exported from `lib/keitaro/poll.ts`) runs after BOTH the click upsert and the conversion projection, so `campaign_stages.checkout_click_count` never lags a tick. The projection calls it with `exactCheckoutClicks: true`: the projection is non-monotonic, so that one field takes the recomputed sum even when it DECREASES (0 included) — otherwise a zeroed day would leave a stale higher counter on the campaign page and in the creatives metrics cache forever. `click_count` and `sales_payout_each` keep their positive-only/COALESCE guard, `sales_count` is never touched. It also THROWS now instead of swallowing: the swallow lives at `pollKeitaro`'s call site (the pool), because swallowing inside would poison a caller-supplied transaction (`--apply`, the DB tests). See [keitaro-poll.md §2a](keitaro-poll.md).

Checks: `scripts/test-stage-day-conversions.ts` (camman-v2 only, rolled back, 39) — the projection's semantics; the three coverage bounds (a stage with no ledger rows keeps its rows, a stage-day months before coverage is never zeroed, an empty ledger refuses and writes nothing) alongside the bug-2 correction that must survive them; the exact downward mirror; the watermark (first run, out-of-window, an old watermark extending the window, the cap, advance-only-on-success, no advance on a refusal); and source guards on the route's ingest-ok branch and its cron-only alert. The projection alert's decisions are in `scripts/test-conversion-monitor.ts` (J1-J5) and its latch in `scripts/test-conversion-monitor-db.ts` (C1-C5).

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

Guard: [`scripts/test-p3-task4-reader-switch-db.ts`](../../scripts/test-p3-task4-reader-switch-db.ts) — preview DB only, rolled back. Runs each reader's actual query text against three one-sided fixtures (`ledger_only`, `legacy_only`, `rejected_ledger`) and the OLD `stage_sends`-column query text against the same rows, proving the switch: the new query counts the real ledger purchase and ignores the legacy column, the old query does the reverse (and would have wrongly rescued the rejected conversion).

## Not built yet

- **Phase 3 remaining:** revenue and EPC → `counts_revenue` and `approved` only, with pending revenue as its own column (Task 6).
- **Phase 4:** Registered lane (tier 3; converted becomes 4; CHECK widened then).
- **Phase 5:** per-event report columns.
