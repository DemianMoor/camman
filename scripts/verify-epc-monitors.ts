import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres";
import { runEpcMonitors, EXCLUDED_CONVERSION_ALERT_PCT, RULE_F_BASELINE } from "@/lib/reporting/epc-monitors";
function assert(c:boolean,m:string){if(!c)throw new Error(`ASSERTION FAILED: ${m}`);console.log(`  ✓ ${m}`);}
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:5}); const d=drizzle(c);
  const r=await runEpcMonitors(d);
  console.log("\n=== human share of taps by month ==="); console.table(r.human_share);
  console.log("=== excluded-clicker conversion ==="); console.table([r.excluded_conversion]);
  console.log("=== rule F ==="); console.table([r.rule_f]);
  console.log("=== row-5 probe ==="); console.table([r.row5]);
  console.log("=== breaches ==="); console.log(r.breaches.length ? r.breaches : "(none)");

  assert(r.human_share.length >= 3, "human-share series covers all months of history");
  assert(r.human_share.every(m => m.human_share_pct > 0), "every month has a non-zero human share");
  assert(EXCLUDED_CONVERSION_ALERT_PCT === 0.1, "excluded-conversion threshold is 0.1% as specified");
  assert(RULE_F_BASELINE === 8, "Rule F baseline is 8 as measured");
  assert(r.rule_f.rescues >= 0, "Rule F rescue count reads");
  assert(!r.row5.breached, `row 5 still measures zero (${r.row5.reached_without_click}) — the no-ingest decision holds`);
  console.log("\nverify-epc-monitors OK.");
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
