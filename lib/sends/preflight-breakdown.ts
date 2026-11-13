import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { isCarrierRejectionSuppressionOn } from "@/lib/carrier-rejection/eligibility";
import { isTagRulesRefusal } from "@/lib/messages/render";
import type { TagKey } from "@/lib/messages/tags";
import { carrierPolicyClause, type CarrierPolicy } from "@/lib/sends/carrier-policy";
import { resolveSendsPerSecond } from "@/lib/sends/circuit-breakers";
import { SEND_DEDUP_WINDOW_MS } from "@/lib/sends/dedup-window";
import {
  buildStageEligibilityExclusions,
  LIFECYCLE_EXCLUSION_KEYS,
  ZERO_LIFECYCLE_EXCLUSIONS,
  type LifecycleExclusionCounts,
} from "@/lib/sends/eligibility";
import type { PreflightBlocker } from "@/lib/sends/preflight";
import { hasResolvableCredential } from "@/lib/sends/provider-credential";
import { computeStageReconciliation } from "@/lib/sends/reconcile";
import {
  stageRecipientsSql,
  type StageEligibilityOverlay,
  type StageRecipientFilters,
} from "@/lib/sends/recipients";
import {
  countMissingByTag,
  countingTagRules,
  loadStageTagRules,
} from "@/lib/sends/tag-rules";
import { OFFER_COOLDOWN_DAYS_DEFAULT } from "@/lib/validators/campaigns";

export type DbOrTx =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── P5/P6: preflight breakdown ─────────────────────────────────────────────
//
// A stage's resolved send picture, computed ~15 min BEFORE it materializes, for
// the Telegram preflight digest (P5) and the /sends/autopilot view (P6).
//
// ⭐ THE RECIPIENT SET IS BUILT ONCE (2026-11-13). This used to evaluate the
// stage's full eligibility up to four times per stage — preflightStageSend's
// recipient count (+ its unused per-reason lifecycle split), the dedup
// prediction, and the carrier breakdown's WITH- and WITHOUT-policy queries —
// each a 50–90 s statement on production against a disk at its IOPS ceiling.
// Now, inside ONE transaction with its own `SET LOCAL statement_timeout = 60s`:
//
//   • preflight_recipients (TEMP, ON COMMIT DROP, ANALYZEd — §10b: a set-op
//     relation must be materialized before the planner can cost joins on it) =
//     stageRecipientsSql WITHOUT the carrier policy, plus `passes_carrier` = the
//     SAME carrierPolicyClause evaluated per row. The policy is a pure per-row
//     WHERE on qualified and the split bucket hashes contact_id only, so
//       recipients(with policy) = { r ∈ preflight_recipients : passes_carrier }
//     exactly. From it come materialized_audience, dedup_1h_predicted and the
//     per-carrier exclusions — one eligibility evaluation instead of four.
//   • computeStageReconciliation — UNCHANGED, still its own pass over the frozen
//     pool: its buckets attribute the PRE-overlay pool (no lane, no carrier
//     policy) to the first layer that caught each contact, a different relation
//     from the recipient set, so nothing in it can be read off the temp table.
//   • missing_by_tag — still counted over the PRE-eligibility base (it reports
//     who lacks a tag, i.e. who the missing_tag_data layer would remove), which
//     the post-eligibility temp table by definition no longer contains. Runs only
//     for a tag-requiring stage, exactly as in preflightStageSend.
//   • blockers + drain estimate — the same cheap checks preflightStageSend runs,
//     restated in stageBlockers below in the SAME order (the array is persisted).
//
// preflightStageSend, stageRecipientsSql and computeStageReconciliation are NOT
// changed: they are shared with kickoff / the stage send panel. Every number this
// persists is identical to the pre-2026-11-13 implementation for the same stage
// in the same snapshot — held by scripts/test-preflight-breakdown-once.ts against
// a frozen copy of that implementation (scripts/_legacy-preflight-breakdown.ts).
//
// The two NET-NEW numbers:
//   - lane = qualified − materialized_audience (only for lane children; the
//     contacts dropped by tier/aliveness). Non-lane stages → 0.
//   - dedup_1h_predicted = of the materialized set, how many phones already
//     have a `status='sent'` row org-wide within the send-dedup window, i.e.
//     would be marked `skipped_duplicate` at dispatch. This is the smoke-test
//     nuance: it makes a stage whose audience is ~100% dedup-skipped visible
//     BEFORE it fires. Inherently an ESTIMATE (the window slides and the drain
//     also dedups intra-batch), so predicted_sends is "≈".
//
// BEST-EFFORT: a timeout (57014) or any other failure throws out of here and
// the cron skips the stage for this tick, retrying on the next one. Nothing here
// writes outside the temp table; it never gates or alters a send.

/** Per-statement cap for the preflight's own transaction. SET LOCAL only — a
 *  session SET leaks onto shared backends through the transaction pooler. */
export const PREFLIGHT_STATEMENT_TIMEOUT = "60s";

export interface PreflightBreakdown {
  computed_at: string; // ISO
  mode: "manual" | "tracked";
  pool_total: number; // frozen campaign_audience_pool size
  materialized_audience: number; // stage_sends rows the kickoff will create
  predicted_sends: number; // materialized_audience − dedup_1h_predicted (≈ actual deliveries)
  // ⚠️ The lifecycle reasons are SPREAD from LifecycleExclusionCounts, never
  // listed here. Three other surfaces report the same buckets; spelling them
  // out in each is how they drift. See lib/sends/eligibility.ts.
  excluded: LifecycleExclusionCounts & {
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
  // P4: per required contact tag, how many lack it (not exclusive). `{}` when tag-less.
  missing_by_tag: Partial<Record<TagKey, number>>;
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

// The stage row preflightStageSend reads (same SELECT, same joins), so the
// recipient set and the blockers are built from exactly its inputs.
interface StageRow {
  link_mode: string;
  brand_id: number | null;
  campaign_tracking_id: string | null;
  creative_text: string | null;
  creative_id: number | null;
  offer_id: number | null;
  exclude_prior_offer_contacts: boolean;
  lifecycle_rules: boolean;
  offer_rules_enabled: boolean;
  offer_cooldown_days: number;
  offer_limit_times: number;
  stage_tracking_id: string | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  supports_api_send: boolean | null;
  provider_sends_enabled: boolean | null;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
  behavioral_tier: number | null;
  parent_stage_id: number | null;
  source_stage_ids: number[] | null;
  split_group_id: string | null;
  sender_max_sends_per_second: number | null;
  allow_unknown_carrier: boolean | null;
}

export async function computePreflightBreakdown(
  dbc: DbOrTx,
  ids: { orgId: string; campaignId: number; stageId: number },
): Promise<PreflightBreakdown> {
  // One transaction per stage: the temp table needs it, and SET LOCAL scopes the
  // 60 s cap to this work alone. When the caller already holds a transaction
  // (the test bars), drizzle opens a SAVEPOINT instead — a failure rolls back to
  // it (undoing the SET LOCAL and the temp table); on success the temp table is
  // dropped in computeInTx and the timeout restored below, so the caller's
  // transaction is left as it was.
  return (dbc as typeof db).transaction(async (tx) => {
    const prev = (await tx.execute(
      sql`SELECT current_setting('statement_timeout') AS v`,
    )) as unknown as { v: string }[];
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = '${PREFLIGHT_STATEMENT_TIMEOUT}'`),
    );
    const out = await computeInTx(tx, ids);
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${prev[0]?.v ?? "0"}, true)`,
    );
    return out;
  });
}

async function computeInTx(
  dbc: DbOrTx,
  {
    orgId,
    campaignId,
    stageId,
  }: { orgId: string; campaignId: number; stageId: number },
): Promise<PreflightBreakdown> {
  // 1. The stage row — preflightStageSend's SELECT, verbatim.
  const rows = (await dbc.execute(sql`
    SELECT
      c.link_mode         AS link_mode,
      c.brand_id          AS brand_id,
      c.tracking_id       AS campaign_tracking_id,
      cr.text             AS creative_text,
      s.creative_id       AS creative_id,
      c.offer_id          AS offer_id,
      c.exclude_prior_offer_contacts AS exclude_prior_offer_contacts,
      c.lifecycle_rules AS lifecycle_rules,
      c.offer_rules_enabled,
      c.offer_cooldown_days,
      c.offer_limit_times,
      s.tracking_id       AS stage_tracking_id,
      s.sms_provider_id   AS sms_provider_id,
      s.provider_phone_id AS provider_phone_id,
      p.supports_api_send AS supports_api_send,
      p.sends_enabled     AS provider_sends_enabled,
      s.include_no_status AS include_no_status,
      s.include_clickers  AS include_clickers,
      s.exclude_clickers  AS exclude_clickers,
      s.split_index       AS split_index,
      s.split_total       AS split_total,
      s.behavioral_tier   AS behavioral_tier,
      s.parent_stage_id   AS parent_stage_id,
      sg.source_stage_ids AS source_stage_ids,
      s.split_group_id AS split_group_id,
      pp.max_sends_per_second AS sender_max_sends_per_second,
      pp.allow_unknown_carrier AS allow_unknown_carrier
    FROM campaigns c
    JOIN campaign_stages s ON s.id = ${stageId} AND s.campaign_id = c.id
    LEFT JOIN creatives cr ON cr.id = s.creative_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id AND p.org_id = ${orgId}
    LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id AND pp.org_id = ${orgId}
    LEFT JOIN campaign_stage_split_groups sg ON sg.id = s.split_group_id
    WHERE c.id = ${campaignId} AND c.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as StageRow[];
  const row = rows[0];
  const mode: "manual" | "tracked" =
    row?.link_mode === "tracked" ? "tracked" : "manual";

  // Defaults = preflightStageSend's not-found result (no recipients, blocker
  // no_creative); the breakdown then finds no stage either and returns `empty`.
  let materialized = 0;
  let dedup1h = 0;
  const carrierExcluded: Record<string, number> = {};
  let missingByTag: Partial<Record<TagKey, number>> = {};
  let blockers: PreflightBlocker[] = ["no_creative"];
  let senderRate: number | null = null;
  let estimatedDrainSeconds: number | null = null;

  if (row) {
    const rawTagRules = await loadStageTagRules(dbc, { orgId, stageId });
    const tagRules = countingTagRules(rawTagRules);
    const carrierRejectedSuppression = await isCarrierRejectionSuppressionOn(orgId);

    const filters: StageRecipientFilters = {
      includeNoStatus: row.include_no_status,
      includeClickers: row.include_clickers,
      excludeClickers: row.exclude_clickers,
      splitIndex: row.split_index ?? null,
      splitTotal: row.split_total ?? null,
      behavioralTier: row.behavioral_tier ?? null,
      parentStageId: row.parent_stage_id ?? null,
      sourceStageIds: row.source_stage_ids ?? null,
      splitGroupId: row.split_group_id ?? null,
      laneStageId: stageId,
    };
    const eligibility: StageEligibilityOverlay = {
      creativeId: row.creative_id ?? null,
      offerId: row.offer_id ?? null,
      excludePriorOffer: row.exclude_prior_offer_contacts,
      lifecycleRules: row.lifecycle_rules === true,
      offerRulesEnabled: row.offer_rules_enabled === true,
      offerCooldownDays: Number(row.offer_cooldown_days ?? OFFER_COOLDOWN_DAYS_DEFAULT),
      offerLimitTimes: Number(row.offer_limit_times ?? 5),
      tagRules,
      carrierRejectedSuppression,
    };
    // Q4: the same carrier policy kickoff enforces.
    const carrierPolicy: CarrierPolicy = {
      providerPhoneId: row.provider_phone_id,
      allowUnknownCarrier: row.allow_unknown_carrier !== false,
    };

    // 2. THE recipient set, once. Unrestricted by the carrier policy so the
    //    per-carrier exclusions come off the same rows; `passes_carrier` is the
    //    policy's own clause (coalesce = WHERE semantics: NULL drops the row).
    await dbc.execute(sql`
      CREATE TEMP TABLE preflight_recipients ON COMMIT DROP AS
      SELECT u.contact_id, u.phone_number, u.carrier_norm,
             coalesce((${carrierPolicyClause(carrierPolicy, orgId, sql`u.carrier_norm`)}), false) AS passes_carrier
      FROM (${stageRecipientsSql({ campaignId, orgId, filters, eligibility })}) u
    `);
    await dbc.execute(sql`ANALYZE preflight_recipients`);

    // 3. Recipient count + predicted 1-hour phone dedup (the SAME window
    //    constant the drain enforces), in one read of the materialized set.
    const cnt = (await dbc.execute(sql`
      SELECT
        count(*) FILTER (WHERE r.passes_carrier)::int AS n,
        count(*) FILTER (
          WHERE r.passes_carrier AND EXISTS (
            SELECT 1 FROM stage_sends ss
            WHERE ss.org_id = ${orgId}::uuid
              AND ss.status = 'sent'
              AND ss.sent_at >= now() - interval '1 millisecond' * ${SEND_DEDUP_WINDOW_MS}
              AND ss.phone = r.phone_number
          )
        )::int AS dedup
      FROM preflight_recipients r
    `)) as unknown as { n: number; dedup: number }[];
    materialized = Number(cnt[0]?.n ?? 0);
    dedup1h = Number(cnt[0]?.dedup ?? 0);

    // 4. Q4 per-carrier exclusions: contacts that pass every other gate but are
    //    dropped by THIS NUMBER's carrier policy, per carrier. Skipped when the
    //    stage has no sending number (the clause is then a literal TRUE).
    if (carrierPolicy.providerPhoneId != null) {
      const rowsC = (await dbc.execute(sql`
        SELECT carrier_norm, count(*)::int AS n
        FROM preflight_recipients
        WHERE NOT passes_carrier
        GROUP BY carrier_norm
        ORDER BY count(*) DESC
      `)) as unknown as { carrier_norm: string | null; n: number }[];
      for (const r of rowsC) {
        // A NULL carrier is reported under its own label rather than dropped —
        // an unlabelled exclusion is the kind an operator never notices.
        carrierExcluded[r.carrier_norm ?? "(no carrier)"] = Number(r.n);
      }
    }
    // Done with the set. Dropped now rather than left to ON COMMIT DROP so a
    // caller that runs several stages inside one outer transaction (the bars)
    // can create it again.
    await dbc.execute(sql`DROP TABLE preflight_recipients`);

    // 5. P4: per required tag, who lacks it — over the PRE-eligibility base
    //    (with the carrier policy), as preflightStageSend counts it, behind the
    //    same guard (only when the stage has a lifecycle/tag layer).
    const lcLayers = buildStageEligibilityExclusions({
      orgId,
      currentCampaignId: campaignId,
      currentCreativeId: row.creative_id ?? null,
      currentOfferId: row.offer_id ?? null,
      excludePriorOffer: row.exclude_prior_offer_contacts,
      lifecycleRules: row.lifecycle_rules === true,
      offerRulesEnabled: row.offer_rules_enabled === true,
      offerCooldownDays: Number(row.offer_cooldown_days ?? OFFER_COOLDOWN_DAYS_DEFAULT),
      offerLimitTimes: Number(row.offer_limit_times ?? 5),
      tagRules,
      carrierRejectedSuppression,
    }).filter((l) =>
      (LIFECYCLE_EXCLUSION_KEYS as readonly string[]).includes(l.key),
    );
    if (lcLayers.length > 0) {
      missingByTag = await countMissingByTag(
        dbc,
        stageRecipientsSql({ campaignId, orgId, filters, carrierPolicy }),
        tagRules,
      );
    }

    // 6. Structural blockers + drain estimate.
    blockers = await stageBlockers(dbc, orgId, row, mode, materialized, rawTagRules);
    if (mode === "tracked" && row.provider_phone_id != null) {
      senderRate = resolveSendsPerSecond(row.sender_max_sends_per_second);
      if (materialized > 0) estimatedDrainSeconds = Math.ceil(materialized / senderRate);
    }
  }

  // 7. Stage config for the reconciliation filters.
  const cfgRows = (await dbc.execute(sql`
    SELECT s.include_no_status, s.include_clickers, s.exclude_clickers,
           s.split_index, s.split_total, s.behavioral_tier
    FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.id = ${stageId} AND c.id = ${campaignId} AND c.org_id = ${orgId}::uuid
    LIMIT 1
  `)) as unknown as {
    include_no_status: boolean;
    include_clickers: boolean;
    exclude_clickers: boolean;
    split_index: number | null;
    split_total: number | null;
    behavioral_tier: number | null;
  }[];
  const cfg = cfgRows[0];

  const empty: PreflightBreakdown = {
    computed_at: new Date().toISOString(),
    mode,
    pool_total: 0,
    materialized_audience: materialized,
    predicted_sends: materialized,
    excluded: {
      ...ZERO_LIFECYCLE_EXCLUSIONS,
      opt_out: 0,
      stage_filter: 0,
      split: 0,
      content_dedup: 0,
      lane: 0,
      dedup_1h_predicted: 0,
      carrier: {},
    },
    missing_by_tag: missingByTag,
    estimated_drain_seconds: estimatedDrainSeconds,
    sender_sends_per_second: senderRate,
    blockers,
    red: {
      no_audience: materialized === 0,
      all_dedup_predicted: false,
      has_blocker: blockers.length > 0,
    },
  };
  if (!cfg || !row) return empty;

  // 8. Per-cause exclusion buckets off the frozen pool (opt-out/filter/split/
  //    dedup + lifecycle layers). A different relation from the recipient set
  //    (pre-lane, pre-carrier-policy pool attribution), so computed as before.
  const recon = await computeStageReconciliation(dbc, {
    campaignId,
    orgId,
    stageId,
    filters: {
      includeNoStatus: cfg.include_no_status,
      includeClickers: cfg.include_clickers,
      excludeClickers: cfg.exclude_clickers,
      splitIndex: cfg.split_index ?? null,
      splitTotal: cfg.split_total ?? null,
    },
  });

  // 9. Lane exclusion = contacts that passed everything but failed the tier/
  //    aliveness overlay. Only meaningful for lane children; for non-lane stages
  //    qualified and materialized should match, so no drift is called "lane".
  const laneExcluded =
    cfg.behavioral_tier != null
      ? Math.max(0, recon.qualified - materialized)
      : 0;
  const predicted = Math.max(0, materialized - dedup1h);

  return {
    computed_at: new Date().toISOString(),
    mode,
    pool_total: recon.pool_total,
    materialized_audience: materialized,
    predicted_sends: predicted,
    excluded: {
      // Per-layer, from the reconciliation — NOT folded into content_dedup,
      // which would label a suppressed lead as a creative repeat.
      ...recon.excluded_by_layer,
      opt_out: recon.excluded_optout,
      stage_filter: recon.excluded_filter,
      split: recon.excluded_split,
      content_dedup: recon.excluded_dedup,
      lane: laneExcluded,
      dedup_1h_predicted: dedup1h,
      carrier: carrierExcluded,
    },
    missing_by_tag: missingByTag,
    estimated_drain_seconds: estimatedDrainSeconds,
    sender_sends_per_second: senderRate,
    blockers,
    red: {
      no_audience: materialized === 0,
      all_dedup_predicted: materialized > 0 && predicted === 0,
      has_blocker: blockers.length > 0,
    },
  };
}

// preflightStageSend's blocker checks, in its order (the array is persisted and
// compared). ⚠️ A blocker added there must be added here — the equality bar
// (scripts/test-preflight-breakdown-once.ts) compares the two on fixtures and
// source-guards that every blocker literal in preflight.ts appears here.
async function stageBlockers(
  dbc: DbOrTx,
  orgId: string,
  row: StageRow,
  mode: "manual" | "tracked",
  recipientCount: number,
  rawTagRules: Awaited<ReturnType<typeof loadStageTagRules>>,
): Promise<PreflightBlocker[]> {
  const blockers: PreflightBlocker[] = [];
  if (!row.creative_text) blockers.push("no_creative");
  if (!(recipientCount > 0)) blockers.push("no_recipients");
  // segment_ceiling_exceeded / multi_segment_not_allowed / missing_brand
  if (isTagRulesRefusal(rawTagRules)) blockers.push(rawTagRules.refused);
  if (mode !== "tracked") return blockers;

  if (!(row.stage_tracking_id && row.campaign_tracking_id)) blockers.push("stage_not_ready");
  const hasProvider = row.sms_provider_id != null;
  if (!hasProvider) blockers.push("no_provider");
  if (!(hasProvider && row.supports_api_send === true)) blockers.push("provider_not_api_capable");
  if (!(hasProvider && row.provider_sends_enabled === true)) blockers.push("provider_sends_disabled");
  if (row.provider_phone_id == null) blockers.push("no_sender_number");
  const hasCred = hasProvider
    ? await hasResolvableCredential(dbc, {
        orgId,
        providerId: row.sms_provider_id!,
        brandId: row.brand_id,
        providerPhoneId: row.provider_phone_id,
      })
    : false;
  if (!hasCred) blockers.push("no_credentials");
  const sd = (await dbc.execute(sql`
    SELECT 1 AS ok FROM short_domains
    WHERE org_id = ${orgId} AND brand_id = ${row.brand_id} AND status = 'active'
    LIMIT 1
  `)) as unknown as { ok: number }[];
  if (sd.length === 0) blockers.push("no_short_domain");
  return blockers;
}
