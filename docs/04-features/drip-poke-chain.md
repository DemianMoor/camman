# Feature — Drip poke chain (lead-to-send speed-up)

_Last updated: 2026-10-12_

Migration **0206**. Code: [lib/drip/poke.ts](../../lib/drip/poke.ts), [lib/drip/lead-latency.ts](../../lib/drip/lead-latency.ts). **Ships dark**: `org_settings.drip_poke_enabled = false`. Rollback = set it back to false; nothing else changes.

## 1. Why

A partner lead is hot for 1–3 minutes. Measured on prod 2026-10-12 (pml, campaign 1683, 2,788 leads, 11:00–13:00 ET), the median lead-to-send was **6.7 min**:

| Hop | p50 | What set it |
|---|---|---|
| received → queued for lookup | 36 s | enrichment cron fires at :18 |
| queued → Telnyx done | 94 s | lookup worker is `*/2`, fires at :05 |
| Telnyx done → processed | 10 s | next enrichment run |
| processed → routed | 47 s | routing cron fires at :05 |
| routed → queued | 51 s | scheduler cron fires at :50 |
| queued → sent | 107 s | send drain is `*/5`, fires at :34 |

Each step's work takes seconds. The minutes were the waits for the next tick, stacked. Only **~1 %** of pml leads are lookup cache hits (`lead_intake_daily.lookups_spent ≈ received` every day), so the lookup worker must be in the chain or ~99 % of leads cannot speed up.

## 2. What it does

When `drip_poke_enabled` is on (for any org that also has `drip_enabled`), a step that finished with work for the next one **wakes it**:

```
intake ─► lead-enrichment ⇄ lookup-worker
                lead-enrichment ─► drip-routing ─► drip-scheduler ─► drip-drain
```

| Step finished | Condition | Pokes |
|---|---|---|
| intake API (`/api/intake/leads/[token]`) | ≥ 1 lead accepted | `lead-enrichment` |
| `lead-enrichment` | `lookupsEnqueued > 0` / `processed > 0` | `lookup-worker` / `drip-routing` |
| `lookup-worker` | `processed > 0` | `lead-enrichment` (the second pass) |
| `drip-routing` | `routed > 0` | `drip-scheduler` |
| `drip-scheduler` | `inserted > 0` | `drip-drain` |

A poke is a `GET` to the step's **existing cron route** with the `CRON_SECRET` bearer and header `x-camman-poke: 1`, sent to `appOrigin()` (`NEXT_PUBLIC_SITE_URL`). The route answers **202** at once and does the work in `after()`. `drip-drain` is `/api/cron/send-scheduled`.

## 3. Rules it keeps (owner requirements, 2026-10-12)

**The crons are the safety net and do not change.** `vercel.json` is untouched. A lost, failed or refused poke changes nothing but latency: the next cron tick does the work exactly as before. `requestPoke` never throws, and no step depends on being poked.

**No duplicate processing.** A poked run executes the same function under the **same `cron_locks` lease key** as its cron (`runLeasedJob` → `withCronLease`). So at most one run of a step exists at any moment, which is the invariant the crons already had. A poke that meets a held lease does not run. Below the lease, every step's own protection is unchanged:

| Step | Protection |
|---|---|
| enrichment | `FOR UPDATE SKIP LOCKED` claim; `lead_events` `ON CONFLICT (inbox_id)` |
| lookup worker | its own `lookup_settings` lease + `SKIP LOCKED` (a poked run also sits under the `lookup-worker` `cron_locks` lease, so pokes coalesce) |
| routing | `drip_journeys_lead_event_uniq` + `drip_journeys_one_live_per_contact_uniq` (23505 = lost race) |
| scheduler | `stage_sends_active_contact_uniq` (stage, contact) for pending/sending, **plus the zero-rows rollback** (below) |
| drain | per-phone lease `send-drain:p<phone>`; claim `pending → sending` with `SKIP LOCKED`; 1-hour dedup gate |

**Scheduler zero-rows rollback (shipped with this).** The first-send stamp `UPDATE drip_journeys … WHERE first_send_at IS NULL` now returns its row. If it updates nothing (another run already gave the journey its first send), the transaction throws `JourneyAlreadyQueued` and rolls back the link, the `stage_sends` row and the stamp. It is counted as `alreadyQueued`. Before this, that path could commit a second pending message, covered only by the lease and the drain's 1-hour dedup.

**Identical code path.** Routing, scheduling and minting run `runDripRoutingBatch` / `runDripSchedulerBatch` themselves. That means the same campaign selection, creative, opt-out gate, stop controls (#334 `isDripSendingHalted`), freshness and carry rules. Only the trigger differs.

**Drain pokes are drip-only and skip housekeeping.** A poked drain calls `runScheduledSends(db, { dripOnly: true })`, which:
- skips Phase A;
- adds `c.type = 'drip'` to `selectDrainableStages`;
- does not run `reconcileStuckStages` / `refreshDripStageCosts`, which stay on the 5-minute tick.

A regular stage is never drained by a poke. Each run gets a fresh `max_sends_per_run` budget, so draining regular stages more often would raise their send rate; with this, regular campaigns send exactly as before. Per-row dispatch (`runStageDrain`) is unchanged.

**Heartbeats stay on cron runs.** Poked runs never stamp `cron_heartbeats`, so pokes cannot hide a dead cron from `drip-monitors`.

## 4. Coalescing (load in a burst)

State lives on the job's `cron_locks` row (0206 columns):

- `poke_requested_at` is stamped by **every** request. If it is newer than `last_run_started_at`, the lease holder **re-runs** before releasing (`pokeLoop`). A request landing between the holder's last check and its lease release is caught by a tail check that re-requests.
- `poke_dispatched_at`: the HTTP wake-up is sent only when the lease is free **and** no earlier wake-up is unconsumed. "Unconsumed" means sent after the latest run started and less than `POKE_MIN_GAP_MS` ago; after that it is presumed lost and re-sent. So there is **at most one wake-up in flight per job**, however many leads arrive.
- `last_run_started_at`: runs of one job start at least `POKE_MIN_GAP_MS` (**5 s**) apart. A poke-triggered first run waits out the gap; a cron-triggered one never waits.

Result: each step runs at most ~12 times a minute, one at a time. Re-runs stay inside the route's time budget:

| Job | Budget | Notes |
|---|---|---|
| enrichment, routing | 45 s | a re-run gets the remaining time as its `deadlineMs` |
| scheduler | 45 s | re-run only while 15 s remain |
| lookup, drain | 30 s | lease TTL 330 s covers their 300 s `maxDuration` |

No new infrastructure, no cron added. Vercel usage rises by the poke invocations: estimated 15–40K/day during partner hours (owner-approved 2026-10-12; a plan upgrade needs a new decision). Telnyx spend is unchanged, since each number is still looked up once.

⚠️ **The drip number is shared with regular campaigns** (number 285 carried 41 regular stages in the week to 2026-10-12). While the 5-minute drain holds `send-drain:p285` for a long regular send, a poked drip drain is skipped (`phone_lease_skipped`). It retries every 5 s within its 30 s budget, and otherwise the rows go out on the next tick. Leads then wait longer, which the latency monitoring shows. The per-phone lease is what keeps the carrier rate, so this is correct behaviour.

## 5. Monitoring

One definition, `leadToSendLatency` ([lib/drip/lead-latency.ts](../../lib/drip/lead-latency.ts)). The timestamps are:
- `lead_inbox.received_at` → `processed_at`;
- `drip_journeys.routed_at` → `first_send_at`;
- `stage_sends.sent_at`.

**Only leads routed on arrival count:** `carried_days = 0` and `lead_events.drip_recheck_at IS NULL`. A lead that waited on a paused or capped campaign waited by design. Send-window waits do count.

- **Per minute:** the cron `drip-scheduler` run logs `[lead-latency] {n, p50Sec, p95Sec, stepP50Sec:{lookup,route,queue,send}}` for leads first-sent in the previous whole minute. Every step's summary line carries `trigger: "cron" | "poke"` and `run`. The scheduler now logs `[drip-scheduler]`, and a poked drain logs `[drip-drain]`. Dispatch problems log `[poke]`.
- **Per ET day:** the hourly partner-intake digest has a line `Lead→send (routed on arrival): hour p50 · p95 (n) · ET day p50 · p95 (n)`. History: `npx tsx scripts/lead-to-send-latency.ts [days]` (read-only).
- **Alert** (`drip-monitors`, every 15 min, only while the chain is on):
  - looks at the median over the last 15 min, with at least 20 leads;
  - **> 3 min fires** `drip:lead_to_send_slow:<org>` (state transition, retried until delivered);
  - **< 2 min resolves**, with a ✅ message only if it was firing;
  - between the two it holds.

  With the chain off the baseline is minutes by construction, so it does not run.

## 6. Operating it

- **On:** `UPDATE org_settings SET drip_poke_enabled = true WHERE org_id = …` (owner decision; the column lives on prod only after 0206 is applied). Takes effect within 5 s (per-instance flag cache).
- **Off / rollback:** set it false. Pokes stop within 5 s; in-flight poked runs finish normally under their lease.
- **Preview:** a preview deployment is behind Vercel deployment protection. Pokes add `x-vercel-protection-bypass` when `VERCEL_AUTOMATION_BYPASS_SECRET` is set (Vercel's "Protection Bypass for Automation").
- **Tests:** `scripts/test-drip-poke-chain.ts` (preview DB; HTTP stubbed). It covers:
  - dispatch coalescing;
  - no overlap between a cron run and a poked run;
  - re-run spacing;
  - flag-off = old path;
  - the drip-only selector;
  - the latency definition.
