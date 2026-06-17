import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { campaignTierExpr } from "@/lib/campaign-tier";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// The stage-level audience toggles + split partition that narrow the frozen
// campaign_audience_pool down to a single stage's recipients.
export interface StageRecipientFilters {
  includeNoStatus: boolean;
  includeClickers: boolean;
  excludeClickers: boolean;
  splitIndex: number | null;
  splitTotal: number | null;
  // Behavioral-lane overlays (step 3). OPTIONAL so ordinary callers (kickoff,
  // export, audience-count) pass neither and get exactly today's behavior.
  // When behavioralTier is set the stage is a lane: it resolves to the alive,
  // not-opted-out contacts whose LIVE campaign high-water tier EXACTLY equals
  // behavioralTier. parentStageId drives the aliveness ("received the prior
  // position") check. Either absent/null ⇒ that overlay is off.
  behavioralTier?: number | null;
  parentStageId?: number | null;
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

  // Behavioral-lane overlays. NULL-guarded: for an ordinary stage both fragments
  // render to the EMPTY sql, and they sit at zero-width insertion points, so the
  // emitted query is byte-identical to the pre-lane version. The frozen pool
  // stays the universe; tier + aliveness are LIVE overlays read at query time,
  // exactly like the existing live opt_outs check — the pool is never re-snapshotted.
  const isLane = f.behavioralTier !== null && f.behavioralTier !== undefined;
  const hasParent = f.parentStageId !== null && f.parentStageId !== undefined;

  // Block 1 — aliveness ("received the prior position"): keep only contacts who
  // received the parent stage. Tracked-only for now; the EXISTS body is shaped so
  // a manual-mode source unions in later with NO caller change, e.g.:
  //   union all select 1 from stage_result_rows srr
  //     where srr.stage_id = <parent> and srr.contact_id = p.contact_id
  //       and srr.outcome = 'delivered'
  const aliveness =
    isLane && hasParent
      ? sql`
        and exists (
          select 1 from stage_sends ss
          where ss.stage_id = ${f.parentStageId!}::int
            and ss.contact_id = p.contact_id
            and ss.org_id = ${orgId}::uuid
            and ss.status = 'sent'
        )`
      : sql``;

  // Block 2 — EXACT tier match + the global converted guard. campaignTierExpr is
  // LEFT JOINed (alias bt) so the high-water tier is read live; a contact with no
  // signal has NULL tier ⇒ coalesce 0 (the tier-0 / "ignored" lane). The `<> 3`
  // guard is redundant with exact-match against {0,1,2} but makes "converted
  // never appears in any lane" explicit and survives a future threshold lane.
  const tierJoin = isLane
    ? sql`
      left join (${campaignTierExpr(campaignId, orgId)}) bt on bt.contact_id = p.contact_id`
    : sql``;
  const behavioralWhere = isLane
    ? sql`${aliveness}
        and coalesce(bt.tier, 0) = ${f.behavioralTier!}::int
        and coalesce(bt.tier, 0) <> 3`
    : sql``;

  return sql`
    with qualified as (
      select
        c.phone_number,
        p.contact_id,
        row_number() over (order by p.contact_id) - 1 as rn
      from campaign_audience_pool p
      inner join contacts c on c.id = p.contact_id${tierJoin}
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
        and not (${f.excludeClickers}::boolean and p.was_clicker_at_snapshot)${behavioralWhere}
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

// Count the qualifying recipients for a stage WITHOUT materializing the rows —
// `select count(*)` over the same stageRecipientsSql query. The single source of
// truth for "how many would this stage send to right now", including the
// behavioral-lane overlays (tier + aliveness). The stages-list audience_count
// uses this for lane rows so the displayed number is the live lane preview, not
// a snapshot-only estimate. Reuses the choke-point query — no second recipient SQL.
export async function countStageRecipients(
  dbc: DbOrTx,
  opts: { campaignId: number; orgId: string; filters: StageRecipientFilters },
): Promise<number> {
  const inner = stageRecipientsSql(opts);
  const rows = (await dbc.execute(
    sql`select count(*)::int as n from (${inner}) q`,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
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
