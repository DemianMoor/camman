# Task 3 — Write-time audience facts: recon spec

_Recon only. No build. Written 2026-10-02 after Task 2 (T1–T5) went live._
_Scope per owner: segment evaluation is in scope (2026-10-01); for clock-dependent
rules, the timestamp-fact option is evaluated first._

---

## 0. One screen

After Task 2, the campaign preview runs in two parts. The **base** part reruns
only when segments or groups change. The **audience** part reruns on every
change and is narrowed to the selected lifecycle statuses. On this morning's
production run (Small compute, 2026-10-02 05:03–05:18 UTC) the slow recipes are
still slow, and the time sits in **two places**:

1. **Segment evaluation, in the base part: 3–5 s.** Almost all real segment use
   (246 of 255 segment campaigns in 30 days) is one rule, *not used in a campaign
   in the last 3 days / 1 week / 2 weeks*. Evaluating it means walking up to
   421K pool rows and subtracting them from the group universe every time.
2. **The offer-history read, in the audience part: ~7.5 s on 1521's recipe.**
   With offer 115 (189K history rows) the audience part takes **9.4 s**. With an
   offer that has no history it takes **1.9 s**, on otherwise the same recipe.

**What Task 3 can remove:**
- **For (1):** a per-contact timestamp fact, compared with `now()` at read time
  (§4). It turns a 3–5 s set subtraction into an index read. Expected: base
  part 5–7 s → about 1.5–3 s on the segment recipes.
- **For (2):** not a fact table. A covering index answers the offer rules
  without heap fetches (§6, the plan's Option C). Expected: audience part
  7–13 s → about 2–4 s.

These two together are what would bring the heavy recipes under 5 s cold.
Everything else is already under 2 s.

**Recommendation:** build (1) as **fact + change journal, read exactly**
(§4.4), and (2) as an index. Measure per layer in a quiet window before
committing (§9).

---

## 1. Where the time goes now (run 1, 2026-10-02, Small)

Seconds; `ref` = frozen pre-Task-2 preview, `live` = today's single statement,
`base` / `audience` = the two Task 2 parts the form now uses. The operator
waits for `max(base, audience)` when segments or groups change, and for
`audience` alone otherwise.

| recipe | shape | ref | live | base | audience |
| --- | --- | ---: | ---: | ---: | ---: |
| 1521 | Hot/Warm · seg 223 · groups 2,94,135 · offer 115 rules | 105.8 | 59.0 | **6.0** | **9.4** |
| 1521 + Cold | same + Cold chip | 45.3 | 49.2 | **5.5** | **13.1** |
| 1521, offer 142 | same, **offer with no history** | 34.4 | 17.9 | **5.3** | **1.9** |
| 1519 | Hot/Warm · seg 223 · groups 2,94,102,135 · offer 118 rules | 46.3 | 47.2 | **6.2** | **7.1** |
| 1429 | legacy · seg 227 + 223 · 13 groups | 7.0 | 7.8 | **6.8** | 7.0 ¹ |
| 1560 | Freeze · groups 6,7,8,5 · offer 126 rules | 11.3 | 8.7 | 1.3 | **6.9** |
| 1559 | Cold · groups 6,8,7,5 · offer 58 rules | 10.6 | 18.1 | 1.6 | 2.4 |
| 1558 | New · group 139 | 0.5 | 2.9 | 0.3 | 0.5 |
| 1432 | legacy · group 137 · carrier | 1.7 | 0.7 | 0.2 | 0.7 |
| 1346 | legacy · group 101 | 0.3 | 0.3 | 0.1 | 0.3 |

¹ Legacy campaigns fall back to the single statement for the audience part.

**Segment evaluation alone**, same morning (segment gate: the selected
segments' clauses only, two interleaved rounds, round 1 / round 2):

| recipe | segments only | whole reference preview | share |
| --- | ---: | ---: | ---: |
| 1521 | 3.47 / 3.12 | 32.6 / 31.0 | 10% |
| 1521 + Cold | 2.72 / 3.71 | 76.4 / 38.7 | 6% |
| 1521, offer 142 | 3.43 / 2.89 | 14.1 / 12.1 | 24% |
| 1519 | 3.13 / 4.03 | 44.8 / 30.7 | 9% |
| 1429 (two segments) | 5.89 / 4.81 | 9.7 / 8.8 | 58% |

**Attribution.** Each line rests on a controlled comparison or a direct
measurement:
- **Base part = segment evaluation + a small remainder.** Base without
  segments costs 0.1–1.6 s (1558, 1560, 1559, 1432, 1346). With segment 223
  it costs 5.3–6.8 s, and the segment clauses alone measure 2.7–5.9 s. So
  **3–5 s of every segment recipe's base part is segment evaluation.**
- **Audience part = mostly the offer read.** 1521 with offer 115: 9.4 s. The
  same recipe with offer 142, which has no history: 1.9 s. **About 7.5 s is
  the offer-history read** (offer-rule grouped scan + bought-offer). The 1.9 s
  also bounds everything else in that recipe's audience part, including its
  narrowed segment evaluation. 1519 (offer 118, 351K rows) is 7.1 s; adding
  Cold to 1521 (more candidates) makes it 13.1 s.
- **Not attributed: 1560's 6.9 s.** It combines the Freeze layer
  (`contact_engagement`, whose table data hits only 54% of the time) with offer
  126 (30K rows). Which one dominates needs the per-layer measurement in §9.

**Caveat:** run 1 timed each part as a whole, not each layer. The numbers
above are attributions by controlled pairs, not a profile.

---

## 2. Scope

**In:**
- write-time facts that let the preview stop recomputing per-contact state on
  every run, **including segment membership** (owner, 2026-10-01);
- for clock-dependent rules, the **timestamp fact** first (owner);
- the offer-history and freeze reads, because they are the measured remainder.

**Out:**
- building anything (recon only);
- changing what any rule means;
- the send path, except where a fact would also serve it (named, not proposed).

**Constraint carried from Task 2 T7 [change 5]:** the narrowed audience part
uses a `TEMP` table and `ANALYZE`, which a read-only replica (hot standby)
refuses. A design that answers from facts and indexes alone removes the temp
table, which is what makes a replica viable later (§7).

---

## 3. Recon facts (production, read-only, 2026-10-02)

**Segments and rules:**
- 39 live segments, 38 of them with active rules.
- 343 campaigns created in the last 30 days, **255 (74%) with segments**.
- Rules on segments used by those campaigns:

| rule | campaigns (30 d) |
| --- | ---: |
| `in_use_in_campaign_last_period` **is_not** `1w` | 114 |
| `in_use_in_campaign_last_period` **is_not** `2w` | 66 |
| `in_use_in_campaign_last_period` **is_not** `3d` | 66 |
| `is_clicker_for_offer` / `is_clicker_any_brand` | ≤ 10 each |
| `is_in_contact_group` | ≤ 3 each |

The *not used in the last period* family is **246 of 255** segment campaigns.
A fix for that one rule is, in practice, the segment fix.

**What that rule actually means** (`lib/segment-rules-eval.ts`,
`in_use_in_campaign_last_period`):
- **In use:** the contact is in the `campaign_audience_pool` of a campaign that
  - is `active` / `paused` / `completed` (not draft, not archived),
  - **was created** within the window (`campaigns.created_at >= now() − N`),
    and
  - still has **at least one live stage** (`draft` / `pending` / `sent` /
    `success`).
- **Releases:** a campaign stops counting when it is archived, or when all of
  its stages end up cancelled or failed.
- So the window is anchored on the **campaign's creation time**, not on when
  the contact entered the pool or was messaged, and membership depends on
  campaign **and stage status**, not on the clock alone.

**Sizes and churn:**
- `campaign_audience_pool`: **2.94 M rows**; average snapshot 2,932 contacts
  (max about 150K).
- Live campaigns (ran, ≥1 live stage): **711**.
- Contacts in use, by window: 3 days **82,231** · 1 week **207,761** ·
  2 weeks **343,067** (from 421K pool rows). Computing those three sets took
  0.6 s warm, so **the cost is the subtraction, not the set**: today's clause
  is `universe EXCEPT in-use`, and the universe is the selected groups.
- Campaign status changes in 30 days: **369**, of which 17 archives.
- Offer history (`contact_offer_campaigns`): offer 58 474K rows / 467K
  contacts; 118 351K / 263K; 115 189K / 186K; 126 30K / 30K. Almost one row
  per contact, so a per-(contact, offer) rollup would barely be smaller than
  the table.

**Write-time state that already exists** (reused, not reinvented):
- `contact_engagement` (engagement job: status, `last_sent_at`, `last_click_at`,
  cadence, message windows);
- `contacts.lifecycle_status` (projection);
- `contact_offer_campaigns` (per contact, offer and campaign);
- `offer_exposures` + `offer_exposure_counts`;
- `segment_stats` (trigger-maintained counts);
- `cron_locks` (leases + watermarks for crons).

---

## 4. Option 1 (evaluated first): the timestamp fact

### 4.1 The fact

One row per contact that has ever been in a live campaign's pool:

```
contact_campaign_use (org_id, contact_id PK, last_live_use_at timestamptz)
  last_live_use_at = max(campaigns.created_at)
                     over campaigns that are LIVE and have the contact in their pool
  LIVE = status in (active, paused, completed) AND ≥1 stage in (draft, pending, sent, success)
index (org_id, last_live_use_at)
```

**The read compares with `now()`**, so the clock needs no maintenance:

| rule | today | with the fact |
| --- | --- | --- |
| used in last N (`is`) | pool ⋈ campaigns ⋈ EXISTS stages, created ≥ now−N | `last_live_use_at >= now() − N` |
| not used in last N (`is_not`) | universe **EXCEPT** the above | universe **minus** the index range — or, inside the narrowed preview, a PK probe per candidate: `last_live_use_at IS NULL OR < now() − N` |

Exactness: this equals today's rule **if and only if** `last_live_use_at` is the
max over the campaigns that are live *now*. The max over all campaigns ever is
not enough, because a campaign can stop being live.

### 4.2 What changes the fact

| event | effect | rows touched | how often |
| --- | --- | --- | --- |
| campaign becomes live (activation with a live stage; first live stage added later) | `last = greatest(last, campaign.created_at)` for its pool | pool size (avg 2.9K, max ~150K) | ~11/day |
| live campaign gains or loses pool rows | upsert / recompute those contacts | the rows | rare (pools are frozen after activation) |
| campaign stops being live (archived; every stage cancelled or failed) | contacts whose max came from it must be **recomputed** from their remaining live campaigns | up to pool size, per-contact max over the pool index by `contact_id` | 17 archives / 30 d plus stage cancellations |
| the clock moves | **nothing**: compared at read time | 0 | — |

The monotonic case (becoming live) is a cheap `greatest()` upsert. The
non-monotonic case (stopping) needs a recompute, but it is rare and bounded by
one pool.

### 4.3 Where to maintain it: three ways

1. **In the same transaction as the event** (activation, archive, stage
   status). Always exact. But activation already spends ~8.5 s of a 60 s route
   on a 150K snapshot, and a 150K-row upsert plus the stage-status writers
   (send pipeline, cancellations) all join the hot path. **Risky.**
2. **Asynchronously:** the event writes a row to a small
   `campaign_liveness_changes` journal, and a cron applies it every minute. The
   fact lags by up to about a minute. Fine for a preview. **Not fine for
   activation**, which must stay exact: two campaigns activated within the same
   minute could both take a contact the rule should have excluded.
3. **Fact + journal, read exactly** (recommended). As (2), plus the reader
   corrects for the journal rows the cron hasn't applied yet:

   ```
   used(N) = { c : fact.last_live_use_at >= now()−N  AND c not only-in a campaign that stopped since the watermark }
           ∪ { pool contacts of campaigns that BECAME live since the watermark and were created ≥ now()−N }
   ```

   The journal tail is tiny (minutes of changes, a few campaigns), so the
   correction costs little. **Exact for activation as well as the preview,**
   with no work added to the activation transaction beyond one journal insert.

### 4.4 Recommendation for the clock rules: option 3

- **Tables:**
  - `contact_campaign_use` (the fact);
  - `campaign_liveness_changes` (journal: campaign_id, became_live / stopped,
    at);
  - a watermark in `cron_locks`.
- **Writers:** an append-only journal insert where liveness can change.
  - campaign status route: activate, archive, restore, complete;
  - stage status writers: cancellations, failures, the drain's terminal
    states.
  - The writer list is the risky part. A missed writer is a silently stale
    fact, so the spec for the build must list every writer and add a drift
    verifier.
- **Cron:** applies the journal: the `greatest()` upsert for became-live, and a
  per-contact recompute for stopped.
- **Reader:** `buildSegmentAudienceClause` for these two rule types. The same
  machinery serves `in_use_in_offer` (same liveness, keyed by offer: either a
  fact per (contact, offer), or a filter on the journal-corrected set).
- **Verifier:** nightly, outside working hours. Recompute the fact for a
  sample, or in full, and compare it with the stored one. This is "a drift
  test of a write-time fact", the same discipline as the 4a gate.
- **Backfill:** one pass over 2.94 M pool rows, joined to live campaigns,
  grouped by contact (≈ the cost of one 2-week rule evaluation × a few).
- **Expected effect** (to be measured, §9):
  - segment evaluation for the dominant rule goes from 2.7–5.9 s to an index
    range or a per-candidate probe, well under a second;
  - base part on the segment recipes: 5–7 s → 1.5–3 s;
  - the narrowed audience part loses its share of segment evaluation (≤ 1.9 s,
    bounded by the 1521/offer-142 pair).

### 4.5 The same machinery covers the campaign-level "exclude in use"

`exclude_in_use_contacts` (on for nearly every campaign) excludes contacts in
any **active** campaign's pool. That is a different definition from the
segment rule: active only, any age. A per-contact `active_campaign_count` on the
same journal (became active +1, stopped being active −1) answers it with a PK
probe. Not measured separately this morning; included in the §9 measurement.

---

## 5. Other options for segments (for comparison)

| option | what | gain | cost / risk |
| --- | --- | --- | --- |
| **2 · materialised membership** | `segment_members (segment_id, contact_id)` refreshed by cron; the preview reads members ∩ candidates | covers **every** rule type, not just the clock ones | Clock rules go stale between refreshes (a campaign crossing the 7-day line releases contacts continuously). Each refresh costs today's evaluation per segment. Segment 223 alone is ~552K members. Activation still needs an exact path. |
| **3 · per-campaign liveness column** | `campaigns.is_live`, maintained on status and stage changes; the rule drops its per-campaign EXISTS | small and safe | Small gain: computing the set already takes 0.6 s; the cost is the subtraction from the universe, which this does not touch. |
| **4 · on-read cache** | cache a segment's members by (segment, rule version, universe), with a TTL | repeat previews instant | The first preview pays in full; staleness within the TTL; preview only. |

**Option 1 dominates** for the rule family that is 96% of real use. Option 2 is
the general fallback if rule usage diversifies. Option 4 combines with any of
them and costs little.

---

## 6. The offer-history and freeze reads (not segment, but the larger remainder)

- **Offer rules (limit + cooldown):** the grouped read of
  `contact_offer_campaigns` per offer is the largest audience-part cost (§1).
  The table is already a write-time rollup, and its existing index
  `(org_id, offer_id, contact_id)` lacks `last_sent_at`, so the cooldown pays a
  heap fetch per row.
  - **Option C** from the Task 2 plan, a **covering index**
    `(org_id, offer_id, contact_id) INCLUDE (last_sent_at)`, makes the read
    index-only.
  - A per-(contact, offer) rollup would not be smaller: almost every contact
    has one row per offer (§3).
  - This is **D3**, already deferred to the T7 numbers; this morning's numbers
    support it.
- **Bought offer:** `conversion_events` is small (1.5K rows); not a cost.
- **Freeze not due:** `contact_engagement` table data hits 54%, and it is the
  biggest disk reader since yesterday (17.3 M blocks).
  - **Timestamp-fact form:** store `freeze_due_at = last_sent_at +
    freeze_cadence_days` on the row (the engagement job already writes both),
    index `(org_id, status, freeze_due_at)`. Then "not due" =
    `freeze_due_at > now()`, compared at read time. This is the owner's pattern
    applied to the second clock rule we have.
  - **Alternative:** the plan's covering index `(org_id, status) INCLUDE
    (last_sent_at, freeze_cadence_days)`.
- **In use elsewhere** (campaign-level): §4.5.

---

## 7. Read replica

With the segment fact (§4), the offer covering index (§6) and the freeze fact
(§6), the narrowed audience part no longer needs a temp table + ANALYZE to get
good plans: every layer becomes an index probe from the candidates. That is the
condition for running previews on a **read-only replica**, which a hot standby
otherwise refuses (`CREATE TEMP TABLE`, `ANALYZE`). The facts also make the
base part a pure index read. **Not verified:** whether the planner picks good
plans without the temp table's statistics. It's in §9.

---

## 8. What Task 3 does NOT remove

- **Group membership + histogram** in the base part (0.1–1.6 s on non-segment
  recipes): already index reads.
- **The `is_clicker_*` / `is_in_contact_group` rules:** event-driven set reads,
  already cheap and not clock-dependent.
- **Cold cache.** On Small, every first preview after idle read from disk.
  Large compute (2 GB shared_buffers since 2026-10-02 09:35 UTC) addresses that
  separately; run 2 (2026-10-03) measures it.

---

## 9. Measurements needed before building (quiet window, read-only)

1. **Per-layer timings** of the narrowed audience part and the base part, for
   the five segment recipes plus 1560 (EXPLAIN ANALYZE/BUFFERS per statement):
   confirms §1's attribution, including 1560's.
2. **A fact prototype:** build `contact_campaign_use` as a temp table in one
   transaction from the pool, then time the rule both ways (index range vs
   today's EXCEPT) on the same recipes. Read-only (temp table only).
3. **The covering-index effect,** without creating the index: an index-only
   read over `(org_id, offer_id, contact_id)` vs the cooldown's heap fetches.
   Estimate from the buffers; the real index needs a migration.
4. **No temp table:** the narrowed audience part with the temp table replaced by
   a CTE, on Large, to answer §7.
5. **Writer census** for the journal: every code path that changes a
   campaign's status or a stage's status (grep plus `pg_stat_statements`). The
   build is only as exact as this list.


### 9.1 Results — quiet window 2026-10-03 05:08 UTC, Large, warm cache (0 disk reads)

1. **Per-layer** (EXPLAIN per statement, top nodes by exclusive time):
   - **Base part**, dominated by the segment ∩ group membership:
     - 1568 class: 2.25 s of 2.77 s, plus three full Seq Scans of `contacts` at about 0.25 s each;
     - 1429 (two segments, 13 groups): 7.9 s, mostly sorts and aggregates over about 1M rows;
     - 1560 (no segment): 1.12 s.
   - **Narrowed audience part:** 1568 1.60 s (candidates 0.53 s, ANALYZE 0.03 s, main 0.56 s); 1560 2.72 s (main 1.95 s).
2. **Fact prototype** (`last_live_use_at`, temp table):
   - built for 800,954 contacts in **3.55 s**;
   - reproduces today's rule **exactly** in every window (93,112 / 183,219 / 327,453);
   - reads in 0.58 / 0.87 / 0.69 s (today's rule: 0.30 / 0.69 / 1.49 s).

   Meaning (b), the texted rule, in the segment shape: 1.50 / 1.71 / 2.16 s, against 1.42 / 1.61 / 1.94 s for today's rule. Both are dominated by the universe sort; see the plan's §5. **The build gate (< 1 s) is not met.**
3. **Covering index (E4):**
   - offer 115: cooldown read with `last_sent_at` **1.87 s** (hit 192,794, read 3,058); without it (index-only possible) **0.21 s**;
   - offer 118: 0.46 s → 0.35 s.

   E4 is confirmed worth building; the gain is largest where the heap is not cached.
4. **Temp table vs CTE** for the narrowed candidates: equal (1568: 1.33 vs 1.29 s; 1560: 2.40 vs 2.45 s, after one CTE outlier at 4.46 s). **Keep the temp table.** It doesn't argue for a read replica.

**Task 2 run 2 vs run 1** (preview parts the form uses, seconds; Small 10-02 → Large 10-03):

| Campaign | base (run 1) | base (Large) | audience (run 1) | audience (Large) |
| --- | ---: | ---: | ---: | ---: |
| 1521 | 6.0 | 3.1–3.3 | 9.4 | 2.0 |
| 1519 | 6.2 | 3.3 | 7.1 | 2.2–2.3 |
| 1429 | 6.8 | 6.3 | 7.0 | 6.7 |
| 1560 | 1.3 | 0.9 | 6.9 | 2.3 |
| 1558 | 0.3 | 0.3 | 0.5 | 0.5 |
| 1432 | 0.2 | 0.3 | 0.7 | 0.5 |

- Run 2 parity: 0 of 10 recipes differ.
- Segment gate median share 41% (run 1: 10%). The whole preview got faster; segment evaluation did not.
- Cache since the run-1 snapshot: DB-wide **96.81%** (Small's previous day: 93.42%); `contact_engagement` heap **93.21%** (54%).
- 1521 and 1519 were timed separately: newer campaigns of the same shape (1568, 1567) displaced them from run 2's recipe set.

---

## 10. Decisions for the owner

| # | question | recommendation |
| --- | --- | --- |
| E1 | Build the timestamp fact for `in_use_in_campaign_last_period` / `in_use_in_offer`? | **Yes**, as fact + journal, read exactly (§4.4) |
| E2 | Use it at activation too (exact via the journal correction)? | **Yes**, one definition for preview and snapshot |
| E3 | Freeze: timestamp fact (`freeze_due_at`) or covering index? | **Timestamp fact**: same pattern, and it also serves a future `freeze_due` segment rule |
| E4 | Offer rules: the covering index (D3 / Option C)? | **Yes**: confirmed by §9.1 item 3 (offer 115: 1.87 s → 0.21 s) |
| E5 | Materialised membership for other rule types (Option 2)? | **Not now**: 96% of real use is covered by E1 |
| E6 | Target a read replica for previews? | **No** for now: on Large everything was a cache hit, and §9.1 item 4 shows the temp table costs nothing |

---

## 11. Owner review (2026-10-02) and E0

**Decisions recorded:**

| # | ruling |
| --- | --- |
| **E0** (new, before E1) | **Decided 2026-10-02: (b).** Built as a NEW rule type on `contact_engagement.last_sent_at`; the existing rule and segments keep their meaning; segments switch only by the owner, one at a time. Plan: [2026-10-02-task3-texted-rule-plan.md](../plans/2026-10-02-task3-texted-rule-plan.md). Task 3 order: E4 index, then this rule, then the freeze fact. The journal/trigger design for (a) (§4, §12.4) is **shelved**. |
| E1 | Yes, pending E0. |
| E2 | Design for exact reads, but **enable for the preview only**. Activation switches after **14 consecutive days of zero drift**. |
| E3 | Yes. |
| E4 | Yes, and **first**. Migration SQL to be proposed after run 2 (2026-10-03). |
| E5 | Not now. |
| E6 | After measuring. |

§9 measurements are approved for the next quiet window. **No build**: the build needs its own plan file.

### 11.1 E0: campaign-creation anchor vs "last sent"

Production, read-only, 2026-10-02 ~10:40 UTC (a 64 s read, on Large); eligible contacts only.
- **(a) today's rule:** in the pool of a live campaign **created** within N days.
- **(b) last sent within N days** (`contact_engagement.last_sent_at`), combined with exclude-in-use (pools of `active` campaigns).

| window | (a) today | (a) + exclude-in-use | (b) | only (a) | only (b) | both |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 days | 82,231 | 82,231 | 112,392 | 227 | **30,388** | 82,004 |
| 1 week | 190,568 | 190,568 | 211,981 | 1,048 | **22,461** | 189,520 |
| 2 weeks | 343,067 | 343,067 | 358,281 | 1,336 | **16,550** | 341,731 |

**Exclude-in-use adds nothing to (a):** every contact in an active campaign's pool is already inside (a) for all three windows.

**What the differences are** (concrete contacts, 1-week window; ids truncated):

- **Only (b): messaged recently by a campaign created before the window.**
  `4ca749d9…` and `e1276fbb…` are in campaign 1432, **created 09-23**, which
  messaged them on **09-23, 09-24 and 09-25**. By creation date the campaign is
  outside the week, so today's rule treats them as *not used* although they
  were texted 7 days ago. This is the multi-stage / long-running campaign case,
  and it is the large side: 16–30K contacts.
- **Only (a): in a recent pool but never actually messaged by it.**
  - `80ab36da…` is in campaign 1471's pool (**created 09-26**), but was last
    texted **07-28**.
  - `6b07938d…` is in 1503's pool (09-28); last texted 09-07.

  Today's rule counts them as *used* because their snapshot exists, not
  because they were messaged. This is the small side: 0.2–1.3K.

**What each meaning does for Task 3:**
- **(b)** is already a timestamp fact: `contact_engagement.last_sent_at` is
  written by the engagement job and indexed `(org_id, last_sent_at)`. The rule
  would need **no new fact table and no liveness journal**, only the read
  `last_sent_at >= now() − N`, with the existing exclude-in-use beside it.
  Freshness: the engagement job's cadence (every 15 min).
- **(a)** needs the §4 design: the fact, the journal and the triggers.

---

## 12. Requirements added by the owner (binding for the build plan)

1. **Trial period.** Before any switch, the fact-based evaluation and the
   current evaluation are compared **nightly on real recipes** via the parity
   harness (`scripts/verify-preview-parity.ts`, extended with the fact path as
   a third implementation). Any difference fails and alerts. Activation
   switches only after **14 consecutive nights of zero drift** (E2).
2. **Kill switch per fact.** Each fact has its own switch back to today's
   evaluation, like `AUDIENCE_PREVIEW_IMPL`. One env var per fact, e.g.
   `AUDIENCE_FACT_CAMPAIGN_USE=off`, `AUDIENCE_FACT_FREEZE_DUE=off`, read per
   request, with the implementation that answered named in a response header.
3. **Drift alert and speed gate.**
   - **Drift:** the nightly comparison posts to Telegram on any difference,
     naming the recipe, the rule and the count delta.
   - ~~**Speed gate:** a bar that fails if a preview exceeds 2 s at 5× current data.~~
     **Replaced by the owner's decision (2026-10-05): the 5× speed gate is REPLACED by monitoring on live data, at no cost.** Option C (a throwaway Large project with synthetic 5× data) is cancelled; no paid resource is used. Instead, real preview requests are timed on production, the parity harness's real recipes are timed nightly, Telegram alerts fire when a part takes over 5 s or the nightly median rises more than 25% against the 7-night average, and a weekly line compares this week's median and worst with last week's. Card: "Preview speed: live monitoring". [scripts/speed-gate-5x.ts](../../scripts/speed-gate-5x.ts) stays in the repo, unused.
     The original text follows for the record:
   - **Speed gate:** a bar that **fails if a preview exceeds 2 s at 5× current
     data**. That needs a scaled dataset: about 5× contacts (≈ 4.8 M), pool
     rows (≈ 15 M) and offer history. Built on a Supabase branch or a dedicated
     scale database, never on production. The build plan must name where it
     runs and how the data is generated.
4. **Writer census in full in the build plan.**
   - Preliminary count (code, 2026-10-02):
     - **14 files** write `campaigns.status`;
     - **15 Drizzle files + 29 raw-SQL sites** update `campaign_stages`, each
       to be classified as status-changing or not;
     - **1** pool insert (`snapshotAudience`), **1** pool delete
       (`lib/telnyx/sync-contacts.ts`).
   - **Design consequence (recommendation):** write the liveness journal from
     **database triggers** (`AFTER UPDATE OF status … WHEN OLD.status IS
     DISTINCT FROM NEW.status` on `campaigns` and `campaign_stages`;
     `AFTER INSERT / DELETE` on `campaign_audience_pool`, statement-level), not
     from application code. A trigger catches every writer by construction,
     including raw SQL and future code. The census in the build plan is then a
     **check** on the triggers (each listed writer exercised in a test), not
     the mechanism.
   - Only needed if E0 chooses meaning (a). **E0 chose (b): shelved.** The census for (b) (writers of `stage_sends` `'sent'` and of `last_sent_at`) is in the plan, §4.
