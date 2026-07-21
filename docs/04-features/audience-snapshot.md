# Feature — Audience Snapshot (freeze-at-activation)

_Last updated: 2026-07-21_

## 1. Purpose
A campaign's audience is **computed and frozen** the moment it transitions `draft → active`, into `campaign_audience_pool`. The whole point: adding a contact to a referenced segment later does **not** retroactively expand a live campaign's reach. Drafts carry only the *recipe* (segment ids, group ids, filters, cap); the *contacts* are materialized once.

## 2. Key concepts / entities
- Recipe on `campaigns`: `audience_segment_ids[]`, `audience_contact_group_ids[]`, `audience_filters` (jsonb), `audience_cap`, `exclude_in_use_contacts` (default **true**).
- Frozen result: `campaign_audience_pool` (PK campaign_id+contact_id, plus `was_clicker/opt_in/no_status_at_snapshot` booleans).
- Logic in [`lib/audience-snapshot.ts`](../../lib/audience-snapshot.ts).

## 3. How it works

### Recipe composition
1. Per-segment audience clauses (`buildSegmentAudienceClause`, see [audience-segments.md](audience-segments.md)) are UNION'd across `audience_segment_ids` (the segment side); direct `contact_contact_groups` members for `audience_contact_group_ids` are UNION'd into the group side. The two dimensions then **INTERSECT** when both are populated — a contact must be in a selected segment **AND** a selected group — yielding the candidate pool. When only one dimension is filled, that side stands alone (the empty dimension is ignored, not treated as "match nothing"). Composition lives in `buildAudienceSourceClause`; the preview path applies the same intersection via a `membership_ok` flag so it can still report each side's pre-intersection contribution.
2. Each candidate is LEFT JOINed against `opt_ins` / `clickers` to compute status flags, and `audience_filters` (`include_no_status`, `include_opt_in`, `include_clickers`, `include_not_clicked`) select which status buckets qualify (OR logic — any matching include flag keeps the contact).
3. Contacts with **any** `opt_outs` row are excluded (live exclusion).
4. **`exclude_in_use_contacts` (campaign-level, default true):** drops any contact already snapshotted into another `status='active'` campaign's pool — applied to the **whole** candidate pool (i.e. the segment∩group intersection, or the single populated side), which the per-segment flag can't reach for a group-only audience. Both flags compose (idempotent — they EXCEPT the same active-pool set).
4b. **`exclude_prior_offer_contacts` (content-dedup LAYER 3, default false; as of 2026-07-21):** when on AND the campaign has an offer, drops contacts already in `offer_exposures` for that offer (they received it in a previous campaign). Baked into the frozen pool here — the same exclusion `previewAudience` shows — so the pool equals the previewed will-send and the stage doesn't surprise-filter at materialization. Re-checked at send time as a live safety net (post-activation exposures + pre-2026-07-21 pools). See [content-dedup.md §6b](content-dedup.md).
5. **`audience_cap`:** random-sample (`ORDER BY RANDOM() LIMIT cap`) from the remaining pool. `min(cap, available)` — a cap larger than the pool is a no-op; with exclusion(s) on, it samples from the already-narrowed (unused / non-prior-offer) pool only.

### Key functions
| Function | Role |
|----------|------|
| `previewAudience(input)` | SELECT-only; returns counts: `count` (post-cap), `total_matching` (the **intersected** audience when both dimensions are selected), `from_segments` / `from_groups` (each side's eligible pool — see the perf note: when both dimensions are selected `from_segments` is evaluated **within** the group set, so it equals `overlap`/`total_matching`), `overlap`, `excluded_for_optout`, `in_use_in_other_campaigns`, `got_offer_in_prior_campaign` (content-dedup LAYER 3 — in-audience leads who already received the campaign's offer; subtracted from `total_matching` only when `exclude_prior_offer_contacts` is on, and a point-in-time estimate — see [content-dedup.md §6b](content-dedup.md)). Powers the editor preview & "N excluded" UI. |
| `buildAudienceSourceSql(input)` | composes the raw candidate set (segment ∩ group, before status filters). |
| `buildQualifierFromRelation(input, rel)` | wraps a candidate relation with the status-flag joins + filter WHERE, projecting the snapshot booleans. Also applies content-dedup LAYER 3 (`exclude_prior_offer_contacts` + `offerId`) so the frozen pool matches `previewAudience`. |
| `snapshotAudience(input, tx?)` | materializes the candidate set into a temp table, ANALYZEs it, then INSERTs the frozen rows into `campaign_audience_pool`; returns `{ count, total_matching }`. **Must** run inside a transaction (uses `ON COMMIT DROP` temp tables). |
| `computeStageAudienceCount(campaignId, orgId, filters)` | reads the **frozen** pool for an active campaign + applies stage-level filters + live opt-out exclusion. One stage. Used by the audience-count / audience-preview routes. |
| `computeStageAudienceCountForDraft(campaign, filters)` | recomputes live from the recipe for draft-stage previews (no frozen pool yet). One stage. |
| `computeStageAudienceCountsBatch(campaignId, orgId, stages[])` | **batched** equivalent of `computeStageAudienceCount` for MANY non-lane stages in one pass → `Map<stageId, count>`. Used by the stages-list endpoint to avoid an N+1. Numerically identical to the per-stage function (proven before ship). |
| `computeStageAudienceCountsBatchForDraft(campaign, stages[])` | **batched** equivalent of `computeStageAudienceCountForDraft` (draft projection) in one pass. Builds the segment∩group source **once** (the per-stage version rebuilt it per stage) and `MATERIALIZED`s it so the source set-ops evaluate exactly once. |

### Activation transaction (`draft → active`)
Runs in [`app/api/campaigns/[campaignId]/status/route.ts`](../../app/api/campaigns/[campaignId]/status/route.ts):
```mermaid
sequenceDiagram
  participant UI
  participant API as status route (PATCH/POST)
  participant DB as Postgres (tx)
  UI->>API: set status=active
  API->>API: gate: name + brand_id + offer_id + ≥1 contact_group
  alt missing fields
    API-->>UI: 400 incomplete_draft {missing:[...]}
  else
    API->>DB: BEGIN
    API->>DB: snapshotAudience() → INSERT campaign_audience_pool
    alt snapshot count == 0
      API->>DB: ROLLBACK (EmptyAudienceError)
      API-->>UI: 400 "filters yield zero contacts"
    else
      API->>DB: UPDATE campaigns SET status=active, audience_snapshot_count=count
      API->>DB: COMMIT
      API-->>UI: 200 active
    end
  end
```
The snapshot runs in the **same transaction** as the status flip — a stale draft can't slip through, and an empty snapshot rolls the whole thing back.

### Performance (preview + snapshot)
Three optimizations keep this fast even at ~750K contacts:
1. **Group-restricted `is_not` universe.** A near-universal `is_not` rule (e.g. "in use in the last month" negated) would otherwise compute `all_contacts EXCEPT inner` — a full seqscan + disk-spilling set-ops over ~all contacts — *before* the segment∩group intersection narrows it down. When both dimensions are selected, the contact-group set is handed to `buildSegmentAudienceClause(…, restrictUniverse)` as the `is_not` universe, so the negation only spans the (small) group. Provably equivalent: the outer INTERSECT against the same group already constrains the result. Measured ~9s → ~0.4s on a 750K-contact org with a 35K group.
2. **Hash-joined status flags.** Opt-out / opt-in / clicker / in-use membership is computed by LEFT JOINing four deduped CTEs (`flagSetCtes` + `flagJoins`) instead of four correlated `EXISTS (…)` per candidate row, so each set is hashed once rather than probed per row.
3. **Materialize + ANALYZE the candidate set (snapshot path).** The candidate set is built from `UNION`/`INTERSECT`/`EXCEPT` set ops whose output cardinality Postgres cannot estimate — it defaults to **~200 rows**. At real scale (a campaign over a 150K-member contact group) that misestimate makes the planner pick **nested-loop anti-joins** for the opt-out / in-use exclusions (≈ candidates × active-pool comparisons), which never finish → `statement timeout (57014)` and a failed activation. `snapshotAudience` therefore writes the candidate set into a `ON COMMIT DROP` temp table and `ANALYZE`s it before the flag joins, giving the planner true row counts so the exclusions hash-join. The qualified rows go into a second temp table so the count + the `ORDER BY random()` cap sample share one evaluation. Measured: **>180s (timeout) → ~8.5s** for a 150K-candidate / 5K-cap activation. Because temp tables need a transaction, `snapshotAudience` must be called with the activation `tx` (both callers do), and the routes that snapshot set `maxDuration = 60`. *Not applied to `previewAudience` / the single-stage `computeStageAudienceCountForDraft`, which run outside a transaction.*
4. **Batched per-stage counts (stages-list endpoint).** `GET /api/campaigns/[campaignId]/stages` needs `audience_count` for every stage. Computing it one query per stage was an N+1 that dominated the page (the slowest in the app). `computeStageAudienceCountsBatch` / `…ForDraft` collapse all non-lane stages into a **single** pass — the pool/source is scanned once and per-stage filters + the split bucket (`ROW_NUMBER() PARTITION BY stage_id ORDER BY contact_id`) are applied via conditional aggregation. Behavioral-lane stages keep their own per-lane `countStageRecipients` (live tier + aliveness) unchanged. Proven numerically identical to the per-stage functions across all real campaigns (active, mid-send, lane, and forced-draft cases) before shipping. The draft batch CTE is `MATERIALIZED`: without it the planner re-evaluated the expensive segment-rule source once *per stage inside one statement* (nested loop), which tripped `statement_timeout` where the old N-separate-statements path did not — `MATERIALIZED` forces one source evaluation. The route sets `maxDuration = 30`.

## 4. Data it reads/writes
- Reads: `segments`/`segment_rules`/`segment_contacts`, `contact_contact_groups`, `opt_ins`, `clickers`, `opt_outs`, other campaigns' `campaign_audience_pool`.
- Writes: `campaign_audience_pool`, `campaigns.audience_snapshot_count` / `status`.

## 5. UI surface
- The audience composition card in the campaign editor ([`components/campaigns/campaign-editor-page.tsx`](../../components/campaigns/campaign-editor-page.tsx)): total contacts, a will-send-vs-above-cap progress bar, breakdown (from segments / from groups / overlap / excluded opt-outs), filter chips, and the "Exclude in-use" switch.
- `POST /api/campaigns/audience-preview` backs the live preview.

## 6. Rules & edge cases
- **Activation gate (code-authoritative):** name + `brand_id` + `offer_id` + **≥1 contact group**. **Segments are optional.** ⚠️ This differs from CLAUDE.md §10b, which says "≥1 segment" — the code requires a contact group. See [07-conventions.md](../07-conventions.md).
- Once `active`, the audience is **locked**: PATCH rejects changes to `audience_segment_ids`, `audience_contact_group_ids`, `audience_filters`, `audience_cap`, `exclude_in_use_contacts` with `details.reason = 'audience_locked_after_draft'`.
- Frozen pools are never recomputed when underlying segments/rules/opt-outs change later — stage exports apply live opt-out exclusion on top of the frozen pool at query time.

## 7. Extension points / limitations
- No re-snapshot / refresh-audience action by design.
- Random sampling is `ORDER BY RANDOM()` — fine at current scale; revisit for very large pools.
