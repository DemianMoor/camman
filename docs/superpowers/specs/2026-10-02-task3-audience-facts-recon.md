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

---

## 10. Decisions for the owner

| # | question | recommendation |
| --- | --- | --- |
| E1 | Build the timestamp fact for `in_use_in_campaign_last_period` / `in_use_in_offer`? | **Yes**, as fact + journal, read exactly (§4.4) |
| E2 | Use it at activation too (exact via the journal correction)? | **Yes**, one definition for preview and snapshot |
| E3 | Freeze: timestamp fact (`freeze_due_at`) or covering index? | **Timestamp fact**: same pattern, and it also serves a future `freeze_due` segment rule |
| E4 | Offer rules: the covering index (D3 / Option C)? | **Yes**, after run 2 confirms the read on Large |
| E5 | Materialised membership for other rule types (Option 2)? | **Not now**: 96% of real use is covered by E1 |
| E6 | Target a read replica for previews? | Decide after §9 item 4 |
