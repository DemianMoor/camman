import { sql, type SQL } from "drizzle-orm";

import { purchasedOfferContacts } from "@/lib/sale-attribution";

// ── Content-dedup eligibility (Phase 2, migration 0086/0087) ──────────────────
// The SINGLE shared definition of "which contacts must be suppressed for this
// stage" — consumed by the send/export recipient query (stageRecipientsSql), the
// reconciliation accounting (computeStageReconciliation), and the build-time
// preview. Send and export MUST NOT compute eligibility differently; everything
// derives from the three exclusion fragments produced here.
//
// Three layers (see docs/04-features/content-dedup.md):
//   LAYER 1 (always on, when a creative is attached): saw THIS creative in a
//           DIFFERENT campaign. The `campaign_id IS NULL OR campaign_id <> current`
//           clause is the in-campaign-reuse exception — a campaign may reuse its
//           own creative across stages; a deleted-campaign row (campaign_id NULL)
//           suppresses unconditionally.
//   LAYER 2 (always on, when a creative is attached): in-flight send of THIS
//           creative in ANOTHER campaign — covers the window between
//           materialization and status='sent' (the ledger only fills at 'sent').
//   LAYER 3 (only when excludePriorOffer): already received THIS offer in a
//           DIFFERENT campaign. Same `campaign_id IS NULL OR campaign_id <> current`
//           carve-out as LAYER 1 — a multi-stage campaign may re-send its own offer
//           across stages (a drip), so a stage must not suppress contacts that an
//           EARLIER stage of the SAME campaign already reached. Without this a
//           single-offer drip self-cannibalizes: stage 1 reaches everyone, then
//           stage 2+ see the whole audience as "already got this offer" → ~nobody.
//
// Opt-out suppression is NOT here — it already lives in the audience the caller
// passes in (frozen-pool opt_outs check for send/export; buildSegmentAudience-
// Clause for the preview). All fragments are pure `SELECT contact_id` set-ops
// (no per-row work, no TEMP tables, no session SET — pooler-safe per the brief).

export interface StageEligibilityParams {
  orgId: string;
  currentCampaignId: number;
  // The stage's creative. NULL ⇒ no creative to dedup on (Edge A): layers 1+2
  // are omitted entirely (never pass a null into `creative_id = …`).
  currentCreativeId: number | null;
  // The campaign's offer. Only used when excludePriorOffer is true.
  currentOfferId: number | null;
  // campaigns.exclude_prior_offer_contacts — gates LAYER 3.
  excludePriorOffer: boolean;
  // campaigns.lifecycle_rules (migration 0187). Gates the three lifecycle
  // layers below.
  //
  // ⚠️ REQUIRED, not optional-defaulting-to-false, and deliberately so. Five
  // call sites reach this builder and none of them knew the flag before PR 4b;
  // an optional field would let any one of them keep compiling while silently
  // skipping every lifecycle exclusion, forever. The symptom — "some sends
  // exclude suppressed contacts and some don't" — is close to unfindable from
  // the outside. Required turns that into a compile error that enumerates the
  // callers for you.
  lifecycleRules: boolean;
}

// Every exclusion layer, in the order they are applied and reported. Adding a
// layer means adding a key here and a builder below — every consumer iterates
// this list rather than naming fields, so nothing else has to change.
//
// ⚠️ THE ORDER IS THE CONTRACT. Before this was a list, the ordering lived
// implicitly in two copies of the literal [ex.creative, ex.inFlight, ex.offer]
// inside applyEligibilityExcept and eligibilityUnion. It is written down once
// now. Exclusion REPORTING counts each lead against the first layer that
// catches it, so changing this order changes which bucket a lead lands in.
//
// The lifecycle layers (suppressed, bought_offer, freeze_not_due) are declared
// here but not built until PR 4b; they sort ahead of the content-dedup layers
// per spec §8.3.
export const EXCLUSION_PRIORITY = [
  "suppressed",
  "bought_offer",
  "freeze_not_due",
  "creative",
  "in_flight",
  "offer",
] as const;

export type EligibilityLayerKey = (typeof EXCLUSION_PRIORITY)[number];

// One layer: a labelled `SELECT contact_id` fragment. A layer that does not
// apply is simply absent from the list — there is no null member.
export interface EligibilityLayer {
  key: EligibilityLayerKey;
  sql: SQL;
}

// The applicable layers, already in EXCLUSION_PRIORITY order.
export type StageEligibilityExclusions = EligibilityLayer[];

/** Sort an arbitrary set of layers into the canonical order. */
export function orderLayers(
  layers: EligibilityLayer[],
): StageEligibilityExclusions {
  const rank = new Map<EligibilityLayerKey, number>(
    EXCLUSION_PRIORITY.map((k, i) => [k, i]),
  );
  return [...layers].sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
}

/**
 * The three LIFECYCLE exclusion layers (PR 4b, spec §8.1), as the send path and
 * the audience preview both need them.
 *
 * ⚠️ Separate from buildStageEligibilityExclusions ON PURPOSE: none of these
 * three depends on the current campaign or creative, and the preview
 * (lib/audience-snapshot.ts) has no campaign id to pass. Extracting them means
 * the preview's "excluded because suppressed / bought this offer" buckets are
 * built from the SAME SQL the send later EXCEPTs, instead of a second copy that
 * agrees today and drifts later. scripts/test-lifecycle-eligibility-layers.ts
 * asserts the two stay identical.
 *
 * None of them filters messaging_status: gateEligible() gates the whole
 * audience, the same decision PR 3 made for the segment rules.
 */
export function lifecycleExclusionLayers(p: {
  orgId: string;
  offerId: number | null;
}): EligibilityLayer[] {
  const layers: EligibilityLayer[] = [
    // Suppressed — the end of the lifecycle. Reads the migration-0188
    // projection on contacts, like the audience chips do.
    {
      key: "suppressed",
      sql: sql`
        SELECT id AS contact_id FROM contacts
        WHERE org_id = ${p.orgId}::uuid AND lifecycle_status = 'suppressed'
      `,
    },
  ];
  // Bought this offer. Shares ONE definition with the made_purchase_for_offer
  // segment rule (spec §8.1) so the two cannot drift about who bought what.
  if (p.offerId != null) {
    layers.push({
      key: "bought_offer",
      sql: purchasedOfferContacts(p.orgId, p.offerId),
    });
  }
  // In freeze AND messaged inside their OWN effective cadence. The cadence is
  // stored per contact by the engagement job, so this needs no threshold lookup
  // and no join to contact_groups.
  layers.push({
    key: "freeze_not_due",
    sql: sql`
      SELECT contact_id FROM contact_engagement
      WHERE org_id = ${p.orgId}::uuid
        AND status = 'freeze'
        AND last_sent_at > now() - make_interval(days => freeze_cadence_days)
    `,
  });
  return orderLayers(layers);
}

export function buildStageEligibilityExclusions(
  p: StageEligibilityParams,
): StageEligibilityExclusions {
  const hasCreative = p.currentCreativeId != null;

  const creative = hasCreative
    ? sql`
        SELECT contact_id FROM creative_exposures
        WHERE org_id = ${p.orgId}::uuid
          AND creative_id = ${p.currentCreativeId}::int
          AND (campaign_id IS NULL OR campaign_id <> ${p.currentCampaignId}::int)
      `
    : null;

  const inFlight = hasCreative
    ? sql`
        SELECT ss.contact_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.org_id = ${p.orgId}::uuid
          AND cs.creative_id = ${p.currentCreativeId}::int
          AND ss.campaign_id <> ${p.currentCampaignId}::int
          AND ss.status IN ('pending', 'sending')
      `
    : null;

  const offer =
    p.excludePriorOffer && p.currentOfferId != null
      ? sql`
        SELECT contact_id FROM offer_exposures
        WHERE org_id = ${p.orgId}::uuid
          AND offer_id = ${p.currentOfferId}::int
          AND (campaign_id IS NULL OR campaign_id <> ${p.currentCampaignId}::int)
      `
      : null;

  const layers: EligibilityLayer[] = [];

  // ── The lifecycle layers (PR 4b, spec §8.1) ────────────────────────────
  // Only for a lifecycle campaign. None of them filters messaging_status:
  // gateEligible() gates the whole audience, the same decision PR 3 made for
  // the segment rules and for the same reason.
  if (p.lifecycleRules) {
    layers.push(
      ...lifecycleExclusionLayers({
        orgId: p.orgId,
        offerId: p.currentOfferId,
      }),
    );
  }

  if (creative) layers.push({ key: "creative", sql: creative });
  if (inFlight) layers.push({ key: "in_flight", sql: inFlight });
  if (offer) layers.push({ key: "offer", sql: offer });
  return orderLayers(layers);
}

// Compose `base` (a `SELECT contact_id …` audience) with the exclusions via
// EXCEPT set-arithmetic — the form lib/segment-rules-eval.ts uses, so each branch
// keeps its own index plan (NOT `c.id IN (sub1) OR …`, which seqscans). `base`
// is returned unchanged when there are no applicable exclusions.
export function applyEligibilityExcept(
  base: SQL,
  ex: StageEligibilityExclusions,
): SQL {
  if (ex.length === 0) return base;
  return ex.reduce((acc, layer) => sql`${acc}\nEXCEPT\n${layer.sql}`, base);
}

// The DISTINCT union of all applicable exclusion layers as a single
// `SELECT contact_id …`, or null when no layer applies. For membership tests
// (e.g. reconciliation's "would this pool member have been deduped?") where the
// per-layer split doesn't matter — only "is this contact excluded".
export function eligibilityUnion(ex: StageEligibilityExclusions): SQL | null {
  if (ex.length === 0) return null;
  const unioned = ex
    .map((l) => l.sql)
    .reduce((acc, layer) => sql`${acc}\nUNION\n${layer}`);
  return sql`SELECT DISTINCT contact_id FROM (${unioned}) elig_union`;
}
