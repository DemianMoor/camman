# Drip Phase 6 — recon: behavioural follow-ups + journey lifecycle

Card: [Drip P6](https://app.clickup.com/t/869endm13) · parent [Drip Campaigns](https://app.clickup.com/t/869ency4b)
Date: 2026-08-24 · Status: **recon complete, awaiting rulings**

Everything below was read from source or measured against production. Where a
claim came from the card, it is marked **verified** or **corrected**.

---

## 1. The three recon questions

### Q1 — How does tier detection latency map to timer starts?

| Tier | Signal | Timestamp column | Stamped from | Detection lag |
|---|---|---|---|---|
| 1 clicked | `clicks` row | `clicks.clicked_at` | **`DEFAULT now()`** at the `/r/` request | **none — real time** |
| 2 reached_offer | `stage_sends.offer_reached_at` | Keitaro **event** datetime | poll `12,27,42,57` | ≤15 min + network |
| 3 converted | `stage_sends.converted_at` | Keitaro **event** datetime | poll `9,24,39,54` | ≤15 min + network |

**Verified:** `lib/keitaro/poll-offer-reaches.ts:188` and `poll-conversions.ts:235`
both write `(v.dt \|\| ' ' \|\| CAMPAIGN_TIMEZONE)::timestamptz` — the **event**
time from Keitaro, not the poll time. `clicks` has no explicit `clicked_at` in
its INSERT (`lib/links/resolve-click.ts:79`), so it takes the column default
`now()` — request time.

**⚠️ The consequence, and it is the central design problem of this phase.**
A timer defined as "time since detection" cannot key off `offer_reached_at` or
`converted_at`, because those are already in the past when we learn of them. With
the measured p50 of 146 min to offer-reach, a 60-minute Offer timer computed from
`offer_reached_at` is **already expired at the moment of detection** — the
follow-up would fire immediately on the next tick, not 60 minutes later. The
operator sets 60 minutes and gets zero.

Tier 1 is exempt: click detection *is* the event.

⇒ **Tiers 2 and 3 need a detection timestamp that does not exist today.** See D1.

### Q2 — What closes or cancels pending behavioural sends today?

**Opt-out cancellation is already complete and drip inherits it for free**,
because drip sends are `stage_sends` rows (G1). Five sites converge on one
terminal shape:

- `lib/sends/drain.ts:587` — claim-time re-check
- `lib/sends/poll-opt-outs.ts:330`, `textrequest-optout.ts:253`,
  `tells-optout.ts:206`, `ahoi-optout.ts:247` — cascade-cancel at ingest

all setting `status = 'skipped_opted_out', last_error = 'opt_out_cancel'` with

```sql
WHERE org_id = … AND contact_id = … AND status = 'pending'
```

— **contact-scoped, every pending row, org-wide**, which is exactly the briefed
"opt-out cancels everything pending for that contact". Nothing to build.

**Nothing else cancels a pending send.** There is no cancellation on conversion,
on campaign end, or on journey termination. Those are new in this phase.

### Q3 — Does the 5×3 children model need migration to `campaign_stages`, or a separate table?

**Neither a new table nor new linkage — both already exist and are in live use.**

`campaign_stages` already carries `parent_stage_id` and `behavioral_tier`, and
production holds **536 lane children**: 161 at tier 0, 188 at tier 1, 187 at
tier 2 (690 rows have `behavioral_tier NULL` — ordinary stages).

The regular-campaign lane machinery is already the model this phase needs:

- `lib/sends/recipients.ts:135` LEFT JOINs `campaignTierExpr` and selects
  `coalesce(bt.tier,0) = behavioral_tier`, with an explicit `<> 3` guard so
  **converted never appears in any lane** — matching "a buyer exits the journey".
- `lib/sends/child-slip.ts` already gates a child on parent completion, with a
  bounded slip and a 24h hold cap.
- Ignored / Clicked / Offer map **exactly** onto tiers 0 / 1 / 2.

**What is genuinely missing is the timer.** Regular lanes are scheduled with an
absolute `campaign_stages.scheduled_at` chosen by the operator. Drip needs a
*per-contact relative* offset from that contact's own detection moment. There is
no delay/offset column anywhere on `campaign_stages`.

---

## 2. Journey lifecycle — what exists

`drip_journeys.state` CHECK today allows exactly:

```
'routed' | 'active' | 'completed' | 'exited' | 'unroutable'
```

**`completed` and `exited` are dead states** — they appear only in
`db/schema.ts:4422`. The single `UPDATE drip_journeys` in the entire repository
is the scheduler's `routed → active` (`lib/drip/scheduler.ts:334`). This is the
Phase 5 check that failed.

The briefed terminal set is `opted_out · converted · completed · expired ·
exited`. Of those, **`opted_out`, `converted` and `expired` are not in the CHECK
at all** — the constraint must be widened, not merely used.

**Why terminal states matter beyond tidiness:** the partial unique index

```
drip_journeys_one_live_per_contact_uniq (org_id, contact_id) WHERE state IN ('routed','active')
```

means every contact ever routed holds that slot **permanently** today. Freeing it
on a terminal transition is what allows the contact to be routed again later.

**End-date semantics already half-exist:** `routing-eval.ts:263` refuses a lead
whose `received_at >= cfg.end_at`, so "after `end_at`, no first-sends" is already
true. What is missing is the transition to `expired` once follow-ups finish.

**⚠️ `exited` on campaign *deletion* is unreachable as briefed.**
`drip_journeys.campaign_id` is `ON DELETE CASCADE` (migration 0161), so a hard
delete removes the journey row rather than leaving one to mark. Only **archive**
(the project's soft-delete convention, §6) leaves a journey to transition. See D3.

---

## 3. Proposed migrations

Additive only; no destructive change; no backfill that rewrites live rows.

**0167 — journey lifecycle**
```sql
ALTER TABLE drip_journeys ADD COLUMN closed_at    timestamptz;
ALTER TABLE drip_journeys ADD COLUMN close_reason text;
-- widen the state vocabulary (drop + recreate the CHECK)
--   routed | active | completed | exited | unroutable
-- + opted_out | converted | expired
```
The partial unique index needs no change: it keys on
`state IN ('routed','active')`, so any new terminal value frees the slot by
construction.

**0168 — behavioural children**
```sql
ALTER TABLE campaign_stages ADD COLUMN drip_followup_minutes smallint;
ALTER TABLE drip_campaign_configs ADD COLUMN behavioral_enabled boolean NOT NULL DEFAULT false;
```
`drip_followup_minutes` is NULL on every existing row, so nothing changes for the
536 live lane children. Campaign-level on/off defaults **false** — behaviour
preserved.

**0169 — detection timestamps (shape depends on D1)**
```sql
ALTER TABLE stage_sends ADD COLUMN offer_reached_detected_at timestamptz;
ALTER TABLE stage_sends ADD COLUMN converted_detected_at     timestamptz;
```
⚠️ `stage_sends` is at **3.47M rows**. Two nullable columns with no default and
no index is a metadata-only change in PG 11+, so it does not rewrite the table —
but this is the table the send path reads twice a minute, so it wants confirming
rather than assuming.

---

## 4. Decisions needed before build

**D1 — where the detection timestamps live.**
(a) Two nullable columns on `stage_sends` (above): the timestamp sits beside the
event it detects, the pollers stamp it in the same UPDATE they already run, and
`campaignTierExpr` needs no reshaping. Cost: two columns on a 3.47M-row table.
(b) A separate `drip_tier_detections(journey_id, tier, detected_at)` table:
leaves `stage_sends` untouched, but adds a join to every timer query and a second
place where "when did we learn this" is defined.
**Recommendation: (a)** — one fact, one row, and the pollers already write there.

**D2 — backfill for the 3 existing journeys.** Measured now:

| Number | State | Tier | Opted out | Proposed |
|---|---|---|---|---|
| +18262062523 | active | **1** clicked | no | stays `active` |
| +18144007479 | active | — | **yes** | → `opted_out`, `closed_at` = its opt-out time (12:31:50Z) |
| +15642155963 | active | — | no | stays `active` (the ready-made Ignored case) |

Exactly one row becomes terminal. Proposed as a one-off idempotent script keyed
on the opt-out, not a migration.

**D3 — `exited` on delete vs archive.** Hard delete cascades the journey away, so
only archive can produce `exited`. Confirm archive is the intended trigger.

**D4 — the Ignored-lane guard.** An Ignored timer must not fire while a
not-yet-polled offer-reach could reclassify the contact. The floor should be the
poll cadence plus a margin — proposed: **the Ignored timer may not elapse until
at least one full offer-reach poll cycle (15 min) has completed after the
first-send**, independent of the operator's chosen 1–24h value. This only ever
delays; it cannot cause a send. Confirm, or set a different floor.

---

## 5. Production proof plan (with the build)

Reuses campaign 994 and the Personal Numbers, per the standing rule that a
fixture is never a live entity:

- **+15642155963** — untouched, tier 0 ⇒ the ready-made **Ignored** case.
- **+18262062523** — already tier 1 (clicked 12:29:50Z) ⇒ **Clicked** lane; must
  provably *not* enter Ignored (the card's first exit criterion).
- **+18144007479** — opted out ⇒ proves `opted_out` terminal + slot freed.
- Purchase/`converted` exit is verified against `purchasedClause()` on a
  synthesized `sale_status='lead'` row in a rolled-back probe, since we cannot
  make a real purchase — **and `'lead'`, not `'sale'`, is the whole point.**

Posture stays **OFF** until that proof.
