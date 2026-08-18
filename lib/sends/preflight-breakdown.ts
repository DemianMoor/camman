import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { SEND_DEDUP_WINDOW_MS } from "@/lib/sends/dedup-window";
import { preflightStageSend, type PreflightBlocker } from "@/lib/sends/preflight";
import { computeStageReconciliation } from "@/lib/sends/reconcile";
import { stageRecipientsSql, type StageRecipientFilters } from "@/lib/sends/recipients";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── P5/P6: preflight breakdown ─────────────────────────────────────────────
//
// A stage's resolved send picture, computed ~15 min BEFORE it materializes, for
// the Telegram preflight digest (P5) and the /sends/autopilot view (P6). It layers
// three sources so we don't re-implement anything:
//   • preflightStageSend  → the live materialized_audience (the recipient set the
//     kickoff WILL create, post opt-out/filter/split/content-dedup/lane), the
//     structural blockers, and the drain-time estimate.
//   • computeStageReconciliation → the per-cause exclusion buckets off the frozen
//     pool (opt-out, stage-filter, split, content/offer dedup). It does NOT apply
//     the behavioral-lane overlay, so its `qualified` is the pre-lane audience.
//   • Two NET-NEW numbers:
//       - lane = qualified − materialized_audience (only for lane children; the
//         contacts dropped by tier/aliveness). Non-lane stages → 0.
//       - dedup_1h_predicted = of the materialized set, how many phones already
//         have a `status='sent'` row org-wide within the send-dedup window, i.e.
//         would be marked `skipped_duplicate` at dispatch. This is the smoke-test
//         nuance: it makes a stage whose audience is ~100% dedup-skipped visible
//         BEFORE it fires. Inherently an ESTIMATE (the window slides and the drain
//         also dedups intra-batch), so predicted_sends is "≈".

export interface PreflightBreakdown {
  computed_at: string; // ISO
  mode: "manual" | "tracked";
  pool_total: number; // frozen campaign_audience_pool size
  materialized_audience: number; // stage_sends rows the kickoff will create
  predicted_sends: number; // materialized_audience − dedup_1h_predicted (≈ actual deliveries)
  excluded: {
    opt_out: number;
    stage_filter: number; // include_no_status / include_clickers / exclude_clickers
    split: number;
    content_dedup: number; // saw-this-creative / prior-offer
    lane: number; // behavioral tier/aliveness (lane children only)
    dedup_1h_predicted: number; // would be skipped_duplicate at dispatch (estimate)
    // Q4: contacts dropped by THIS NUMBER's carrier allow-list, per carrier.
    // Empty object = no carrier policy applied (the default everywhere today).
    // Reported per carrier rather than as one total because "excluded 4,102"
    // tells an operator nothing actionable — "excluded 4,102 T-Mobile" does.
    carrier: Record<string, number>;
  };
  estimated_drain_seconds: number | null;
  sender_sends_per_second: number | null;
  blockers: PreflightBlocker[];
  // Any true ⇒ this stage warrants a standalone red alert (not just the digest).
  red: {
    no_audience: boolean; // materialized_audience === 0
    all_dedup_predicted: boolean; // materialized > 0 but every send would dedup
    has_blocker: boolean; // a structural blocker (no creative / sender / creds / …)
  };
}

interface CfgRow {
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
  behavioral_tier: number | null;
  parent_stage_id: number | null;
  creative_id: number | null;
  offer_id: number | null;
  exclude_prior_offer_contacts: boolean;
  provider_phone_id: number | null;
  allow_unknown_carrier: boolean | null;
}

export async function computePreflightBreakdown(
  dbc: DbOrTx,
  { orgId, campaignId, stageId }: { orgId: string; campaignId: number; stageId: number },
): Promise<PreflightBreakdown> {
  // 1. Live audience + blockers + drain estimate (the authoritative send picture).
  const pf = await preflightStageSend(dbc, { orgId, campaignId, stageId });
  const materialized = pf.recipient_count;

  // 2. Stage config for the reconciliation filters + the dedup predictor's set.
  const cfgRows = (await dbc.execute(sql`
    SELECT s.include_no_status, s.include_clickers, s.exclude_clickers,
           s.split_index, s.split_total, s.behavioral_tier, s.parent_stage_id,
           s.creative_id, c.offer_id, c.exclude_prior_offer_contacts,
           s.provider_phone_id, pp.allow_unknown_carrier
    FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id
    WHERE s.id = ${stageId} AND c.id = ${campaignId} AND c.org_id = ${orgId}::uuid
    LIMIT 1
  `)) as unknown as CfgRow[];
  const cfg = cfgRows[0];

  const empty: PreflightBreakdown = {
    computed_at: new Date().toISOString(),
    mode: pf.mode,
    pool_total: 0,
    materialized_audience: materialized,
    predicted_sends: materialized,
    excluded: { opt_out: 0, stage_filter: 0, split: 0, content_dedup: 0, lane: 0, dedup_1h_predicted: 0, carrier: {} },
    estimated_drain_seconds: pf.estimated_drain_seconds,
    sender_sends_per_second: pf.sender_sends_per_second,
    blockers: pf.blockers,
    red: { no_audience: materialized === 0, all_dedup_predicted: false, has_blocker: pf.blockers.length > 0 },
  };
  if (!cfg) return empty;

  // Q4: the same carrier policy kickoff enforces. Every recipient query in this
  // breakdown must use it, or the numbers describe an audience the send will
  // not produce.
  const carrierPolicy = {
    providerPhoneId: cfg.provider_phone_id,
    allowUnknownCarrier: cfg.allow_unknown_carrier !== false,
  };

  const filters: StageRecipientFilters = {
    includeNoStatus: cfg.include_no_status,
    includeClickers: cfg.include_clickers,
    excludeClickers: cfg.exclude_clickers,
    splitIndex: cfg.split_index ?? null,
    splitTotal: cfg.split_total ?? null,
  };
  const eligibility = {
    creativeId: cfg.creative_id ?? null,
    offerId: cfg.offer_id ?? null,
    excludePriorOffer: cfg.exclude_prior_offer_contacts,
  };

  // 3. Per-cause exclusion buckets off the frozen pool (opt-out/filter/split/dedup).
  //    reconcile does NOT apply the lane overlay, so its `qualified` is pre-lane.
  const recon = await computeStageReconciliation(dbc, { campaignId, orgId, stageId, filters });

  // 4. Lane exclusion = contacts that passed everything but failed the tier/aliveness
  //    overlay. Only meaningful for lane children; for non-lane stages, qualified
  //    and materialized should match, so we don't attribute any drift to "lane".
  const laneExcluded =
    cfg.behavioral_tier != null ? Math.max(0, recon.qualified - materialized) : 0;

  // 5. Predicted 1-hour phone dedup: of the materialized recipient set, how many
  //    phones already have a 'sent' row org-wide within the dedup window. Uses the
  //    SAME window constant the drain enforces, so the estimate tracks reality.
  const dedupRows = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM (
      ${stageRecipientsSql({
        campaignId,
        orgId,
        filters: {
          ...filters,
          behavioralTier: cfg.behavioral_tier ?? null,
          parentStageId: cfg.parent_stage_id ?? null,
        },
        eligibility,
        carrierPolicy,
      })}
    ) r
    WHERE EXISTS (
      SELECT 1 FROM stage_sends ss
      WHERE ss.org_id = ${orgId}::uuid
        AND ss.status = 'sent'
        AND ss.sent_at >= now() - interval '1 millisecond' * ${SEND_DEDUP_WINDOW_MS}
        AND ss.phone = r.phone_number
    )
  `)) as unknown as { n: number }[];
  const dedup1h = Number(dedupRows[0]?.n ?? 0);
  const predicted = Math.max(0, materialized - dedup1h);

  // 6. Q4 per-carrier exclusions: contacts that pass every other gate but are
  //    dropped by THIS NUMBER's carrier policy. Computed as the difference
  //    between the recipient query WITHOUT the policy and WITH it, grouped by
  //    carrier — so the figure is exactly "who this number may not text",
  //    attributable per carrier rather than as one opaque total.
  //
  //    Skipped entirely when the stage has no sending number, and cheap when
  //    the policy is empty (the WITHOUT/WITH queries are then identical and the
  //    anti-join finds nothing).
  const carrierExcluded: Record<string, number> = {};
  if (carrierPolicy.providerPhoneId != null) {
    const rows = (await dbc.execute(sql`
      SELECT carrier_norm, count(*)::int AS n FROM (
        ${stageRecipientsSql({
          campaignId,
          orgId,
          filters: {
            ...filters,
            behavioralTier: cfg.behavioral_tier ?? null,
            parentStageId: cfg.parent_stage_id ?? null,
          },
          eligibility,
        })}
      ) unrestricted
      WHERE NOT EXISTS (
        SELECT 1 FROM (
          ${stageRecipientsSql({
            campaignId,
            orgId,
            filters: {
              ...filters,
              behavioralTier: cfg.behavioral_tier ?? null,
              parentStageId: cfg.parent_stage_id ?? null,
            },
            eligibility,
            carrierPolicy,
          })}
        ) restricted
        WHERE restricted.contact_id = unrestricted.contact_id
      )
      GROUP BY carrier_norm
      ORDER BY count(*) DESC
    `)) as unknown as { carrier_norm: string | null; n: number }[];
    for (const r of rows) {
      // A NULL carrier is reported under its own label rather than dropped —
      // an unlabelled exclusion is the kind an operator never notices.
      carrierExcluded[r.carrier_norm ?? "(no carrier)"] = Number(r.n);
    }
  }

  return {
    computed_at: new Date().toISOString(),
    mode: pf.mode,
    pool_total: recon.pool_total,
    materialized_audience: materialized,
    predicted_sends: predicted,
    excluded: {
      opt_out: recon.excluded_optout,
      stage_filter: recon.excluded_filter,
      split: recon.excluded_split,
      content_dedup: recon.excluded_dedup,
      lane: laneExcluded,
      dedup_1h_predicted: dedup1h,
      carrier: carrierExcluded,
    },
    estimated_drain_seconds: pf.estimated_drain_seconds,
    sender_sends_per_second: pf.sender_sends_per_second,
    blockers: pf.blockers,
    red: {
      no_audience: materialized === 0,
      all_dedup_predicted: materialized > 0 && predicted === 0,
      has_blocker: pf.blockers.length > 0,
    },
  };
}
