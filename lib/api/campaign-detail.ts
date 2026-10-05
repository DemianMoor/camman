import { sql as drizzleSql } from "drizzle-orm";

import { brands, campaigns, offers, routing_types, traffic_types } from "@/db/schema";

// What GET /api/campaigns/[campaignId] returns. Moved verbatim out of the
// route so the EDIT SCREEN can type-check against it: a Next.js route file
// may only export its handlers.
//
// ⚠️ THE EDIT SCREEN READS ONLY WHAT IS LISTED HERE. Twice a field the editor
// reads was missing from this list and nothing failed: lifecycle_rules (every
// campaign rendered as legacy) and offer_cooldown_days / offer_limit_times
// (2026-10-01, card 869fad9c9: the edit-screen preview ran with 7 / 5
// whatever was stored). components/campaigns/campaign-editor-page.tsx now
// asserts at compile time that every key of its CampaignDetail is a key of
// this object, so the third time is a build failure.
export const CAMPAIGN_DETAIL_SELECT = {
  id: campaigns.id,
  org_id: campaigns.org_id,
  // ⚠️ LOAD-BEARING, NOT DECORATIVE. The campaign detail page gates its whole
  // "Drip settings" section on `campaign.type === "drip"`. While this column was
  // missing from the select the comparison was `undefined === "drip"` — always
  // false — so the drip config panel (interest tag, partner, start/end, the
  // three caps, priority, sending numbers, behavioural follow-ups, the journey
  // funnel) rendered for NOBODY, on every drip campaign. Nothing failed; the
  // section simply was not there. Found by opening the page, not by reading it.
  type: campaigns.type,
  slug: campaigns.slug,
  human_id: campaigns.human_id,
  name: campaigns.name,
  notes: campaigns.notes,
  brand_id: campaigns.brand_id,
  offer_id: campaigns.offer_id,
  routing_type_id: campaigns.routing_type_id,
  traffic_type_id: campaigns.traffic_type_id,
  assigned_to_user_id: campaigns.assigned_to_user_id,
  created_by_user_id: campaigns.created_by_user_id,
  audience_segment_ids: campaigns.audience_segment_ids,
  audience_exclude_segment_ids: campaigns.audience_exclude_segment_ids,
  audience_contact_group_ids: campaigns.audience_contact_group_ids,
  audience_filters: campaigns.audience_filters,
  audience_snapshot_count: campaigns.audience_snapshot_count,
  audience_cap: campaigns.audience_cap,
  exclude_in_use_contacts: campaigns.exclude_in_use_contacts,
  exclude_prior_offer_contacts: campaigns.exclude_prior_offer_contacts,
  // The two parameters of the offer rules (869f53efz). Missing until
  // 2026-10-01 (card 869fad9c9): the edit screen fell back to 7 / 5.
  offer_cooldown_days: campaigns.offer_cooldown_days,
  offer_limit_times: campaigns.offer_limit_times,
  start_date: campaigns.start_date,
  end_date: campaigns.end_date,
  status: campaigns.status,
  previous_status: campaigns.previous_status,
  status_changed_at: campaigns.status_changed_at,
  // ⚠️ REQUIRED BY THE EDIT SCREEN, and its absence is why every saved
  // draft and every activated campaign showed its lifecycle chips greyed
  // out. The editor resolves `lifecycleRules` from this field; with the
  // field missing it read `undefined === true` → false, decided the
  // campaign was LEGACY, and then ignored the stored
  // audience_filters.lifecycle_statuses in favour of the approximate
  // mapping from the four legacy booleans. The selection was stored and
  // loaded correctly the whole time — it was this flag that never arrived.
  lifecycle_rules: campaigns.lifecycle_rules,
  tracking_id: campaigns.tracking_id,
  link_mode: campaigns.link_mode,
  default_provider_phone_id: campaigns.default_provider_phone_id,
  archived_at: campaigns.archived_at,
  created_at: campaigns.created_at,
  brand: {
    id: brands.id,
    name: brands.name,
    color: brands.color,
    // 1b: the stage form's read-only landing-URL preview builds from this
    // with the SAME function the send path mints with.
    landing_host: brands.landing_host,
    // The brand's EFFECTIVE short domain — the tracked-mode SMS preview's
    // BRAND-LEVEL candidate. Single-row via subquery.
    //
    // ⚠️ `is_default DESC` first. This ordering must match the brand branch
    // of resolveShortDomainForSend exactly: it used to order by created_at
    // alone, so once a brand held two active domains with a non-oldest
    // default, the preview counted its segments against a DIFFERENT host
    // than the one the send path mints under — and the link sits inside the
    // counted body, so that silently shifts the segment boundary. NULL when
    // the brand has no active domain.
    short_domain: drizzleSql<string | null>`(
      SELECT sd.domain FROM short_domains sd
      WHERE sd.brand_id = ${brands.id} AND sd.status = 'active'
      ORDER BY sd.is_default DESC, sd.created_at ASC, sd.id ASC LIMIT 1
    )`,
  },
  offer: {
    id: offers.id,
    name: offers.name,
    color: offers.color,
    sales_pages: offers.sales_pages,
    base_url: offers.base_url,
    postfix: offers.postfix,
  },
  routing_type: {
    id: routing_types.id,
    name: routing_types.name,
    color: routing_types.color,
  },
  traffic_type: {
    id: traffic_types.id,
    name: traffic_types.name,
    color: traffic_types.color,
  },
};
