import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Stage Total Cost model.
//
// total_cost = cost_per_sms × (sends + opt_out_count), where cost_per_sms comes
// from the stage's assigned provider phone (provider_phones.cost_per_sms; 0 when
// no phone is assigned). Opt-out replies are billed like sends, so they count
// toward the multiplier alongside the sends.
//
// "sends" is the number of messages actually dispatched, which differs by stage
// type: API/tracked stages materialize one stage_sends row per recipient and
// `sms_count` stays 0, so the real count is the stage_sends rows accepted by the
// provider (status='sent' — the same number the UI's "Submitted / accepted by
// TextHub" badge shows). Manual/CSV stages have no stage_sends rows and carry
// the operator-entered tally in `sms_count`. GREATEST(sms_count, sent_count)
// resolves both without double-counting.
//
// Cost is calculated from the messages ACTUALLY sent — a manual tally
// (`sms_count > 0`) OR at least one accepted API send (a `status='sent'`
// stage_sends row). It is deliberately NOT gated on `campaign_stages.sent_at`:
// that stage-level fire-lock can stay NULL when a drain was interrupted before
// its finalization step ran, yet thousands of rows already sent — gating cost on
// it zeroed the cost of stages that had fully sent (the 8_62_070726_2 incident).
// Failed / stuck / dedup-skipped rows are NOT 'sent', so they neither add cost
// nor zero it. Before any send, total_cost stays 0.
//
// This auto formula owns total_cost only while campaign_stages.total_cost_manual
// is false. When true — an operator override or a CSV-imported provider cost —
// the stored value is authoritative and the recompute below is a no-op.

// Pure formula, used for the manual-results form's live preview where the
// effective sends are already resolved client-side. Cost is in dollars
// (matches numeric(12,4) precision after rounding).
export function stageTotalCost(
  costPerSms: number,
  sends: number,
  optOutCount: number,
): number {
  return costPerSms * (sends + optOutCount);
}

// Any drizzle executor — the top-level client or a transaction handle.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Recompute one stage's total_cost in SQL from its current counters and its
// provider phone's cost. Skips manual/imported stages.
//
// DRIP stages are priced per SEND instead: each 'sent' row at its own
// cost_per_sms snapshot (else the sending number's current rate; drip inserts
// wrote no snapshot before 2026-10-07), plus each attributed opt-out reply at
// the rate of the send it answered. That is the Overview's per-day drip cost
// (dripCostByStageInRange in lib/reporting/stage-funnel.ts) summed over all
// days, so the two foot, and a rate edit doesn't re-price weeks of past drip
// sends. A drip stage sends for weeks, so it is also refreshed on a timer
// (refreshDripStageCosts below) — opt-outs alone left it stale between them. Used by the opt-out
// poller (after it bumps opt_out_count) and the stage PATCH (after a
// provider-phone change). Reads the post-write counter values, so call it
// AFTER the mutation that changed sms_count / opt_out_count / provider_phone_id.
export async function recomputeStageTotalCost(
  exec: Executor,
  stageId: number,
): Promise<void> {
  await exec.execute(sql`
    UPDATE campaign_stages cs
    SET total_cost = CASE
      WHEN c.type = 'drip' THEN
        COALESCE(
          (SELECT sum(COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0))
           FROM stage_sends ss
           LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
           WHERE ss.stage_id = cs.id AND ss.status = 'sent'),
          0
        ) + COALESCE(
          (SELECT sum(COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0))
           FROM opt_out_attributions oa
           JOIN stage_sends ss ON ss.id = oa.stage_send_id
           LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
           WHERE oa.stage_id = cs.id),
          0
        )
      WHEN cs.sms_count > 0
        OR EXISTS (
          SELECT 1 FROM stage_sends ss
          WHERE ss.stage_id = cs.id AND ss.status = 'sent'
        ) THEN
        COALESCE(
          (SELECT pp.cost_per_sms FROM provider_phones pp
           WHERE pp.id = cs.provider_phone_id),
          0
        ) * (
          GREATEST(
            cs.sms_count,
            (SELECT count(*) FROM stage_sends ss
             WHERE ss.stage_id = cs.id AND ss.status = 'sent')
          ) + cs.opt_out_count
        )
      ELSE 0
    END
    FROM campaigns c
    WHERE cs.id = ${stageId}
      AND c.id = cs.campaign_id
      AND cs.total_cost_manual = false
  `);
}

// Recompute every drip stage that sent within `sinceMinutes`. Run from the
// send-scheduled cron (every 5 min) after the drain; the 60-minute default
// covers missed ticks. Candidates come off the (org_id, sent_at) index, so the
// lookup reads only the window's sends, not each stage's history.
export async function refreshDripStageCosts(
  exec: Executor,
  opts: { orgId?: string; sinceMinutes?: number } = {},
): Promise<number> {
  const since = opts.sinceMinutes ?? 60;
  const stages = (await exec.execute(sql`
    SELECT DISTINCT ss.stage_id
    FROM organizations o
    JOIN stage_sends ss ON ss.org_id = o.id
    JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
    WHERE ss.status = 'sent'
      AND ss.sent_at >= now() - make_interval(mins => ${since})
      ${opts.orgId ? sql`AND o.id = ${opts.orgId}::uuid` : sql``}
  `)) as unknown as { stage_id: number }[];
  for (const { stage_id } of stages) {
    await recomputeStageTotalCost(exec, Number(stage_id));
  }
  return stages.length;
}
