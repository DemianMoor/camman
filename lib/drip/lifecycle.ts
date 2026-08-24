import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { purchasedClause } from "@/lib/sale-attribution";

/** Either the pooled client or an open transaction. */
type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Drip journey lifecycle (Drip Phase 6).
//
// ⚠️ THIS IS THE CHECK PHASE 5 FAILED. A contact replied STOP, was suppressed
// and attributed correctly, and its journey still read 'active' — because
// nothing in the codebase ever closed a journey. `completed` and `exited`
// existed only in a CHECK constraint.
//
// ⚠️ CLOSING A JOURNEY IS NOT BOOKKEEPING. The partial unique index
// drip_journeys_one_live_per_contact_uniq keys on state IN ('routed','active'),
// so a live journey holds that contact's ONLY slot. Until it closes, the contact
// can never be routed to another drip campaign — and an opted-out lead would
// hold its slot for ever. Every transition here frees the slot by construction.
//
// ⚠️ FREEING THE SLOT IS NOT PERMISSION TO RE-ROUTE. The routing evaluator still
// applies the week rule, the same-offer-same-creative rule and the org-wide
// opt-out gate. A closed journey makes a contact ELIGIBLE for consideration
// again; it does not make it a target.

export const TERMINAL_STATES = [
  "opted_out",
  "converted",
  "completed",
  "expired",
  "exited",
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export interface CloseResult {
  closed: number;
  state: TerminalState;
}

/**
 * Close journeys, idempotently.
 *
 * ⚠️ Every close is guarded by `state IN ('routed','active')`, so a journey that
 * already reached a terminal state is never re-stamped and never has its
 * `closed_at` moved. Two writers racing produce one close, not two.
 */
async function close(
  tx: DripTx,
  state: TerminalState,
  reason: string,
  where: ReturnType<typeof sql>,
): Promise<CloseResult> {
  const rows = (await tx.execute(sql`
    UPDATE drip_journeys j
    SET state = ${state}, closed_at = now(), close_reason = ${reason}
    WHERE j.state IN ('routed', 'active')
      AND ${where}
    RETURNING j.id
  `)) as unknown as { id: string }[];
  return { closed: rows.length, state };
}

/**
 * STOP received ⇒ close this contact's live journey.
 *
 * Called from the opt-out ingesters, in the SAME transaction that writes the
 * `opt_outs` row and cascade-cancels pending sends — so a lead can never be
 * suppressed-but-still-journeying, which is precisely the state Phase 5 left
 * behind.
 */
export async function closeJourneyOnOptOut(
  tx: DripTx,
  { orgId, contactId }: { orgId: string; contactId: string },
): Promise<CloseResult> {
  return close(
    tx,
    "opted_out",
    "stop_received",
    sql`j.org_id = ${orgId}::uuid AND j.contact_id = ${contactId}::uuid`,
  );
}

/**
 * Purchase ⇒ close.
 *
 * ⚠️ VIA purchasedClause(), NEVER sale_status = 'sale'. This account's network
 * fires `lead`-status postbacks for paid conversions and effectively never sends
 * `sale`; an `= 'sale'` test once found 2 buyers where the truth was ~835. That
 * bug is the reason this helper exists rather than an inline predicate.
 */
export async function closeJourneysOnPurchase(
  tx: DripTx,
  { orgId, campaignId }: { orgId: string; campaignId?: number },
): Promise<CloseResult> {
  const scope = campaignId != null ? sql`AND j.campaign_id = ${campaignId}` : sql``;
  return close(
    tx,
    "converted",
    "purchased",
    sql`j.org_id = ${orgId}::uuid ${scope}
        AND EXISTS (
          SELECT 1 FROM stage_sends ss
          WHERE ss.contact_id = j.contact_id
            AND ss.campaign_id = j.campaign_id
            AND ss.org_id = j.org_id
            AND ${purchasedClause()}
        )`,
  );
}

/**
 * Campaign archived ⇒ close every live journey on it.
 *
 * ⚠️ ARCHIVE, NOT DELETE (ruling D3). drip_journeys.campaign_id is ON DELETE
 * CASCADE, so a hard delete removes the journey row rather than leaving one to
 * mark — there is nothing to transition and that is accepted. Archive is the
 * project's soft-delete convention and is the only trigger that can produce
 * 'exited'.
 */
export async function closeJourneysOnArchive(
  tx: DripTx,
  { orgId, campaignId }: { orgId: string; campaignId: number },
): Promise<CloseResult> {
  return close(
    tx,
    "exited",
    "campaign_archived",
    sql`j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}`,
  );
}

/**
 * A journey is COMPLETE when every enabled stage that could serve it has served
 * it: the first-send happened, and no active behavioural child of that stage is
 * still owed a send.
 *
 * ⚠️ "Owed" is the operative word, and it is NOT "has a pending row". A child
 * whose timer has not elapsed has no row yet, so counting rows would complete a
 * journey minutes before its follow-ups were due and free the slot early. The
 * predicate below asks whether a child exists that this contact has NOT been
 * sent — which stays true until the send actually lands.
 */
export async function closeCompletedJourneys(
  tx: DripTx,
  { orgId, campaignId }: { orgId: string; campaignId: number },
): Promise<CloseResult> {
  return close(
    tx,
    "completed",
    "all_stages_sent",
    sql`j.org_id = ${orgId}::uuid
        AND j.campaign_id = ${campaignId}
        AND j.first_send_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM campaign_stages ch
          WHERE ch.parent_stage_id = j.first_stage_id
            AND ch.org_id = j.org_id
            AND ch.archived_at IS NULL
            AND ch.drip_active IS TRUE
            AND ch.drip_followup_minutes IS NOT NULL
            -- ⚠️ A LANE BELOW THE CONTACT'S CURRENT TIER IS UNREACHABLE FOR EVER.
            -- campaignTierExpr is HIGH-WATER: a tier only ever rises, so a
            -- contact that has clicked can never match the Ignored lane again.
            -- Waiting on it would make completion unreachable for every contact
            -- above the lowest active lane -- i.e. for anyone who ever engaged,
            -- which is exactly the population whose journey should end cleanly.
            AND ch.behavioral_tier >= COALESCE((
              SELECT MAX(t.tier) FROM (
                SELECT 1 AS tier FROM links l
                  JOIN clicks ck ON ck.link_id = l.id
                 WHERE l.campaign_id = j.campaign_id AND l.contact_id = j.contact_id
                   AND l.org_id = j.org_id
                   AND ck.classification NOT IN ('bot','prefetch','suspect')
                UNION ALL
                SELECT 2 FROM stage_sends ss3
                 WHERE ss3.campaign_id = j.campaign_id AND ss3.contact_id = j.contact_id
                   AND ss3.org_id = j.org_id AND ss3.offer_reached_at IS NOT NULL
              ) t
            ), 0)
            AND NOT EXISTS (
              SELECT 1 FROM stage_sends ss
              WHERE ss.stage_id = ch.id
                AND ss.contact_id = j.contact_id
                AND ss.org_id = j.org_id
            )
        )`,
  );
}

/**
 * Past the campaign's end_at ⇒ expire, but only once follow-ups have finished.
 *
 * ⚠️ END_AT ALREADY STOPS FIRST-SENDS — routing-eval refuses a lead whose
 * received_at is outside [start_at, end_at). What it does NOT do is end the
 * journeys of leads already messaged, and the spec is explicit that their
 * follow-ups may finish. So this reuses the same "nothing owed" predicate as
 * completion; end_at alone is not sufficient to close.
 */
export async function expireJourneysPastEndDate(
  tx: DripTx,
  { orgId, campaignId }: { orgId: string; campaignId: number },
): Promise<CloseResult> {
  return close(
    tx,
    "expired",
    "campaign_end_date_passed",
    sql`j.org_id = ${orgId}::uuid
        AND j.campaign_id = ${campaignId}
        AND EXISTS (
          SELECT 1 FROM drip_campaign_configs cfg
          WHERE cfg.campaign_id = j.campaign_id
            AND cfg.end_at IS NOT NULL
            AND cfg.end_at <= now()
        )
        AND NOT EXISTS (
          SELECT 1
          FROM campaign_stages ch
          WHERE ch.parent_stage_id = j.first_stage_id
            AND ch.org_id = j.org_id
            AND ch.archived_at IS NULL
            AND ch.drip_active IS TRUE
            AND ch.drip_followup_minutes IS NOT NULL
            -- ⚠️ A LANE BELOW THE CONTACT'S CURRENT TIER IS UNREACHABLE FOR EVER.
            -- campaignTierExpr is HIGH-WATER: a tier only ever rises, so a
            -- contact that has clicked can never match the Ignored lane again.
            -- Waiting on it would make completion unreachable for every contact
            -- above the lowest active lane -- i.e. for anyone who ever engaged,
            -- which is exactly the population whose journey should end cleanly.
            AND ch.behavioral_tier >= COALESCE((
              SELECT MAX(t.tier) FROM (
                SELECT 1 AS tier FROM links l
                  JOIN clicks ck ON ck.link_id = l.id
                 WHERE l.campaign_id = j.campaign_id AND l.contact_id = j.contact_id
                   AND l.org_id = j.org_id
                   AND ck.classification NOT IN ('bot','prefetch','suspect')
                UNION ALL
                SELECT 2 FROM stage_sends ss3
                 WHERE ss3.campaign_id = j.campaign_id AND ss3.contact_id = j.contact_id
                   AND ss3.org_id = j.org_id AND ss3.offer_reached_at IS NOT NULL
              ) t
            ), 0)
            AND NOT EXISTS (
              SELECT 1 FROM stage_sends ss
              WHERE ss.stage_id = ch.id
                AND ss.contact_id = j.contact_id
                AND ss.org_id = j.org_id
            )
        )`,
  );
}

/**
 * Cancel every pending send for a journey that is closing for a non-opt-out
 * reason.
 *
 * ⚠️ THE SHAPE MIRRORS THE OPT-OUT CASCADE ON PURPOSE — same terminal status,
 * same distinct `last_error` marker convention — so cancelled-by-lifecycle stays
 * countable apart from provider rejects, and anyone who already knows how the
 * opt-out cancel reads can read this one. Opt-out itself is NOT handled here:
 * the ingesters already cascade org-wide for the contact, which is broader than
 * per-journey and must stay that way.
 */
export async function cancelPendingForJourney(
  tx: DripTx,
  { orgId, contactId, campaignId, reason }: {
    orgId: string;
    contactId: string;
    campaignId: number;
    reason: string;
  },
): Promise<number> {
  const rows = (await tx.execute(sql`
    UPDATE stage_sends
    SET status = 'filtered', last_error = ${`journey_${reason}`}
    WHERE org_id = ${orgId}::uuid
      AND contact_id = ${contactId}::uuid
      AND campaign_id = ${campaignId}
      AND status = 'pending'
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length;
}
