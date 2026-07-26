import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { db as dbType } from "@/db/client";
import {
  countAlignedOptOutsInWindowsForStage,
  countSentInWindowsForStage,
} from "@/lib/sends/circuit-breakers";
import {
  decideOptOutRateBreaker,
  optOutBreakerReason,
  optOutRateWindowConfigs,
} from "@/lib/sends/optout-rate-breaker";
import { findUnjoinableOptOutAttributions } from "@/lib/sends/unjoinable-attributions";

// READ-ONLY verification of the re-cut opt-out-rate breaker against LIVE data.
// SELECT ONLY — this script must never UPDATE/INSERT/DELETE, and it deliberately
// does NOT call checkOptOutRateBreaker (which would latch a pause). It runs the
// real production queries + the pure decision and reports what WOULD happen.
//
//   A. every stage with sends in the trailing long window → would it trip now?
//   B. the same for the campaigns that are currently send_paused
//   C. the null-stage_send_id blind-spot stat the hourly cron watches
//
// Run: npx tsx scripts/verify-optout-breaker-alignment.ts

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(pg);
  const T = d as unknown as typeof dbType;
  const cfg = optOutRateWindowConfigs();

  console.log(`=== verify-optout-breaker-alignment — ${new Date().toISOString()} ===`);
  console.log(
    `config: long ${cfg.long.window_seconds}s @ ${(cfg.long.threshold * 100).toFixed(0)}% (floor ${cfg.long.min_sends}) · ` +
      `short ${cfg.short.window_seconds}s @ ${(cfg.short.threshold * 100).toFixed(0)}% (floor ${cfg.short.min_sends})\n`,
  );

  // Candidate stages: anything that sent inside the long window. Judging every
  // one of them is exactly what the runtime would do, one STOP at a time.
  const stages = (await d.execute(sql`
    SELECT ss.org_id AS org_id, ss.stage_id AS stage_id, ss.campaign_id AS campaign_id,
           c.name AS campaign_name, c.send_paused AS campaign_paused,
           count(*)::int AS sends
    FROM stage_sends ss
    JOIN campaigns c ON c.id = ss.campaign_id
    WHERE ss.status = 'sent'
      AND ss.sent_at > now() - make_interval(secs => ${cfg.long.window_seconds})
    GROUP BY ss.org_id, ss.stage_id, ss.campaign_id, c.name, c.send_paused
    ORDER BY count(*) DESC
  `)) as unknown as {
    org_id: string;
    stage_id: number;
    campaign_id: number;
    campaign_name: string | null;
    campaign_paused: boolean;
    sends: number;
  }[];

  console.log(`A. ${stages.length} stage(s) sent inside the ${cfg.long.window_seconds / 3600}h window.\n`);

  let judged = 0;
  const trips: string[] = [];
  const started = Date.now();
  for (const s of stages) {
    const sent = await countSentInWindowsForStage(
      T, s.org_id, s.stage_id, cfg.long.window_seconds, cfg.short.window_seconds,
    );
    const oo = await countAlignedOptOutsInWindowsForStage(
      T, s.org_id, s.stage_id, cfg.long.window_seconds, cfg.short.window_seconds,
    );
    const dec = decideOptOutRateBreaker(
      {
        long: { sent: sent.long, opt_outs: oo.long },
        short: { sent: sent.short, opt_outs: oo.short },
      },
      cfg,
    );
    if (dec.evaluated) judged++;
    const line =
      `  stage ${s.stage_id} (campaign ${s.campaign_id} "${s.campaign_name ?? "?"}"` +
      `${s.campaign_paused ? ", PAUSED" : ""}) — ` +
      `24h ${oo.long}/${sent.long} = ${sent.long ? ((oo.long / sent.long) * 100).toFixed(2) : "—"}% · ` +
      `2h ${oo.short}/${sent.short} = ${sent.short ? ((oo.short / sent.short) * 100).toFixed(2) : "—"}%` +
      `${dec.evaluated ? "" : "  [below floor — not judged]"}`;
    console.log(line);
    if (dec.tripped_by !== null) {
      trips.push(`  ⚠️  WOULD TRIP: ${optOutBreakerReason(s.stage_id, dec)}`);
    }
  }
  console.log(
    `\n  (${stages.length} stages, ${judged} above the min-send floor, ${Date.now() - started}ms for ${stages.length * 2} queries)`,
  );

  console.log(`\nB. stages that WOULD trip right now: ${trips.length}`);
  for (const t of trips) console.log(t);
  if (trips.length === 0) {
    console.log("  none — no live stage breaches the aligned thresholds.");
  }

  console.log("\nC. currently send_paused campaigns:");
  const paused = (await d.execute(sql`
    SELECT id, name, send_paused_reason,
           (send_paused_at AT TIME ZONE 'America/New_York')::text AS paused_at_et
    FROM campaigns WHERE send_paused = true ORDER BY send_paused_at`)) as unknown as {
    id: number; name: string | null; send_paused_reason: string | null; paused_at_et: string | null;
  }[];
  if (paused.length === 0) console.log("  none.");
  for (const p of paused) {
    console.log(`  ${p.id} "${p.name}" — ${p.send_paused_reason} (${p.paused_at_et} ET)`);
  }

  console.log("\nD. null-stage_send_id blind spot (what the hourly cron watches):");
  for (const hours of [24, 720]) {
    const s = await findUnjoinableOptOutAttributions(T, { windowHours: hours });
    console.log(`  last ${hours}h: ${s.nulls}/${s.total} unjoinable = ${(s.pct * 100).toFixed(2)}%`);
  }

  await pg.end();
  console.log("\n=== done (read-only) ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
