import { sql, type SQL } from "drizzle-orm";

// Line-type gate (migrations 0218, 0222): contact_groups.allow_voip / allow_unknown /
// allow_toll_free.
//
// ⭐ STRICTEST GROUP WINS, EVERYWHERE. A contact in ANY active group that
// disallows its line type is blocked from every campaign — not only campaigns
// that select that group. Drip routes by tag, not group, so a "only when
// selected via this group" rule could never reach drip.
//
// ⭐ SELECTION-TIME ONLY (owner ruling, 2026-10-20: "only block new sends").
// Applied by gateEligible() in lib/segment-rules-eval.ts (segment pages and
// every buildSegmentAudienceClause caller) and, for the campaign audience, ONCE
// at the top of the combined segment/group source via excludeLineTypeBlocked
// below (lib/audience-snapshot.ts) — so snapshot, preview, draft counts, lanes
// and the segment page all agree; and as the drip routing global rule
// `line_type` (lib/drip/routing-eval.ts). NOT in lib/sends/eligibility.ts: queued sends,
// frozen pools and in-flight drip follow-ups still go out.
//
// Reads contacts.line_type, the copy of phone_lookups. That copy must be
// current — drip intake writes it at contact creation (lib/drip/enrichment.ts)
// and scripts/backfill-contact-line-type.ts repaired the history.

/**
 * contact_ids blocked by the gate, as a `SELECT contact_id` set.
 *
 * ⚠️ DRIVEN FROM CONTACTS, NOT FROM GROUP MEMBERSHIP. The obvious shape —
 * walk the flagged groups' memberships, join contacts, keep voip/unknown —
 * probes contacts once per MEMBER: measured on prod 2026-10-20 with pml-aca +
 * pml-medicare flagged, 414,666 probes, 1.9 s warm / 5.2 s cold, paid inside
 * every segment evaluation. This shape reads only the org's voip/unknown
 * contacts (contacts_org_linetype_eligible_idx) and checks membership by
 * contact_contact_groups' PK (contact_id first).
 *
 * The first EXISTS is uncorrelated, so Postgres runs it ONCE as a one-time
 * filter: while no active group in the org has a box unchecked the whole set
 * is skipped (measured 0.05 ms). messaging_status = 'eligible' is a LITERAL so
 * the partial index matches; landlines are never in an audience anyway.
 */
export function lineTypeBlockedContactsSql(orgId: string): SQL {
  // (#451 briefly gave this a withLifecycleStatus flag for the preview's inner
  // EXCEPTs. Those EXCEPTs are gone — the campaign source applies the gate once
  // via excludeLineTypeBlocked, whose NOT EXISTS passes extra columns through —
  // so the set is contact_id only again.)
  return sql`
    SELECT lt_c.id AS contact_id
    FROM contacts lt_c
    WHERE lt_c.org_id = ${orgId}::uuid
      AND lt_c.messaging_status = 'eligible'
      AND lt_c.line_type IN ('voip', 'unknown', 'toll_free')
      AND EXISTS (
        SELECT 1 FROM contact_groups lt_any
        WHERE lt_any.org_id = ${orgId}::uuid AND lt_any.status = 'active'
          AND (lt_any.allow_voip = false OR lt_any.allow_unknown = false OR lt_any.allow_toll_free = false))
      AND EXISTS (
        SELECT 1
        FROM contact_contact_groups lt_ccg
        INNER JOIN contact_groups lt_g ON lt_g.id = lt_ccg.contact_group_id
        WHERE lt_ccg.contact_id = lt_c.id
          AND lt_g.org_id = ${orgId}::uuid
          AND lt_g.status = 'active'
          AND ((lt_g.allow_voip = false AND lt_c.line_type = 'voip')
            OR (lt_g.allow_unknown = false AND lt_c.line_type = 'unknown')
            OR (lt_g.allow_toll_free = false AND lt_c.line_type = 'toll_free')))
  `;
}

/**
 * Drop line-type-blocked contacts from a relation that exposes `contact_id`
 * (any other columns pass through). The CAMPAIGN-AUDIENCE form of the gate:
 * applied ONCE at the top of the combined segment/group source — the same
 * level as excludeCarrierRejected — by buildAudienceSourceSql,
 * computeStageAudienceCountForDraft and buildPreviewMembership
 * (lib/audience-snapshot.ts), whose inner clauses
 * (buildSegmentAudienceClauseForCampaignSource, buildGroupMembershipClause)
 * therefore omit it. Per-contact predicate ⇒ identical counts to subtracting it
 * from every branch, at one pass instead of up to three.
 *
 * NOT EXISTS rather than EXCEPT so it works on the preview's tagged, multi-
 * column UNION ALL relation, and the snapshot and preview share one shape.
 */
export function excludeLineTypeBlocked(relation: SQL, orgId: string): SQL {
  return sql`
    SELECT lt_rel.* FROM (${relation}) lt_rel
    WHERE NOT EXISTS (
      SELECT 1 FROM (${lineTypeBlockedContactsSql(orgId)}) lt_blk
      WHERE lt_blk.contact_id = lt_rel.contact_id
    )
  `;
}
