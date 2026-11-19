# Engagement refresh: no org-wide recount during the ET working day — plan (APPROVED 2026-11-17, build after the 05:00 UTC Task 1 measurements — see §8)

**Status:** draft 2026-11-17. Written from source and today's `postgres_logs`; no user-table queries.

**Goal:** between 08:00 and 22:00 ET, the 15-minute `refresh-contact-engagement` tick recounts only the contacts touched in its window. It never escalates to a whole-org recount. The full recount stays nightly (06:35 UTC), and the incremental behaviour outside 08:00–22:00 ET is unchanged.

**Out of scope:** the evaluator (`lib/engagement/status-sql.ts`), thresholds, the nightly full run, the Group × Lifecycle and day rollups, and every reader.

---

## 1. Why (measured 2026-11-17)

- From 14:40 UTC, every tick escalated to a full recount, because the touched set (sends + scored human clicks in `[last success − 30 min, now]`) went over `INCREMENTAL_MAX_TOUCHED = 20,000` ([lib/engagement/refresh.ts:170-178](../../../lib/engagement/refresh.ts)).

  | Tick (UTC) | eng_clicks | eng_facts |
  |---|---|---|
  | 14:40 | 37 s | 45 s |
  | 14:59 | 93 s | 163 s |
  | 15:17 | 106 s | 312 s |
  | 15:31 | 148 s | 234 s |
  | 15:41 | 63 s | (running) |

  No run was cancelled.
- The same thing happened at 15:00–17:00 UTC on 11-16. This is the afternoon send burst, not today's PRs.
- Effect: each run reads all of `stage_sends` and `clicks` and walks `contact_engagement`. contact_engagement heap hit fell to **32.8%** over 13:58–15:43 UTC (64 GB read), the snapshot's working set was evicted, and campaign create slowed down.
- Escalation exists because the per-contact path took more than 270 s at 43,448 touched contacts (2026-09-23). At that point the bounded set-based pass was cheaper. That trade is right at night and wrong during the working day.

## 2. What the send path reads from these tables

Only these values are read at selection or send time:

| Reader | Table.column | Rule |
|---|---|---|
| `lifecycleExclusionLayers` → `suppressed` ([lib/sends/eligibility.ts:200-207](../../../lib/sends/eligibility.ts)) | `contacts.lifecycle_status` | `= 'suppressed'` |
| `lifecycleExclusionLayers` → `freeze_not_due` ([eligibility.ts:219-228](../../../lib/sends/eligibility.ts)) | `contact_engagement.status`, `.last_sent_at`, `.freeze_cadence_days` | `status = 'freeze' AND last_sent_at > now() − cadence` |
| `offerRuleLayers` → `offer_limit`, `offer_cooldown` ([eligibility.ts:283-305](../../../lib/sends/eligibility.ts)) | `contact_offer_campaigns` rows (`contact_id, offer_id, campaign_id, last_sent_at`) | count of campaigns per offer; `last_sent_at > now() − Y days` |
| Send-time recheck ([lib/sends/lifecycle-recheck.ts:117-140](../../../lib/sends/lifecycle-recheck.ts)) | `contacts.lifecycle_status`, `contact_engagement.status`, `.freeze_cadence_days` (+ live `stage_sends`) | same as above |
| Audience snapshot / preview chips ([lib/audience-snapshot.ts](../../../lib/audience-snapshot.ts)) | `contacts.lifecycle_status`, `contact_offer_campaigns` | selection, same values |

`status` and `lifecycle_status` are themselves computed from `msgs_since_click`, `last_click_at`, the freeze clock (`freeze_entered_at`, `freeze_started_at`, `freeze_msgs`) and `time_due_at`. So the comparison set is:

- `contact_engagement.(status, last_sent_at, freeze_cadence_days, freeze_entered_at, freeze_started_at, freeze_msgs, msgs_since_click, last_click_at, time_due_at)`
- `contacts.lifecycle_status`
- the full `contact_offer_campaigns` row set for the contact

The send path does **not** read `msgs_7d`, `msgs_14d`, `msgs_30d` or `msgs_90d`. They are rolling windows and already drift for untouched contacts between nightly runs, as today.

## 3. Why the values are identical by construction

For a contact in the recount set, both paths run the same `refreshContactEngagement` steps 2–8:

- the same human-click aggregate
- the same send aggregate over the contact's **full history**, as of the same `asOf`
- the same offer aggregate
- the same thresholds
- the same evaluator and the same writes

The only differences between the two paths:

1. **Which contacts are recounted.**
   - Full: everyone.
   - Daytime path: the contacts with a send or a newly scored human click in the window.

   An untouched contact's inputs did not change. Its stored row equals what a recount would produce, except where time alone changes the status (hot→warm, warm→cold, freeze→suppressed). That case is already handled: both modes also evaluate every row with `time_due_at <= asOf`. This is today's incremental contract and is unchanged.
2. **How sends are joined.**
   - Full: `stage_sends` by `contact_id`.
   - Per-contact: `(org_id, phone, contact_id)` through `stage_sends_org_phone_sent_idx`.

   These differ only for a send whose `phone` is not the contact's current `phone_number`. On 2026-09-22 that count was 0. It is re-measured in Task 1. If it is not 0, those contacts are listed and the nightly full run keeps correcting them, as today.

## 4. Design

### 4.1 Time-sliced incremental

The change is in `refreshContactEngagement` and the cron route.

- **New option `until: Date`** (incremental only). It is the upper bound of the touched window. It is separate from `asOf`, the evaluation instant, which stays `now()`. Today both are `asOf`.
- **New option `noEscalate: boolean`, required** (§11b: it decides who is recounted, so every caller states it). With `true`, the `> maxTouched` branch never switches to full. The nightly full caller and the backfill script pass `false`, with a comment saying why.
- **The route, during the ET working day** (`isCampaignDaytime(tickAt)`):
  - It loops over **time slices** of the window `[watermark − 30 min overlap, now]`. Each slice is sized so its touched set is at most `DAYTIME_SLICE_MAX_TOUCHED` (start at 5,000; Task 1 measures the per-contact cost).
  - The slice end is found by counting touched contacts per 5-minute bucket. Sends go through `stage_sends_org_sent_at_idx (org_id, sent_at)`. `clicks.scored_at` has **no index**, but today's incremental tick already filters on it every 15 minutes. Task 1 measures that query's cost. If it matters, an index becomes a separate migration on your go; it is not part of this plan.
  - Each slice is **its own transaction**: recount the slice's touched set, commit, then advance the `contact-engagement` watermark to that slice's `until`. A burst is then worked through over several ticks without ever redoing finished slices.
  - **The time-due evaluation** (`time_due_at <= asOf`) runs once per tick, in the last slice.
  - **Budget:** stop starting new slices after 540 s of the 800 s function. The lease (14 min) still prevents overlap. The remainder is picked up next tick from the advanced watermark.
  - **No stale fallback to full during the day.** The 3-hour `FULL_FALLBACK_HOURS` rule applies only outside 08:00–22:00 ET. During the day, a lagging watermark keeps slicing.
- **Outside 08:00–22:00 ET:** exactly today's code path, a single window with escalation allowed.
- **Heartbeat:** `contact-engagement` is stamped when a tick finishes caught up (its last slice reached `now`). The existing watcher thresholds are checked in Task 2 so a long burst does not page falsely. A tick that ends behind logs `lag_minutes`.

### 4.2 Why not just raise `INCREMENTAL_MAX_TOUCHED`

A single 40K-contact per-contact transaction is exactly what timed out on 09-23. With slices, every transaction stays bounded no matter how big the burst is.

## 5. Proof the send-path values are identical

### 5.1 New `scripts/test-engagement-daytime-slices.ts` (preview DB, throwaway org)

- **World:** about 60 contacts in four groups covering every lifecycle branch (new, cold, freeze due and not due, suppressed, hot, warm, a hot→warm time-due case), two offers × three campaigns, and a send burst spread over 90 minutes plus late-scored clicks.
- **From the same starting state S0** (same outer transaction, savepoint rollback between paths):
  - **path A:** daytime slices, with `DAYTIME_SLICE_MAX_TOUCHED = 7` to force several slices
  - **path B:** one full recount at the same `asOf`
- **Bars:**
  - **S1:** for every contact, the §2 comparison set is identical between A and B, and `contacts.lifecycle_status` is identical.
  - **S2:** the `contact_offer_campaigns` rows are identical as sets.
  - **S3:** the eligibility layers (`lifecycleExclusionLayers`, `offerRuleLayers`), evaluated on both states, return identical contact sets per layer key.
  - **S4:** A never ran an org-wide pass. It took at least 3 slices, and no slice's touched set exceeded 7.
  - **S5:** the watermark advanced per slice. A run killed after slice 2 (simulated by throwing) leaves the watermark at slice 2's end, and the next run starts there.
  - **S6:** outside the daytime window, the route still escalates above `maxTouched` (today's behaviour).
  - **S7:** a time-due-only contact (hot→warm by age) transitions in A exactly as in B.
- **Red-prove:** a mutated path A that skips the time-due pass fails S1/S7. One that drops the overlap fails S1.

### 5.2 Existing suites stay green

`test-engagement-db.ts` (A, B, C), `test-offer-limit-cooldown`, `test-preview-matches-snapshot`.

### 5.3 Production check (read-only, 05:00–06:00 UTC)

- **Phone-mismatch count:** sent `stage_sends` whose phone is not the contact's `phone_number`, for the same `contact_id`. This is the only source of divergence (§3).
- **Per-contact recount cost:** `dryRun` (temp tables only, no writes) of the daytime path over a real 15:00–15:45 UTC window from 11-17, to size `DAYTIME_SLICE_MAX_TOUCHED`.

## 6. Tasks

1. **Window measurement (05:00–06:00 UTC):** phone mismatches; touched contacts per 5 minutes for 11-16/11-17 afternoons; per-contact recount ms from a dry run.
   *Verify:* numbers written into this plan; slice size chosen.
2. **Code:** `until` + `noEscalate` (required) in `refresh.ts`; slice loop, budget, daytime gating and the watermark per slice in the route; constants in `lib/engagement/constants.ts`.
   *Verify:* `tsc` 0 (the compiler lists every caller that must state `noEscalate`); lint on changed files; the §5 suites on the preview DB, with S1–S7 green and red-proven.
3. **Docs:** 04-features/contact-lifecycle.md (cadence: daytime slices, nightly full), crons.md, 07-conventions.md (no org-wide pass during the ET working day), CHANGELOG.
4. **Ship:** one PR, no migration. Merge on green, and confirm the prod deployment is on the merge SHA.
5. **Post-deploy (next working-day afternoon):** from `postgres_logs`, no `eng_facts`/`eng_clicks` statement over 30 s between 12:00 and 02:00 UTC; heartbeat fresh; `lag_minutes` logged. The next morning: contact_engagement heap hit over the day vs today's 32.8%.

## 7. Risks

- **A very large burst lags for a few ticks.** The statuses the send path reads are then up to about an hour behind for the contacts in the unprocessed slices. Today, during an escalated run, they are equally behind for the 4–8 minutes each run takes, and a failed run puts them hours behind. The send-time recheck reads live `stage_sends` for the freeze cadence, so that check is never stale.
- **Many small transactions instead of one.** Each is bounded, and none holds a connection for more than its slice.

## 8. Owner decisions — APPROVED 2026-11-17

- **Build order:** the build starts after the Task 1 measurements of the 2026-11-18 05:00 UTC window.
- **Added — lag alert:** a Telegram alert when a daytime tick ends with `lag_minutes > 60`. It is latched, so one alert per episode, and it clears when a tick finishes caught up. This goes in Task 2, with a test bar: **S8**, lag 61 pages once; lag 59 and a caught-up tick page nothing.
- **Added — no false page on a normal burst:** the `contact-engagement` heartbeat is stamped only when a tick ends caught up. So the watcher's max-age for it must be above the 60-minute lag alert, otherwise a normal burst pages twice. Task 2 sets it from Task 1's measured burst length and adds bar **S9**: a simulated 45-minute burst (three ticks behind, then caught up) pages neither the heartbeat watcher nor the lag alert.
- **Post-deploy report:** the afternoon numbers (no `eng_*` statement over 30 s from 12:00 to 02:00 UTC, the largest `lag_minutes`, and contact_engagement heap hit over the day) against 11-17's **32.8%**.
