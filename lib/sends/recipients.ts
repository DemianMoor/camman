import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { campaignTierExpr } from "@/lib/campaign-tier";
import {
  applyEligibilityExcept,
  buildStageEligibilityExclusions,
} from "@/lib/sends/eligibility";
import { splitBucketMatch } from "@/lib/sends/split-bucket";

// Content-dedup overlay (Phase 2). When provided, the stage's recipients also
// subtract the eligibility exclusions (saw-this-creative-elsewhere [+ in-flight],
// and — if the campaign opts in — got-this-offer-before). creativeId NULL ⇒ no
// creative dedup (Edge A). Omitting `eligibility` entirely = no dedup (legacy
// callers + tests keep exactly today's behavior). org/campaign come from the
// outer opts so there's one source for them.
export interface StageEligibilityOverlay {
  creativeId: number | null;
  offerId: number | null;
  excludePriorOffer: boolean;
}

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
  // Migration 0096. Carried through the send path so the pre-mint backstop can
  // detect (and skip + alert on) any not_applicable contact that leaked past the
  // audience gates. Normally always 'eligible' — landlines never enter the pool.
  messaging_status?: string;
  // Migration 0096: stamped onto stage_sends at materialization (§1.7 analytics enabler).
  carrier_norm?: string;
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
  eligibility?: StageEligibilityOverlay;
  // Resumable materialization: when set, exclude contacts that ALREADY have a
  // LIVE stage_sends row for this stage (any status EXCEPT 'rejected'), so a
  // windowed/interrupted kickoff re-run materializes only the REMAINING
  // recipients. 'rejected' rows are canceled/recalled sends kept for audit — they
  // must NOT block re-enumeration, otherwise a cancel→edit→re-materialize would
  // silently produce 0 recipients. Omit for the export path + preview counts
  // (they want the full qualifying set).
  excludeMaterializedStageId?: number;
}): SQL {
  const { campaignId, orgId, filters: f } = opts;
  const splitActive = f.splitIndex !== null && f.splitTotal !== null;
  // Resumability filter (see excludeMaterializedStageId). Zero-width when unset,
  // so the emitted query is byte-identical to the pre-resumable version.
  const notYetMaterialized =
    opts.excludeMaterializedStageId !== undefined
      ? sql`
      and not exists (
        select 1 from stage_sends ss
        where ss.stage_id = ${opts.excludeMaterializedStageId}::int
          and ss.contact_id = p.contact_id
          and ss.status <> 'rejected'
      )`
      : sql``;
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

  // Content-dedup exclusions (Phase 2). Built from the stage's creative + the
  // campaign's offer + the opt-in toggle. When `eligibility` is omitted, all
  // layers are null and `eligible` collapses to `base` (today's behavior).
  const exclusions = opts.eligibility
    ? buildStageEligibilityExclusions({
        orgId,
        currentCampaignId: campaignId,
        currentCreativeId: opts.eligibility.creativeId,
        currentOfferId: opts.eligibility.offerId,
        excludePriorOffer: opts.eligibility.excludePriorOffer,
      })
    : { creative: null, inFlight: null, offer: null };

  // base = frozen pool ∩ live opt-outs ∩ stage filter toggles ∩ lane overlays.
  // The phone-number join is deferred to `qualified` so the dedup EXCEPTs operate
  // on a bare contact_id set. The split then partitions the POST-dedup audience
  // (what actually sends) via a STABLE per-contact hash bucket — see below.
  const base = sql`
    select p.contact_id
    from campaign_audience_pool p${tierJoin}
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
      and not (${f.excludeClickers}::boolean and p.was_clicker_at_snapshot)${behavioralWhere}${notYetMaterialized}
  `;

  return sql`
    with base as (${base}),
    eligible as (
      ${applyEligibilityExcept(sql`select contact_id from base`, exclusions)}
    ),
    qualified as (
      select
        c.phone_number,
        c.messaging_status,
        c.carrier_norm,
        e.contact_id
      from eligible e
      inner join contacts c on c.id = e.contact_id
    )
    select contact_id, phone_number, messaging_status, carrier_norm
    from qualified
    where not ${splitActive}::boolean
      or ${splitBucketMatch(sql`contact_id`, sql`${f.splitTotal ?? 1}`, sql`${f.splitIndex ?? 1}`)}
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
  opts: {
    campaignId: number;
    orgId: string;
    filters: StageRecipientFilters;
    eligibility?: StageEligibilityOverlay;
  },
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
  opts: {
    campaignId: number;
    orgId: string;
    filters: StageRecipientFilters;
    eligibility?: StageEligibilityOverlay;
    excludeMaterializedStageId?: number;
  },
): Promise<StageRecipientRow[]> {
  const rows = (await dbc.execute(
    stageRecipientsSql(opts),
  )) as unknown as StageRecipientRow[];
  if (!Array.isArray(rows)) return [];

  // Backstop (defense in depth): the audience gates + snapshot + landline sync
  // keep not_applicable contacts out of the pool, so this should never fire. If it
  // does, an upstream gate leaked — skip the offenders, count them, and alert
  // loudly rather than silently sending to a landline. NOT a quiet WHERE filter.
  const leaked = rows.filter((r) => r.messaging_status === "not_applicable");
  if (leaked.length > 0) {
    console.error(
      `[send-guard] ${leaked.length} not_applicable contact(s) leaked into stage ${opts.campaignId} recipients — skipping. Sample: ${leaked
        .slice(0, 5)
        .map((r) => r.contact_id)
        .join(", ")}`,
    );
    void notifyTelegram(
      `🛑 Send guard: ${leaked.length} landline/not_applicable contact(s) leaked into a send set (campaign ${opts.campaignId}) and were SKIPPED. An upstream audience gate leaked — investigate.`,
    );
    return rows.filter((r) => r.messaging_status !== "not_applicable");
  }
  return rows;
}
