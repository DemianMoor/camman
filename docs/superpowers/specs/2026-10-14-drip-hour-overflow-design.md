# Drip hour-level overflow — design

Status: APPROVED by the owner 2026-10-14 (proposal + rulings below). Base: origin/main a4a5d3c2 (hourly cap #360/0209, manual lease #361, day-level overflow #359/0210).

## Owner rulings

- **O1 Window-open only.** A candidate's hourly room is considered only while one of its first-send windows is open now. Outside a window a routed lead is not on any hour (it waits and is released as backlog), so "this hour" does not apply.
- **O2 Separate flag.** `org_settings.drip_routing_hour_overflow boolean NOT NULL DEFAULT false` (migration 0213). Effective only when `drip_routing_send_capacity` is also on. Off ⇒ routing is byte-identical to today.
- **O3 Divert, never defer.** `hour_capacity` may only move a lead to a lower-priority sibling that has hourly room. If every candidate that is otherwise eligible fails ONLY on `hour_capacity`, the lead is routed to the best-priority one of them anyway (today's behaviour: it joins that campaign's queue). Hour-fullness alone never defers a lead and never lets it expire at freshness. Deferral stays only for day-fullness and the existing temporary reasons.
- **O4 One shared formula.** The hourly-room calculation lives in one helper used by the scheduler's maintenance pass, routing, and "Why not routed" — the `lib/drip/daily-sends.ts` pattern. No second implementation.
- **O5 Recording.** `overflowed_from` entries carry `kind: "day" | "hour"`; hour entries read `hour full (N/cap this hour)`. A lead routed by the O3 fallback records `hour_fallback: true` plus the hour-full candidates it passed over. "Why not routed" shows both kinds. Old rows without `kind` display as day.
- **O6 Race bound accepted.** No lock between routing and the scheduler; worst case is a bounded over-commit (below), never a send overshoot.
- **Operator guideline (docs):** turn the flag on for a tag only where the combined hourly caps of its same-tag siblings ≈ that tag's hourly arrival rate. Far below it, hour overflow mostly fills every sibling and the O3 fallback reverts to queueing; it never helps.
- The originally proposed "next-hour recheck for hour-deferred leads" is DROPPED: under O3 no lead is ever deferred by hour-fullness alone, so it would be unreachable.

## 1. Shared helper — `lib/drip/hourly-room.ts`

```
loadHourCounts(dbc, { campaigns: { id, windows }[], hourStart }) → Map<id, HourCounts>
  sentH        first sends with first_send_at ∈ [H, H+1h)            (index drip_journeys_campaign_first_send_idx)
  assigned     routed, unsent, hour_start = H
  queued       routed, unsent, hour_start < H                        (only exists under carry ON)
  pendingFresh routed, unsent, hour_start IS NULL, routed_at ∈ [H, H+1h), routed minute inside a window
hourCommitted(c) = sentH + assigned + pendingFresh + queued
hourFullness(cap, c) → { full: committed ≥ cap, committed, detail: "hour full (N/cap this hour)" | null }
routedInWindowSql(windows)   — the ET-minute, half-open [start,end) test, moved here from hourly-maintenance.ts
```

`pendingFresh` is what makes routing safe: a lead routed in-window counts against the hour exactly once — pending (routed, not yet assigned) → assigned (maintenance `assignFresh`) → sent. Both transitions keep `committed` unchanged. Without it, routing would not see leads it routed seconds ago that the scheduler has not assigned yet.

Users:
- `prepareHourly` / `hourCounts` / `sentBetween` in `lib/drip/hourly-maintenance.ts` read through `loadHourCounts` (no behaviour change; existing suites prove it). Maintenance keeps its own *room* (`cap − sentH`) and backlog-release arithmetic; both derive from the same counts.
- Routing: loaded once per routing run per org for campaigns with an hourly cap and an open window (alongside `loadCampaignJourneyCounts`), incremented in-tick when a lead is routed in-window to that campaign (`pendingFresh + 1`).
- "Why not routed": calls the helper directly for the live evaluation.

## 2. Rule

In `evaluateLeadRouting`, per candidate, after `send_capacity` (day):
- if `org_hour_overflow` AND `org_send_capacity` AND `cfg.hourly_cap` set AND `org_hourly_cap_enabled` AND a first-send window is open now: `rules.hour_capacity = full ? "blocked" : "pass"`, `detail.hour_capacity = "hour full (N/cap this hour)"`.
- otherwise the rule is ABSENT (not "pass") — flag-off byte identity.

Winner selection:
1. Normal: best-ranked fully eligible candidate.
2. **O3 fallback** (only when 1 finds none): among candidates whose ONLY failing rule is `hour_capacity`, the best-ranked becomes the winner, with `hour_fallback: true`.
3. Otherwise no winner ⇒ existing classification (defer / permanent / expired). `hour_capacity` is NOT added to the temporary-rule set: because of step 2 it can never be the sole cause of a deferral.

`overflowSkips` gains kinds: a skipped higher-ranked candidate whose only failures are day-capacity rules ⇒ `kind:"day"` (unchanged text); only `hour_capacity` ⇒ `kind:"hour"`; both ⇒ day.

## 3. Race analysis (accepted)

Routing (`drip-routing` lease) and the scheduler (`drip-scheduler` lease, cron + pokes + manual since #361) run concurrently.
- **No send overshoot is possible.** Only the scheduler sends, single-flight, and it caps each campaign at `cap − sentH` (Task 4 of the hourly cap). Routing errors cost lead placement, never the cap.
- **No double count.** In-tick cache increments; the next run re-reads the DB; a lead is pending XOR assigned (`hour_start` NULL vs set).
- **Bounded over-commit.** The scheduler's backlog release reads counts then fills the free room; if a routing run read the counts earlier and commits its journeys after the release read, the hour is over-committed by at most the leads routed to that campaign in that one overlapping run. Effect on those leads: carry ON ⇒ they queue to the next hour (today's behaviour); carry OFF ⇒ the hour-end demote rule applies (R1). Measured in test H-O7.
- **Hour boundary.** At :00, `sentH`, `assigned`, `pendingFresh` restart at 0; carry-ON `queued` still counts, so a campaign with a queue can be hour-full from :00 and fresh leads divert. Nothing is ever re-routed, so leads cannot ping-pong.
- **Fairness (#351)** unaffected (diverted leads occupy the sibling's per-campaign slots, capped by its room). **Poke chain** unaffected; it shrinks the pending window.

## 4. Cost

Per lead: no extra queries (cache). Per routing run: one grouped count over hourly-capped campaigns with an open window + one windows query — expected a few ms against the 10-13 baseline p50 585 ms / p95 1,554 ms. "Why not routed": direct per-campaign count.

## 5. Data model (0213, additive)

`org_settings.drip_routing_hour_overflow boolean NOT NULL DEFAULT false`. No index (existing 0209 indexes serve the counts). `org_settings` is not tracked in snapshots; 0213 snapshot = clone of 0212's snapshot (#363) with new id, prevId = 0212's id. Renumbered from 0211 on 2026-10-15 (0211 = #362, 0212 = #363); on prod 0212 must be applied before 0213.

## 6. Test plan

Pure: `hourCommitted`, `hourFullness` text, window gating, `overflowSkips` kinds, O3 fallback selection order.

Same-formula proof: source guard — no hour-count SQL (`first_send_at >=` with an hour bound, `hour_start =`) outside `hourly-room.ts`; DB parity — maintenance room and routing committed computed from the same `loadHourCounts` on one fixture.

DB (preview, throwaway org):
- H-O1 flag off (with day flag on, and off) ⇒ stored reasons byte-identical to main.
- H-O2 A hour-full, B room ⇒ routes to B, `overflowed_from:[{kind:"hour", detail:"hour full (3/3 this hour)"}]`.
- H-O3 A day-full, B hour-full, nothing else ⇒ O3: routes to B (fallback), `hour_fallback: true`, overflowed_from has A kind day.
- H-O4 no hourly cap on A ⇒ never hour-full.
- H-O5 A's window closed now ⇒ rule absent; lead routes to A and waits.
- H-O6 pendingFresh: one run, no scheduler, A cap 3, 8 leads ⇒ A gets 3, B gets its 3, remaining 2 ⇒ O3 fallback to A (best-ranked hour-only failure).
- H-O7 race: interleave maintenance release read → routing insert ⇒ over-commit ≤ leads routed in that run; sends never exceed cap.
- H-O8 ping-pong across an hour boundary: A, B cap 3; 10 leads at 10:55 ⇒ A 3, B 3, 4 via O3 fallback to A (queue); at 11:01 new leads ⇒ A full from :00 because of its carry-ON queue (4) ⇒ divert to B; every lead exactly one journey, never re-routed, per-hour sends ≤ cap.
- **H-O9 (owner)** single candidate, hour-full, day room, carry ON ⇒ the lead routes and queues exactly as today (reason has no deferral; journey routed).
- **H-O10 (owner)** big queue: carry ON queue > cap (permanently hour-full) ⇒ fresh leads still route in, never defer.
- H-O11 why-not-routed renders both kinds and the fallback.
Regression: overflow, hourly-cap, routing, scheduler suites.
