import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Stage Total Cost model.
//
// total_cost = cost_per_sms × (sms_count + opt_out_count), where cost_per_sms
// comes from the stage's assigned provider phone (provider_phones.cost_per_sms;
// 0 when no phone is assigned). The opt-out replies are billed like sends, so
// they count toward the multiplier alongside sms_count.
//
// This auto formula owns total_cost only while campaign_stages.total_cost_manual
// is false. When true — an operator override or a CSV-imported provider cost —
// the stored value is authoritative and the recompute below is a no-op.

// Pure formula, used where the inputs are already in hand (the manual-results
// route). Cost is in dollars (matches numeric(12,4) precision after rounding).
export function stageTotalCost(
  costPerSms: number,
  smsCount: number,
  optOutCount: number,
): number {
  return costPerSms * (smsCount + optOutCount);
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
    SET total_cost = COALESCE(
          (SELECT pp.cost_per_sms FROM provider_phones pp
           WHERE pp.id = cs.provider_phone_id),
          0
        ) * (cs.sms_count + cs.opt_out_count)
    WHERE cs.id = ${stageId}
      AND cs.total_cost_manual = false
  `);
}
