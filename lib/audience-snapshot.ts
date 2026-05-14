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
  filters: AudienceFilters;
}

export interface AudienceSnapshotInput extends AudiencePreviewInput {
  campaignId: number;
}

export interface AudienceSnapshotResult {
  count: number;
}

// Build the SQL that yields one row per qualifying contact_id, with the
// per-contact snapshot booleans materialized. Both preview and snapshot
// reuse this — preview counts the rows, snapshot inserts them into the
// pool. The qualifier WHERE clause OR-combines the filter toggles: a
// contact is in if ANY enabled category includes them, and they're never
// in if they have any opt-out record for this org.
async function buildQualifyingContactsSql(input: AudiencePreviewInput) {
  const { orgId, segmentIds, filters } = input;
  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;

  // Per-segment rule-filtered clauses, UNION'd into segment_members. Each
  // segment's clause respects its own rules; a segment with zero active
  // rules contributes its full manual membership (the buildSegmentAudienceClause
  // helper handles the empty-rules short-circuit). The end result is the
  // distinct set of contacts who belong to at least one of the listed
  // segments AFTER each segment's rules are applied.
  const perSegmentClauses = await Promise.all(
    segmentIds.map((id) => buildSegmentAudienceClause(id, orgId)),
  );
  const unioned = perSegmentClauses.reduce(
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

// Compute the count for the UI's audience preview. No DB write.
export async function previewAudience(
  input: AudiencePreviewInput,
): Promise<AudienceSnapshotResult> {
  if (input.segmentIds.length === 0) return { count: 0 };
  const qualifying = await buildQualifyingContactsSql(input);
  const result = (await db.execute(drizzleSql`
    select count(*)::int as count from (${qualifying}) q
  `)) as unknown as { count: number }[];
  const row = Array.isArray(result) ? result[0] : null;
  return { count: row?.count ?? 0 };
}

// Snapshot the audience for a campaign: inserts one row into
// campaign_audience_pool for each qualifying contact with its per-row
// snapshot booleans. Returns the count of inserted rows. Caller is
// responsible for running this inside a transaction with the campaign
// row itself, so a failure rolls back the whole campaign.
export async function snapshotAudience(
  input: AudienceSnapshotInput,
  // Allow passing a transaction handle so this call participates in the
  // caller's transaction. Falls back to the top-level db.
  tx?: Pick<typeof db, "execute">,
): Promise<AudienceSnapshotResult> {
  if (input.segmentIds.length === 0) return { count: 0 };
  const runner = tx ?? db;
  const qualifying = await buildQualifyingContactsSql(input);
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
    on conflict (campaign_id, contact_id) do nothing
    returning contact_id
  `)) as unknown as { contact_id: string }[];
  const count = Array.isArray(result) ? result.length : 0;
  return { count };
}
