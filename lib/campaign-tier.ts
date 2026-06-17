import { sql, type SQL } from "drizzle-orm";

// A contact's CURRENT high-water behavioral tier WITHIN one campaign:
//   0 = ignored        — no qualifying signal (see "absence" note below)
//   1 = clicked        — a CLEAN click on a link belonging to this campaign
//   2 = reached_offer  — a stage_sends row with offer_reached_at set
//   3 = converted      — a stage_sends row with sale_status = 'sale'
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
// TRACKED-mode signals only for now (clicks via links⋈clicks, offer/sale via
// stage_sends). A manual-mode source (e.g. CSV-derived clicked/reached/converted)
// slots in later as ANOTHER `SELECT contact_id, <tier>` UNION branch below
// WITHOUT reshaping the output or touching any caller.
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
      -- tier 3: converted (a sale attributed to this recipient)
      SELECT ss.contact_id AS contact_id, 3 AS tier
      FROM stage_sends ss
      WHERE ss.campaign_id = ${campaignId}::int
        AND ss.org_id = ${orgId}::uuid
        AND ss.sale_status = 'sale'
    ) signals
    GROUP BY contact_id
  `;
}
