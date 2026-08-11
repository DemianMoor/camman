import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { refreshCountedClickers } from "@/lib/reporting/counted-clickers";

// Does autovacuum keep up with the refresh churn on counted_clickers?
// Measured, not assumed. The suspicion: INSERT ... ON CONFLICT DO NOTHING uses
// SPECULATIVE INSERTION — a conflicting row is inserted then killed, leaving a
// dead tuple. The incremental pass re-processes a 6h window every 5 minutes, so
// each already-present row would be re-speculated ~72x/day.
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:1}); const d=drizzle(c);
  const q=async(x:ReturnType<typeof sql>)=>(await d.execute(x)) as unknown as Record<string,unknown>[];
  const stat=async()=>(await q(sql`
    SELECT n_live_tup, n_dead_tup, n_tup_ins, n_tup_del, autovacuum_count,
           pg_size_pretty(pg_total_relation_size('counted_clickers')) AS size
    FROM pg_stat_user_tables WHERE relname='counted_clickers'`))[0];

  console.log("=== autovacuum settings in effect ===");
  console.table(await q(sql`
    SELECT name, setting FROM pg_settings
    WHERE name IN ('autovacuum_vacuum_scale_factor','autovacuum_vacuum_threshold','autovacuum_naptime')`));
  console.log("per-table overrides:");
  console.table(await q(sql`SELECT reloptions FROM pg_class WHERE relname='counted_clickers'`));

  console.log("\n=== baseline ==="); console.table([await stat()]);
  const before = await stat();

  // Simulate a day of incremental passes (they re-process the same 6h window).
  console.log("\nrunning 5 incremental passes...");
  for (let i=0;i<5;i++) await refreshCountedClickers(d,"incremental");
  const after = await stat();
  console.log("=== after 5 incremental passes ==="); console.table([after]);

  const deadDelta = Number(after.n_dead_tup) - Number(before.n_dead_tup);
  const insDelta = Number(after.n_tup_ins) - Number(before.n_tup_ins);
  console.log(`\ndead tuples added by 5 passes: ${deadDelta}  (inserts recorded: ${insDelta})`);
  console.log(`extrapolated per day (288 passes): ${Math.round(deadDelta/5*288).toLocaleString()} dead tuples`);
  console.log(`live rows: ${Number(after.n_live_tup).toLocaleString()}`);
  const threshold = 50 + 0.2*Number(after.n_live_tup);
  console.log(`default autovacuum trigger at ~${Math.round(threshold).toLocaleString()} dead tuples`);
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
