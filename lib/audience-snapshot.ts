import "server-only";

import { sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "@/db/client";

import { buildSegmentAudienceClause } from "./segment-rules-eval";

// Compose the audience-source set (contact_ids, before status filters /
// opt-out / in-use exclusion) from the two selection dimensions:
//
//   * segments — OR'd together (a contact in ANY selected segment qualifies)
//   * contact groups — OR'd together (a contact in ANY selected group)
//
// The two dimensions INTERSECT when both are present: a contact must be in a
// selected segment AND a selected group. When only one dimension is
// populated, that side is used alone (the empty dimension is ignored, not
// treated as "match nothing"). Each `segmentBranch` must already be a plain
// `SELECT contact_id …` (callers subquery-wrap the rule clauses) so the UNION
// here can't be mis-parenthesized by a segment clause's own set operators.
function buildAudienceSourceClause(
  segmentBranches: SQL[],
  groupClause: SQL | null,
): SQL {
  const segmentUnion =
    segmentBranches.length > 0
      ? segmentBranches.reduce((acc, branch, i) =>
          i === 0 ? branch : drizzleSql`${acc} UNION ${branch}`,
        )
      : null;
  if (segmentUnion && groupClause) {
    return drizzleSql`(${segmentUnion}) INTERSECT (${groupClause})`;
  }
  // hasAnySource guards the callers, so at least one side is non-null here.
  return (segmentUnion ?? groupClause) as SQL;
}

// The raw contact-group membership clause (`SELECT contact_id …`) for the
// selected groups, or null when none are selected. Reused as both the group
// side of the audience and — when both dimensions are present — the universe
// restriction handed to `buildSegmentAudienceClause` (see below).
function buildGroupMembershipClause(
  orgId: string,
  contactGroupIds: number[],
): SQL | null {
  if (contactGroupIds.length === 0) return null;
  return drizzleSql`
    SELECT contact_id
    FROM contact_contact_groups
    WHERE org_id = ${orgId}::uuid
      AND contact_group_id = ANY(${drizzleSql.raw(
        "ARRAY[" + contactGroupIds.join(",") + "]::int[]",
      )})
  `;
}

// Deduped per-contact status sets, emitted as CTE bodies to splice into a
// `WITH` list (no leading `with`, no trailing comma). LEFT JOINing these once
// is dramatically cheaper than a correlated `EXISTS (…)` per candidate row —
// the planner builds each hash once instead of probing per row. `clickers` /
// `opt_ins` may be empty, in which case the join is a no-op.
function flagSetCtes(orgId: string): SQL {
  return drizzleSql`
    oo_set as (select distinct contact_id from opt_outs where org_id = ${orgId}::uuid),
    oi_set as (select distinct contact_id from opt_ins where org_id = ${orgId}::uuid),
    cl_set as (select distinct contact_id from clickers where org_id = ${orgId}::uuid),
    iu_set as (
      select distinct p.contact_id
      from campaign_audience_pool p
      join campaigns ca on ca.id = p.campaign_id
      where p.org_id = ${orgId}::uuid and ca.status = 'active'
    )`;
}

// The LEFT JOINs that attach the flagSetCtes to a candidate relation aliased
// `alias` (which must expose a `contact_id` column). Pair with the boolean
// expressions `<set>.contact_id is not null` in the SELECT list.
function flagJoins(alias: string): SQL {
  const a = drizzleSql.raw(alias);
  return drizzleSql`
    left join oo_set on oo_set.contact_id = ${a}.contact_id
    left join oi_set on oi_set.contact_id = ${a}.contact_id
    left join cl_set on cl_set.contact_id = ${a}.contact_id
    left join iu_set on iu_set.contact_id = ${a}.contact_id`;
}

export interface AudienceFilters {
  include_no_status?: boolean;
  include_opt_in?: boolean;
  include_clickers?: boolean;
  include_not_clicked?: boolean;
  // include_opt_out is implicitly false — opt-outs are always excluded.
}

export interface AudiencePreviewInput {
  orgId: string;
  segmentIds: number[];
  contactGroupIds?: number[];
  filters: AudienceFilters;
  // Optional cap. When set, the preview returns BOTH the total matching
  // count and the effective count (= min(total, cap)). The snapshot path
  // takes a random sample of `cap` contacts at activation time.
  cap?: number | null;
  // When true, drop any contact already snapshotted into another campaign
  // with status='active' from the WHOLE audience (segments + groups). The
  // cap then samples from the remaining unused pool only. Campaign-level
  // counterpart to the per-segment segments.exclude_in_use_contacts flag.
  excludeInUse?: boolean;
}

export interface AudienceSnapshotInput extends AudiencePreviewInput {
  campaignId: number;
}

export interface AudiencePreviewResult {
  // Effective count after cap is applied (= total_matching if no cap or
  // if cap >= total_matching). This is the number the campaign will
  // actually send to.
  count: number;
  // Full matching pool size, ignoring any cap. Equal to count when no
  // cap is in effect.
  total_matching: number;
  applied_cap: number | null;
  // Composition breakdown. All counts are post-filter (qualified for
  // sending) unless noted. Sum from_segments + from_groups - overlap =
  // total_matching.
  from_segments: number;
  from_groups: number;
  overlap: number;
  // Count of contacts in the union (across all selected sources) who
  // have an opt_out record and were therefore dropped. Independent of
  // the include_* filter toggles.
  excluded_for_optout: number;
  // Count of qualifying contacts who are also in another *active*
  // campaign's audience_pool. Informational — whether they're excluded
  // from the snapshot depends on the per-segment exclude_in_use_contacts
  // flag (see segments.exclude_in_use_contacts). Drafts and the current
  // campaign itself are not counted as conflicts because they don't have
  // pool rows yet (pools materialize at activation).
  in_use_in_other_campaigns: number;
}

export interface AudienceSnapshotResult {
  // Number of rows actually inserted into campaign_audience_pool.
  count: number;
  // Full matching pool size before the cap was applied. Equal to count
  // when no cap was in effect.
  total_matching: number;
}

// Compose the raw audience-source set (contact_ids only, before any status
// filter / opt-out / in-use exclusion) from the segment + contact-group
// dimensions. See buildAudienceSourceClause for the intersection semantics.
// Pulled out of the qualifier so the snapshot path can materialize it into a
// temp table (see snapshotAudience).
async function buildAudienceSourceSql(
  input: AudiencePreviewInput,
): Promise<SQL> {
  const { orgId, segmentIds, contactGroupIds = [] } = input;

  // Contact-group clause: every contact tagged with any of the selected
  // groups. Built first so it can double as the universe restriction for the
  // segment evaluation (see below).
  const groupClause = buildGroupMembershipClause(orgId, contactGroupIds);
  const bothSides = segmentIds.length > 0 && contactGroupIds.length > 0;

  // Per-segment rule-filtered clauses. Each yields a set of contact_ids
  // honoring that segment's rules + manual membership UNION. Subquery-wrap
  // each so its own internal set operators can't bleed into the UNION below.
  // When both dimensions are selected the result is the segment∩group
  // intersection anyway, so we hand the group set as the is_not universe —
  // this keeps a near-universal `is_not` rule from scanning all contacts.
  const restrictUniverse = bothSides ? groupClause! : undefined;
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) => buildSegmentAudienceClause(id, orgId, restrictUniverse)),
  );
  const segmentBranches = perSegmentClauses.map(
    (clause) => drizzleSql`SELECT contact_id FROM (${clause}) seg_inner`,
  );

  return buildAudienceSourceClause(segmentBranches, groupClause);
}

// Build the SQL that yields one row per qualifying contact_id, with the
// per-contact snapshot booleans materialized, reading candidates from
// `candidateRelation` (a relation exposing a `contact_id` column, e.g. a
// materialized temp table). The qualifier WHERE clause OR-combines the
// filter toggles: a contact is in if ANY enabled category includes them,
// and they're never in if they have any opt-out record for this org.
function buildQualifierFromRelation(
  input: AudiencePreviewInput,
  candidateRelation: SQL,
): SQL {
  const { orgId, filters } = input;
  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;
  const excludeInUse = input.excludeInUse === true;

  return drizzleSql`
    with ${flagSetCtes(orgId)},
    flagged as (
      select
        cand.contact_id,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere
      from ${candidateRelation} cand
      ${flagJoins("cand")}
    )
    select
      contact_id,
      has_opt_in as was_opt_in,
      has_clicker as was_clicker,
      (not has_opt_in and not has_clicker) as was_no_status
    from flagged
    where has_opt_out = false
      and (
        (${includeNoStatus}::boolean and not has_opt_in and not has_clicker)
        or (${includeOptIn}::boolean and has_opt_in)
        or (${includeClickers}::boolean and has_clicker)
        or (${includeNotClicked}::boolean and not has_clicker)
      )
      and (not ${excludeInUse}::boolean or not is_in_use_elsewhere)
  `;
}

function hasAnySource(input: AudiencePreviewInput): boolean {
  return (
    input.segmentIds.length > 0 || (input.contactGroupIds?.length ?? 0) > 0
  );
}

// Stage-level filter toggles. Mutex on include_clickers / exclude_clickers
// is enforced upstream (validator + DB check constraint).
export interface StageAudienceFilters {
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  // Optional A/B partition. When both are set, the audience is filtered
  // by `mod(hashtext(contact_id::text), split_total) = split_index - 1`.
  // Either-NULL ⇒ no partition. Bounds are enforced by the DB CHECK.
  split_index?: number | null;
  split_total?: number | null;
}

export interface StageAudienceCountResult {
  count: number;
  breakdown: {
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  };
}

// Compute the resolved audience count + breakdown for a stage's filters on
// top of a campaign's frozen pool, with live opt-outs excluded. Shared by
// the audience-preview endpoint (hypothetical filters posted in the body),
// the audience-count endpoint (filters read from the saved stage row), and
// the stages list endpoint (per-row audience_count column).
//
// One round-trip per call. The caller is responsible for verifying the
// campaign belongs to the org BEFORE calling — this function trusts that
// (campaignId, orgId) was already authorized.
export async function computeStageAudienceCount(
  campaignId: number,
  orgId: string,
  filters: StageAudienceFilters,
): Promise<StageAudienceCountResult> {
  const { include_no_status, include_clickers, exclude_clickers } = filters;
  const splitIndex = filters.split_index ?? null;
  const splitTotal = filters.split_total ?? null;
  const splitActive = splitIndex !== null && splitTotal !== null;
  // Row-number partitioning instead of hash partitioning so splits are
  // ALWAYS as equal as possible: every sibling gets either floor(N/M)
  // or ceil(N/M) contacts, never the ±2-5% variance hashtext produces.
  // The qualifying set is established first (opt-outs excluded, stage
  // filters applied), then ROW_NUMBER over a stable ORDER BY contact_id
  // assigns each contact to a bucket = (rn-1) % split_total. Bucket
  // membership is stable across previews so long as the qualifying set
  // is stable (i.e. same filter on each sibling, as the split endpoint
  // clones).
  const rows = (await db.execute(drizzleSql`
    with joined as (
      select
        p.contact_id,
        p.was_clicker_at_snapshot,
        p.was_no_status_at_snapshot,
        exists (
          select 1 from opt_outs oo
          where oo.contact_id = p.contact_id and oo.org_id = ${orgId}::uuid
        ) as is_opt_out_now
      from campaign_audience_pool p
      where p.campaign_id = ${campaignId}::int and p.org_id = ${orgId}::uuid
    ),
    qualified as (
      select
        contact_id,
        was_clicker_at_snapshot,
        was_no_status_at_snapshot,
        row_number() over (order by contact_id) - 1 as rn
      from joined
      where not is_opt_out_now
        and (
          (${include_no_status}::boolean and was_no_status_at_snapshot)
          or (${include_clickers}::boolean and was_clicker_at_snapshot)
        )
        and not (${exclude_clickers}::boolean and was_clicker_at_snapshot)
    )
    select
      count(*) filter (
        where not ${splitActive}::boolean
          or rn % ${splitTotal ?? 1}::int = (${(splitIndex ?? 1) - 1})::int
      )::int as count,
      (select count(*) from joined where not is_opt_out_now and was_no_status_at_snapshot)::int as no_status,
      (select count(*) from joined where not is_opt_out_now and was_clicker_at_snapshot)::int as clickers,
      (select count(*) from joined where is_opt_out_now)::int as excluded_for_optout
    from qualified
  `)) as unknown as {
    count: number;
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  }[];

  const row = rows[0] ?? {
    count: 0,
    no_status: 0,
    clickers: 0,
    excluded_for_optout: 0,
  };
  return {
    count: row.count,
    breakdown: {
      no_status: row.no_status,
      clickers: row.clickers,
      excluded_for_optout: row.excluded_for_optout,
    },
  };
}

// Projected stage audience for *draft* campaigns whose pool hasn't been
// frozen yet. Computes the count live against the campaign's selected
// segments + contact groups + campaign-level filters, then layers the
// stage filters on top. Returns the same shape as
// computeStageAudienceCount for a drop-in swap at the call site.
//
// Cap is honored as a clamp on the final count (the at-activation
// snapshot will random-sample, but for preview a clamp gives the right
// upper bound). Splits are honored by ANDing the hashtext partition
// into the WHERE.
//
// This intentionally lives parallel to previewAudience instead of
// merging: previewAudience handles the campaign-level question ("how
// many contacts would this campaign reach if activated now"), whereas
// this answers the stage-level question ("how many would THIS stage
// reach inside that campaign"). The two queries share buildSegment-
// AudienceClause and the qualifier SQL, but the SELECT shape differs.
export async function computeStageAudienceCountForDraft(
  campaign: {
    id: number;
    orgId: string;
    segmentIds: number[];
    contactGroupIds: number[];
    filters: AudienceFilters;
    cap: number | null;
    excludeInUse?: boolean;
  },
  stageFilters: StageAudienceFilters,
): Promise<StageAudienceCountResult> {
  const { orgId, segmentIds, contactGroupIds, filters, cap } = campaign;
  const excludeInUse = campaign.excludeInUse === true;
  // No audience source on the parent campaign → trivially zero.
  if (segmentIds.length === 0 && contactGroupIds.length === 0) {
    return {
      count: 0,
      breakdown: { no_status: 0, clickers: 0, excluded_for_optout: 0 },
    };
  }

  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;

  const stageIncludeNoStatus = stageFilters.include_no_status;
  const stageIncludeClickers = stageFilters.include_clickers;
  const stageExcludeClickers = stageFilters.exclude_clickers;
  const splitIndex = stageFilters.split_index ?? null;
  const splitTotal = stageFilters.split_total ?? null;
  const splitActive = splitIndex !== null && splitTotal !== null;

  // Mirror previewAudience's source composition — segments OR together,
  // groups OR together, the two dimensions INTERSECT when both are present.
  // The group set doubles as the is_not universe restriction when both
  // dimensions are present (perf — see buildSegmentAudienceClause).
  const groupClause = buildGroupMembershipClause(orgId, contactGroupIds);
  const bothSides = segmentIds.length > 0 && contactGroupIds.length > 0;
  const restrictUniverse = bothSides ? groupClause! : undefined;
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) => buildSegmentAudienceClause(id, orgId, restrictUniverse)),
  );
  const segmentBranches = perSegmentClauses.map(
    (clause) => drizzleSql`SELECT contact_id FROM (${clause}) seg_inner`,
  );
  const source = buildAudienceSourceClause(segmentBranches, groupClause);

  // Row-number partitioning over the qualified set so splits are as
  // equal as possible. Mirrors the active-pool path.
  const rows = (await db.execute(drizzleSql`
    with sources as (
      select distinct contact_id from (${source}) u
    ),
    ${flagSetCtes(orgId)},
    flagged as (
      select
        s.contact_id,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere
      from sources s
      ${flagJoins("s")}
    ),
    qualified as (
      select
        contact_id,
        row_number() over (order by contact_id) - 1 as rn
      from flagged
      where has_opt_out = false
        and (
          (${includeNoStatus}::boolean and not has_opt_in and not has_clicker)
          or (${includeOptIn}::boolean and has_opt_in)
          or (${includeClickers}::boolean and has_clicker)
          or (${includeNotClicked}::boolean and not has_clicker)
        )
        and (not ${excludeInUse}::boolean or not is_in_use_elsewhere)
        and (
          (${stageIncludeNoStatus}::boolean and not has_opt_in and not has_clicker)
          or (${stageIncludeClickers}::boolean and has_clicker)
        )
        and not (${stageExcludeClickers}::boolean and has_clicker)
    )
    select
      count(*) filter (
        where not ${splitActive}::boolean
          or rn % ${splitTotal ?? 1}::int = (${(splitIndex ?? 1) - 1})::int
      )::int as count,
      (select count(*) from flagged
        where has_opt_out = false and not has_opt_in and not has_clicker)::int as no_status,
      (select count(*) from flagged
        where has_opt_out = false and has_clicker)::int as clickers,
      (select count(*) from flagged where has_opt_out)::int as excluded_for_optout
    from qualified
  `)) as unknown as {
    count: number;
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  }[];

  const row = rows[0] ?? {
    count: 0,
    no_status: 0,
    clickers: 0,
    excluded_for_optout: 0,
  };
  // Apply the campaign cap as an upper-bound clamp. At activation the
  // snapshot will random-sample, but a clamp here gives the right
  // ceiling for the preview.
  const cappedCount =
    cap !== null && cap < row.count ? cap : row.count;
  return {
    count: cappedCount,
    breakdown: {
      no_status: row.no_status,
      clickers: row.clickers,
      excluded_for_optout: row.excluded_for_optout,
    },
  };
}

// ── Batched per-stage audience counts ────────────────────────────────────────
// The stages-list endpoint needs the audience_count for EVERY stage of a
// campaign. Doing that as one query per stage (computeStageAudienceCount* per
// row) is an N+1 that dominates the page's latency. These two functions compute
// the count for MANY non-lane stages in a SINGLE pass and are numerically
// identical to calling the per-stage function for each stage — proven by
// scripts/tmp-verify-batch.ts across real campaigns before this shipped.
//
// Identity argument (must hold for both):
//   • the candidate set (frozen pool, or segment∩group source) is scanned ONCE
//     and is the same set the per-stage query reads;
//   • the live opt-out exclusion is the same membership test — an `oo_set` hash
//     anti-join is logically identical to the per-row `EXISTS (opt_outs …)`
//     (one opt_out row ⇒ excluded; the pool has a unique row per contact so the
//     join can't fan out);
//   • per-stage filters/split come from a per-stage relation, and the split
//     bucket uses ROW_NUMBER() PARTITIONed BY stage_id ORDERed BY contact_id —
//     within each partition that is byte-identical to the per-stage
//     ROW_NUMBER() OVER (ORDER BY contact_id).
// Lane stages (behavioral_tier set) are NOT handled here — they keep using
// countStageRecipients (live tier + aliveness), which is left untouched.

export interface StageCountBatchItem {
  stageId: number;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
}

// One row per stage, as a typed UNION ALL of SELECTs (robust against VALUES
// type inference): stage_id + the three filter booleans + the split bounds.
// The split filter `split_total is null or split_index is null or
// rn % split_total = split_index - 1` reproduces the per-stage
// `not splitActive or rn % splitTotal = splitIndex - 1` exactly.
function buildStagesCte(stages: StageCountBatchItem[]): SQL {
  const rows = stages.map(
    (s) => drizzleSql`select
      ${s.stageId}::int as stage_id,
      ${s.include_no_status}::boolean as inc_ns,
      ${s.include_clickers}::boolean as inc_cl,
      ${s.exclude_clickers}::boolean as exc_cl,
      ${s.split_index}::int as split_index,
      ${s.split_total}::int as split_total`,
  );
  return rows.reduce((acc, r, i) =>
    i === 0 ? r : drizzleSql`${acc} union all ${r}`,
  );
}

const BATCH_SPLIT_FILTER = drizzleSql`count(*) filter (
        where split_total is null or split_index is null
          or rn % split_total = split_index - 1
      )::int as count`;

// Batched equivalent of computeStageAudienceCount(...).count for the ACTIVE
// (frozen-pool) path. Returns stage_id → count; a stage with zero qualifying
// contacts is absent from the map (the caller defaults it to 0, matching the
// per-stage function which returns count 0).
export async function computeStageAudienceCountsBatch(
  campaignId: number,
  orgId: string,
  stages: StageCountBatchItem[],
): Promise<Map<number, number>> {
  if (stages.length === 0) return new Map();
  const stagesCte = buildStagesCte(stages);
  const rows = (await db.execute(drizzleSql`
    with oo_set as (
      select distinct contact_id from opt_outs where org_id = ${orgId}::uuid
    ),
    -- MATERIALIZED: compute the pool ∩ opt-out base ONCE, then the per-stage
    -- relation cross-joins it. Without this the planner can re-scan the base per
    -- stage in a nested loop (one statement doing N× the work) instead of N
    -- cheap statements.
    base as materialized (
      select
        p.contact_id,
        p.was_clicker_at_snapshot,
        p.was_no_status_at_snapshot,
        (oo_set.contact_id is not null) as is_opt_out_now
      from campaign_audience_pool p
      left join oo_set on oo_set.contact_id = p.contact_id
      where p.campaign_id = ${campaignId}::int and p.org_id = ${orgId}::uuid
    ),
    st as (${stagesCte}),
    qualified as (
      select
        st.stage_id,
        st.split_index,
        st.split_total,
        row_number() over (partition by st.stage_id order by base.contact_id) - 1 as rn
      from st
      join base on
        not base.is_opt_out_now
        and (
          (st.inc_ns and base.was_no_status_at_snapshot)
          or (st.inc_cl and base.was_clicker_at_snapshot)
        )
        and not (st.exc_cl and base.was_clicker_at_snapshot)
    )
    select stage_id, ${BATCH_SPLIT_FILTER}
    from qualified
    group by stage_id
  `)) as unknown as { stage_id: number; count: number }[];
  return new Map(rows.map((r) => [Number(r.stage_id), Number(r.count)]));
}

// Batched equivalent of computeStageAudienceCountForDraft(...).count for the
// DRAFT (projected) path. Source set is built ONCE (it depends only on the
// campaign, not the stage) — the per-stage function rebuilt it for every stage.
export async function computeStageAudienceCountsBatchForDraft(
  campaign: {
    id: number;
    orgId: string;
    segmentIds: number[];
    contactGroupIds: number[];
    filters: AudienceFilters;
    cap: number | null;
    excludeInUse?: boolean;
  },
  stages: StageCountBatchItem[],
): Promise<Map<number, number>> {
  if (stages.length === 0) return new Map();
  const { orgId, segmentIds, contactGroupIds, filters, cap } = campaign;
  const excludeInUse = campaign.excludeInUse === true;
  // No audience source on the parent campaign → every stage is trivially zero
  // (mirrors computeStageAudienceCountForDraft's short-circuit).
  if (segmentIds.length === 0 && contactGroupIds.length === 0) {
    return new Map(stages.map((s) => [s.stageId, 0]));
  }

  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;

  // Identical source composition to computeStageAudienceCountForDraft (it uses
  // the same buildAudienceSourceSql logic inline).
  const source = await buildAudienceSourceSql({
    orgId,
    segmentIds,
    contactGroupIds,
    filters,
    excludeInUse,
  });
  const stagesCte = buildStagesCte(stages);

  const rows = (await db.execute(drizzleSql`
    with sources as (
      select distinct contact_id from (${source}) u
    ),
    ${flagSetCtes(orgId)},
    -- MATERIALIZED is load-bearing: the source set-ops (segment-rule SQL) are
    -- expensive. Computing the flagged set once and reusing it across the
    -- per-stage cross-join keeps the batch at one source evaluation. Without it
    -- the planner can re-evaluate the source per stage inside this single
    -- statement, blowing statement_timeout where the old per-stage path (N
    -- separate statements) did not. MATERIALIZED changes execution, not results.
    flagged as materialized (
      select
        s.contact_id,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere
      from sources s
      ${flagJoins("s")}
    ),
    st as (${stagesCte}),
    qualified as (
      select
        st.stage_id,
        st.split_index,
        st.split_total,
        row_number() over (partition by st.stage_id order by flagged.contact_id) - 1 as rn
      from st
      join flagged on
        flagged.has_opt_out = false
        and (
          (${includeNoStatus}::boolean and not flagged.has_opt_in and not flagged.has_clicker)
          or (${includeOptIn}::boolean and flagged.has_opt_in)
          or (${includeClickers}::boolean and flagged.has_clicker)
          or (${includeNotClicked}::boolean and not flagged.has_clicker)
        )
        and (not ${excludeInUse}::boolean or not flagged.is_in_use_elsewhere)
        and (
          (st.inc_ns and not flagged.has_opt_in and not flagged.has_clicker)
          or (st.inc_cl and flagged.has_clicker)
        )
        and not (st.exc_cl and flagged.has_clicker)
    )
    select stage_id, ${BATCH_SPLIT_FILTER}
    from qualified
    group by stage_id
  `)) as unknown as { stage_id: number; count: number }[];

  const counts = new Map<number, number>(
    rows.map((r) => [Number(r.stage_id), Number(r.count)]),
  );
  // Per-stage cap clamp, exactly as computeStageAudienceCountForDraft (min(cap, count)).
  const result = new Map<number, number>();
  for (const s of stages) {
    const c = counts.get(s.stageId) ?? 0;
    result.set(s.stageId, cap !== null && cap < c ? cap : c);
  }
  return result;
}

// Compute the count + composition breakdown for the UI's audience
// preview. No DB write.
//
// Returns total_matching (pre-cap), count (post-cap, what actually gets
// sent to), and a per-source breakdown so the UI can show how segments
// vs contact groups vs overlap contribute. One SQL round-trip; the
// breakdown reuses the same CTE chain as the count.
//
// The snapshot path (snapshotAudience) builds its own row-level projection
// via buildQualifierFromRelation (against a materialized temp table) for the
// actual insert. The preview takes a different shape because it aggregates
// instead.
export async function previewAudience(
  input: AudiencePreviewInput,
): Promise<AudiencePreviewResult> {
  const cap = input.cap ?? null;
  if (!hasAnySource(input)) {
    return {
      count: 0,
      total_matching: 0,
      applied_cap: cap,
      from_segments: 0,
      from_groups: 0,
      overlap: 0,
      excluded_for_optout: 0,
      in_use_in_other_campaigns: 0,
    };
  }

  const { orgId, segmentIds, contactGroupIds = [], filters } = input;
  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;
  const excludeInUse = input.excludeInUse === true;
  // When BOTH dimensions are selected the audience is their INTERSECTION:
  // a contact must be in a selected segment AND a selected group. With only
  // one dimension populated, that side stands alone (no intersection).
  const bothSides = segmentIds.length > 0 && contactGroupIds.length > 0;

  // Group side, built first so it can double as the is_not universe
  // restriction for the segment evaluation when both dimensions are present
  // (see buildSegmentAudienceClause). This is the key perf lever: it keeps a
  // near-universal `is_not` rule from materializing the entire contacts table
  // before the intersection narrows it to the group.
  const groupClause = buildGroupMembershipClause(orgId, contactGroupIds);
  const restrictUniverse = bothSides ? groupClause! : undefined;

  // Per-segment clauses tagged with a from_segment=true / from_group=false
  // marker so the aggregate query can attribute each contact to a source.
  // We use UNION ALL because the GROUP BY downstream dedupes via BOOL_OR.
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) => buildSegmentAudienceClause(id, orgId, restrictUniverse)),
  );
  const segmentBranches = perSegmentClauses.map(
    (clause) => drizzleSql`
      SELECT contact_id, true::boolean AS from_segment, false::boolean AS from_group
      FROM (${clause}) seg_inner
    `,
  );
  const groupBranches = groupClause
    ? [
        drizzleSql`
          SELECT contact_id, false::boolean AS from_segment, true::boolean AS from_group
          FROM (${groupClause}) grp_inner
        `,
      ]
    : [];
  const allBranches = [...segmentBranches, ...groupBranches];
  const unionedWithSources = allBranches.reduce(
    (acc, branch, i) =>
      i === 0 ? branch : drizzleSql`${acc} UNION ALL ${branch}`,
  );

  const rows = (await db.execute(drizzleSql`
    with unionized as (${unionedWithSources}),
    sources as (
      select
        contact_id,
        bool_or(from_segment) as from_segment,
        bool_or(from_group) as from_group
      from unionized
      group by contact_id
    ),
    ${flagSetCtes(orgId)},
    flagged as (
      select
        s.contact_id,
        s.from_segment,
        s.from_group,
        (oo_set.contact_id is not null) as has_opt_out,
        (oi_set.contact_id is not null) as has_opt_in,
        (cl_set.contact_id is not null) as has_clicker,
        (iu_set.contact_id is not null) as is_in_use_elsewhere
      from sources s
      ${flagJoins("s")}
    ),
    qualified as (
      select
        f.*,
        (
          not has_opt_out and (
            (${includeNoStatus}::boolean and not has_opt_in and not has_clicker)
            or (${includeOptIn}::boolean and has_opt_in)
            or (${includeClickers}::boolean and has_clicker)
            or (${includeNotClicked}::boolean and not has_clicker)
          )
        ) as qualifies
      from flagged f
    ),
    eligible as (
      -- The actual pool the cap samples from. When the campaign-level
      -- exclude_in_use flag is on, in-use contacts are dropped here so
      -- total_matching reflects the unused pool. membership_ok applies the
      -- cross-dimension intersection: when both a segment and a group are
      -- selected, a contact must appear in both sides.
      select
        q.*,
        (
          q.qualifies
          and (not ${excludeInUse}::boolean or not q.is_in_use_elsewhere)
        ) as is_eligible,
        (not ${bothSides}::boolean or (q.from_segment and q.from_group)) as membership_ok
      from qualified q
    )
    select
      -- The audience that actually sends = eligible ∩ membership rule.
      count(*) filter (where is_eligible and membership_ok)::int as total_matching,
      -- Per-source contributions stay PRE-intersection (eligible on each
      -- side) so the UI can show how the two dimensions narrow down; the
      -- intersection itself is the overlap column, which equals
      -- total_matching when both dimensions are selected.
      count(*) filter (where is_eligible and from_segment)::int as from_segments,
      count(*) filter (where is_eligible and from_group)::int as from_groups,
      count(*) filter (where is_eligible and from_segment and from_group)::int as overlap,
      count(*) filter (where has_opt_out)::int as excluded_for_optout,
      -- Reported on the in-audience set (post-intersection, pre in-use
      -- exclusion) so the UI's "N excluded" reflects the real audience.
      count(*) filter (where qualifies and membership_ok and is_in_use_elsewhere)::int as in_use_in_other_campaigns
    from eligible
  `)) as unknown as {
    total_matching: number;
    from_segments: number;
    from_groups: number;
    overlap: number;
    excluded_for_optout: number;
    in_use_in_other_campaigns: number;
  }[];

  const row = Array.isArray(rows) ? rows[0] : null;
  const total = row?.total_matching ?? 0;
  const effective = cap !== null && cap < total ? cap : total;
  return {
    count: effective,
    total_matching: total,
    applied_cap: cap,
    from_segments: row?.from_segments ?? 0,
    from_groups: row?.from_groups ?? 0,
    overlap: row?.overlap ?? 0,
    excluded_for_optout: row?.excluded_for_optout ?? 0,
    in_use_in_other_campaigns: row?.in_use_in_other_campaigns ?? 0,
  };
}

// Snapshot the audience for a campaign: inserts one row into
// campaign_audience_pool for each qualifying contact with its per-row
// snapshot booleans. Returns the count of inserted rows + the full
// matching pool size. Caller is responsible for running this inside a
// transaction with the campaign row itself, so a failure rolls back the
// whole campaign.
//
// When `cap` is set and less than the resolved pool, applies
// ORDER BY RANDOM() LIMIT cap to take a random sample. The sample is
// frozen in the pool — there's no reseeding.
export async function snapshotAudience(
  input: AudienceSnapshotInput,
  // MUST be a transaction handle: this materializes a `ON COMMIT DROP` temp
  // table, so it only works inside a transaction. Both callers (campaign
  // create + draft→active) pass their tx. Falls back to the top-level db
  // only for the no-source short-circuit, which never reaches the temp table.
  tx?: Pick<typeof db, "execute">,
): Promise<AudienceSnapshotResult> {
  if (!hasAnySource(input)) return { count: 0, total_matching: 0 };
  const runner = tx ?? db;
  const cap = input.cap ?? null;

  // Materialize the candidate set (segment ∩ group composition) into a temp
  // table and ANALYZE it before joining the status flags. This is the crux
  // of the perf fix: the source is built from UNION/INTERSECT/EXCEPT set ops,
  // whose output cardinality Postgres can't estimate — it defaults to ~200
  // rows. At real scale (100K+ candidates) that misestimate makes the planner
  // pick nested-loop anti-joins for the opt-out / in-use exclusions, which
  // never finish (statement timeout on activation). A materialized + analyzed
  // temp table gives the planner true row counts, so the exclusions hash-join
  // and the whole snapshot runs in ~2s instead of timing out. The temp table
  // also lets count + insert share one evaluation of the source set ops.
  const source = await buildAudienceSourceSql(input);
  await runner.execute(drizzleSql`
    create temp table audience_candidates on commit drop as
    select distinct contact_id from (${source}) src
  `);
  await runner.execute(drizzleSql`analyze audience_candidates`);

  // Resolve the qualified set (status filters + opt-out / in-use exclusions,
  // with the snapshot booleans) into a second temp table. Doing this once —
  // rather than re-running the qualifier for both the count and the insert —
  // means the (now correctly-planned) flag hash-joins evaluate a single time;
  // the count is then a trivial read and the insert just samples this set.
  const qualifying = buildQualifierFromRelation(
    input,
    drizzleSql`audience_candidates`,
  );
  await runner.execute(drizzleSql`
    create temp table audience_qualified on commit drop as ${qualifying}
  `);

  const totalRows = (await runner.execute(drizzleSql`
    select count(*)::int as count from audience_qualified
  `)) as unknown as { count: number }[];
  const total = Array.isArray(totalRows) ? totalRows[0]?.count ?? 0 : 0;

  const limitClause =
    cap !== null && cap < total
      ? drizzleSql`order by random() limit ${cap}`
      : drizzleSql``;

  const result = (await runner.execute(drizzleSql`
    insert into campaign_audience_pool
      (campaign_id, contact_id, org_id, was_clicker_at_snapshot, was_opt_in_at_snapshot, was_no_status_at_snapshot)
    select
      ${input.campaignId}::int,
      contact_id,
      ${input.orgId}::uuid,
      was_clicker,
      was_opt_in,
      was_no_status
    from audience_qualified
    ${limitClause}
    on conflict (campaign_id, contact_id) do nothing
    returning contact_id
  `)) as unknown as { contact_id: string }[];
  const count = Array.isArray(result) ? result.length : 0;
  return { count, total_matching: total };
}
