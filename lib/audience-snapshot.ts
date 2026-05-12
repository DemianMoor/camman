import "server-only";

import { sql as drizzleSql } from "drizzle-orm";

import { db } from "@/db/client";

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
function buildQualifyingContactsSql(input: AudiencePreviewInput) {
  const { orgId, segmentIds, filters } = input;
  const includeNoStatus = filters.include_no_status === true;
  const includeOptIn = filters.include_opt_in === true;
  const includeClickers = filters.include_clickers === true;
  const includeNotClicked = filters.include_not_clicked === true;

  // segment_ids must be a non-empty integer[]; caller validates at the
  // schema level. Convert to a literal SQL array fragment via sql.placeholder
  // would require parameter binding; using sql.raw on validated numeric ids
  // is safe here because the schema accepts only z.number().int().positive().
  const idsLiteral = segmentIds.length === 0 ? "0" : segmentIds.join(",");

  return drizzleSql`
    with segment_members as (
      select distinct contact_id
      from segment_contacts
      where org_id = ${orgId}::uuid
        and segment_id in (${drizzleSql.raw(idsLiteral)})
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

// Compute the count for the UI's audience preview. No DB write.
export async function previewAudience(
  input: AudiencePreviewInput,
): Promise<AudienceSnapshotResult> {
  if (input.segmentIds.length === 0) return { count: 0 };
  const qualifying = buildQualifyingContactsSql(input);
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
  const qualifying = buildQualifyingContactsSql(input);
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
