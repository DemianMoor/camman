import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  campaign_audience_pool,
  campaign_stages,
  campaigns,
  creatives,
  offers,
} from "@/db/schema";
import { notifyGuardrail, notifyGuardrailOncePerDay } from "@/lib/guardrails/notify";
import {
  isProven,
  loadCreativeSendHistory,
  UNPROVEN_DAILY_WARN_THRESHOLD,
} from "@/lib/guardrails/proven-creative";
import { trailingSendingDayAverage } from "@/lib/guardrails/volume";

// Everything that runs at PREPARE time (ClickUp 869et3vm1, Phase 3).
//
// ⚠️ ONE CALL PER PREPARE. `loadCreativeSendHistory` is executed exactly once
// here, and the per-creative answer is a map read. Calling it per stage would
// cost ~1.0-1.2s each (recon §7) inside a request a human is waiting on — a
// twelve-lane campaign would spend fifteen seconds doing the same scan twelve
// times over.
//
// scripts/test-proven-creative-query-count.ts proves the once-per-Prepare
// property by counting the statement in pg_stat_statements across a real
// Prepare, rather than by reading this comment and believing it.

/** Recipients this stage is about to materialize. */
export async function stageAudienceSize(
  dbc: typeof db,
  opts: { orgId: string; campaignId: number; stageId: number },
): Promise<number> {
  const rows = await dbc
    .select({ n: sql<number>`count(*)::int` })
    .from(campaign_audience_pool)
    .where(
      and(
        eq(campaign_audience_pool.org_id, opts.orgId),
        eq(campaign_audience_pool.campaign_id, opts.campaignId),
      ),
    );
  return rows[0]?.n ?? 0;
}

export interface PrepareGuardrailInput {
  orgId: string;
  campaignId: number;
  stageId: number;
  actorUserId: string;
  plannedRecipients: number;
}

/**
 * WARN-only guardrails. These never refuse — they post to Telegram, write
 * audit_log, and let the Prepare proceed.
 */
export async function runPrepareGuardrails(
  input: PrepareGuardrailInput,
): Promise<void> {
  const { orgId, campaignId, stageId, actorUserId, plannedRecipients } = input;

  const [stage] = await db
    .select({
      creative_id: campaign_stages.creative_id,
      stage_number: campaign_stages.stage_number,
    })
    .from(campaign_stages)
    .where(
      and(eq(campaign_stages.id, stageId), eq(campaign_stages.org_id, orgId)),
    )
    .limit(1);

  // ── WARN 1: unproven creative at volume ─────────────────────────────────
  if (stage?.creative_id && plannedRecipients > UNPROVEN_DAILY_WARN_THRESHOLD) {
    // THE single history load for this Prepare.
    const history = await loadCreativeSendHistory(orgId);
    if (!isProven(history, stage.creative_id)) {
      const [meta] = await db
        .select({
          text: creatives.text,
          slug: creatives.slug,
          campaignName: campaigns.name,
          offerName: offers.name,
        })
        .from(creatives)
        .leftJoin(campaigns, eq(campaigns.id, campaignId))
        .leftJoin(offers, eq(offers.id, campaigns.offer_id))
        .where(eq(creatives.id, stage.creative_id))
        .limit(1);

      // Dedupe on creative+day, not on stage: the same unproven creative across
      // three lanes of one campaign is ONE fact an Owner needs to know, not
      // three notifications.
      await notifyGuardrailOncePerDay(
        {
          orgId,
          actorUserId,
          event: "guardrail.unproven_creative",
          headline: `Unproven creative planned for ${plannedRecipients.toLocaleString()} recipients today`,
          detail: [
            `Creative: ${meta?.slug ?? stage.creative_id}`,
            `Text: ${(meta?.text ?? "").slice(0, 200)}`,
            `Offer: ${meta?.offerName ?? "—"}`,
            `Campaign: ${meta?.campaignName ?? campaignId} (stage ${stage.stage_number})`,
            `Planned volume: ${plannedRecipients.toLocaleString()}`,
            `By: ${actorUserId}`,
          ],
          entityType: "creative",
          entityId: String(stage.creative_id),
          metadata: {
            creative_id: stage.creative_id,
            campaign_id: campaignId,
            stage_id: stageId,
            planned: plannedRecipients,
          },
        },
        `unproven:${stage.creative_id}`,
      );
    }
  }

  // ── WARN 2: today's volume vs the trailing 7 SENDING-day average ────────
  //
  // Sending days, not calendar days (Dmytro, decision C). A Sunday with zero
  // sends would otherwise drag the mean down ~14% and make Monday fire a
  // spurious breach every week.
  const avg = await trailingSendingDayAverage(orgId);
  if (avg.average > 0) {
    const projected = avg.today + plannedRecipients;
    const threshold = avg.average * 1.2;
    if (projected > threshold) {
      await notifyGuardrailOncePerDay(
        {
          orgId,
          actorUserId,
          event: "guardrail.volume_deviation",
          headline:
            `Today's volume ${projected.toLocaleString()} is ` +
            `${Math.round((projected / avg.average - 1) * 100)}% above the trailing ` +
            `${avg.days}-sending-day average (${Math.round(avg.average).toLocaleString()})`,
          detail: [
            `Already today: ${avg.today.toLocaleString()}`,
            `This Prepare adds: ${plannedRecipients.toLocaleString()}`,
            `Averaged over ${avg.days} sending days: ${avg.dayList.join(", ")}`,
          ],
          entityType: "org",
          entityId: orgId,
          metadata: { projected, average: avg.average, days: avg.days },
        },
        // One per DAY for the org, not per stage — the brief says "fire once per
        // day per breach, not per stage".
        `volume-deviation`,
      );
    }
  }
}

/** Used by the deletion queue and cap refusals that happen outside Prepare. */
export { notifyGuardrail };
