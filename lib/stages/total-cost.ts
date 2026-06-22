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
// Cost is only calculated once the stage has been SENT — not at creation time.
// "Sent" means `sent_at IS NOT NULL` (an API fire or a "Mark as sent" click) OR
// `sms_count > 0` (hand-entered results imply the send happened, even if the
// stage was never marked sent). Before that, total_cost stays 0.
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
// provider phone's cost. Skips manual/imported stages. Used by the opt-out
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
      WHEN cs.sent_at IS NOT NULL OR cs.sms_count > 0 THEN
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
    WHERE cs.id = ${stageId}
      AND cs.total_cost_manual = false
  `);
}
