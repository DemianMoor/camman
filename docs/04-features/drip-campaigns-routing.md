# Drip campaigns and routing (Phase 4)

_Last updated: 2026-10-13 (hourly send cap; the edit screen is type-gated)_

A second campaign **type**, and the worker that assigns each partner lead to exactly one drip
campaign. **Zero sends** — a journey is an assignment, not a message. The scheduler is Phase 5.

> **Later phases.** Journey lifecycle, behavioural lanes and the **journey
> funnel** (routed → sent → clicked → offer → converted, plus outcomes grouped on
> `(state, close_reason)`) are Phase 6/7 — see
> [drip-partner-reporting.md](drip-partner-reporting.md). Note in particular that
> the **Ignored lane is terminal**: it closes its journey `completed`/`unengaged`
> in the same transaction as the lane send.
>
> **2026-09-18 (conversion-events Phase 4).** The behavioural tier scale gained
> **Registered** as tier 3 and the purchased exit moved to tier 4, but the funnel
> above is unchanged and gained **no Registered step**: `reached offer` still
> counts registrants (they did reach it) and only `converted` moved, from
> `tier >= 3` to `tier >= 4`, so a $0 registration is no longer a conversion. See
> [drip-partner-reporting.md](drip-partner-reporting.md) and
> [behavioral-lanes.md](behavioral-lanes.md).
>
> Three consequences for drip specifically, none of which changes who receives a
> message:
>
> 1. **There is NO Registered drip follow-up, and that is a decision, not a
>    gap.** `FOLLOWUP_TIERS` ([`lib/drip/children.ts`](../../lib/drip/children.ts))
>    stays `[0, 1, 2]` and `FollowupTier` stays `0 | 1 | 2`, so no tier-3 child
>    can be created. `runDripFollowups` matches a contact to a child on **exact**
>    tier, so a registrant (tier 3) falls into `tierMismatch` for every 0/1/2
>    child and nothing sends — the intended no-op. The detection ladder in
>    [`lib/drip/followups.ts`](../../lib/drip/followups.ts) has no `WHEN 3` arm
>    for the same reason, and its `ELSE NULL` **fails closed**: `followupDueAt`
>    answers `no_detection`, so an unarmed tier can never send. ⚠️ Adding a
>    `WHEN 3` "to be safe" is not a safety fix — it is precisely how a Registered
>    follow-up would SEND — and a tier-3 child armed only there would hang for
>    ever, because the reachability predicate below waits on it (`3 >= 3`) while
>    nothing can send it. Both halves are pinned by
>    [`scripts/test-drip-followup-timing.ts`](../../scripts/test-drip-followup-timing.ts).
>
> 2. **A registrant's journey now COMPLETES.** `closeCompletedJourneys()` and
>    `expireJourneysPastEndDate()` ([`lib/drip/lifecycle.ts`](../../lib/drip/lifecycle.ts))
>    ask "is an active behavioural child still owed a send?", and a child BELOW
>    the contact's tier can never be owed. Each carries an **inline copy** of the
>    tier ladder rather than importing `campaignTierExpr` — they need the tier
>    correlated per journey row (`j.campaign_id` / `j.contact_id`) while the
>    shared fragment takes a literal campaign id. While those copies topped out
>    at 2, a registrant matched no child (0/1/2) yet the tier-2 child was still
>    judged reachable, so the journey never completed — and because
>    `drip_journeys_one_live_per_contact_uniq` keys on `state IN ('routed','active')`
>    it held that contact's **only** live-journey slot against every future
>    journey too. A buyer has the identical shape and survives only because
>    `closeJourneysOnPurchase` closes those separately; **there is no registration
>    analogue and none is being built.** Both copies now span tiers 1–4 and are
>    pinned byte-identical to the original by bars `P20`–`P26` in
>    [`scripts/test-campaign-tier-scale.ts`](../../scripts/test-campaign-tier-scale.ts).
>
> 3. ⚠️ **Tier 3 is the one NON-MONOTONIC value on the scale, and drip is where
>    that bites.** Every other branch only adds a signal, so a tier can only
>    rise; tier 3 can be **revoked**, because a later *rejected* purchase drops
>    that contact back to their click / offer-reach tier (see
>    [behavioral-lanes.md](behavioral-lanes.md)). A journey already CLOSED at
>    tier 3 is never reopened — `close()` guards `state IN ('routed','active')`
>    and `runDripFollowups` filters `j.state = 'active'` — so that contact
>    silently loses the 0/1/2 follow-ups they would now qualify for. **The same
>    final ledger state therefore produces two different outcomes depending on
>    postback order versus sweep timing.** This is accepted (owner's ruling: the
>    rule that a rejected buyer is not a registrant is worth more than the edge),
>    not a bug to be fixed by dropping the `NOT EXISTS` — dropping it re-admits a
>    rejected buyer to the Registered lane, which is the thing the rule exists to
>    prevent.

Card `869endku0` · migrations **0159–0163** · recon:
[2026-08-23-drip-phase-4-routing-recon.md](../superpowers/specs/2026-08-23-drip-phase-4-routing-recon.md)

## Shape

| Thing | Where |
|---|---|
| Campaign type | `campaigns.type` — `'regular'` (default) or `'drip'`. The **only** column this phase adds to `campaigns` |
| Drip settings | `drip_campaign_configs`, 1:1 (PK = `campaign_id`) |
| Assignments | `drip_journeys` |
| Runtime flags | `org_settings.drip_enabled` (posture) + `drip_paused` (latch) |
| Worker | `/api/cron/drip-routing`, 1-minute, `withCronLease('drip-routing')`, watched by `/api/cron/drip-monitors` |

`campaigns` gains exactly one column on purpose: the claim this phase must prove is "regular
campaigns are unaffected", and that is only provable if the disturbance is small enough to
enumerate.

## R14 — regular campaign activation is unchanged, by construction

The in-use set is built in one place in the activation path (`iu_set`). Drip extends it, which
touches the path every regular activation runs through.

**The drip branch is emitted only when drip posture is on.** With posture off — every org today —
the builder returns character-for-character the SQL it returned before Phase 4, so the planner
receives the same query and cannot produce a different plan.

The alternative — always UNION an empty branch — preserves the original subplan exactly but adds an
outer dedup pass, measured at **9,959 → 11,292, about +13%**. "Unchanged" does not mean a 13% delta
somebody re-justifies at each review.

| | plan |
|---|---|
| baseline (pre-P4) | `HashAggregate` → `Nested Loop` → 2 index scans, cost 9,959 |
| after, posture **off** | identical nodes/indexes/join order; cost differs only with the data (14 → 19 active campaigns) |
| posture **on** | the same subplan, plus `Append` → `Index Only Scan` on `drip_journeys_one_live_per_contact_uniq` (cost 2.35) |

[scripts/test-drip-in-use-sql-shape.ts](../../scripts/test-drip-in-use-sql-shape.ts) freezes the
pre-Phase-4 text and asserts **both** directions.

**⚠️ G2 touches two files.** `iu_set` and `applyInUseExclusion` (the per-segment flag) were
independent definitions that agreed by coincidence. Both now call the one builder in
[lib/drip/in-use.ts](../../lib/drip/in-use.ts).

## One campaign per contact is an invariant

`drip_journeys` carries `UNIQUE (org_id, contact_id) WHERE state IN ('routed','active')`.

Everything else about routing — tag match, filters, priority, tie-break — is **policy**, living in
code that can be raced or called twice. The index is what makes the central rule of the spec a
**database guarantee**. The worker inserts optimistically and treats `23505` as "lost the race,
skip": it is allowed to be optimistic precisely because the index is pessimistic.

Partial on the live states, so a `completed`/`exited`/`unroutable` journey frees the contact for
re-entry — which the >1-week rule requires.

## Eligibility

Evaluated by [lib/drip/routing-eval.ts](../../lib/drip/routing-eval.ts). Global rules block every
campaign; the rest are per candidate.

| Rule | Notes |
|---|---|
| opt-out | global |
| in use | global, **both directions**: an active regular campaign's pool **or** another live drip journey |
| >1-week re-entry | global. A repeat arrival only qualifies once the contact has been in the system more than 7 days |
| interest tag | exact match, required |
| partner key | optional narrowing |
| window | `received_at ∈ [start_at, end_at)` |
| demographics | gender / age_band / state / country / income_band / kids / married — **skip-if-missing** (state/country: only in include mode, see below) |
| carrier | reuses `campaigns.audience_filters.carrier_filter` |
| same offer | offer half only — **the creative half is `deferred_p5`** |
| caps | `campaign_cap` and `routing_daily_admission_cap` |

Winner: **priority ASC, tie → newest campaign.**

**⚠️ skip-if-missing is reported as `missing`, not `mismatch`.** They need different fixes: one is a
partner sending incomplete data, the other is targeting working correctly.

**State / country include–exclude mode.** Each geo filter carries an optional mode beside its list
in the same `drip_campaign_configs.filters` JSONB: `state_mode` / `country_mode` = `"include"`
("Only these", the default) or `"exclude"` ("All except these"). No migration: a config without the
key reads as include, so existing campaigns are unchanged. The read is **positive** —
`geoFilterMode()` in [lib/drip/routing-eval.ts](../../lib/drip/routing-eval.ts) returns exclude only for
the literal `"exclude"`; missing, null or any other value is include.

| mode | lead value in list | lead value not in list | lead has no value |
|---|---|---|---|
| include | pass | `mismatch` | `missing` (skipped) |
| exclude | `mismatch` (skipped) | pass | **pass** — unknown ≠ excluded |

Exclude mode inverts the missing rule on purpose: it removes *known* matches only. An excluded
lead's reason (stored in `drip_journeys.reason` with the rest of the candidate detail) reads
`lead state=TX is in the excluded list [...] (exclude mode; a lead with no state would have
passed)`; the form shows the same rule as a helper line under the field, prefixed with the input format
(2-letter codes, comma-separated, any case, e.g. `TX, FL`); with an empty list the line reads
"Empty = any state" instead of the mode rule. The input keeps its own raw text (`ListTextInput` in
[components/campaigns/drip-audience-fields.tsx](../../components/campaigns/drip-audience-fields.tsx)) — deriving the
shown value from the parsed list round-trips every keystroke and eats a trailing comma. State/country values are
compared **case-insensitively** (both modes) because the field is free text — a typed `tx` must still
exclude `TX`. Tested by `scripts/test-drip-geo-exclude-mode.ts` (preview DB, rolled back).

**⚠️ The same-offer rule is half-implemented on purpose.** Drip stages are Phase 5, so "would
receive the same creative" has no operand. The journey `reason` records
`creative_check: "deferred_p5"` rather than silently passing, which would look implemented.

## Three caps, three windows

| Cap | Counts | When | Status |
|---|---|---|---|
| `campaign_cap` | journeys, lifetime | routing | **live** |
| `routing_daily_admission_cap` | journeys, per ET day | routing | **live**, NULL = unlimited |
| `daily_cap` | **sends**, per ET day | send time | **not enforced until P5** |

They cannot be one number: a journey routed at 23:50 ET sends the next day. Enforcing a send cap
against journeys now and against sends later would give two caps fighting over one field. The UI
labels which are live — a cap that silently does nothing looks like protection.

## Unrouted leads: permanent, deferred, expired (2026-10-11, card 869ency4b)

Every verdict without a winner is classified by `classifyRoutingOutcome`
([lib/drip/routing-eval.ts](../../lib/drip/routing-eval.ts)):

| Outcome | When | What is written |
|---|---|---|
| **permanent** | opted out; or every candidate fails a rule that cannot change today (tag, partner, window, demographic/carrier filter, same offer + creative, no config); or no live-or-paused drip campaign exists | a terminal `unroutable` row on the **first** evaluation, `reason.permanent = true` with every rule |
| **defer** | only TEMPORARY rules fail somewhere: contact in use, week rule, campaign cap, daily admission cap, campaign paused (status `paused` **or** `send_paused`) | `lead_events.drip_recheck_at = now + 15 min`; nothing else |
| **expired** | the only candidates left are past their freshness cutoff | the same re-check stamp; nothing terminal |

**Candidate order:** never-evaluated leads first (oldest first), then deferred leads whose re-check
time has passed. Up to **600 per tick**, stopping at 45 s (the route's `maxDuration` is 60 s); the
rest head the next tick.

**Why (2026-10-10):** candidates used to be "the 200 oldest leads with no journey", and an unrouted
lead got no row for 7 days. About 180 dead leads (mostly opted out) sat at the head of every batch,
and 44,968 routable ProMarketing leads behind them never got a turn. 90% of all evaluations ever run
(414K vs 41K inserts) were re-checks of dead leads. `scripts/test-drip-routing-queue.ts` reproduces
it: against the old worker, 0 of 10 good leads were routed behind 250 dead ones after 600
evaluations; now all 10 are routed after 260 (each dead lead once).

A **paused** campaign is still a candidate: it owns its tag, so a lead that matches only a paused
campaign is deferred, never "no campaign exists". Under freshness, a pause that outlasts the lead's
admission window means that lead never enters drip.

## Freshness — drip admission closes at the end of the arrival day

A lead is admitted to a drip campaign only until the **end of its arrival ET day plus a cutoff**:
`drip_campaign_configs.admission_cutoff_minutes` if set, else
`org_settings.drip_admission_cutoff_minutes` (default **0** = midnight ET). It is the `freshness`
rule in the evaluator. The worker's candidate scan starts at the earliest arrival day any live or
paused campaign could still admit, so older leads are **never evaluated and never written to**.
They stay ordinary contacts, fully usable in regular campaigns, contact groups and segments.

Evening arrivals are admitted the same day and texted the next morning when the send window opens;
that is intended (owner, 2026-10-11).

The ~45K ProMarketing leads waiting from 2026-10-10 were left exactly as they were (owner ruling, no
cleanup). They are below the floor, so routing skips them.

**Where it is set:** the campaign page's Drip settings → **Freshness** box ("Admission closes (minutes
after midnight ET)"), placeholder showing the org default. Empty = org default. The org default
(`org_settings.drip_admission_cutoff_minutes`) has no screen yet; it is 0.

**⚠️ The cutoff is capped at 1439 minutes (migration 0203, 2026-10-12).** The routing worker's
candidate floor is recomputed from the largest cutoff in play on every tick, and an expired lead has
no durable record — so RAISING the cutoff re-admits leads that already expired. Before 0203 the API
allowed 10,080 (7 days): setting 2880 on 2026-10-12 would have re-admitted ~72K skipped leads (45,337
from the Oct-10 backlog + 26,717 Oct-11 expiries). The cap bounds that to the previous ET day; it does
**not** close it — a raise still re-admits yesterday's expiries up to the new cutoff. The full guard
(an effective-from time that leads arriving earlier cannot pass) now exists — see
[Carry-over — Send leads](#carry-over--send-leads) below (migration 0204).

## Carry-over — Send leads (2026-10-12, migration 0204)

Lets a drip campaign keep a lead that was not messaged on its arrival day and admit it on the
following day(s). **Ships OFF**: every config has `carry_days` NULL, the org `drip_carry_days` is 0 and
`widened_at` is NULL, which behaves exactly as before. Spec:
[2026-10-12-drip-carry-over-design.md](../superpowers/specs/2026-10-12-drip-carry-over-design.md).

**Formula** ([lib/drip/admission-window.ts](../../lib/drip/admission-window.ts), pure, shared by the
evaluator, the scan floor and the tests):
`admission closes = end of (arrival ET day + carry days) + cutoff minutes`, with
`carry = campaign carry_days ?? org drip_carry_days` (0–7, `MAX_CARRY_DAYS`) and the cutoff as in
[Freshness](#freshness--drip-admission-closes-at-the-end-of-the-arrival-day).

**⭐ widened-at rule.** `widened_at` is stamped by DB triggers (see
[03-data-model.md](../03-data-model.md)) whenever the effective window grows. A lead that arrived
BEFORE `GREATEST(campaign, org) widened_at` gets window 0: the end of its arrival ET day, no carry, no
cutoff. Window 0 is the smallest window that ever existed, so a lead that expired under any earlier
setting stays expired. Narrowing applies immediately. A raise can drop pending carries, never revive.
Creating or duplicating a campaign with a cutoff or carry stamps it too, so it never admits leads that
expired before it existed.

**Forward-only stamps (0205).** The triggers also fire on writes to the `widened_at` columns themselves and
keep `GREATEST(OLD, NEW)`: setting a stamp to NULL or to an earlier time keeps the old value, so
already-skipped leads can never become admissible again. Test fixtures that must backdate a stamp set
the test-only escape hatch `camman.allow_widened_backdate = 'on'` with `SET LOCAL` / `set_config(…, true)`
inside a transaction ([07-conventions.md](../07-conventions.md)). A stamp set into the FUTURE by mistake is
accepted and sticks (every lead before it gets window 0 — over-restrictive, never unsafe); correct it with the
same hatch inside a transaction: `BEGIN; SET LOCAL camman.allow_widened_backdate = 'on'; UPDATE …; COMMIT;`.

**Entering active/paused stamps (0205).** A drip campaign moving INTO active or paused from draft,
completed or archived gets `admission_widened_at = now()` (trigger `campaigns_drip_status_widened`), because
the scan only considers active/paused campaigns: a long-idle campaign with carry would otherwise floor
back to its old stamp. Covers draft → active and archived/completed → active/paused. active ↔ paused
does not stamp. With window 0 the stamp changes nothing.

**Scan floor** (`scanFloor` in the same file, used by [lib/drip/routing.ts](../../lib/drip/routing.ts)):
never goes below a widening, except today's own arrivals. The Oct-10 backlog (45,337 leads) and the
Oct-11 expiries (26,717) can never re-enter under any setting.

**Candidate order** (`routing.ts`): today's arrivals first (never-evaluated before re-checks, oldest
first, unchanged), then carried leads (never-evaluated before re-checks, **newest first**, so day 1
precedes day 2).

**Reserve** (`loadCampaignJourneyCounts` / the admission cap in
[lib/drip/routing-eval.ts](../../lib/drip/routing-eval.ts)): a carried lead is admitted only while
`today's journeys + reserve < routing_daily_admission_cap`. `reserve` = same-day (`carried_days = 0`)
journeys routed yesterday, counted from now−24h to today's ET midnight. Fresh leads ignore it; a NULL
cap means no reserve. The reserve holds back yesterday's same-time-onward fresh volume: an estimate, not a guarantee; a heavy afternoon can still find the cap spent (spec §6).

**`carried_days`** is written at journey insert: ET date(routed) − ET date(arrival). Evening same-day
admissions stay 0. ⚠️ Behaviour change for cutoff-only configs: a config with `admission_cutoff_minutes
> 0` and no carry now marks after-midnight admissions `carried_days = 1` and applies the reserve to
them (before, they were admitted under a plain cap). Both live campaigns use cutoff NULL / org 0, so
nothing changes today.

**UI:** campaign page → Drip settings → **Freshness** box → **"Send leads"** select in
[components/campaigns/drip-config-panel.tsx](../../components/campaigns/drip-config-panel.tsx):
Account default / Same day only / Also 1 day later / Also up to N days later (N 2–7, validated
client-side before save and by Zod in
[lib/validators/drip-campaigns.ts](../../lib/validators/drip-campaigns.ts)). Helper text: "Leads not
messaged on their arrival day are dropped from this campaign, or kept and messaged on the following
day(s)." The account default has no screen. Duplicating a campaign copies `carry_days`
([duplicate route](../../app/api/campaigns/[campaignId]/duplicate/route.ts)). The same-day vs carried
funnel split is in [drip-partner-reporting.md](drip-partner-reporting.md#same-day-vs-carried-2026-10-12).

## Drip settings panel saves are partial (2026-10-11)

The panel PUTs tag, dates, priority, caps and the cutoff — not `partner_key_id`, `filters` or the
carrier filter. `PUT /api/campaigns/[campaignId]/drip-config` used to set every column from the body,
so **saving caps from the panel reset the campaign's partner restriction and demographic filters to
empty**. Those three fields (and `admission_cutoff_minutes`, which the campaign editor never sends) are
now **kept when omitted**; an explicit `null` still clears them. The admission cap
("Routing per day") was already on this panel and in the editor ("Daily admission"); it limits drip
admission only, which the panel now says in plain words.

## Hourly send cap (2026-10-13, migration 0209)

Caps how many **first sends** a drip campaign makes per ET clock hour, so a burst of leads is paced
instead of sent at once. **Ships OFF**: `hourly_cap` NULL on every config, `hourly_carry` false and
`org_settings.drip_hourly_cap_enabled` false behave exactly as before. Spec:
[2026-10-13-drip-hourly-send-cap-design.md](../superpowers/specs/2026-10-13-drip-hourly-send-cap-design.md).
Code: pure rules in [lib/drip/hourly-cap.ts](../../lib/drip/hourly-cap.ts), the per-run pass in
[lib/drip/hourly-maintenance.ts](../../lib/drip/hourly-maintenance.ts), the room gate in
[lib/drip/scheduler.ts](../../lib/drip/scheduler.ts).

**Setting.** Two fields in the Caps box, shown only while the org flag is on: **Hourly send cap**
(positive integer or empty = unlimited; saved by `PUT /api/campaigns/[campaignId]/drip-config`, omitted =
keep the stored value) and **Carry unsent leads to the next hour** (default OFF). The daily send cap still
applies; both bind. **Follow-ups are not subject to the cap** and never count toward it: it is lead
pacing, and per-number headroom covers provider throughput.

**Hour semantics.** The hour key is `date_trunc('hour', <utc instant>)`
([hourStartOf](../../lib/drip/hourly-cap.ts)), never a local-time truncation: ET boundaries are whole-hour
offsets, so UTC hours are ET hours and the DST fall-back 01:00 ET stays two distinct hours. Each unsent
routed journey carries `hour_start` + `hour_fresh` (both NULL = **waiting**, on no clock):

- **Fresh** (`hour_fresh = true`): routed while one of the campaign's first-send windows
  (`parent_stage_id IS NULL`, `drip_active`, half-open `[start, end)`) covered its routed ET minute,
  during the current hour. Assigned regardless of room; its clock starts when it became sendable.
- **Waiting**: routed outside every window, or reverted. Released into the current hour only into spare
  room, as `hour_fresh = false` (backlog).
- `sentH` = the campaign's journeys with `first_send_at` in `[H, H+1h)`, counted from the DB every run
  (restart-proof). Sends this hour never exceed `min(cap - sentH, daily room)`.

**Per-run pass** (`prepareHourly`, inside the scheduler lease, before the due query). First, org-wide,
`clearIneligibleHourAssignments`: org drip off/paused, flag off, campaign not `active` / `send_paused`, or
cap removed => assignments revert to waiting. Then per capped campaign:

1. **Assign fresh** to the current hour.
2. **Able to send?** `send_paused`, org drip halt, lifetime `campaign_cap` reached, or no number with
   headroom. If not: revert the campaign's assignments to waiting, room 0, **skip step 3**.
3. **Close past hours (OFF only).** Released backlog reverts to waiting (never dropped). Fresh unsent leads
   of a past hour H: a send refusal recorded in H => dropped `blocked`; otherwise, with `B` = backlog first
   sends in H and `U` = the remaining fresh unsent, the **newest** `min(U, B)` are demoted to waiting (the
   backlog took their slots) and the oldest `U - B` dropped: `cap` if H's first sends reached the cap, else
   `closed`.
4. **Release backlog** (only while a window is open), oldest `routed_at` first. OFF:
   `min(cap - sentH - freshUnsent, ceil(cap x minutesIntoHour / 60) - sentH)` (fresh-first, backlog paced
   over the hour). ON: `cap - sentH - assignedUnsent`.
5. **Room** = `cap - sentH`. For a capped campaign `selectDueJourneys` takes only assigned journeys
   (`hour_start <= current hour`), ordered ON `hour_start, routed_at` (queue first) / OFF
   `hour_fresh DESC, routed_at`; the send loop stops at the room. A full campaign contributes no rows, so
   it never takes batch slots.

> **The code differs from the spec on two points (documented here on purpose).** (1) The spec's section 4
> listed "close past hours" before the "able to send?" check; the code checks first and skips the close when
> unable, because a stop control must never cause a drop, even at the hour boundary (owner invariant).
> (2) "Backlog sent in hour H" counts first sends in `[H, H+1h)` of journeys with `hour_fresh = false` with
> **no condition on their `hour_start`**, so a send loop straddling :00 is credited correctly.

**Combinations** ("daily carry" = `carry_days`, routing admission on later days):

| Hourly carry | Daily carry | Behaviour |
|---|---|---|
| OFF | 0 | Routed on the arrival ET day only. A fresh lead must send within its hour, else dropped (cap / closed / blocked). Waiting leads (evening arrivals, reverts) are released into spare room, paced, fresh-first, never dropped. |
| OFF | N > 0 | Also routed on later days. A carried lead routed inside a window is a fresh lead of its routed hour: the day admits it, the hour can still drop it. |
| ON | 0 | Nothing dropped by the hour; unsent leads queue into later hours (queue first, oldest first, fresh behind), spilling into later days when windows close. No age limit. |
| ON | N > 0 | As above, plus carried routing. |

**Drop.** `state = 'expired'`, `closed_at = now()`, `close_reason` = `missed_hour_cap` (hourly cap full) /
`missed_hour_closed` (window closed / daily cap before its turn) / `missed_hour_blocked` (send refused by
gate or mint), and `reason.missed_hour = {hour_start, cap, cause, sent_in_hour, backlog_sent_in_hour}`.
Closing frees the one-live-per-contact slot, so the contact is usable in regular campaigns again; the
contact row is never touched and the lead event is not re-offered to another drip campaign.
`blocked` is told apart from `cap`: when the per-lead transaction rolls back on `MintRefused` /
`GateRefused` for a capped campaign, `recordSendRefusal` writes `reason.last_send_refusal = {kind, at}`
outside it (no write for uncapped campaigns). Any `blocked` drop fires the alert
`drip:missed_hour_blocked:<campaign>:<hour>`.

**Stop controls never drop.** Pause, org drip halt/off, flag off, cap removed, lifetime cap, no number
headroom: assignments revert to waiting and resume later with zero drops. **Carry ON -> OFF** on save
reverts unsent journeys with `hour_start` before the current hour (`applyHourlyCarryTransition`, in the
same transaction as the PUT): the queue becomes backlog, not a mass drop. A lowered cap needs no handling;
the lower room applies from the next run.

> **Open owner question.** A stage whose `drip_active` is turned off mid-hour is **not** treated as a stop
> control: windows are built from `drip_active` stages only, so its unsent fresh leads can later drop as
> `missed_hour_closed`. Whether stage-off should revert instead is undecided.

**Reporting.** Funnel outcomes get three labels ("Dropped — hourly cap full", "... window closed / daily
cap before its turn", "... send blocked (gate/mint)"), in [lib/drip/funnel.ts](../../lib/drip/funnel.ts). The
**Hourly cap panel** ([components/drip/hourly-cap-panel.tsx](../../components/drip/hourly-cap-panel.tsx),
only for a capped campaign with the org flag on) shows sent this hour / cap, due this hour, queued from
earlier hours, waiting, oldest unsent age, and 7 ET days of drops by cause. **Why not routed**
([app/api/drip/why-not-routed/route.ts](../../app/api/drip/why-not-routed/route.ts)) returns `close_reason`
and `reason.missed_hour` and renders "missed its hour". Not in the Daily results rollup in v1.

## Per-tick journey counts

The cap rules read journey counts per campaign. The worker loads them **once per tick**
(`loadCampaignJourneyCounts`) and increments them as it inserts, so the admission cap holds within a
tick. The debugging tool passes no counts and reads them per call, as before. The
"creatives already received" lookup now runs only when the contact has an exposure to the
campaign's offer, the only case the creative rule reads it. On production one evaluation went from
**78.6 ms / 47,932 buffers to 7.8 ms / 114 buffers** (EXPLAIN ANALYZE, lead 431198a6, 2026-10-11).

**⚠️ An `unroutable` row has `campaign_id = NULL`** (migration 0163). It matched nothing, so naming
a campaign would inflate that campaign's journey count and mislead the debugging tool. A CHECK keeps
`campaign_id` mandatory for every other state.

**⚠️ An `unroutable` row also needs `closed_at`** — `drip_journeys_closed_at_check` requires it on every
state other than `routed`/`active`. The insert in [lib/drip/routing.ts](../../lib/drip/routing.ts)
omitted it until 2026-10-06, so the first aged-out lead failed with 23514 and threw out of the batch.
Candidates are oldest-first, so that one lead headed every batch and **stopped all routing** — found
the moment drip posture was first switched on, by an Aug-24 internal-test lead.

## First-send stages vs. behavioural lanes

A **first-send stage** is a drip stage with `parent_stage_id IS NULL`; its daily window decides which
stage a newly routed lead gets first, so active first-send windows may not overlap or touch. A
**behavioural lane** (`parent_stage_id` set — Ignored / Clicked / Offer) is NOT a first-send stage: it
sends its `drip_followup_minutes` timer after its parent's signal (`lib/drip/followups.ts`), inside the
provider's send hours, and has no window of its own.

**⚠️ Every first-send selector must filter `parent_stage_id IS NULL`.** Until 2026-10-07 the scheduler's
stage query ([lib/drip/scheduler.ts](../../lib/drip/scheduler.ts)) and the window guard
([lib/api/drip-stage-window-guard.ts](../../lib/api/drip-stage-window-guard.ts)) did not. No lane had
a window, so `pickStage` dropped them — but the stage editor showed lanes the window fields, and the
first operator to set a creative on a lane hit "Windows overlap" against the parent. Had the window
saved, the lane would have become a first-send candidate and new leads could have got the Clicked
message as their FIRST SMS. Now: the scheduler excludes lanes, the guard skips a lane being saved and
leaves lanes out of the sibling set, the editor shows a lane a note instead of window fields (so a
lane's creative is set from its Stages-table row with no window involved), and the Stages table shows
a lane's own state (`Needs a creative` / `Lane on` / `Lane off`) instead of the first-send readiness
badge, which would call every lane "No window".

## Scheduler batch: per-campaign fairness (2026-10-12, migration 0207)

The scheduler ([lib/drip/scheduler.ts](../../lib/drip/scheduler.ts)) turns at most 200 routed journeys
per run into pending first sends. `selectDueJourneys` picks them in one of two orders:

- **`org_settings.drip_scheduler_fair = false` (default, the old order):** the 200 **oldest** routed
  journeys org-wide. One campaign's backlog takes every slot. On 2026-10-12, campaign 1637 was
  un-paused with ~11.7K routed journeys, and campaign 1683's fresh leads waited up to **20 min**
  (p90 routed→queued 1,259 s) behind them.
- **`true`:** round-robin across campaigns. Each campaign's journeys are ranked oldest first
  (`row_number() OVER (PARTITION BY campaign_id ORDER BY routed_at, id)`), and the batch takes
  rank 1 of every campaign, then rank 2, and so on. A campaign with 5 fresh leads gets all 5 in the
  next batch, whatever another campaign has queued.
  - Within a campaign the order is unchanged.
  - A paused or window-closed campaign still takes its share and skips it in the per-campaign loop,
    but it can no longer hold the others back.
  - The ranking reads only narrow `drip_journeys` rows and then joins the 200 it keeps: 166 ms on a
    79K-row proxy, ~50 ms on prod's current (empty) queue.

Proof: `scripts/test-drip-scheduler-fairness.ts` (preview DB). It reproduces the starvation with the
flag off (B gets 0 of 200), then checks that all of B's 5 make the batch with it on. Pairs with the
[poke chain](drip-poke-chain.md), which removes tick waits; this removes queueing behind another
campaign.

## Routed leads (campaign page)

The drip campaign page shows a **collapsed** "Routed leads" header with the lifetime journey count.
Expanding it reveals an **Export CSV** button — the page no longer lists journeys inline (the old list
showed the latest 50 with each one's raw routing JSON, which stopped being readable at real volume).

`GET /api/campaigns/[campaignId]/drip-journeys/export`
([route](../../app/api/campaigns/[campaignId]/drip-journeys/export/route.ts)) streams EVERY journey
of the campaign, newest first: phone, journey status, close reason, routed / first-sent / closed
times, partner, interest tag, lead received time, line type and US state. Times are ET wall-clock
`yyyy-MM-dd HH:mm` so the file sorts in a spreadsheet. `campaigns.view`; operator-denied in the
route map like the rest of drip. `/drip-journeys` itself now returns only `{ funnel }`.

## "Why not routed"

`/drip/why-not-routed` → [components/drip/why-not-routed.tsx](../../components/drip/why-not-routed.tsx).

**It calls the same evaluator the router calls.** A separate explain-path would be a second
implementation of the rules, and the first time they drifted the tool would confidently explain a
decision that never happened.

It distinguishes where a number got stuck, because the causes and fixes differ completely:

| stage | meaning |
|---|---|
| `never_seen` | intake never received it — partner isn't posting, or the key is sandbox |
| `stuck_before_contact` | intake got it, enrichment dropped it (landline?) |
| `contact_without_lead_event` | exists, but not from partner intake |
| `evaluated` | routing considered it — every rule's verdict is shown |

The live evaluation can differ from a stored journey's `reason`: the reason records what was true at
routing time. **That difference is usually the answer.**

## Duplication (R25)

The duplicate route builds its insert as an explicit `values()` literal, so any column it does not
name silently takes its default — a duplicated drip campaign came back **regular**. It now carries
`type` **and** copies the config row: copying `type` alone yields a drip campaign with no config,
which the router skips, i.e. a duplicate that silently never routes. Guarded by
[scripts/test-campaign-duplicate-type.ts](../../scripts/test-campaign-duplicate-type.ts), which
checks the route's source text as well as the behaviour.

## Not built here

Number selection (P5), stages and the scheduler (P5), sends (P5), behavioural follow-ups (P6), the
pause button's wiring (P5 — the list shows type only), and the creative half of the same-offer rule.

## Stop controls: what halts drip sends, and where

Three switches stop drip messages. Each is checked by **the drain** (`lib/sends/drain.ts`, the
only code that calls a provider) before it claims anything AND between every batch of 50, so a
switch flipped mid-burst stops sending within one batch — up to 49 messages of the batch already
in flight still go out. Rows left behind stay `pending` and resume when the switch is cleared.

| Switch | Column | Drain stop reason |
|---|---|---|
| Campaign "Pause sending" | `campaigns.send_paused` | `paused` (refusal `campaign_paused`) |
| Org drip posture OFF | `org_settings.drip_enabled = false` | `drip_halted` |
| Org drip paused | `org_settings.drip_paused = true` | `drip_halted` |

The drip switches are read by `isDripSendingHalted` (`lib/sends/circuit-breakers.ts`): true for a
**drip** campaign when posture is off or paused, and always false for a regular campaign. **Before
2026-10-11 the drain never read the drip switches** — only the scheduler did, which merely queues
rows — so turning drip off left already-queued drip rows sending. The scheduler and follow-ups also
re-read both the campaign latch and the drip switches right before queuing (the follow-ups gate
used to read `drip_enabled` only, so `drip_paused` never stopped follow-ups).

Intake, lookup and enrichment never read any of these switches: leads keep arriving and being
stored while sending is stopped. Routing stops admitting new journeys while the org drip switches
are off, but keeps admitting under a campaign pause, so journeys accumulate for that campaign.

Proof: `scripts/test-drip-stop-controls.ts` (preview DB) — a 200-row drip burst through the real
drain with an injected sender, each control flipped after message 10: 50 sent / 150 pending for
each, a regular campaign unaffected. Against the previous code, posture OFF and drip paused sent
all 200.

## Activation and the drainable stamp

A drip campaign is **exempt from the contact-group launch requirement** in both
the create validator and the `draft → active` status route, and its activation
skips `snapshotAudience`: the frozen `audience_snapshot_count` is `0` and
`campaign_audience_pool` stays empty for that campaign forever. That is correct,
not a degenerate case — the audience arrives afterwards, one lead at a time, and
the drip in-use branch reads `drip_journeys`, never the pool. The exemption is a
positive read of `type === 'drip'`; NULL or an unrecognised type keeps the
requirement.

Reaching `active` is not optional: routing
([lib/drip/routing-eval.ts](../../lib/drip/routing-eval.ts)), the scheduler
([lib/drip/scheduler.ts](../../lib/drip/scheduler.ts)) and the drain
([lib/sends/scheduled.ts](../../lib/sends/scheduled.ts)) all filter on it.

`stampDripStageDrainable` (exported from the scheduler) sets `send_approved`,
`materialized_at` and `sent_at` on the drip stage in the **same transaction** as
the first `stage_sends` insert, so the existing drain picks the rows up with no
change to `drain.ts`. It is idempotent, refuses any stage whose `drip_active` is
not `TRUE`, and fills `sent_at` only when NULL — see
[docs/07-conventions.md](../07-conventions.md) for why that column cannot be
assigned.

## Per-lead link minting

Drip is one lead at a time, so it mints one tracked link per lead rather than
reusing a stage-wide URL. [lib/drip/mint.ts](../../lib/drip/mint.ts) resolves the
destination from the stage's landing page and the campaign brand's
`landing_host`, picks the short domain with the shared `resolveShortDomainForSend`,
and calls `mintLink` — all inside the same transaction as the `stage_sends`
insert.

**No link, no send.** If the landing page, the brand host, the short domain or
either tracking ID cannot be resolved, the lead is skipped, counted in
`mintRefused`, and logged with the reason; the journey stays `routed` so the next
tick retries after the configuration is fixed.
