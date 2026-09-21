import { sql, type SQL } from "drizzle-orm";

import { purchasedClause } from "@/lib/sale-attribution";

// A contact's CURRENT high-water behavioral tier WITHIN one campaign:
//   0 = ignored        — no qualifying signal (see "absence" note below)
//   1 = clicked        — a CLEAN click on a link belonging to this campaign
//   2 = reached_offer  — a stage_sends row with offer_reached_at set
//   3 = converted      — a counted PURCHASE event in the conversion_events
//                        ledger for this campaign (lib/sale-attribution.ts).
//                        A registration is NOT a purchase and never reaches 3.
//
// "Clean click" = NOT bot/prefetch/suspect, byte-for-byte the same definition
// the click report uses for its clean count (lib/links/click-report.ts:
// raw − bot − prefetch − suspect, i.e. human + unknown still count). Keep these
// two in sync — a divergence would let a click count toward a lane that the
// report calls dirty, or vice-versa.
const DIRTY_CLICK_CLASSIFICATIONS = ["bot", "prefetch", "suspect"] as const;

// Returns a SUBQUERY that yields one row `(contact_id, tier)` for every contact
// with AT LEAST ONE qualifying signal in this campaign, where `tier` is the
// HIGHEST tier reached — high-water / monotonic, computed as MAX over a UNION of
// the per-signal sources (so a contact who clicked AND reached AND bought reads
// as 3, never 1). Campaign-scoped: only signals tied to THIS campaign count, not
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
// stage_sends.offer_reached_at, and the purchase via the conversion_events
// ledger (NOT stage_sends.sale_status — see the tier-3 branch below). A
// manual-mode source (e.g. CSV-derived clicked/reached/converted) slots in later
// as ANOTHER `SELECT contact_id, <tier>` UNION branch below WITHOUT reshaping
// the output or touching any caller.
export function campaignTierExpr(campaignId: number, orgId: string): SQL {
  const dirty = sql.join(
    DIRTY_CLICK_CLASSIFICATIONS.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`
    SELECT contact_id, MAX(tier)::int AS tier
    FROM (
      -- tier 1: a CLEAN click on a link belonging to this campaign
      SELECT l.contact_id AS contact_id, 1 AS tier
      FROM links l
      JOIN clicks ck ON ck.link_id = l.id
      WHERE l.campaign_id = ${campaignId}::int
        AND l.org_id = ${orgId}::uuid
        AND ck.classification NOT IN (${dirty})

      UNION ALL
      -- tier 2: reached the offer page (per-recipient offer-reach stamp)
      SELECT ss.contact_id AS contact_id, 2 AS tier
      FROM stage_sends ss
      WHERE ss.campaign_id = ${campaignId}::int
        AND ss.org_id = ${orgId}::uuid
        AND ss.offer_reached_at IS NOT NULL

      UNION ALL
      -- tier 3: converted — a counted PURCHASE event in the conversion_events
      -- ledger attributed to this campaign. Shared definition:
      -- lib/sale-attribution.ts (purchase event types, status pending|approved;
      -- rejected is a refund and never a purchase).
      --
      -- READS THE LEDGER, NOT stage_sends.sale_status. One row per conversion, so
      -- a $0 registration arriving after a purchase can no longer overwrite it —
      -- and a registration is not a purchase at all, so it cannot put a contact
      -- in this tier. Index conversion_events_campaign_event_idx
      -- (campaign_id, event_type_id, contact_id) answers this from the campaign's
      -- handful of conversions; an EXISTS over stage_sends would probe once per
      -- recipient. contact_id IS NOT NULL drops the stage-only rows (a conversion
      -- whose recipient could not be resolved has no contact to place in a tier).
      SELECT ce.contact_id AS contact_id, 3 AS tier
      FROM conversion_events ce
      WHERE ce.campaign_id = ${campaignId}::int
        AND ce.org_id = ${orgId}::uuid
        AND ce.contact_id IS NOT NULL
        AND ${purchasedClause()}
    ) signals
    GROUP BY contact_id
  `;
}
