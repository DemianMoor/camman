import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { computeCreativeMetrics } from "@/lib/creatives/metrics-cache";
function assert(c:boolean,m:string){if(!c)throw new Error(`ASSERTION FAILED: ${m}`);console.log(`  ✓ ${m}`);}
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:3}); const d=drizzle(c);
  const org=(await d.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as {id:string}[];
  const rows=await computeCreativeMetrics(org[0].id);
  const clean30=(r:typeof rows[0])=>r.manual_clean+r.tracked_clean;

  assert(rows.length>0,"metrics computed");
  assert(rows.every(r=>r.lifetime_clean>=clean30(r)),"lifetime clean >= 30-day clean on EVERY creative");
  const divergent=rows.filter(r=>r.lifetime_clean>clean30(r));
  assert(divergent.length>0,`${divergent.length} creatives have history beyond the 30-day window`);

  // The case that justifies the column: recent window says nothing, history does.
  const hidden=rows.filter(r=>clean30(r)>0 && r.payout===0 && r.lifetime_payout>0);
  console.log(`\n  creatives with $0 over 30d but real lifetime revenue: ${hidden.length}`);
  console.table(hidden.slice(0,5).map(r=>({creative:r.creative_id, clean30:clean30(r), cleanLife:r.lifetime_clean,
    epc30:"$0.0000", epcLife:"$"+(r.lifetime_payout/r.lifetime_clean).toFixed(4)})));
  assert(hidden.length>0,"the lifetime column surfaces creatives the 30-day view writes off entirely");

  // Sort must stay on the 30-day figure.
  const src=(await import("node:fs")).readFileSync("app/api/creatives/list/route.ts","utf-8");
  assert(/RATIO_SQL/.test(src) && /epc:\s*drizzleSql`CASE WHEN \$\{cleanExpr\}/.test(src),
    "server-side epc sort expression still uses the 30-day cleanExpr, not lifetime");
  console.log("\nverify-creatives-lifetime OK.");
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
