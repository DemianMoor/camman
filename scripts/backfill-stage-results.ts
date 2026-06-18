import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// One-time (idempotent) backfill of the per-stage Results counters from the
// upstream sources, so existing campaigns/stages reflect the history already
// stored from Keitaro + TextHub — the same numbers the going-forward polls
// maintain (lib/keitaro/poll.ts, lib/sends/poll-opt-outs.ts).
//
// Override policy (matches the polls):
//   * Keitaro → click_count / checkout_click_count / sales_count, summed across
//     ALL stat_dates per stage. PER-FIELD GUARD: only override when Keitaro
//     reports a POSITIVE value for that field — a Keitaro 0 never zeroes an
//     existing manual/CSV number, and a stage with no Keitaro data is skipped
//     entirely. sales_payout_each is snapshotted from the offer CPA the first
//     time sales appear (COALESCE keeps an existing snapshot).
//   * TextHub → opt_out_count is mirrored from the maintained
//     inbound_opt_out_count, but only where that counter is > 0 (a stage with no
//     attributed STOPs keeps its manual opt_out value).
//
// Safe to re-run: every UPDATE is deterministic and converges. To widen the
// Keitaro coverage first, run the poll with a large window (e.g.
// `pollKeitaro(db, { windowDays: 45 })`) so keitaro_stage_results holds the
// full retained history before backfilling.
async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const client = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(client);

  try {
    // 1. Keitaro counters (clicks / checkouts / sales). Only stages that have at
    //    least one positive Keitaro metric are touched.
    const keitaro = await db.execute(drizzleSql`
      UPDATE campaign_stages cs SET
        click_count = CASE WHEN k.clickers > 0 THEN k.clickers ELSE cs.click_count END,
        checkout_click_count = CASE WHEN k.checkouts > 0 THEN k.checkouts ELSE cs.checkout_click_count END,
        sales_count = CASE WHEN k.sales > 0 THEN k.sales ELSE cs.sales_count END,
        sales_payout_each = CASE
          WHEN k.sales > 0 THEN COALESCE(cs.sales_payout_each, o.payout_cpa)
          ELSE cs.sales_payout_each
        END
      FROM (
        SELECT stage_id,
               max(campaign_id) AS campaign_id,
               coalesce(sum(visit_clicks_clean), 0)::int AS clickers,
               coalesce(sum(checkouts), 0)::int          AS checkouts,
               coalesce(sum(sales), 0)::int              AS sales
        FROM keitaro_stage_results
        GROUP BY stage_id
      ) k
      LEFT JOIN campaigns c ON c.id = k.campaign_id
      LEFT JOIN offers o    ON o.id = c.offer_id
      WHERE cs.id = k.stage_id
        AND (k.clickers > 0 OR k.checkouts > 0 OR k.sales > 0)
    `);

    // 2. TextHub opt-outs: mirror the maintained attribution counter into the
    //    panel's opt_out_count, only where there are attributed STOPs.
    const optOuts = await db.execute(drizzleSql`
      UPDATE campaign_stages
      SET opt_out_count = inbound_opt_out_count
      WHERE inbound_opt_out_count > 0
        AND opt_out_count <> inbound_opt_out_count
    `);

    console.log(
      `Backfill complete:\n` +
        `  Keitaro counters: ${keitaro.count} stage(s) updated\n` +
        `  Opt-out mirror:   ${optOuts.count} stage(s) updated`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
