import { sql, type SQL } from "drizzle-orm";

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
//   LAYER 3 (only when excludePriorOffer): already received THIS offer in any
//           previous campaign.
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
}

// The three layers as individually-labeled `SELECT contact_id` fragments (null
// when not applicable). Returned labeled so the preview can attribute per-layer
// counts; the send/export path just EXCEPTs all the non-null ones.
export interface StageEligibilityExclusions {
  // LAYER 1 — saw this creative in another campaign.
  creative: SQL | null;
  // LAYER 2 — in-flight send of this creative in another campaign.
  inFlight: SQL | null;
  // LAYER 3 — got this offer in a previous campaign (only when toggle on).
  offer: SQL | null;
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
      `
      : null;

  return { creative, inFlight, offer };
}

// Compose `base` (a `SELECT contact_id …` audience) with the exclusions via
// EXCEPT set-arithmetic — the form lib/segment-rules-eval.ts uses, so each branch
// keeps its own index plan (NOT `c.id IN (sub1) OR …`, which seqscans). `base`
// is returned unchanged when there are no applicable exclusions.
export function applyEligibilityExcept(
  base: SQL,
  ex: StageEligibilityExclusions,
): SQL {
  const layers = [ex.creative, ex.inFlight, ex.offer].filter(
    (l): l is SQL => l !== null,
  );
  if (layers.length === 0) return base;
  return layers.reduce((acc, layer) => sql`${acc}\nEXCEPT\n${layer}`, base);
}

// The DISTINCT union of all applicable exclusion layers as a single
// `SELECT contact_id …`, or null when no layer applies. For membership tests
// (e.g. reconciliation's "would this pool member have been deduped?") where the
// per-layer split doesn't matter — only "is this contact excluded".
export function eligibilityUnion(ex: StageEligibilityExclusions): SQL | null {
  const layers = [ex.creative, ex.inFlight, ex.offer].filter(
    (l): l is SQL => l !== null,
  );
  if (layers.length === 0) return null;
  const unioned = layers.reduce((acc, layer) => sql`${acc}\nUNION\n${layer}`);
  return sql`SELECT DISTINCT contact_id FROM (${unioned}) elig_union`;
}
