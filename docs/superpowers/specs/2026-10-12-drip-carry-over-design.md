# Drip carry-over ("Send leads") — design

_Status: approved by the owner 2026-10-12. Ships OFF ("Same day only") everywhere._
_Base: origin/main 58d6ee16 (after #335/#336/#338/#341), plus #342 (0203, cutoff ≤ 1439)._

## 1. Goal

A per-campaign setting (with an account default) that lets a drip lead **not admitted on its
arrival ET day** stay eligible and be admitted on the following day(s), instead of being skipped by
the freshness rule. The setting generalises freshness: **"Same day only" is today's behaviour,
byte-for-byte**, and is the default for every existing and new campaign.

Ship the switch, do not turn it on. The owner turns it on per campaign when they want to test it,
and judges it with the same-day vs carried split in the journey funnel.

## 2. Facts this design rests on (verified 2026-10-12)

1. **Freshness gates ADMISSION, not messaging.** It is the `freshness` rule in
   `lib/drip/routing-eval.ts`. Once a journey is `routed`, `lib/drip/scheduler.ts` sends it at the
   next open first-send window with no staleness test. So "carry a lead to tomorrow" = "admit it
   tomorrow"; scheduler, caps, stages, link minting and the per-message compliance gate are
   unchanged. **No new send path.**
2. **An expired lead has no durable record** — only a `lead_events.drip_recheck_at` stamp. It is
   kept out solely by the routing worker's scan floor (`lib/drip/routing.ts`), which is recomputed
   from the current settings every tick. Any widening of the window moves the floor back and
   re-admits leads that already expired.
3. Prod: 45,337 Oct-10 leads (backlog) and 26,717 Oct-11 leads have no journey. Both drip
   campaigns (1606, 1637) have `admission_cutoff_minutes = NULL`, org cutoff 0.
4. **Admission caps bind**: 1606 cap 20,000/day, 1637 10,000/day; Oct-11 had 48.5K arrivals, 21.5K
   admitted. Priority between fresh and carried leads is a real constraint, not theoretical.
5. A drip journey's sends inherit the journey (first send + behavioural lanes), so marking the
   journey marks everything downstream.

## 3. Decisions (owner, 2026-10-12)

| # | Decision |
|---|---|
| D1 | Priority = **ordering + yesterday-based reserve** (option B, §6) |
| D2 | N is capped at **7** days |
| D3 | **Carried = admitted (routed) on a later ET day than arrival.** An evening admission texted next morning stays "same day", as today |
| D4 | V1 reporting split = **journey funnel only**. Partner report internal view = follow-up |
| D5 | The 1439-minute cap on "Admission closes" ships separately, now (#342 / 0203) |
| D6 | A raise (e.g. 1 → 2 days) may DROP pending carries of earlier arrivals; it must never REVIVE anything |
| D7 | The widened-at time gating the scan floor is mandatory: the Oct-10/11 leads (and anything already skipped) never enter the scan under any setting value |

## 4. Data model — migration 0204 (additive)

| Column | Type | Meaning |
|---|---|---|
| `org_settings.drip_carry_days` | `int NOT NULL DEFAULT 0`, CHECK 0–7 | Account default. 0 = same day only |
| `org_settings.drip_admission_widened_at` | `timestamptz NULL` | Last time the org's admission window got LONGER |
| `drip_campaign_configs.carry_days` | `int NULL`, CHECK NULL or 0–7 | Per-campaign override; NULL = account default |
| `drip_campaign_configs.admission_widened_at` | `timestamptz NULL` | Last time this campaign's effective window got LONGER |
| `drip_journeys.carried_days` | `smallint NOT NULL DEFAULT 0`, CHECK ≥ 0 | ET days between the lead's arrival and its admission. Written once at insert. `> 0` ⇔ carried |

`ADD COLUMN … NOT NULL DEFAULT <const>` is metadata-only on PG ≥ 11, so `drip_journeys` is not
rewritten. Migration leads with `SET LOCAL lock_timeout = '5s'`.

### 4.1 The admission window

```
window_minutes(campaign) = carry_days × 1440 + cutoff_minutes
   carry_days     = cfg.carry_days            ?? org.drip_carry_days            (0..7)
   cutoff_minutes = cfg.admission_cutoff_minutes ?? org.drip_admission_cutoff_minutes (0..1439, 0203)
widened_at(campaign) = GREATEST(cfg.admission_widened_at, org.drip_admission_widened_at)   -- NULLs ignored

admission closes for lead L =
   end of L's arrival ET day + (L.received_at >= widened_at OR widened_at IS NULL
                                  ? window_minutes
                                  : 0)
```

- With `carry_days = 0` everywhere and `widened_at` NULL (every row after the migration) the
  formula is exactly today's: end of arrival day + cutoff.
- **A lead that arrived before the last widening gets window 0** (midnight of its arrival day) —
  the smallest window that has ever existed, so anything that expired under any earlier setting is
  still expired (D6, D7). It also covers the cutoff, closing what 0203 only bounded.
- A **narrowing** takes effect immediately for everyone (the formula is evaluated live). Turning
  carry off stops pending carries on the next tick.
- Using GREATEST of org and campaign widened_at is deliberately conservative: an org-default raise
  also resets a campaign that overrides it. Only drops, never revives.

### 4.2 Who stamps `widened_at` — a trigger, not the API

`BEFORE INSERT OR UPDATE` triggers on both tables compute old vs new effective window and set the
stamp to `now()` when it grows:

- `drip_campaign_configs`: effective window resolves NULLs against the org row. INSERT with a
  window > 0 stamps (a new or duplicated campaign never inherits history). UPDATE stamps when
  `new_window > old_window`.
- `org_settings`: stamps when `carry_days*1440 + cutoff` grows.

Why a trigger: the org default has no screen (same as freshness today) and is changed by SQL; the
duplicate route inserts configs with explicit `values()`. A trigger covers every writer, including
ones that don't exist yet. The guarantee in D7 must not depend on each writer remembering.

## 5. Routing changes (`lib/drip/routing-eval.ts`, `lib/drip/routing.ts`)

### 5.1 Evaluator
- Read `cfg.carry_days`, `cfg.admission_widened_at`, `org.drip_carry_days`,
  `org.drip_admission_widened_at` alongside the cutoff columns already read.
- `freshness` uses §4.1. Detail string names carry days, cutoff, and — when the lead predates the
  widening — "arrived before the window was widened at …; same day only".
- Expose on each candidate `carried: boolean` = now's ET day > arrival ET day (used by §6).

### 5.2 Scan floor (D7 — mandatory)
Per live/paused drip campaign (plus the org default for completeness):
```
W = window_minutes(c)
floor(c) = widened_at(c) IS NULL
             ? dayStart(now - W)                                   -- = today's formula when carry is 0
             : max(dayStart(now - W), min(widened_at(c), dayStart(now)))
org floor = min over live/paused campaigns of floor(c)
```
Leads that arrived before `widened_at` only have window 0 (their arrival day), so they can only be
in scope if they arrived today; a widening earlier today therefore floors at today's midnight.
Leads below the floor are never selected, so the Oct-10/11 leads (arrived before any widening) can
never enter the scan. Pinned by a test that asserts **zero evaluations** of pre-widening leads.

### 5.3 Candidate order (D1, part 1)
```
ORDER BY (received_at < dayStart(now)),          -- carried candidates last
         (drip_recheck_at IS NOT NULL),          -- #335: never-evaluated first
         CASE WHEN received_at < dayStart(now) THEN -epoch(received_at)   -- carried: newest first (day-1 before day-2)
              ELSE epoch(received_at) END        -- fresh: oldest first (unchanged)
```
With carry off the first key is always false for admissible leads, so today's ordering is preserved.

### 5.4 Reserve (D1, part 2)
`loadCampaignJourneyCounts` adds `reserve` per campaign: journeys with `carried_days = 0` routed
**yesterday from this time of day to midnight** (`routed_at ∈ [now − 24h, dayStart(now))`).
Admission-cap rule:
- fresh lead: `today < cap` (unchanged)
- carried lead: `today + reserve < cap`
- cap NULL ⇒ no reserve, no difference.

A carried lead blocked by the reserve fails `routing_daily_admission` (TEMPORARY) ⇒ `defer`, and is
re-checked behind fresh leads. Detail says "held back for today's fresh arrivals (reserve N)".

### 5.5 Insert
`carried_days = (routed_at AT TIME ZONE ET)::date − (received_at AT TIME ZONE ET)::date`, computed
in the INSERT. Same-day (incl. evening admissions texted next morning) ⇒ 0 (D3).

## 6. Why the reserve, in one paragraph
Ordering alone puts fresh first only within a tick. Carried leads become admissible at the start of
the next day, when few fresh leads exist yet, so they would take cap that afternoon arrivals need.
The reserve holds back yesterday's same-time-onward fresh volume, self-adjusting, with no new knob.
It is an estimate: an unusually heavy afternoon can still find the cap spent. Accepted.

## 7. UI and API

- **Drip settings → Freshness box**, next to "Admission closes": a `<Select>` **"Send leads"**:
  `Account default (…)` / `Same day only` / `Also 1 day later` / `Also up to N days later` + a
  number input 2–7 when the last is picked. Helper text (owner's wording): "Leads not messaged on
  their arrival day are dropped from this campaign, or kept and messaged on the following day(s)."
- `PUT /api/campaigns/[campaignId]/drip-config`: `carry_days` int 0–7 | null | omitted, with the
  #338 partial-save semantics (omitted = keep, null = account default). GET returns `carry_days`,
  `org_carry_days`.
- Duplicate route copies `carry_days`; the trigger stamps `admission_widened_at` at duplication.
- Account default: column only, no screen (mirrors freshness today).
- "Why not routed" shows the new freshness detail with no extra work (same evaluator).

## 8. Reporting — journey funnel split (D4)

`getDripFunnel` gains `split: { same_day: SplitRow, carried: SplitRow, unmatched_sales: number } | null`
(null when the campaign has no carried journey — the section is hidden):

| Field | Definition (per group, Total/lifetime) |
|---|---|
| routed | journeys in the group |
| sent | `first_send_at IS NOT NULL` |
| clicked | `COALESCE(tier,0) >= 1` (same `campaignTierExpr` as progression) |
| CTR | clicked / sent |
| sales | purchase `conversion_events` (same `purchasedClause`) attributed to the contact's journey in this campaign with the latest `routed_at <= occurred_at` |

`same_day + carried` equals the progression row for routed/sent/clicked; for sales,
`same_day + carried + unmatched_sales` equals `converted` (a sale with no matching journey is shown,
not dropped). UI: a compact two-row table under the progression block in
`components/drip/journey-funnel.tsx`, Total only (Today stays event-based and unsplit).

## 9. Conflicts with the Oct-11 routing changes

| PR | Touchpoint | Resolution |
|---|---|---|
| #335 | scan floor | §5.2; floor respects widened_at |
| #335 | candidate ORDER BY | §5.3 extends it; never-evaluated-first kept within each group |
| #335 | per-tick counts | §5.4 adds `reserve`; counts still incremented in-tick |
| #335 | 15-min re-check | carried leads blocked by the reserve re-check every 15 min behind fresh ones; at 600/tick a large carried pool lags, it does not block fresh leads |
| #338 | panel partial save | `carry_days` follows the same omitted/null rules |
| #338/R25 | duplicate route | copies `carry_days`; trigger stamps |
| #336 | follow-ups / drain | untouched |

## 10. Test plan

Preview DB (camman-v2), each script in a rolled-back transaction or throwaway org:

1. **Unit** `scripts/test-drip-admission-window.ts`: the §4.1 function — carry 0 + widened NULL
   equals today's `freshUntil` for a grid of arrival times / cutoffs / DST days; pre-widening lead
   ⇒ midnight; narrowing applies to everyone.
2. **Trigger** (same script, DB part): stamps on raise of carry, of cutoff, of the org default seen
   by an inheriting campaign, and on INSERT with window > 0; does NOT stamp on lowering or on
   unrelated column updates.
3. **Routing** `scripts/test-drip-carry-over.ts` with leads on D-2, D-1, D:
   - carry 0: only D admitted, routed leads identical to the pre-change worker;
   - raise to 1 at T: D-1 leads before T never evaluated (evaluation count = 0); D-1 leads after T
     admitted on D with `carried_days = 1`;
   - backlog fixture (500 leads 2 days old, no journey) is never evaluated under carry 0, 1 and 7;
   - cap 10, 8 fresh + 5 carried, reserve 0 ⇒ 8 fresh + 2 carried (8+0<10, 9+0<10, then 10);
     reserve 3 ⇒ 8 fresh + 0 carried (8+3 ≥ 10); fresh leads ignore the reserve (8 fresh with
     reserve 9 ⇒ all 8 admitted);
   - lowering to 0 ⇒ no carried admission on the next tick.
4. **Funnel** `scripts/test-drip-funnel-split.ts`: halves sum to progression; sales + unmatched sum
   to converted; split is null with no carried journeys.
5. **Regression** (must pass unchanged): `test-drip-routing-queue`, `test-drip-stop-controls`,
   `test-drip-regular-unaffected`, `test-drip-geo-exclude-mode`, `test-campaign-duplicate-type`,
   `test-drip-enrichment-throughput`, `test-drip-item6-queues`.
6. **Prod after deploy** (read-only): all configs `carry_days` NULL, org 0, widened_at NULL;
   routing tick summaries unchanged vs the previous hour; new journeys `carried_days = 0`; funnel
   for 1606 shows no split section.

## 11. Out of scope

Partner report split (follow-up), a separate day-2 stage/creative, an account-default screen,
re-admitting any lead that arrived before a widening, any backfill.
