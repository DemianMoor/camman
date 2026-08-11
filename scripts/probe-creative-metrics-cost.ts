import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { computeCreativeMetrics } from "@/lib/creatives/metrics-cache";
// Does the unbounded lifetime aggregate materially raise the cold-read cost of
// the creatives metrics cache? Flagged as a risk when the column was proposed;
// measured before shipping rather than assumed.
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:3}); const d=drizzle(c);
  const org=(await d.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as {id:string}[];
  const t=[] as number[];
  for (let i=0;i<3;i++){ const s=Date.now(); const rows=await computeCreativeMetrics(org[0].id); t.push(Date.now()-s);
    if(i===0){ const withLife=rows.filter(r=>r.lifetime_clean>0);
      console.log(`rows=${rows.length}, with lifetime clickers=${withLife.length}`);
      const ex=rows.filter(r=>r.lifetime_clean>r.tracked_clean+r.manual_clean).slice(0,4);
      console.table(ex.map(r=>({creative:r.creative_id, clean30:r.manual_clean+r.tracked_clean, cleanLife:r.lifetime_clean,
        epc30:(r.payout/Math.max(r.manual_clean+r.tracked_clean,1)).toFixed(4), epcLife:(r.lifetime_payout/Math.max(r.lifetime_clean,1)).toFixed(4)})));
    }}
  console.log(`compute timings (ms): ${t.join(", ")}  median=${t.sort((a,b)=>a-b)[1]}`);
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
