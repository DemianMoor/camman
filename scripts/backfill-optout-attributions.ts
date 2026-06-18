// One-shot backfill: attribute existing inbound STOPs (opt_outs.source =
// 'sms_inbound') to the campaign/stage(s) that sent to the number, using the
// SAME 72h-window rule the live poller applies (lib/sends/poll-opt-outs.ts),
// then recompute every campaign_stages.inbound_opt_out_count from the resulting
// opt_out_attributions rows.
//
// Idempotent — the attribution INSERT is ON CONFLICT (opt_out_id, stage_id) DO
// NOTHING, and the counter recompute rewrites from the junction, so re-running
// converges. Safe to run repeatedly.
//
// Run: `npx tsx scripts/backfill-optout-attributions.ts` against the same
// DATABASE_URL the deployed app uses. Migration 0075 must be applied first.
// Bypasses RLS via the privileged DB connection — no signed-in user required.
//
// Anchor: historical opt_outs predate provider_received_at, so the window is
// anchored on opt_outs.created_at (the poll-insert time). That's slightly later
// than the true receipt, which only widens the upper bound generously — it
// never wrongly excludes a triggering send.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { OPT_OUT_ATTRIBUTION_WINDOW_HOURS } from "@/lib/sends/poll-opt-outs";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    // 1) Attribute: one (latest) send per (opt_out, stage) inside the window.
    const inserted = (await db.execute(drizzleSql`
      INSERT INTO opt_out_attributions
        (org_id, opt_out_id, stage_send_id, stage_id, campaign_id)
      SELECT DISTINCT ON (oo.id, ss.stage_id)
             oo.org_id, oo.id, ss.id, ss.stage_id, ss.campaign_id
      FROM opt_outs oo
      JOIN stage_sends ss
        ON ss.org_id = oo.org_id
       AND ss.phone = oo.phone_number
       AND ss.status = 'sent'
       AND ss.sent_at IS NOT NULL
       AND ss.sent_at >= oo.created_at
                          - (${OPT_OUT_ATTRIBUTION_WINDOW_HOURS} * interval '1 hour')
       AND ss.sent_at <= oo.created_at + interval '5 minutes'
      WHERE oo.source = 'sms_inbound'
      ORDER BY oo.id, ss.stage_id, ss.sent_at DESC
      ON CONFLICT (opt_out_id, stage_id) DO NOTHING
      RETURNING id
    `)) as unknown as { id: number }[];

    // 2) Recompute the denormalized per-stage counter from the junction. Writes
    // only stages whose stored count drifted from the recomputed value.
    const updated = (await db.execute(drizzleSql`
      UPDATE campaign_stages cs
      SET inbound_opt_out_count = agg.n
      FROM (
        SELECT cs2.id AS stage_id, count(oa.id)::int AS n
        FROM campaign_stages cs2
        LEFT JOIN opt_out_attributions oa ON oa.stage_id = cs2.id
        GROUP BY cs2.id
      ) agg
      WHERE cs.id = agg.stage_id
        AND cs.inbound_opt_out_count <> agg.n
      RETURNING cs.id
    `)) as unknown as { id: number }[];

    console.log(
      `Backfill complete: ${inserted.length} new attribution row(s), ` +
        `${updated.length} stage counter(s) corrected ` +
        `(window ${OPT_OUT_ATTRIBUTION_WINDOW_HOURS}h).`,
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Backfill crashed:", err);
  process.exit(1);
});
