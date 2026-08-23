# Drip campaigns and routing (Phase 4)

_Last updated: 2026-08-23_

A second campaign **type**, and the worker that assigns each partner lead to exactly one drip
campaign. **Zero sends** — a journey is an assignment, not a message. The scheduler is Phase 5.

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
| demographics | gender / age_band / state / country / income_band / kids / married — **skip-if-missing** |
| carrier | reuses `campaigns.audience_filters.carrier_filter` |
| same offer | offer half only — **the creative half is `deferred_p5`** |
| caps | `campaign_cap` and `routing_daily_admission_cap` |

Winner: **priority ASC, tie → newest campaign.**

**⚠️ skip-if-missing is reported as `missing`, not `mismatch`.** They need different fixes: one is a
partner sending incomplete data, the other is targeting working correctly.

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

## Unrouted leads

No row is written. The lead is re-evaluated every tick — a campaign may be created, a cap may reset,
the contact may leave another campaign. After **7 days** it becomes a terminal `unroutable` row
carrying its last reason.

Seven days is chosen to coincide with the >1-week re-entry rule, so an unroutable lead becomes
re-eligible as a "new" arrival exactly when that rule would have re-qualified it anyway.

**⚠️ An `unroutable` row has `campaign_id = NULL`** (migration 0163). It matched nothing, so naming
a campaign would inflate that campaign's journey count and mislead the debugging tool. A CHECK keeps
`campaign_id` mandatory for every other state.

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
