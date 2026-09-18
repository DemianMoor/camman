import { sql, type SQL } from "drizzle-orm";

import {
  PURCHASE_EVENT_TYPE_IDS,
  purchasedClause,
  registeredClause,
} from "@/lib/sale-attribution";

// A contact's CURRENT high-water behavioral tier WITHIN one campaign:
//   0 = ignored        — no qualifying signal (see "absence" note below)
//   1 = clicked        — a CLEAN click on a link belonging to this campaign
//   2 = reached_offer  — a stage_sends row with offer_reached_at set
//   3 = registered     — a counted REGISTRATION (a retarget-signal event type,
//                        lib/sale-attribution.ts) and NO purchase-type event of
//                        ANY status on this campaign. $0, and never revenue.
//   4 = purchased      — a counted PURCHASE event in the conversion_events
//                        ledger for this campaign. EXITS the sequence; never a
//                        lane (migration 0184's CHECK admits 0-3 only).
//
// ⚠️ THE EXIT MOVED FROM 3 TO 4 (Phase 4, 2026-09-18) so the scale stays
// MONOTONIC IN BEHAVIOURAL RANK. That is load-bearing: the ranking function is
// MAX(tier), so a contact who registered AND bought must read as the HIGHER
// value, the exit. Appending Registered as 4 instead would have made MAX rank a
// registration above a purchase and messaged a buyer again.
//
// Nothing was back filled, because the tier is COMPUTED here and never stored.
// Measured on prod 2026-09-18: campaign_stages 2,100 rows / tier 3 → 0;
// report_stage_hour 514 / 0; report_group_hour 3,431 / 0.
//
// ⚠️ A REJECTED PURCHASE DOES NOT RETURN A CONTACT TO Registered. A rejected
// conversion contributes no tier of its own, so MAX alone would read a
// registrant with a rejected purchase as 3; the tier-3 branch therefore carries
// an explicit NOT EXISTS over purchase-type events at any KNOWN status
// (pending / approved / rejected). Such a contact falls back to their click /
// offer-reach tier — exactly what they read before this phase. A purchase row
// whose STATUS is unmapped (NULL) does NOT evict them: an unmapped row counts as
// nothing everywhere else in this codebase and counts as nothing here.
//
// ⚠️ EVERY BRANCH IS CAMPAIGN-SCOPED, including the two ledger ones. A
// registration on a PREVIOUS campaign or offer does not place a contact in this
// campaign's Registered lane; they read tier 0 and are targetable normally.
// "Has ever registered for offer X" is a SEGMENT RULE question, not a lane one.
//
// ⚠️ LANE MEMBERSHIP FREEZES AT MATERIALIZATION. A contact who registers after
// their lane materialized is still sent that lane's message: 382/382 recent lanes
// materialized before T-15 (p50 2.6h early) and the drain re-checks only
// opt-outs and the 1-hour phone dedup. A send-time purchase/registration
// re-check is a SEPARATE card, deliberately not attempted here.
//
// "Clean click" = NOT bot/prefetch/suspect, byte-for-byte the same definition
// the click report uses for its clean count (lib/links/click-report.ts:
// raw - bot - prefetch - suspect, i.e. human + unknown still count). Keep these
// two in sync — a divergence would let a click count toward a lane that the
// report calls dirty, or vice-versa.
const DIRTY_CLICK_CLASSIFICATIONS = ["bot", "prefetch", "suspect"] as const;

// ── THE SCALE ───────────────────────────────────────────────────────────────
// Named so the next insertion is one edit here, not another hunt for the
// literal. Consumers import these instead of writing the number.
export const TIER_IGNORED = 0;
export const TIER_CLICKED = 1;
export const TIER_REACHED_OFFER = 2;
export const TIER_REGISTERED = 3;
export const TIER_PURCHASED = 4;

/** The tier that EXITS the sequence. Never a lane; never targetable. */
export const EXIT_TIER = TIER_PURCHASED;

/** Every tier that CAN be a lane, ascending. Mirrors migration 0184's CHECK. */
export const LANE_TIER_VALUES: readonly number[] = [
  TIER_IGNORED,
  TIER_CLICKED,
  TIER_REACHED_OFFER,
  TIER_REGISTERED,
];

/**
 * The ONLY way a tier number reaches SQL.
 *
 * NOT a bind parameter: `SELECT $1 AS tier` inside a UNION ALL fails with
 * "could not determine data type of parameter", and `coalesce(t.tier,0) <> $1`
 * would quietly change a rendered-SQL guard into a parameterised one. The input
 * is always a module constant above, so there is nothing to escape.
 */
export function tierLiteral(n: number): SQL {
  return sql.raw(String(n));
}

// Returns a SUBQUERY that yields one row `(contact_id, tier)` for every contact
// with AT LEAST ONE qualifying signal in this campaign, where `tier` is the
// HIGHEST tier reached — high-water / monotonic, computed as MAX over a UNION of
// the per-signal sources (so a contact who clicked AND reached AND bought reads
// as 4, never 1). Campaign-scoped: only signals tied to THIS campaign count, not
// the contact's org-wide activity.
//
// ABSENCE = tier 0. A contact with no signal is simply not in the result set;
// callers LEFT JOIN this and `COALESCE(t.tier, 0)` so an absent contact reads as
// ignored. Wrap it as a derived table at the call site:
//
//   LEFT JOIN (${campaignTierExpr(campaignId, orgId)}) t ON t.contact_id = p.contact_id
//   ... COALESCE(t.tier, 0) = <behavioral_tier>
//
// Read LIVE off current data on every call (the on-the-fly / Option A approach).
// The whole computation is encapsulated in this one fragment specifically so a
// future swap to a materialized `campaign_contact_state(campaign_id, contact_id,
// tier)` table is a one-line change at the single call site — the (contact_id,
// tier) shape callers depend on stays identical.
//
// TRACKED-mode signals only for now: clicks via links⋈clicks, offer reach via
// stage_sends.offer_reached_at, and the registration + purchase via the
// conversion_events ledger. A manual-mode source (e.g. CSV-derived
// clicked/reached/converted) slots in later as ANOTHER `SELECT contact_id,
// <tier>` UNION branch below WITHOUT reshaping the output or touching any caller.
export function campaignTierExpr(campaignId: number, orgId: string): SQL {
  const dirty = sql.join(
    DIRTY_CLICK_CLASSIFICATIONS.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`
    SELECT contact_id, MAX(tier)::int AS tier
    FROM (
      -- tier 1: a CLEAN click on a link belonging to this campaign
      SELECT l.contact_id AS contact_id, ${tierLiteral(TIER_CLICKED)} AS tier
      FROM links l
      JOIN clicks ck ON ck.link_id = l.id
      WHERE l.campaign_id = ${campaignId}::int
        AND l.org_id = ${orgId}::uuid
        AND ck.classification NOT IN (${dirty})

      UNION ALL
      -- tier 2: reached the offer page (per-recipient offer-reach stamp)
      SELECT ss.contact_id AS contact_id, ${tierLiteral(TIER_REACHED_OFFER)} AS tier
      FROM stage_sends ss
      WHERE ss.campaign_id = ${campaignId}::int
        AND ss.org_id = ${orgId}::uuid
        AND ss.offer_reached_at IS NOT NULL

      UNION ALL
      -- tier 3: REGISTERED — a counted registration (a retarget-signal event
      -- type, status pending|approved) AND no purchase-type event of ANY status
      -- on this campaign. Shared definition: lib/sale-attribution.ts.
      --
      -- The NOT EXISTS is the user's binding rule that a REJECTED purchase does
      -- not return a contact to this lane. It is not redundant with MAX: a
      -- rejected purchase yields no tier row, so without it a registrant who
      -- tried to buy and was rejected would read 3.
      --
      -- Index conversion_events_campaign_event_idx
      -- (campaign_id, event_type_id, contact_id) serves both the outer scan and
      -- the probe, from the campaign's handful of conversions.
      SELECT ce.contact_id AS contact_id, ${tierLiteral(TIER_REGISTERED)} AS tier
      FROM conversion_events ce
      WHERE ce.campaign_id = ${campaignId}::int
        AND ce.org_id = ${orgId}::uuid
        AND ce.contact_id IS NOT NULL
        AND ${registeredClause()}
        AND NOT EXISTS (
          SELECT 1
          FROM conversion_events pe
          WHERE pe.campaign_id = ce.campaign_id
            AND pe.org_id = ce.org_id
            AND pe.contact_id = ce.contact_id
            AND pe.event_type_id IN ${PURCHASE_EVENT_TYPE_IDS}
            -- An UNMAPPED status counts as NOTHING everywhere else in this
            -- codebase (conversion_events_unmapped_idx: "stored, alerted, never
            -- counted"), so it must not evict a registrant from this lane
            -- either. Only a row we actually understand -- pending, approved or
            -- rejected -- ends someone's Registered status.
            AND pe.status IS NOT NULL
        )

      UNION ALL
      -- tier 4: PURCHASED — a counted PURCHASE event in the conversion_events
      -- ledger attributed to this campaign. EXITS the sequence. Shared
      -- definition: lib/sale-attribution.ts (purchase event types, status
      -- pending|approved; rejected is a refund and never a purchase).
      --
      -- READS THE LEDGER, NOT stage_sends.sale_status. One row per conversion, so
      -- a $0 registration arriving after a purchase can no longer overwrite it —
      -- and a registration is not a purchase at all, so it cannot put a contact
      -- in this tier. contact_id IS NOT NULL drops the stage-only rows (a
      -- conversion whose recipient could not be resolved has no contact to place
      -- in a tier).
      SELECT ce.contact_id AS contact_id, ${tierLiteral(TIER_PURCHASED)} AS tier
      FROM conversion_events ce
      WHERE ce.campaign_id = ${campaignId}::int
        AND ce.org_id = ${orgId}::uuid
        AND ce.contact_id IS NOT NULL
        AND ${purchasedClause()}
    ) signals
    GROUP BY contact_id
  `;
}
