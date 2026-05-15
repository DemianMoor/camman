import "server-only";

import { sql as drizzleSql } from "drizzle-orm";

import { db } from "@/db/client";

import { buildSegmentAudienceClause } from "./segment-rules-eval";

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
}

export interface AudienceSnapshotResult {
  // Number of rows actually inserted into campaign_audience_pool.
  count: number;
  // Full matching pool size before the cap was applied. Equal to count
  // when no cap was in effect.
  total_matching: number;
}

// Build the SQL that yields one row per qualifying contact_id, with the
// per-contact snapshot booleans materialized. Both preview and snapshot
// reuse this — preview counts the rows, snapshot inserts them into the
// pool. The qualifier WHERE clause OR-combines the filter toggles: a
// contact is in if ANY enabled category includes them, and they're never
// in if they have any opt-out record for this org.
//
// Audience source is the UNION of:
//   * per-segment rule-filtered membership (via buildSegmentAudienceClause)
//   * contacts directly tagged in any of the selected contact_groups
// Either source can be empty; the function returns the empty set if both
// are empty (caller short-circuits before invoking).
async function buildQualifyingContactsSql(input: AudiencePreviewInput) {
  const { orgId, segmentIds, contactGroupIds = [], filters } = input;
  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;

  // Per-segment rule-filtered clauses. Each yields a set of contact_ids
  // honoring that segment's rules + manual membership UNION.
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) => buildSegmentAudienceClause(id, orgId)),
  );

  // Contact-group clause: every contact tagged with any of the selected
  // groups. Built inline because the rules engine doesn't model groups
  // (groups are tags directly on contacts, not gated by segment rules).
  const groupClauses =
    contactGroupIds.length > 0
      ? [
          drizzleSql`
            SELECT contact_id
            FROM contact_contact_groups
            WHERE org_id = ${orgId}::uuid
              AND contact_group_id = ANY(${drizzleSql.raw(
                "ARRAY[" + contactGroupIds.join(",") + "]::int[]",
              )})
          `,
        ]
      : [];

  const allClauses = [...perSegmentClauses, ...groupClauses];
  const unioned = allClauses.reduce(
    (acc, clause, i) =>
      i === 0 ? clause : drizzleSql`${acc} UNION ${clause}`,
  );

  return drizzleSql`
    with segment_members as (
      select distinct contact_id from (${unioned}) sm_union
    ),
    flagged as (
      select
        sm.contact_id,
        exists (
          select 1 from opt_outs oo
          where oo.contact_id = sm.contact_id and oo.org_id = ${orgId}::uuid
        ) as has_opt_out,
        exists (
          select 1 from opt_ins oi
          where oi.contact_id = sm.contact_id and oi.org_id = ${orgId}::uuid
        ) as has_opt_in,
        exists (
          select 1 from clickers c
          where c.contact_id = sm.contact_id and c.org_id = ${orgId}::uuid
        ) as has_clicker
      from segment_members sm
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
    )
    select
      count(*) filter (
        where not is_opt_out_now
          and (
            (${include_no_status}::boolean and was_no_status_at_snapshot)
            or (${include_clickers}::boolean and was_clicker_at_snapshot)
          )
          and not (${exclude_clickers}::boolean and was_clicker_at_snapshot)
      )::int as count,
      count(*) filter (
        where not is_opt_out_now and was_no_status_at_snapshot
      )::int as no_status,
      count(*) filter (
        where not is_opt_out_now and was_clicker_at_snapshot
      )::int as clickers,
      count(*) filter (where is_opt_out_now)::int as excluded_for_optout
    from joined
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

// Compute the count + composition breakdown for the UI's audience
// preview. No DB write.
//
// Returns total_matching (pre-cap), count (post-cap, what actually gets
// sent to), and a per-source breakdown so the UI can show how segments
// vs contact groups vs overlap contribute. One SQL round-trip; the
// breakdown reuses the same CTE chain as the count.
//
// The snapshot path (snapshotAudience) keeps using
// buildQualifyingContactsSql for the actual insert — its row-level
// projection is required by the pool insert. The preview takes a
// different shape because it aggregates instead.
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
    };
  }

  const { orgId, segmentIds, contactGroupIds = [], filters } = input;
  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;

  // Per-segment clauses tagged with a from_segment=true / from_group=false
  // marker so the aggregate query can attribute each contact to a source.
  // We use UNION ALL because the GROUP BY downstream dedupes via BOOL_OR.
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) => buildSegmentAudienceClause(id, orgId)),
  );
  const segmentBranches = perSegmentClauses.map(
    (clause) => drizzleSql`
      SELECT contact_id, true::boolean AS from_segment, false::boolean AS from_group
      FROM (${clause}) seg_inner
    `,
  );
  const groupBranches =
    contactGroupIds.length > 0
      ? [
          drizzleSql`
            SELECT contact_id, false::boolean AS from_segment, true::boolean AS from_group
            FROM contact_contact_groups
            WHERE org_id = ${orgId}::uuid
              AND contact_group_id = ANY(${drizzleSql.raw(
                "ARRAY[" + contactGroupIds.join(",") + "]::int[]",
              )})
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
    flagged as (
      select
        s.contact_id,
        s.from_segment,
        s.from_group,
        exists (
          select 1 from opt_outs oo
          where oo.contact_id = s.contact_id and oo.org_id = ${orgId}::uuid
        ) as has_opt_out,
        exists (
          select 1 from opt_ins oi
          where oi.contact_id = s.contact_id and oi.org_id = ${orgId}::uuid
        ) as has_opt_in,
        exists (
          select 1 from clickers c
          where c.contact_id = s.contact_id and c.org_id = ${orgId}::uuid
        ) as has_clicker
      from sources s
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
    )
    select
      count(*) filter (where qualifies)::int as total_matching,
      count(*) filter (where qualifies and from_segment)::int as from_segments,
      count(*) filter (where qualifies and from_group)::int as from_groups,
      count(*) filter (where qualifies and from_segment and from_group)::int as overlap,
      count(*) filter (where has_opt_out)::int as excluded_for_optout
    from qualified
  `)) as unknown as {
    total_matching: number;
    from_segments: number;
    from_groups: number;
    overlap: number;
    excluded_for_optout: number;
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
  // Allow passing a transaction handle so this call participates in the
  // caller's transaction. Falls back to the top-level db.
  tx?: Pick<typeof db, "execute">,
): Promise<AudienceSnapshotResult> {
  if (!hasAnySource(input)) return { count: 0, total_matching: 0 };
  const runner = tx ?? db;
  const qualifying = await buildQualifyingContactsSql(input);
  const cap = input.cap ?? null;

  // We count first so the caller knows total_matching even when capped.
  // One extra query, runs inside the same transaction so the pool sees
  // a consistent snapshot.
  const totalRows = (await runner.execute(drizzleSql`
    select count(*)::int as count from (${qualifying}) q
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
    from (${qualifying}) q
    ${limitClause}
    on conflict (campaign_id, contact_id) do nothing
    returning contact_id
  `)) as unknown as { contact_id: string }[];
  const count = Array.isArray(result) ? result.length : 0;
  return { count, total_matching: total };
}
