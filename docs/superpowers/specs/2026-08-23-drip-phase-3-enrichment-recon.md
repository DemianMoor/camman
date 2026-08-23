# Drip Campaigns — Phase 3 Recon: enrichment worker (zero sends)

_Card: `869endkqt` (Drip P3) · parent `869ency4b` · 2026-08-23 · **RECON ONLY — no code, no migrations**_

Scope: a `lead_inbox` consumer under `withCronLease('lead-enrichment')` — normalize → Telnyx lookup
via the existing queue → landline/mobile split → contacts + `contact_attributes` + `lead_events` +
drip group, plus lookup guards and the backlog alert.

---

## 0. Method — what these findings ran against

| | |
|---|---|
| Code | `origin/main` @ `78d911f` (Phase 2 merged and live) |
| Database | production `rtdarhkkjwcetlmruftl` |
| Telnyx | **live API call** to `/v2/balance`, not a ledger row |
| Corpus | contacts **815,426** · `phone_lookups` complete **807,013** · `lookup_queue` **613,990** (all `done`) · `lookup_batches` **14** · `lead_inbox` **0** |
| New tables | `lead_events`, `lead_intake_daily` — neither exists |
| Writes | none |

---

## 1. The four questions you asked

### 1.1 How the lookup worker returns results, and the realistic lead→contact latency

**It is a synchronous POLL. There is no callback.** [lib/telnyx/worker.ts](../../../lib/telnyx/worker.ts)
claims rows from `lookup_queue` (`FOR UPDATE SKIP LOCKED`), calls `telnyxNumberLookup(phone)` inline,
and writes `phone_lookups` with `lookup_status='complete'` in the same run. Nothing calls us back, so
there is nothing to receive — a second pass over `lead_inbox` is the right shape, exactly as you
specced.

Cadence and pacing: cron `*/2 * * * *`, `lookup_concurrency_rps = 30`, `CLAIM_MAX = 50` per
iteration, `BUDGET_MS = 250_000` under a 300 s `maxDuration`.

**Measured latency, enqueue → `phone_lookups` row (n = 259,863):**

| avg | p50 | p95 | max |
|---|---|---|---|
| 2,904 s (48 min) | 2,548 s (42 min) | 6,643 s (111 min) | 7,200 s (capped by my 2 h filter) |

**⚠️ Do not take that at face value — it does not describe the drip workload.** Every one of those
lookups came from **bulk backfill batches** of 19,713–229,867 numbers. The 42-minute median is queue
depth from a 230K batch draining at 30 rps, not intrinsic latency. The world that produced the
measurement is not the world Phase 3 lives in.

The **intrinsic** drip latency, for a handful of numbers arriving continuously into an empty queue:

| Path | Latency |
|---|---|
| **cache hit** (`phone_lookups.lookup_status='complete'` already) | no Telnyx at all — the sweeper finalizes in the **same pass**. One sweeper interval |
| **cache miss**, empty queue | enqueue → wait for the `*/2` lookup cron (0–2 min) → one Telnyx round trip → next sweeper pass. **~2–5 min** |
| **cache miss, bulk batch in the queue** | **40–110 min** (the measured figures above) |

That third row is the finding, not a footnote → **G22** below.

### 1.2 Does the daily cap's Warsaw-midnight reset matter for drip? **Yes.**

[lib/telnyx/daily-cap.ts](../../../lib/telnyx/daily-cap.ts) anchors the cap to
`LOOKUP_TIMEZONE = "Europe/Warsaw"` and it is **account-global, not per-org**.

Measured live: `warsaw_now 2026-08-23 01:29`, `et_now 2026-08-22 19:29`, **next reset = 18:00 ET**.

**Warsaw midnight is 6 PM ET — inside the drip sending window (8 AM–9 PM ET).** Two consequences:

- One ET drip day **straddles two cap days**. Leads arriving 8 AM–6 PM ET and 6 PM–9 PM ET draw on
  different budgets, so "today's lookup budget" is ambiguous unless stated.
- The cap can exhaust mid-afternoon ET and refill at 6 PM, producing a gap where leads pile up in
  `awaiting_lookup` and then clear in a burst — which looks exactly like an outage but isn't.

Recommendation in **G23**: the *global* cap stays Warsaw (it governs the Telnyx account and other
consumers), the **drip sub-cap is ET-day anchored** like everything else drip does. Two different day
boundaries in one flow is a real wart, so it must be explicit in code and on the settings page rather
than discovered later.

### 1.3 Current Telnyx balance and 7-day spend

**⚠️ BLOCKING: the live balance is `$2.47`.** Fetched from `GET /v2/balance` just now — HTTP 200,
`{"balance":"2.47","available_credit":"2.47","credit_limit":"0.00"}`. Not from the ledger: the newest
`lookup_batches.balance_after_usd` is `$3.34` and is **13 days stale** (2026-08-10).

**7-day spend: `$0.00`. There have been no lookup batches at all since 2026-08-10.**

All-time: 14 batches, 856,571 numbers, **$922.15** actual — ≈ **$0.00108 per number**.
So $2.47 buys roughly **2,300 lookups**, against a spec of **10,000–50,000 leads/day**.

Two separate problems fall out:

- **Operationally, Phase 3 cannot process a single real partner day until Telnyx is topped up.** The
  code can ship and be verified dormant; it cannot do real work. This is a go-live gate, not a code
  defect.
- **⚠️ The top-up alert as specified is dead on arrival.** "balance < 7 × avg daily lookup spend over
  the last 7 days" evaluates to `7 × $0 = $0` today, and `$2.47 < $0` is false — **the alert would
  never fire, precisely at the moment it is needed.** Spend is zero right up until the instant drip
  turns on, which is the same trap as a guard that asserts today's empty state. → **G20**.

### 1.4 The exact "unknown line type" policy today

**Today `unknown` is SENDABLE, and that is a deliberate, documented decision** —
[lib/telnyx/map-line-type.ts](../../../lib/telnyx/map-line-type.ts):

> "Anything exotic or ambiguous ('fixed line or mobile', 'premium rate', pagers, etc.) maps to
> 'unknown', which stays `messaging_status='eligible'` — conservative, we never silently suppress a
> number we're unsure about."

[lib/telnyx/sync-contacts.ts](../../../lib/telnyx/sync-contacts.ts) suppresses **`landline` only**.
Confirmed against live contacts:

| line_type | messaging_status | contacts | share of completed lookups |
|---|---|---|---|
| mobile | eligible | 742,311 | 91.98% |
| landline | **not_applicable** | 46,154 | 5.72% |
| voip | **eligible** | 10,022 | 1.24% |
| unknown | **eligible** | 16,939 | 1.06% |

**⚠️ And "unknown" means two different things.** 8,526 numbers were looked up and Telnyx could not
classify them; **8,413 contacts have never been looked up at all** and also carry
`line_type='unknown'`. Nearly equal populations. A drip rule written as "unknown ⇒ landline ⇒
discard" would discard both — including numbers we never even asked about. → **G19**.

---

## 2. What already exists and is reusable

| Need | Exists | Notes |
|---|---|---|
| Single-runner lease | `withCronLease(jobName, fn, ttlMs)` — [lib/cron/lease.ts](../../../lib/cron/lease.ts) | Exactly as the brief names it. `cron_locks.job_name` is free text ⇒ **no migration** for `lead-enrichment` |
| Heartbeat watched by a *different* job | `tells-monitors` (cron `23 * * * *`) inspects the sweeper's backlog | The precedent to copy — never self-checking |
| Lookup enqueue | `enqueueNormalized(orgId, phones, trigger)` — [lib/telnyx/enqueue.ts](../../../lib/telnyx/enqueue.ts) | Already counts cache hits against `phone_lookups.lookup_status='complete'`. **No second lookup path needed** ✓ |
| Normalizers | [lib/contact-attributes.ts](../../../lib/contact-attributes.ts) | `normalizeDob` (epoch→NULL), `normalizeEmail`, `normalizeBool`, `normalizeIncomeBand`, `normalizeGender`, `ageBandFromDob` — all built in 1c, all reusable as-is ✓ |
| Contact upsert target | `contacts_org_id_phone_number_unique` | Verified present ✓ |
| "Never blank a known value" | `ON CONFLICT (contact_id) DO UPDATE SET x = COALESCE(EXCLUDED.x, ca.x)` in the 1c importer | Exactly the required semantics ✓ |
| Idempotent group apply | `POST /api/contacts/bulk-apply-groups`, `ON CONFLICT DO NOTHING` | ✓ |
| Alert transition gating | `alert_state` + `notifyOnTransition` (0154, Phase 2) | ✓ |

**Two things that look reusable but are not, and both need a migration:**

- **`lookup_batches.trigger` is CHECK-constrained** to `('upload','backfill','csv_update')` (migration
  0097). Calling `enqueueNormalized(orgId, phones, 'drip_intake')` fails with **23514**. Same class of
  trap as the segment-rule CHECK in 1c — the code reads fine and the DB rejects it.
- **`lead_inbox.status` is CHECK-constrained** to `('received','processed','rejected','landline','duplicate')`.
  The `awaiting_lookup` state the design needs is **not** in it.

---

## 3. Conflicts with the brief that need your ruling

### G19 — "unknown-as-landline" inverts today's explicit policy ⚠️

The brief says landline / voip / unknown all become `status='landline'`, are **not** saved to
contacts, and are **not kept** beyond a counter. Today voip and unknown are both `eligible`.

- That discards **2.30%** of looked-up volume (voip 1.24% + unknown 1.06%) that the rest of the
  system considers sendable.
- It would also discard **never-looked-up** numbers, which share the `unknown` label (§1.4).
- **The asymmetry is the argument: discarding is irreversible.** The brief says these rows are not
  kept, so if the call turns out wrong the leads are gone *and* we already paid for the lookup.
  Keeping them costs one row each.

**Recommendation:** discard **`landline` only** (matching `sync-contacts` and today's policy). Keep
voip and classified-unknown as contacts, **stamp `line_type` onto the lead event and the contact**,
and let Phase 4 decide per campaign — the drip campaign config already has a carrier filter. Count
them separately so Phase 7 can report them. If you still want them dropped, I would at minimum
distinguish *classified-unknown* from *never-looked-up* and never drop the latter.

### G20 — the top-up alert formula never fires ⚠️

`balance < 7 × avg_daily_spend(7d)` is `$2.47 < $0` today ⇒ false, forever, until drip has already
been spending for a week.

**Recommendation:** `threshold = max(7 × avg_daily_spend_7d, FLOOR)` with `FLOOR` derived from
expected drip volume (at $0.00108/lookup, 50,000 leads/day ≈ **$54/day**, so a 7-day floor ≈ **$378**),
plus an unconditional **hard floor alert at `balance < $25`** that does not depend on history at all.
State-transition gated via `alert_state`, and cleared when the balance recovers so the next drop
alerts again.

### G21 — Telnyx balance is a go-live gate, not a code issue ⚠️

$2.47 ≈ 2,300 lookups. Phase 3 ships and verifies dormant, but the first real partner day needs a
top-up. I am flagging it rather than working around it.

### G22 — head-of-line blocking in the shared lookup queue ⚠️

`claimQueueBatch` orders `created_at, id` over the **account-global** `lookup_queue` (it has no
`org_id`). A bulk upload enqueued before a drip lead puts that lead behind the whole batch — measured
p95 **111 minutes**. This is the same failure class as the scheduled-drain head-of-line incident.

**Recommendation:** add `lookup_queue.priority smallint NOT NULL DEFAULT 100` and order
`priority, created_at, id`, with drip enqueuing at a lower number. Additive, one index, no behaviour
change for existing callers (everything defaults to 100). The alternative — a separate drip queue —
duplicates the worker and violates "no second lookup path".

### G23 — two day boundaries in one flow

Global cap = Warsaw midnight (18:00 ET). Drip sub-cap = ET midnight, per **G23**. Both must be
labelled wherever they surface, or an operator reading "cap" on one screen will mean the other.

### G24 — sandbox and the counters contradict slightly

The brief lists `sandbox` as a counter column *and* says sandbox leads are "excluded from counters".
I read that as: a sandbox lead increments **only** `sandbox`, never `received`/`mobile`/`landline`,
so Phase 7 can report real volume without filtering. Confirm.

---

## 4. Migration proposal — **STOPPING HERE FOR APPROVAL**

Next number is **0155**. Four migrations, one concern each.

### 0155 — widen the two CHECK constraints (additive, unblocks everything)

```sql
-- lead_inbox gains the two-pass state
ALTER TABLE lead_inbox DROP CONSTRAINT lead_inbox_status_check;
ALTER TABLE lead_inbox ADD CONSTRAINT lead_inbox_status_check
  CHECK (status IN ('received','awaiting_lookup','processed','rejected','landline','duplicate'));

-- lookup_batches gains the drip trigger
ALTER TABLE lookup_batches DROP CONSTRAINT lookup_batches_trigger_check;
ALTER TABLE lookup_batches ADD CONSTRAINT lookup_batches_trigger_check
  CHECK (trigger IN ('upload','backfill','csv_update','drip_intake'));
```

### 0156 — `lead_events`

```
id             uuid PK DEFAULT gen_random_uuid()
org_id         uuid NOT NULL → organizations ON DELETE CASCADE
contact_id     uuid NOT NULL → contacts ON DELETE CASCADE
partner_key_id integer NOT NULL → partner_keys ON DELETE RESTRICT
partner_slug   text NOT NULL                     -- denormalized, as on lead_inbox
interest_tag   text
received_at    timestamptz NOT NULL              -- the PARTNER's arrival time, not ours
inbox_id       uuid → lead_inbox(id) ON DELETE SET NULL
sandbox        boolean NOT NULL DEFAULT false
line_type      text                              -- stamped, per G19
created_at     timestamptz NOT NULL DEFAULT now()

UNIQUE (inbox_id) WHERE inbox_id IS NOT NULL     -- one event per inbox row = idempotent replay
INDEX (org_id, contact_id, received_at DESC)     -- "has this contact arrived before?" (the >1-week rule)
INDEX (org_id, partner_key_id, received_at DESC) -- Phase 7 per-partner reporting
RLS: ENABLE + SELECT-only org policy
```

**⚠️ `ON DELETE SET NULL` on `inbox_id`, not CASCADE.** The brief has landline rows removed from
`lead_inbox`; if that FK cascaded, deleting the inbox row would delete the lead event too. The
partial UNIQUE is what makes the sweeper safely re-runnable after a crash mid-batch.

### 0157 — `lead_intake_daily` (the counter that survives deleted rows)

Answering the brief's "propose the counter shape":

```
org_id         uuid NOT NULL → organizations ON DELETE CASCADE
partner_key_id integer NOT NULL → partner_keys ON DELETE CASCADE
day_et         date NOT NULL                     -- ET calendar day
received       integer NOT NULL DEFAULT 0
mobile         integer NOT NULL DEFAULT 0
landline       integer NOT NULL DEFAULT 0
rejected       integer NOT NULL DEFAULT 0
duplicate      integer NOT NULL DEFAULT 0
sandbox        integer NOT NULL DEFAULT 0
lookups_spent  integer NOT NULL DEFAULT 0        -- Telnyx calls actually made (cache misses only)
PRIMARY KEY (partner_key_id, day_et)
INDEX (org_id, day_et DESC)
RLS: ENABLE + SELECT-only org policy
```

Incremented by the same guarded-upsert shape Phase 2 uses. `lookups_spent` is not in your list but is
the only way Phase 7 can produce the "separate lookup-cost column" the parent card asks for once the
landline rows are gone — cost is per *Telnyx call*, so cache hits must not be counted.

**⚠️ `day_et` is a `date`, and the ET day is resolved in application code** via the existing
`campaignDayBoundsUtc`, never by a functional predicate on a timestamp — same sargability rule as
everywhere else.

### 0158 — `lookup_settings.drip_daily_cap` + `lookup_queue.priority`

```sql
ALTER TABLE lookup_settings ADD COLUMN drip_daily_cap integer NOT NULL DEFAULT 50000;
ALTER TABLE lookup_queue   ADD COLUMN priority smallint NOT NULL DEFAULT 100;   -- G22
CREATE INDEX lookup_queue_priority_pending_idx
  ON lookup_queue (priority, created_at, id) WHERE status = 'pending';
```

Both additive with defaults that preserve today's behaviour exactly (everything existing is priority
100, so ordering is unchanged until drip enqueues at a lower number). The new partial index replaces
nothing — the existing pending scan keeps working.

---

## 5. Risk register additions

| # | Risk | Mitigation |
|---|---|---|
| **R20** | Drip leads starve behind a bulk backfill (measured p95 111 min) | `lookup_queue.priority` (G22). Without it, "1–2 min reaction" is unachievable whenever anyone runs an upload |
| **R21** | Telnyx balance ($2.47) exhausts mid-day; leads pile in `awaiting_lookup` and look like an outage | Hard-floor balance alert (G20) + the drip sub-cap failing **closed** (leads wait, never silently become non-mobile) |
| **R22** | The sweeper crashes mid-batch and re-runs, double-writing contacts/events | Partial UNIQUE on `lead_events.inbox_id` + `ON CONFLICT` upserts throughout; the status transition is the commit point |
| **R23** | An `awaiting_lookup` lead never resolves (queue row failed terminally) and waits forever | The backlog alert must count `awaiting_lookup` older than X **separately** from `received`, or a stuck lookup hides inside a healthy-looking inbox |
| **R24** | Deleting landline rows destroys the only evidence of what a partner actually sent | `lead_intake_daily` is written **before** the row is deleted, in the same transaction |

---

## 6. What I have NOT done

No code, no migrations, no branch. One read-only probe (deleted) and one live `GET /v2/balance`.
Awaiting rulings on **G19–G24** and approval of **0155–0158**.
