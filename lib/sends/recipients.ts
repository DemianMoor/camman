import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// The stage-level audience toggles + split partition that narrow the frozen
// campaign_audience_pool down to a single stage's recipients.
export interface StageRecipientFilters {
  includeNoStatus: boolean;
  includeClickers: boolean;
  excludeClickers: boolean;
  splitIndex: number | null;
  splitTotal: number | null;
}

export interface StageRecipientRow {
  contact_id: string;
  phone_number: string;
}

// Builds the SELECT that yields a stage's qualifying recipients:
//   frozen pool ∩ not-opted-out (live) ∩ stage filter toggles ∩ split bucket,
// ordered by contact_id (stable, deterministic). Returns contact_id +
// phone_number. SHARED by the CSV export and the send pipeline so the two can
// NEVER diverge — this MUST stay byte-equivalent to what export-phones emitted.
export function stageRecipientsSql(opts: {
  campaignId: number;
  orgId: string;
  filters: StageRecipientFilters;
  limit?: number;
  offset?: number;
}): SQL {
  const { campaignId, orgId, filters: f } = opts;
  const splitActive = f.splitIndex !== null && f.splitTotal !== null;
  const limitClause = opts.limit !== undefined ? sql`limit ${opts.limit}` : sql``;
  const offsetClause =
    opts.offset !== undefined ? sql`offset ${opts.offset}` : sql``;

  return sql`
    with qualified as (
      select
        c.phone_number,
        p.contact_id,
        row_number() over (order by p.contact_id) - 1 as rn
      from campaign_audience_pool p
      inner join contacts c on c.id = p.contact_id
      where p.campaign_id = ${campaignId}::int
        and p.org_id = ${orgId}::uuid
        and not exists (
          select 1 from opt_outs oo
          where oo.contact_id = p.contact_id and oo.org_id = ${orgId}::uuid
        )
        and (
          (${f.includeNoStatus}::boolean and p.was_no_status_at_snapshot)
          or (${f.includeClickers}::boolean and p.was_clicker_at_snapshot)
        )
        and not (${f.excludeClickers}::boolean and p.was_clicker_at_snapshot)
    )
    select contact_id, phone_number
    from qualified
    where not ${splitActive}::boolean
      or rn % ${f.splitTotal ?? 1}::int = (${(f.splitIndex ?? 1) - 1})::int
    order by contact_id
    ${limitClause}
    ${offsetClause}
  `;
}

// Materialize the full qualifying recipient list for a stage (no limit). Used
// by the send kickoff. For very large audiences this loads all rows into
// memory; batching can be layered in later if needed.
export async function enumerateStageRecipients(
  dbc: DbOrTx,
  opts: { campaignId: number; orgId: string; filters: StageRecipientFilters },
): Promise<StageRecipientRow[]> {
  const rows = (await dbc.execute(
    stageRecipientsSql(opts),
  )) as unknown as StageRecipientRow[];
  return Array.isArray(rows) ? rows : [];
}
