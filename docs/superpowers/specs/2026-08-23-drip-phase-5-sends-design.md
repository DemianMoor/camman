# Drip Campaigns — Phase 5: stages, scheduler, sends — RECON + DESIGN PROPOSAL

_Card: `869endkyv` (Drip P5) · 2026-08-23 · **RECON ONLY — no code, no migrations. Stopping for approval.**_

This phase touches the live send path. Entry gate is the G10 review; exit gate is "regular campaigns
unaffected, proven".

---

## 0. Method

Code `origin/main` @ `8b3648e`. Production `rtdarhkkjwcetlmruftl`, read-only (`EXPLAIN` only, no
writes). Live blast volume alongside this work: **49K–72K sends/day** over the last 7 days.

---

## 1. G10 — the entry gate: `stage_sends` retention / partitioning

### Measured

| | |
|---|---|
| Rows | **3,568,213** |
| Heap / indexes / total | 1,325 MB / **1,503 MB** / **2,828 MB** |
| Share of the whole database | **27.3%** of 10 GB |
| Indexes | **16** |
| Growth | Jul **1.68M**, Aug **1.55M** ⇒ ≈ **19M rows/yr already**, before drip |
| Oldest row | **2026-06-03** — the table is **81 days old** |
| Rows older than 90 days | **0** |
| Partitioned today | no |
| FKs pointing at it | **9** |

Drip at the spec's 10–50K leads/day adds **3.6M–18M rows/yr**, so the combined steady state is
roughly **23M–37M rows/yr**, ≈ **18–29 GB/yr** at current density.

### ⚠️ Finding 1 — "0 rows older than 90 days" is not evidence retention works

The table has **81 days of history**. The first 90-day boundary is **2026-09-01 — nine days away.**
Nothing has ever aged out, so no retention path has ever been exercised. This is the
assert-today's-empty-state trap: the zero is a countdown, not a green light. **Retention becomes a
live question in September regardless of whether drip ships.**

### ⚠️ Finding 2 — partitioning is BLOCKED by a dedup invariant, and I recommend against it

```
stage_sends_active_contact_uniq
  UNIQUE (stage_id, contact_id) WHERE status IN ('pending','sending')
```

That index is the guarantee that **one contact cannot hold two live sends on one stage**.

PostgreSQL requires a unique index on a partitioned table to contain **every partition-key column**.
Partitioning by `created_at` (the natural choice for time-based retention) would force this to
`(stage_id, contact_id, created_at)` — under which the same contact **could** hold a pending row in
each partition. That is a duplicate-message risk on a compliance-adjacent path, traded for disk.
`stage_sends_pkey (id)` has the same problem.

**Recommendation: do not partition.** Not "not yet for effort reasons" — the invariant is worth more
than the disk, and any partitioning proposal has to explain what replaces it first.

### ✅ Finding 3 — retention by DELETE is feasible, because the FKs were built for it

All 9 inbound FKs already behave correctly under deletion:

| behaviour | tables |
|---|---|
| `SET NULL` | `opt_out_attributions`, `ahoi_dlr_events`, `ahoi_inbound_events`, `tells_webhook_events`, `texthub_inbound_events`, `textrequest_dlr_events` (×2), `textrequest_inbound_events` |
| `CASCADE` | `send_attempts` |

Nothing blocks or restricts. Event tables keep their raw payloads and lose only the correlation
pointer.

**⚠️ But `opt_out_attributions.stage_send_id` going NULL is the real constraint on the window.**
Deleting a send destroys the link between an opt-out and the message that caused it, which the
opt-out-rate breaker and per-stage reporting read. So retention must sit **outside every window that
reads attributions**: the breaker's 24h, the delivery report's 14-day cap, the reports rollup's
14-day rolling window, and the offer/EPC reports.

**Proposed retention: 180 days, by scheduled DELETE, oldest-first, in bounded batches.** Comfortably
outside every window above, and at ~19M rows/yr it holds the table near **9–10M rows / ~7 GB** in
steady state rather than growing without bound. **Not built in Phase 5** — proposed as its own small
card, because it is a destructive recurring job and deserves its own approval and its own dry-run.

### ✅ Finding 4 — the cheapest real win is index write-amplification, not storage

Indexes (1,503 MB) already **exceed the heap** (1,325 MB). At 23–37M rows/yr the dominant cost of
each new row is updating 16 indexes, not the tuple itself. Two are candidates:

| index | size | scans | note |
|---|---|---|---|
| `stage_sends_phone_carrier_sent_day_idx` | 35 MB | **28** | near-unused |
| `stage_sends_org_provider_phone_sent_idx` | 238 MB | 189 | the `sent_from_provider_phone` segment rule — rare but genuinely used |

**Recommendation: review those two on their own card, not in Phase 5.** Dropping an index used 189
times is exactly the kind of thing that should not ride along inside a send-path change.

### G10 verdict

**Entry gate satisfied, with the retention work carved out as a separate card.** Nothing about drip
requires partitioning; drip roughly doubles a growth rate that already needed a retention answer by
September. Phase 5 adds no new index to `stage_sends`.

---

## 2. How drip stages coexist with regular stages — and the discovery that makes G1 work

### ⭐ The drain and the scheduler are already mutually exclusive on one column

| selector | requires |
|---|---|
| **Phase A** (materialize, `scheduled.ts`) | `materialized_at IS NULL` **and** `sent_at IS NULL` |
| **Phase B** (drain, `drain.ts`) | `materialized_at IS NOT NULL` **and** (`sent_at IS NOT NULL` or due) |

So **a drip stage created with `materialized_at` and `sent_at` already stamped is invisible to
Phase A and permanently drainable by Phase B.** Pending rows inserted at any later time are picked up
because Phase B's only freshness condition is `EXISTS (… status='pending')`.

**This is what makes G1 achievable with neither file modified.** It also avoids the known
`sent_at` two-writer hazard by never leaving `sent_at` as a live fire-lock on a drip stage — for
drip it is a one-time "this stage is open for business" stamp, set at activation.

The other Phase B predicates are all satisfiable by configuration: `link_mode='tracked'`,
`status='active'`, `send_paused IS NOT TRUE`, `send_approved=true`, provider not paused,
`sends_enabled IS NOT FALSE`.

### Screens and queries

Drip stages live in `campaign_stages`, so **per-campaign** screens are naturally scoped — a regular
campaign's stage list can never show a drip stage. 14 modules read `campaign_stages` org-wide; they
are overwhelmingly **reporting** (delivery, performance, stage-funnel, click-report, keitaro,
snapshots). Drip sends are real sends and *should* appear there — this is correct by default, not
breakage.

The stage **editor** is the surface that needs type-awareness: a drip stage has a daily window
instead of a `scheduled_at`, no materialize button, and an activation toggle. Proposed as a
conditional branch keyed on `campaign.type`, with the regular path untouched.

**⚠️ And it must go in the LIVE component.** Phase 4 nearly put a control into
`CampaignFormFields`, which is imported by no page. The stage editor's live component will be traced
the same way before any UI is written.

---

## 3. Per-lead rendering vs. the compliance gate

### ⚠️ The gate is stage-level today, and drip would bypass it entirely

The opt-out-language backstop lives in `kickoff.ts`: it resolves the footer once
(`resolveOptOutFooter`), renders one body, and refuses the whole stage with
`missing_opt_out_language` if no STOP keyword survives. **Drip does not call kickoff** — it renders
per lead and inserts `stage_sends` directly. Left as-is, **the gate would simply never run for drip.**

### The gate is already per-message capable

`optOutGateSubject({ renderedBody, resolved, providerKnownAppendedText })` takes **a rendered body**
and returns `{ subject, verifiable }`. It is only *called* once per stage; nothing about it is
stage-shaped.

### Proposal

The drip scheduler runs the identical chain **per rendered message**, before each insert:

1. `resolveOptOutFooter(...)` — number > provider > stage > default, resolved **once per stage per
   tick**, and the winner used for **both** the body and the gate (the Q3 rule: resolving twice lets
   the gate validate one string while another ships);
2. `buildStageSms(...)` per lead;
3. `optOutGateSubject(...)` on **that** body;
4. **fail closed per message**: `verifiable === false` ⇒ refuse the row, always, for every provider.
   No STOP keyword ⇒ refuse for `txr`; other providers dry-run + alert, matching today's carve-out
   exactly.

**⚠️ Refusal is per-row, not per-batch** — one bad render must not block 199 good leads, and a
refused lead stays routed so the next tick retries after a fix.

The launch number is `txr`, where the gate is **enforced** rather than dry-run. That is a point in
favour of 114 for a first live test.

---

## 4. Design

### 4.1 Drip stages

`campaign_stages` gains three nullable columns, all NULL for every regular stage:

```
window_start_min  smallint   -- minutes past ET midnight, inclusive
window_end_min    smallint   -- exclusive
drip_active       boolean    -- the activation toggle
```

Minutes-since-ET-midnight rather than `time` because the comparison is arithmetic on a local
wall-clock and never needs a date. Server validation: ≤5 first-send stages per campaign, and windows
that neither overlap **nor touch** (`09:30–14:00` + `14:00–18:30` is an error — the spec wants
13:59 or 14:01). The editor warns on gaps but does not block them.

**Same-offer-same-creative completes here**: with drip stages existing, "would receive the same
creative" finally has an operand, so the Phase 4 marker `creative_check: "deferred_p5"` is removed
and the rule enforced against the campaign's active first-send creatives.

### 4.2 Number selection and rotation

New `drip_campaign_numbers (campaign_id, provider_phone_id, daily_limit)`. The picker offers **only
the campaign brand's numbers** — reusing the Phase 1 brand→number guard, so the constraint is one
rule, not two.

Rotation: **next number with headroom today (ET)**, headroom = `daily_limit − sends today on that
number for this campaign`. All exhausted ⇒ state-transition Telegram alert and the journeys simply
wait for the next ET day. **No overflow onto an unlisted number**, ever.

### 4.3 Scheduler

`/api/cron/drip-scheduler`, 1-minute, `withCronLease('drip-scheduler')`, heartbeat watched by
`drip-monitors`. **Posture off ⇒ exits immediately after one read.**

Per tick: due journeys → pick the stage whose window covers now (else the next opening via
`nextWindowOpenAtOrAfter`) → check campaign latch, daily cap, campaign cap → pick a number with
headroom → render + gate + mint → insert `stage_sends` pending → **the existing drain sends them.**
A missed tick is caught by the next one; everything is due-time-in-DB.

**Also fixes the P3 gap**: `drip-monitors` is currently unwatched. `drip-scheduler` will check its
heartbeat, giving the same mutual dead-man arrangement `tells-sweep`/`tells-monitors` uses.

### 4.4 Caps, and the P4 handover

`daily_cap` becomes **live here, at send time, per ET day**, using the ET-day-as-timestamptz-**range**
form (never a functional predicate on `sent_at` — R15). Telegram warn at ≥90%.
`routing_daily_admission_cap` stays at routing. `campaign_cap` gets a final check before insert,
because routing and sending are separated in time.

### 4.5 Opt-out monitor and the breaker (G7 / R13)

- New per-drip-campaign, per-ET-day monitor: **≥7% warn, ≥10% set the drip latch** + Telegram with
  an "accept risk and proceed" action that clears **only** the drip latch.
- `checkOptOutRateBreaker` becomes type-aware. **⚠️ Fail toward existing behaviour, normatively:**
  only a positive, successful read of `type = 'drip'` may take the new path. NULL, unknown, or an
  unreadable type ⇒ **the existing breaker, unchanged**. It has four live callers, all opt-out
  ingesters, all compliance-critical.

---

## 5. Migration proposal — **STOPPING HERE**

Next number **0164**.

| # | Contents |
|---|---|
| **0164** | `campaign_stages`: `window_start_min`, `window_end_min`, `drip_active` (all nullable, NULL for every existing row) |
| **0165** | `drip_campaign_numbers (campaign_id, provider_phone_id, daily_limit)` + RLS |
| **0166** | `drip_campaign_configs.daily_cap` becomes enforced — no schema change, but the **P4 UI label changes from "not yet enforced" to live**, so it ships in the same PR |

No new index on `stage_sends` (G10).

---

## 6. Production proof plan (for approval with the design)

**Posture stays OFF in production.** The proof runs in two parts:

1. **Dormant-in-production**: migrations applied, scheduler deployed, `posture=false` ⇒ scheduler
   exits without reading journeys; regular sends continue untouched. Assert live blast volume
   unchanged across the deploy.
2. **camman-v2 preview, posture ON, `SEND_ENABLED=false`**: full pipeline with synthetic leads —
   window matching, next-opening slip, number rotation and exhaustion, daily cap at 90% and 100%,
   campaign cap, latch honoured before insert, **per-message gate refusing a creative with no STOP
   while its siblings still send**, and the R13 test (a regular campaign and an unreadable-type
   campaign both still trip the breaker).

**Exit gate — regular campaigns unaffected:** `selectDrainableStages` and Phase A's selector return
byte-identical row sets before and after, on the same production snapshot; plus a shape test pinning
that neither query's SQL changed.

**No live sends** until your explicit go, after Dmytro confirms Telnyx funding and launch numbers.

---

## 7. Rollout plan for first live sends

1. **Dedicated drip number first, if volume is wanted.** Recorded on the card: phone 114 is
   currently carrying **19.5K–24.5K sends/day** of blast traffic, so the ~1–2K/day shared-number
   ceiling sits *on top of* that, sharing carrier reputation and the same 20,000 `max_sends_per_run`.
2. **LumZen drip campaign** (114 is brand 142; the Phase 1 rule enforces it).
3. One partner, sandbox → live, **single-digit** first send with the campaign cap set to match.
4. Ramp only after a clean opt-out rate over a full ET day.
5. Drip latch and org posture are the two stop buttons; the per-provider breaker stays on top.

---

## 8. What I have NOT done

No code, no migrations, no branch. Two read-only probes (deleted). Posture untouched
(`drip_enabled=false`). Awaiting approval of the design and **0164–0166**.
