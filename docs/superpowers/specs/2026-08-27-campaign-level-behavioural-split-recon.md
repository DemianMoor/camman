# Phase 0 recon — campaign-level behavioural split (multi-stage source set)

_Card: [869eqvaak](https://app.clickup.com/t/869eqvaak) · Recon run 2026-08-27 against prod (read-only)_

**Status: report only. No code, no migration. Stops for approval.**

---

## 0. Headline

The behavioural split already exists and is **heavily in production use** — not a
greenfield build. Measured on prod today:

| | |
|---|---|
| lane stages | **569** (tier 0: 162 · tier 1: 204 · tier 2: 203) |
| lanes that fired (`sent_at` set) | **551** |
| messages sent through lanes | **860,323** (tier 0: 815,227 · tier 1: 40,146 · tier 2: 4,950) |

`docs/04-features/behavioral-lanes.md` still says *"no live send has fired, so lane
preview counts are 0"*. **That line is stale** (doc dated 2026-07-07) and should be
corrected as part of this work.

**The tier is already campaign-wide.** `campaignTierExpr()` reads clicks / offer-reach /
sale across the whole campaign, not the parent's recipient list. So *"a contact who
clicked in stage 1 and ignored stage 3 lands in Clicked"* is **already true today**.

The actual gap is narrower than the brief assumes: **only the aliveness anchor is
single-stage.** A lane's audience is `frozen pool ∩ received THAT ONE parent ∩ tier`.
Widening *"received that one parent"* → *"received ANY completed stage"* is the change.

---

## 1. Where the implementation lives

### Entry point (UI)

- Button **"Behavioral split…"** inside the stage editor's audience block, beside the
  A/B "Split for A/B test…" button — `components/campaigns/stage-form.tsx:1777-1791`.
- Wired from `app/(protected)/campaigns/[id]/page.tsx:2009` (`onBehavioralSplit`), gated
  on `isEdit && behavioral_tier == null && no live lanes`.
- Deliberately **not** in the stages-row dropdown — there is an explicit comment saying
  so at `app/(protected)/campaigns/[id]/page.tsx:1289`.
- Confirm dialog at `app/(protected)/campaigns/[id]/page.tsx:2052` → `handleBehavioralSplit()`
  at `app/(protected)/campaigns/[id]/page.tsx:741`.

### API route

`POST /api/campaigns/[campaignId]/stages/[stageId]/behavioral-split`
→ `app/api/campaigns/[campaignId]/stages/[stageId]/behavioral-split/route.ts`
(thin auth + error map) → `performBehavioralSplit()` in `lib/stages/behavioral-split.ts`.

### The classification query

`campaignTierExpr(campaignId, orgId)` — `lib/campaign-tier.ts`. A subquery yielding
`(contact_id, tier)`, high-water via `MAX` over a `UNION ALL` of per-signal branches.
**Absence ⇒ tier 0** (callers `LEFT JOIN` + `COALESCE(t.tier, 0)`).

### Consumers of the fragment

| Path | File | Applies content-dedup? |
|---|---|---|
| Live preview (all lanes of a campaign in one query) | `computeLaneAudienceCountsBatch()` — `lib/audience-snapshot.ts:929` | **no** |
| Send/export recipient resolution | `stageRecipientsSql()` — `lib/sends/recipients.ts` | yes, when caller passes `eligibility` |
| Materialization | `kickoffStageSend()` — `lib/sends/kickoff.ts:355-372` | **yes** |
| Preflight breakdown (`excluded.lane`) | `lib/sends/preflight-breakdown.ts:123` | n/a (attributes the delta) |

---

## 2. What defines "clicked" and "reached offer"

| Tier | Signal | Source of truth |
|---|---|---|
| 0 Ignored | absence of any signal | — |
| 1 Clicked | `links ⋈ clicks` where `links.campaign_id = X` and `clicks.classification NOT IN ('bot','prefetch','suspect')` | `links`, `clicks` |
| 2 Reached offer | `stage_sends.offer_reached_at IS NOT NULL` | stamped by `lib/keitaro/poll-offer-reaches.ts` |
| 3 Converted (exits) | `stage_sends.sale_status = 'sale'` | stamped by `lib/keitaro/poll-conversions.ts` |

### Concepts that are explicitly NOT used for lanes — do not confuse them

- **`campaign_audience_pool.was_clicker_at_snapshot`** — an org-wide clicker flag frozen
  at snapshot time. Drives the *separate* `include_clickers` / `exclude_clickers` stage
  toggles. Composes with the lane (both applied in `stageRecipientsSql`); a different
  axis, not a competing definition.
- **`clickers` table** (`lib/links/propagate-clickers.ts`) — org-wide, written from
  `classification = 'human'` **only**. Feeds segment clicker rules and the audience
  snapshot. **Stricter than the lane's tier-1 definition.**
- **`counted_clickers`** — reporting only (EPC denominator). Never touches targeting.
- **`campaign_stages.click_count`** — Keitaro `visit_clicks_clean`, reporting only.

> ⚠️ **Two different "clicked" definitions coexist in the codebase.** Tier 1 counts
> `human + unknown` (raw − bot − prefetch − suspect, matching `lib/links/click-report.ts`);
> `clickers` counts `human` only. `campaign-tier.ts` documents the click-report definition
> as authoritative for lanes and warns against divergence. Campaign-level classification
> inherits this — flagging it, not proposing to change it.

---

## 3. What "completed stage" means in the schema

There are **two unrelated notions** and the obvious one is the wrong one.

### `campaign_stages.status` — NOT the pipeline

`draft | pending | sent | success | cancelled | failed | archived`
(`db/schema.ts`, `campaign_stages_status_check`). It is documented in
`lib/stages/stage-status.ts:8-13` as *"a manual record the operator keeps for campaign
results"*, explicitly distinct from the send pipeline.

**Measured drift on prod** (tracked stages only):

| | count |
|---|---|
| tracked stages | 1,231 |
| `sent_at IS NOT NULL` | 1,183 |
| `status IN ('success','sent')` | 957 |
| **`sent_at` set but status is something else** | **227** |
| status says sent but no `sent_at` | 1 |

Using `status` as the source-set filter would silently drop **227 stages that really sent**.

### The pipeline truth — use this

```
sent_at IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM stage_sends ss
                WHERE ss.stage_id = s.id AND ss.status IN ('pending','sending'))
```

That predicate already exists as `getParentState()` — `lib/sends/scheduled.ts:376` — and
is what the P4 parent-complete gate uses. **1,170 of 1,231** tracked stages satisfy it.

- `sent_at` is stamped by Phase B **only after a drain pass actually attempted ≥1 send**
  (deliberate — a gate-refused stage must not read "Sent").
- `'failed'` / `'skipped_*'` are terminal and do **not** block completeness; `'sending'`
  does (a stage mid-flight, or rows stranded by a mid-drain pause).

### Distinguishing completed from sending / aborted

`deriveStageOperationalStatus()` — `lib/stages/stage-status.ts:230` — is the single UI
model (`draft | scheduled_unprepared | held | blocked | materializing | prepared |
sending_sent | missed_failed`). **Aborted** stages reset `materialized_at → NULL` and flip
pending rows to `'rejected'` while keeping opt-out audit rows.

> **Recommendation:** hoist `getParentState`'s predicate into one exported helper
> (`isStageComplete` / `completedStageIdsSql`) so the split source set and the P4 gate
> cannot drift. Two copies of this predicate is exactly how the 227-stage `status` gap
> would sneak back in.

---

## 4. Build time or Prepare time? — **Prepare time. Answered.**

This was the open concern from the autopilot workstream. Definitive answer:

**Nothing about a lane is precomputed at split time.** `performBehavioralSplit()` only
stamps three rows (config clone + `behavioral_tier` + `parent_stage_id` + fresh stage
`tracking_id` + rewritten `full_url`), with `scheduled_at = null` by design.

| Moment | What happens | Frozen? |
|---|---|---|
| Split (build) | 3 stage rows created. No audience touched. | no |
| Any page load | `GET .../stages` returns `audience_count = null` for lanes (`app/api/campaigns/[campaignId]/stages/route.ts:249-267`); client then fetches `GET .../stages/lane-counts` → `computeLaneAudienceCountsBatch` | no — live scan |
| T−15 min | `send-preflight` cron computes + persists a breakdown | no — read-only |
| **Prepare / Phase A materialization** | `kickoffStageSend()` → `stageRecipientsSql()` with `behavioralTier` + `parentStageId` → **`stage_sends` rows written** | **YES** |
| Phase B drain | sends the frozen `stage_sends` rows | already frozen |

So **`stage_sends` rows are the frozen lane membership**, and the brief's *"frozen
guarantee: after materialization, a new click changes nothing"* **already holds today**.
Inline lane counting was tried and reverted — it made a 3-lane campaign's stage list take
30–60s.

---

## 5. How a lane records its source — single FK, load-bearing in four places

```
parent_stage_id integer REFERENCES campaign_stages(id) ON DELETE CASCADE

CHECK campaign_stages_behavioral_lane_check:
  (behavioral_tier IS NULL AND parent_stage_id IS NULL)
  OR (behavioral_tier IN (0,1,2) AND parent_stage_id IS NOT NULL)

INDEX campaign_stages_parent_stage_id_idx ... WHERE parent_stage_id IS NOT NULL
```

`parent_stage_id` is read by:

1. **Aliveness overlay** — `stageRecipientsSql` (`EXISTS stage_sends WHERE stage_id = parent AND status = 'sent'`).
2. **Batched lane counts** — the `alive` CTE in `computeLaneAudienceCountsBatch`.
3. **P4 parent-complete gate + bounded slip** — `lib/sends/scheduled.ts` Phase A +
   `lib/sends/child-slip.ts`. A lane child does not materialize until the parent has fully
   sent; it waits / slips to `parent_complete + original_offset`, capped at 24h, then
   **HOLDs** for a human.
4. **Preflight breakdown** — `excluded.lane` attribution.

Plus `ON DELETE CASCADE`: deleting the parent deletes its lanes.

### Proposal (not built)

**Recommend a group table — not an array on each lane, and not a per-source join table.**

```sql
-- additive; no destructive change in this PR
CREATE TABLE campaign_stage_split_groups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id       integer NOT NULL REFERENCES campaigns(id)     ON DELETE CASCADE,
  anchor_stage_id   integer REFERENCES campaign_stages(id) ON DELETE CASCADE, -- slip anchor
  source_stage_ids  integer[]   NOT NULL DEFAULT '{}',  -- what the recompute actually used
  state             text        NOT NULL DEFAULT 'pending',
                                -- pending | materializing | materialized | failed
  recomputed_at     timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE campaign_stages
  ADD COLUMN split_group_id uuid REFERENCES campaign_stage_split_groups(id) ON DELETE SET NULL;
```

Why this shape:

- **The set lives once, not three times.** Three lane rows share one source scope; an
  array column on each lane stores it three times and lets the copies drift.
- **`integer[]`, not a join table.** Cardinality is bounded by stages-per-campaign
  (max observed **8**). The set is written once and read whole (`ss.stage_id = ANY(...)`);
  there is no per-element query. Ownership is re-verified against the same campaign at
  write time — the same convention CLAUDE.md §10e already uses for set-shaped rule values.
  A join table buys referential integrity we would hand-maintain against the CASCADE
  anyway. (Note `utm_tag_ids` is `jsonb` — that is an *ordered display list*, not a join
  key. `integer[]` is the right type here, and GIN-indexable if it ever needs to be.)
- **`source_stage_ids` is written at RECOMPUTE time, not split time.** The brief's own
  verify criterion — *"a stage completing between T and T−N is included in the source
  set"* — means the set must be **derived live** and only **persisted as the record of
  what that materialization used**. This preserves the existing invariant that the people
  SENT are byte-identical to the people PREVIEWED.
- **`split_group_id` gives the scheduler a unit** to gate the release on (see §9).
- **`parent_stage_id` STAYS.** It remains the P4 slip anchor. Making the slip gate wait on
  N sources is a *separate behavioural change* with its own failure mode (one stalled
  source holds the entire group for 24h, then HOLDs it). Destructive cleanup of
  `parent_stage_id` only if we later decide to collapse the two roles — that is the
  "later PR" the brief anticipates, and it should not be assumed now.

> ⚠️ **Do not write a guard asserting "`source_stage_ids` is empty everywhere" or
> "`split_group_id` is NULL everywhere".** Those ship true and go red the first time the
> feature is correctly used.

---

## 6. Cost — measured on prod, 2026-08-27 (read-only)

### Scope printed

| | |
|---|---|
| `stage_sends` rows | 3,859,551 (3,660,612 with `status = 'sent'`) |
| `links` | 3,859,960 |
| `clicks` | 1,487,571 |
| `campaign_stages` | 1,330 (569 lanes) |
| `campaign_audience_pool` | 1,738,583 |

### The campaign-level classification query, on the largest campaigns

Query = `tier_map` as a `MATERIALIZED` CTE (the three tier branches) + source set
(`DISTINCT contact_id` from `stage_sends status='sent'` joined to completed stages) +
opt-out anti-join + `GROUP BY tier`.

| campaign | stages w/ sends | distinct sent contacts | links | **ms** | t0 / t1 / t2 |
|---|---|---|---|---|---|
| 235 | 6 | 9,999 | 39,372 | **3,500** | 7,592 / 735 / 62 |
| 755 | 7 | 12,726 | 37,597 | **2,127** | 9,325 / 1,988 / 323 |
| 457 | 5 | 12,994 | 38,478 | **1,130** | 11,728 / 315 / 28 |
| 319 (most stages) | 8 | 7,999 | 23,594 | **999** | 6,132 / 396 / 44 |

`EXPLAIN (ANALYZE, BUFFERS)` on campaign 319 — Execution Time **1,018.9 ms**:

- **Dominant cost — tier 1.** Nested Loop: `links_campaign_id_idx` (23,594 rows, 22.7 ms)
  → `clicks_link_id_idx` probe **per link**, 23,594 loops ⇒ **78,312 shared buffers,
  475 ms**. This is the term that scales.
- **Second cost — the opt-out anti-join.** Hash Right Anti Join over an Index-Only Scan
  on `opt_outs_org_id_contact_id_idx`: **153,244 rows, 477 ms** — it reads the org's whole
  opt-out set regardless of campaign size.
- Source set is cheap: Bitmap Heap Scan on `stage_sends_campaign_created_idx`
  (22,848 rows) + hash join to stages = **68 ms**.
- `campaign_stages` gets a Seq Scan (1,225 rows, 0.5 ms) — fine at this table size.

### Verdict

**1.0–3.5 s per campaign.** Comfortable for a 60 s route and for a T−N cron. **Not**
acceptable inline on the stages list — which is exactly why lane counts are already
deferred to `/stages/lane-counts`. **Keep them deferred.**

**Scaling:** cost is roughly linear in the campaign's `links` count. A 10× campaign
(≈400K links) lands at ~10–30 s. If that arrives, the fix is the swap `campaign-tier.ts`
already anticipates in its own comments — a materialized
`campaign_contact_state(campaign_id, contact_id, tier)` table swapped in at the single
call site — not query tuning.

---

## 7. Old vs new source set — strict subset **confirmed on real data**

The brief's Phase-2 criterion ("old behaviour is a strict subset") is already provable.
For every real laned campaign checked, `old_source EXCEPT new_source = 0`:

| campaign | parent | old = alive on that parent | new = alive on any completed stage | old ∖ new |
|---|---|---|---|---|
| 118 | 176 | **0** | 2,426 | 0 |
| 118 | 526 | 2,126 | 2,426 | 0 |
| 889 | 2996 | **5** | 3,000 | 0 |
| 889 | 3042 | 2,829 | 3,000 | 0 |

Structural reason: materialization draws only from `campaign_audience_pool`, so
`sent(parent) ⊆ sent(all completed stages)`. Widening is safe by construction.

Note campaign 118 parent 176 and campaign 889 parent 2996: **old = 0 and 5**. Those
parents barely sent, so lanes hung off them target almost nobody today. Campaign-level
classification takes them to 2,426 / 3,000. That is the win — and also why §10's
zero-contact question matters.

---

## 8. Scheduler: how materialization is triggered, and where a T−N hook attaches

### Today

`send-scheduled` cron, **`*/5`**, `maxDuration = 300` (`vercel.json`,
`app/api/cron/send-scheduled/route.ts`).

- **Phase A — materialize.** `selectDueScheduledStages()` (due, approved, `sent_at IS NULL`,
  `schedule_missed_at IS NULL`, `slip_hold_at IS NULL`, `preflight_aborted_at IS NULL`,
  **`materialized_at IS NULL`**) → per-stage P4 slip decision → window decision →
  `kickoffStageSend(budgetMs = 120s)`.
- **Phase B — drain.** Only stages with **`materialized_at IS NOT NULL`**.
  Phone-partitioned, concurrent, per-phone lease, 20 s per-stage fairness slice, 240 s
  phase deadline.

So materialization is **cron-tick-driven, not a fixed offset**; the manual "Prepare"
button (`POST .../send/kickoff`, `maxDuration = 300`) calls the same `kickoffStageSend`.

### **There is already a T-minus-N hook — use it**

`send-preflight` cron, **`*/5`**, `maxDuration = 120`, `PREFLIGHT_LEAD_MS = 15 min`
(`lib/sends/send-preflight.ts:20`).

It selects stages where `scheduled_at > now AND scheduled_at <= now + 15min AND
materialized_at IS NULL AND sent_at IS NULL AND …`, computes `computePreflightBreakdown`,
persists `preflight_result` / `preflight_computed_at` / `preflight_notified_at`, posts a
Telegram digest, and **never sends**.

This is the right attach point, for four concrete reasons:

1. It already **leads the fire path by exactly one lead time** and has no coupling to it.
2. It is **read-mostly** — it only stamps the `preflight_*` columns.
3. It is **per-stage best-effort**: a throw is caught and that stage skipped, never
   blocking the tick.
4. It already carries an **operator abort** (`preflight_aborted_at`) that Phase A honours.

> ⚠️ **Do not overload `preflight_notified_at`.** It is a *post-once* marker. A recompute
> that must run against the latest data needs its own timestamp — `recomputed_at` on the
> group row (§5).

---

## 9. Can three lanes be materialized atomically? — **No, not with today's kickoff**

`kickoffStageSend` commits **per 2,000-row window** and its contract states outright:
*"Callers must NOT wrap it in an outer transaction"* (`lib/sends/kickoff.ts:36`).
`materialized_at` exists **because** materialization is not atomic.

### Could it be? Measured, so the tradeoff is real rather than hypothetical

- `mintLinksBatch` runs **inside** the transaction and is DB-only — **no HTTP** in the
  materialization path. So one big transaction is not structurally blocked.
- Cost recorded in the route: **~3.5 ms/recipient** (enumerate + mint + insert across
  heavily-indexed tables). At 60 s a stage used to time out around ~17K recipients and
  **roll the whole batch back** — that regression is why windowing exists.
- Observed clean single-stage materializations on prod: **13,000 rows in 25.8 s**;
  12,808 in 21.3 s; 12,273 in 13.5 s; 11,358 in 11.2 s ⇒ **≈500–900 rows/s**.
- Largest real lane trio (combined rows across its three lanes): **18,755**
  ⇒ **≈30–65 s in a single transaction.**

So it is *technically* possible at today's volumes, but it would hold one
**transaction-pooler** connection for 30–65 s, breach the 300 s route ceiling at ~3× today's
size, and discard the resumability built specifically to survive that failure.

### Recommendation — group-level status, all-or-nothing at the RELEASE boundary

Not one transaction. `split_group_id` + `state`
(`pending → materializing → materialized | failed`):

- Materialize each lane **normally** (windowed, resumable, unchanged).
- Gate **Phase B** on the **group** being `materialized` rather than on the stage's own
  `materialized_at`.

That delivers the brief's guarantee — *"on failure the group stays unmaterialized, Tier-1
Telegram alert, lanes do not fire"* — without a long transaction. On failure the group is
never released; already-inserted rows are cleaned by the **existing** abort path
(`.../send/abort` → `materialized_at = NULL`, pending → `'rejected'`, opt-out audit rows
kept).

---

## 10. What happens today if a scheduled stage is unmaterialized at window time

**It materializes — it neither fires-nothing nor blocks.** Phase A materializes it inline
in the same tick and Phase B drains it in that same tick. Late by ≤ one materialization pass.

Failure modes that matter for a slow or erroring recompute:

| Case | Behaviour | Safe? |
|---|---|---|
| **Partial** (120 s `MATERIALIZE_BUDGET_MS` hit) | `materialized_at` stays NULL → Phase B skips → resumes next tick | ✅ |
| **Transient throw** | caught per stage, `refused++`, retried next tick | ✅ |
| **Window closed** | `schedule_missed_at` stamped → Red "missed", stays reschedulable | ✅ (by design) |
| **Provider paused** | held indefinitely, not burned | ✅ |
| **Permanent refusal** | `schedule_missed_at` stamped, drops out of due-selection **forever** | ⚠️ see below |

> ⚠️ **`no_recipients` is in `PERMANENT_REFUSALS`** (`lib/sends/scheduled.ts:355-370`).
> **A zero-contact lane is currently BURNED as `schedule_missed_at`, not skipped** — it
> renders Red "missed / needs attention" and never re-arms on its own.
>
> With campaign-level classification a zero-count lane becomes a **routine** outcome, not
> an error: tier 2 measured at just **28–323 contacts** on the four widest campaigns, and
> it will be genuinely 0 on smaller ones. Left alone, every low-engagement campaign will
> throw a false Red every time it splits. This needs an explicit decision (Q1).

---

## 11. Incidental findings worth a decision

- **Lane preview under-counts exclusions.** `computeLaneAudienceCountsBatch` applies
  opt-outs + tier + aliveness + stage toggles + split, but **not** the content-dedup
  layers from `buildStageEligibilityExclusions`, which `kickoffStageSend` **does** apply.
  So the number shown on the stages list is systematically ≥ what actually materializes.
  (`preflight-breakdown` compensates by attributing the delta, so this is visible in the
  T−15 digest but not in the list.)
- **Stale doc.** `docs/04-features/behavioral-lanes.md`'s status block claims no live send
  has fired. 551 lanes have fired and 860,323 messages have gone out through them.
- **4 lanes also carry an A/B split** (`behavioral_tier IS NOT NULL AND split_total IS NOT NULL`).
  The two partitions compose in `stageRecipientsSql` (split applied post-dedup, by hash
  bucket) — worth an explicit test case in Phase 2.
- **1 lane has been slipped, 0 held** by the P4 gate — the gate is exercised but not stressed.

---

## 12. Open questions — need a call before Phase 1

| # | Question | Recommendation |
|---|---|---|
| **Q1** | **Zero-contact lane:** skip silently, or burn as `schedule_missed_at` (today)? | **Skip, don't burn.** Handle `no_recipients` for lane stages as complete-with-zero rather than missed. A routine outcome must not raise a Red. |
| **Q2** | Does the **P4 parent-complete gate** follow the widened source set (wait on ALL source stages) or stay on the single anchor? | **Stay on the single anchor.** Widening means one stalled source stage holds the whole group 24 h, then HOLDs it. Separate card if wanted. |
| **Q3** | The **569 existing lanes / 551 fired**: leave `split_group_id` NULL = legacy single-parent semantics, or backfill? | **Leave NULL and branch.** Preserves history exactly; a backfill would rewrite what those lanes actually targeted. |
| **Q4** | Brief asks for the button **"next to New Stage"**. Today both split actions deliberately sit together in the stage editor's audience block (with a comment saying so). Move both, or add a second entry point? | **Move both, or leave both** — don't create two places for one action. I'd move both so they stay co-located. |
| **Q5** | **Lane preview omits content-dedup** (§11) while the send applies it. Fix inside this card, or separate? | **Separate card.** It's a pre-existing accuracy bug on a hot path; folding it in confounds the old-vs-new subset verification. |

---

## 13. Verification criteria carried into Phase 2 (for the record)

- Lane counts **sum to** distinct sent contacts across the source set, minus exclusions.
- **No contact in two lanes** (exact-tier match makes this structural; assert anyway).
- Clicked in stage 1 + ignored stage 3 ⇒ **Clicked** (already true; assert as a regression test).
- Reached offer in ANY stage ⇒ **Offer** (precedence Offer > Clicked > Ignored).
- **Old ⊆ new** for one stage (§7 shows the method and the real-data result).
- **Zero-stage or zero-send scope = FAILURE, not pass.** Print input scope on every run.
- Split group: a failed recompute ⇒ **zero pending rows across all three lanes**.
- Frozen guarantee: a click after materialization changes nothing (already structurally
  true — §4).
- A stage completing between T and T−N **is** in the source set (⇒ derive at recompute, §5).
- Run on **preview env (`camman-v2`)** before prod — note that DB is **shared with the
  external demo**; an applied migration stays applied (`docs/preview-environment.md`).

---

## 14. Recon method (reproducible)

Read-only probes, run against prod `DATABASE_URL` on 2026-08-27:

- `tmp/recon-lane-scope.ts` — corpus counts, campaign ranking, stage-status drift,
  `EXPLAIN (ANALYZE, BUFFERS)` of the campaign-level classification.
- `tmp/recon-lane-usage.ts` — lane footprint, laned campaigns, "completed" definitions
  compared.
- `tmp/recon-cost.ts` — per-campaign classification timings + old-vs-new source-set
  subset check.
- `tmp/recon-mat.ts` — observed materialization wall-clock and lane-trio combined sizes.

(`tmp/` is gitignored; the scripts are kept locally, not committed.)
