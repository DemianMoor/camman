// One-shot, idempotent, REVERSIBLE-by-design backfill: collapse historical
// opt-out fan-out so each opt_out is credited to exactly ONE stage — the one
// whose send was most recent — matching the live poller after 2026-06-24
// (lib/sends/poll-opt-outs.ts, latestSendForAttribution).
//
// Before this change the poller wrote one opt_out_attributions row per stage in
// the 72h window, so a sequence that sent the same lead 2–3 messages counted the
// opt-out 2–3× (on ET 2026-06-23: 530 real opt-outs → 996 attribution rows).
// This script keeps, per opt_out, only the attribution whose stage_send.sent_at
// is latest (tie-break: higher stage_id, then higher stage_send_id — IDENTICAL
// to the live ORDER BY), deletes the rest, then re-derives each affected stage's
// inbound_opt_out_count / opt_out_count from the surviving rows and recomputes
// its total_cost.
//
// DRY-RUN BY DEFAULT — prints the before/after summary and rolls back. Pass
// `--apply` to commit:
//   npx tsx scripts/backfill-optout-latest-stage.ts            (preview only)
//   npx tsx scripts/backfill-optout-latest-stage.ts --apply    (writes)
//
// Idempotent: re-running after --apply is a no-op (already one row per opt_out).
// Run against the same DATABASE_URL the deployed app uses; bypasses RLS via the
// privileged connection. Do NOT wire this into deploy — run it deliberately.
//
// CSV/manual coexistence: for any stage that received inbound STOPs the live
// poller already OWNS opt_out_count (it overwrites it to inbound_opt_out_count on
// every STOP), so re-deriving opt_out_count downward here is consistent with
// production semantics, not a regression. Stages with no attributions are never
// touched (the recompute's `<>` guard skips them), so CSV-only opt_out_count is
// preserved.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

const APPLY = process.argv.includes("--apply");

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  const rollback = new Error("__dry_run_rollback__");

  try {
    // Snapshot the fan-out BEFORE touching anything.
    const before = (await db.execute(drizzleSql`
      SELECT count(*)::int AS rows,
             count(DISTINCT opt_out_id)::int AS distinct_opt_outs
      FROM opt_out_attributions
    `)) as unknown as { rows: number; distinct_opt_outs: number }[];

    await db.transaction(async (tx) => {
      // 1) Rank attributions newest-send-first per opt_out (same tie-break the
      //    live poller uses). LEFT JOIN so a row whose stage_send was pruned
      //    (FK SET NULL) still ranks — sent_at NULLS LAST means a row with a
      //    real send always wins over a pruned one. Delete everything but rn=1.
      const deleted = (await tx.execute(drizzleSql`
        WITH ranked AS (
          SELECT oa.id,
                 row_number() OVER (
                   PARTITION BY oa.opt_out_id
                   ORDER BY ss.sent_at DESC NULLS LAST,
                            oa.stage_id DESC,
                            oa.stage_send_id DESC
                 ) AS rn
          FROM opt_out_attributions oa
          LEFT JOIN stage_sends ss ON ss.id = oa.stage_send_id
        )
        DELETE FROM opt_out_attributions oa
        USING ranked r
        WHERE oa.id = r.id AND r.rn > 1
        RETURNING oa.stage_id
      `)) as unknown as { stage_id: number }[];

      // 2) Re-derive the per-stage counters from the surviving junction. Writes
      //    only stages whose stored count drifted (the ones that lost rows), and
      //    mirrors opt_out_count to match (live-poller semantics, see header).
      const recomputed = (await tx.execute(drizzleSql`
        UPDATE campaign_stages cs
        SET inbound_opt_out_count = agg.n,
            opt_out_count = agg.n
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

      // 3) Opt-outs are billed like sends — recompute total_cost for every stage
      //    whose counter changed (no-op for manual/CSV-override stages).
      for (const { id } of recomputed) {
        await recomputeStageTotalCost(tx, id);
      }

      const after = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS rows,
               count(DISTINCT opt_out_id)::int AS distinct_opt_outs
        FROM opt_out_attributions
      `)) as unknown as { rows: number; distinct_opt_outs: number }[];

      const distinctStages = new Set(deleted.map((d) => d.stage_id)).size;
      console.log(
        `${APPLY ? "APPLIED" : "DRY-RUN (no changes committed)"}:\n` +
          `  attribution rows: ${before[0].rows} → ${after[0].rows} ` +
          `(${deleted.length} collapsed)\n` +
          `  distinct opt_outs credited: ${before[0].distinct_opt_outs} → ` +
          `${after[0].distinct_opt_outs} (should be unchanged)\n` +
          `  stages whose latest-stage credit was removed: ${distinctStages}\n` +
          `  stage counters re-derived: ${recomputed.length}`,
      );

      if (!APPLY) throw rollback;
    });
  } catch (err) {
    if (err !== rollback) {
      console.error("Backfill crashed:", err);
      process.exitCode = 1;
    }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to commit.");
  }
}

main();
