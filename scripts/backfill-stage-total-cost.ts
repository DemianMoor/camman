// One-shot backfill: populate campaign_stages.total_cost for stages still in
// auto mode (total_cost_manual = false) from the auto formula
//   total_cost = cost_per_sms × (sms_count + opt_out_count)
// where cost_per_sms is the assigned provider phone's rate (0 if unassigned).
//
// Migration 0081 added the column and flagged existing NON-ZERO costs as
// manual, so every auto stage currently sits at total_cost = 0. This fills in
// the synthetic cost for old stages that have sends/opt-outs + a priced phone.
// The IS DISTINCT FROM guard means rows already at the correct value are left
// untouched, so the script is idempotent and only ever fills in a missing cost.
//
// Run: `npx tsx scripts/backfill-stage-total-cost.ts` against the same
// DATABASE_URL the deployed app uses. Migration 0081 must be applied first.
// Bypasses RLS via the privileged DB connection — no signed-in user required.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  // The auto value expressed once, reused for the preview and the UPDATE.
  // Mirrors lib/stages/total-cost.ts recomputeStageTotalCost: cost is 0 until
  // the stage is sent (sent_at set OR hand-entered sms_count > 0); "sends" is
  // GREATEST(sms_count, real provider-accepted stage_sends) so API/tracked
  // stages (sms_count = 0) cost on their dispatched messages, not just opt-outs.
  const autoCost = drizzleSql`CASE
    WHEN cs.sent_at IS NOT NULL OR cs.sms_count > 0 THEN
      COALESCE(
        (SELECT pp.cost_per_sms FROM provider_phones pp WHERE pp.id = cs.provider_phone_id),
        0
      ) * (
        GREATEST(
          cs.sms_count,
          (SELECT count(*) FROM stage_sends ss
           WHERE ss.stage_id = cs.id AND ss.status = 'sent')
        ) + cs.opt_out_count
      )
    ELSE 0
  END`;

  try {
    const preview = (await db.execute(drizzleSql`
      SELECT
        count(*)::int AS auto_stages,
        count(*) FILTER (
          WHERE cs.total_cost IS DISTINCT FROM ${autoCost}
        )::int AS will_change
      FROM campaign_stages cs
      WHERE cs.total_cost_manual = false
    `)) as unknown as { auto_stages: number; will_change: number }[];

    const { auto_stages, will_change } = preview[0];
    console.log(`Auto-mode stages (total_cost_manual = false): ${auto_stages}`);
    console.log(`Stages whose total_cost will be filled in:     ${will_change}`);

    if (will_change === 0) {
      console.log("Nothing to backfill — every auto stage is already correct.");
      return;
    }

    const updated = (await db.execute(drizzleSql`
      UPDATE campaign_stages cs
      SET total_cost = ${autoCost}
      WHERE cs.total_cost_manual = false
        AND cs.total_cost IS DISTINCT FROM ${autoCost}
      RETURNING cs.id
    `)) as unknown as { id: number }[];

    console.log("");
    console.log("=== Summary ===");
    console.log(`Stages updated: ${updated.length}`);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
