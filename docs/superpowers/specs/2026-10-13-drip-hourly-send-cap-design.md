# Drip hourly send cap — design

Status: APPROVED by the owner 2026-10-13 (proposal + rulings R1–R6 below). Base: origin/main 24980a52.

## Owner rulings (verbatim intent)

- **R1 Fresh-first under OFF.** Fresh arrivals take the hour's slots first; waiting/backlog leads release only into spare room and are **never dropped**. A fresh lead must never be dropped in favour of the backlog. Under ON, queued-first (oldest first, fresh behind the queue) stays — nothing drops there.
- **R2 No queue age limit in v1.** Queue size and oldest-lead age are shown on the funnel.
- **R3** A lead routed in a window's last minutes that misses its hour under OFF is dropped. Accepted.
- **R4** Leads refused by the compliance gate / link mint are dropped after their hour under OFF — but the drop reason distinguishes **"cap full"** from **"blocked by gate/mint"**, and blocked drops must be visible (a broken mint must not hide inside normal missed-hour counts).
- **R5** The UI field appears only when the org flag is on.
- **R6** Behavioural follow-ups are NOT subject to the hourly cap — the cap is lead pacing; per-number headroom covers provider throughput.

## 1. Setting

Per drip campaign, in the Caps box next to "Daily send cap":

- **Hourly send cap** — positive integer or empty. Empty = no hourly limit (today's behaviour). Caps **first sends** per ET clock hour. The daily send cap still applies; both bind.
- **Carry unsent leads to the next hour** — checkbox, default OFF.

Org kill switch `org_settings.drip_hourly_cap_enabled` (default false). While false: the scheduler ignores every hourly setting, the UI hides both fields, and every assignment is cleared (§4 step 0), so turning it on later never acts on stale state.

## 2. Facts the design rests on

1. Daily freshness / carry-over (`lib/drip/admission-window.ts`) gates **routing admission only**. A routed journey never expires; daily-cap overflow waits in `routed` and sends the next day.
2. The scheduler is single-flight (`cron_locks` lease; pokes reuse it, `lib/drip/poke.ts`). A DB-derived count cannot be overshot by a concurrent run.
3. ET clock-hour boundaries = UTC hour boundaries (whole-hour offsets). The hour key is `date_trunc('hour', ts)` on the UTC instant — DST-safe; the fall-back 01:00 ET stays two distinct hours.
4. Routing defers leads for paused campaigns (`campaign_paused` is a temporary candidate rule), so a lead is not routed into a paused campaign.

## 3. A lead's hour

Two new journey columns: `hour_start timestamptz` (the UTC instant of the clock hour the lead is on) and `hour_fresh boolean` (true = assigned by its own routing time; false = released backlog). Both NULL ⇒ **waiting**, not on any clock. CHECK: both NULL or both set.

- **Fresh lead** — routed while one of its campaign's first-send windows covered the routed ET minute (half-open `[start, end)`, `parent_stage_id IS NULL` stages only). `hour_start = date_trunc('hour', routed_at)`, `hour_fresh = true`, assigned regardless of room. Its clock starts when it became sendable.
- **Waiting lead** — routed outside every window, or reverted (below). Not accumulating. Released into the **current** hour only into spare room (§5), `hour_fresh = false`.
- **Revert to waiting** (clear both columns on unsent routed journeys) when the campaign cannot send for a reason that is not the lead's: org drip paused/off, hourly flag off, campaign not `active`, `send_paused`, hourly cap removed, campaign lifetime cap reached, no number with headroom. Stop controls never cause a drop.
- **Window closes or daily cap fills mid-hour** — assignments stay. Under OFF the unsent fresh ones are processed at hour end (R3: "stricter wins").

## 4. Per-run algorithm (scheduler, before the due query)

0. **Clear ineligible** — one org-wide statement: revert every unsent routed journey with `hour_start IS NOT NULL` whose org is paused/off/flag-off or whose campaign is not active / `send_paused` / has `hourly_cap IS NULL`.
For each active campaign with `hourly_cap` (org flag on, org not paused):
1. **Assign fresh** — unassigned unsent journeys routed inside a window **during the current hour** ⇒ `hour_start = current hour`, `hour_fresh = true`. The current-hour bound is what keeps a reverted lead (§3) from being re-clocked to its old routed hour and dropped on resume; the cost is that a lead routed in an earlier hour that no run ever assigned (a cron gap of a whole clock hour) becomes backlog instead of being dropped — the lenient side.
2. **Close past hours (OFF only)** — for each past hour H with unsent journeys (`hour_start < current hour`):
   - released backlog (`hour_fresh = false`) ⇒ revert to waiting (never dropped, R1);
   - fresh, with a send refusal recorded during H ⇒ **drop, cause `blocked`**;
   - remaining fresh, sorted `routed_at` ascending: let `B` = backlog first sends in H. The **newest** `min(U, B)` are **demoted** to waiting (the backlog took their slots, so they are not dropped — R1); the oldest `U − B` are **dropped**, cause `cap` if first sends in H ≥ cap, else `closed` (window closed / daily cap filled before their turn).
3. **Unable to send now** (no number with headroom, lifetime cap reached) ⇒ revert all of the campaign's unsent assigned journeys; skip the campaign.
4. **Release backlog** (only if a window is open now): waiting journeys oldest `routed_at` first, `hour_start = current`, `hour_fresh = false`, count:
   - OFF: `min(cap − sentH − freshUnsentH, ceil(cap × elapsedMin / 60) − sentH)` — fresh-first, and backlog paced evenly over the hour so a late fresh burst still finds room;
   - ON: `cap − sentH − assignedUnsent` (queue + current).
5. **Room** — `min(cap − sentH, daily room)`; the scheduler sends at most that many of this campaign's first sends this run.

`sentH` = journeys with `first_send_at ∈ [hourStart, hourStart+1h)` for the campaign — counted from the DB every run (restart-proof, like the daily cap). Follow-ups never count (R6).

### Send order among assigned journeys (`hour_start <= current hour`)

- ON: `hour_start, routed_at` — the queue first, oldest first; this hour's fresh arrivals behind it.
- OFF: `hour_fresh DESC, routed_at` — fresh first, backlog fills.

### Drop write

`state = 'expired'`, `closed_at = now()`, `close_reason ∈ {missed_hour_cap, missed_hour_closed, missed_hour_blocked}`, `reason = reason || {"missed_hour": {"hour_start", "cap", "cause", "sent_in_hour", "backlog_sent_in_hour"}}`. `hour_start` is kept for audit. No CHECK change (`close_reason` is free text; `expired` already terminal). Closing frees the one-live-per-contact slot ⇒ the contact is usable in regular campaigns, groups and segments. The contact row is never touched. The lead event is not re-offered to another drip campaign (it has a journey) — same as a freshness skip.

### Refusal record (R4)

When the scheduler's per-lead transaction rolls back on `MintRefused` / `GateRefused` for a campaign with an hourly cap, it writes `reason = reason || {"last_send_refusal": {"kind": "mint"|"gate", "at": now}}` outside the rolled-back transaction. Step 2 uses `last_send_refusal.at ∈ H`. Campaigns without a cap: no write (zero change).

### Alert (R4)

Any `missed_hour_blocked` drop in a run ⇒ `notifyOnTransition` key `drip:missed_hour_blocked:<campaign>:<hour ISO>` — "N leads dropped in hour HH:00 ET because sends were refused (gate/mint) — system fault, not staleness".

## 5. Combined behaviour

"Daily carry" = `carry_days` (routing admission on later days). The hourly rule operates after routing.

| Hourly carry | Daily carry | Behaviour |
|---|---|---|
| OFF | 0 | Routed on the arrival ET day only (unchanged). Fresh lead must send within its hour, else dropped (cap / closed / blocked). Waiting leads (evening arrivals, reverts) are released into spare room, paced, fresh-first, never dropped. |
| OFF | N > 0 | Also routed on later days (fresh-first, unchanged). A carried lead routed inside a window is a fresh lead of its routed hour and is subject to the hourly drop: the day admits it, the hour can still drop it. |
| ON | 0 | Same-day routing. Nothing dropped by the hour; unsent leads queue into later hours (queue first, oldest first, fresh behind), spilling into later days when windows close — no age limit (R2). |
| ON | N > 0 | As above, plus carried routing. |

Every combination: sends this hour ≤ `min(hourly room, daily room)`.

### Mid-flight setting changes

- Cap set → NULL, flag off, org paused: step 0 reverts. Nothing dropped.
- **Carry ON → OFF**: the drip-config PUT, in the same transaction, reverts unsent journeys with `hour_start < current hour` — the existing queue becomes backlog, not a mass drop.
- Cap lowered: no special handling; the lower room applies from the next run.

## 6. Scheduler, poke chain (#350), fairness (#351)

- `selectDueJourneys` gains a required `hourly` argument: per hourly-capped campaign, the current hour start and its room this run. For those campaigns it selects only assigned journeys (`hour_start <= current hour`), ordered per §4, and (fair path) `fair_rank <= room`; a campaign with room 0 contributes no rows, so a full hour never takes batch slots. Campaigns without a cap: rows and order identical to today (pinned by a test).
- The scheduler send loop stops a campaign at its room (in addition to the existing daily check).
- Poke chain unchanged. A poked run reaching a full hour is a cheap no-op for that campaign. Hour-rollover work (steps 0–4) runs on the existing every-minute cron — within 60 s of `:00`.
- Routing, drain, compliance gate, opt-out monitor, stop controls, quiet hours, follow-ups: unchanged.

## 7. Reporting

- **Funnel outcomes** (already grouped on `(state, close_reason)` with a Today column): labels "Dropped — hourly cap full", "Dropped — window closed / daily cap before its turn", "Dropped — send blocked (gate/mint) ⚠️".
- **Funnel hourly panel** (only when the campaign has a cap): cap, carry, sent this hour, assigned-unsent this hour, queued from earlier hours, waiting, oldest queued/waiting age (R2), and the last 7 ET days of drops by cause (dated by `closed_at`, ET-day ranges).
- **Why not routed**: the API returns `close_reason` and `reason.missed_hour`; the UI renders "journey expired — missed its hour (cause, cap N/h, HH:00 ET)".
- Daily results rollup: not in v1 (the funnel covers per-ET-day; the rollup can add columns later).

## 8. Data model (migration 0209, additive)

- `drip_campaign_configs.hourly_cap integer NULL CHECK (hourly_cap > 0)`
- `drip_campaign_configs.hourly_carry boolean NOT NULL DEFAULT false`
- `drip_journeys.hour_start timestamptz NULL`, `drip_journeys.hour_fresh boolean NULL`, CHECK `(hour_start IS NULL) = (hour_fresh IS NULL)`
- `org_settings.drip_hourly_cap_enabled boolean NOT NULL DEFAULT false`
- Index `drip_journeys_campaign_first_send_idx (campaign_id, first_send_at) WHERE first_send_at IS NOT NULL` — hourly sent count; no state filter so a journey that opts out within the hour still counts.
- Index `drip_journeys_hourly_queue_idx (campaign_id, hour_start, routed_at) WHERE state = 'routed' AND first_send_at IS NULL`.
- Index `drip_journeys_missed_hour_idx (campaign_id, closed_at) WHERE close_reason LIKE 'missed_hour%'` — funnel 7-day panel.

Per §11b: the new selection inputs are REQUIRED on every internal type (`selectDueJourneys`' `hourly`, the maintenance inputs); the PUT body keeps "omitted = keep stored value" (#338 convention).

## 9. Test plan

Pure (no DB): hour key incl. DST fall-back; in-window test at window edges (half-open); backlog room formula ON/OFF incl. pacing; hour-end split (demote newest `min(U,B)`, drop oldest, cause precedence blocked > cap > closed).

DB (preview, throwaway org, injected `now`):
- H1 cap NULL / flag off ⇒ due list identical to origin/main, no column written.
- H2 3N fresh in hour h, OFF ⇒ N sent; at h+1, 2N `missed_hour_cap`; contacts untouched; a regular-campaign in-use check no longer sees them.
- H3 same, ON ⇒ 2N sent first in h+1, oldest first, ahead of h+1 arrivals.
- H4 3N evening backlog, window opens 09:00, OFF ⇒ zero drops; paced release; fresh arrivals sent first.
- H5 backlog sends B in hour h then U fresh unsent ⇒ newest min(U,B) demoted, oldest U−B dropped.
- H6 pause / org drip_paused / number exhaustion mid-hour, resume ⇒ zero drops.
- H7 daily cap < hourly ⇒ daily binds; OFF fresh leftovers `missed_hour_closed`.
- H8 follow-ups not counted, still sent when the hour is full.
- H9 fairness: a full campaign contributes no rows; another campaign's 5 fresh leads all in the batch.
- H10 restart mid-hour (second run, fresh process state) ⇒ no overshoot.
- H11 four-combination matrix incl. a carried lead.
- H12 gate/mint refusal in hour ⇒ `missed_hour_blocked` + alert fired once.
- H13 carry ON→OFF via PUT ⇒ queue reverted, nothing dropped.

Then preview stack, owner gate before prod `db:migrate`, ship with flag off and prove inert, then one campaign with a generous cap under watch.
