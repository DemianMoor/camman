import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { propagateTrackedClickers } from "@/lib/links/propagate-clickers";
import { getClickerReconciliation } from "@/lib/reporting/epc-monitors";
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:3}); const d=drizzle(c);
  const q=async(x:ReturnType<typeof sql>)=>(await d.execute(x)) as unknown as Record<string,unknown>[];
  console.log("=== SCOPE (printed before any number, so the result is readable) ===");
  console.table(await q(sql`SELECT count(*)::int AS clickers_rows_now,
    (SELECT watermark::text FROM cron_locks WHERE job_name='propagate-clickers') AS current_watermark,
    (SELECT count(*)::int FROM clicks WHERE classification='human') AS human_clicks_all_time FROM clickers`));
  const recon = await getClickerReconciliation(d);
  console.log(`\nreconciliation probe BEFORE: ${recon.missing} missing (tolerance ${recon.tolerance}, breached=${recon.breached})`);
  const inc = await propagateTrackedClickers(d, { mode: "incremental", dryRun: true });
  console.log(`\nINCREMENTAL dry-run: would insert ${inc.inserted}`);
  console.log(`  scope: ${inc.scope}`);
  const reb = await propagateTrackedClickers(d, { mode: "rebuild", dryRun: true });
  console.log(`\nREBUILD dry-run: would insert ${reb.inserted}`);
  console.log(`  scope: ${reb.scope}`);
  console.log(`\nNOTHING WRITTEN. Re-run with the apply script to commit.`);
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
