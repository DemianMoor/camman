import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";

// Does the creatives picker's `epc desc` ordering change if it sorts by LIFETIME
// EPC instead of the 30-day figure? The picker drives which creatives get sent,
// so a material reshuffle is a business decision, not a build detail.
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:3}); const d=drizzle(c);
  const q=async(x:ReturnType<typeof sql>)=>(await d.execute(x)) as unknown as Record<string,unknown>[];
  const rows = await q(sql`
    WITH rev30 AS (
      SELECT cs.creative_id,
             sum((SELECT coalesce(sum(k.revenue),0) FROM keitaro_stage_results k WHERE k.stage_id=cs.id))::float8 AS revenue
      FROM campaign_stages cs
      WHERE cs.creative_id IS NOT NULL AND cs.created_at >= now() - interval '30 days'
      GROUP BY 1),
    den30 AS (
      SELECT creative_id, count(DISTINCT contact_id)::int AS denom FROM counted_clickers
      WHERE creative_id IS NOT NULL AND first_click_at >= now() - interval '30 days' GROUP BY 1),
    revlife AS (
      SELECT cs.creative_id,
             sum((SELECT coalesce(sum(k.revenue),0) FROM keitaro_stage_results k WHERE k.stage_id=cs.id))::float8 AS revenue
      FROM campaign_stages cs WHERE cs.creative_id IS NOT NULL GROUP BY 1),
    denlife AS (
      SELECT creative_id, count(DISTINCT contact_id)::int AS denom FROM counted_clickers
      WHERE creative_id IS NOT NULL GROUP BY 1)
    SELECT r30.creative_id,
           round((r30.revenue/nullif(d30.denom,0))::numeric,4) AS epc_30d,
           round((rl.revenue/nullif(dl.denom,0))::numeric,4) AS epc_life,
           d30.denom AS denom_30d, dl.denom AS denom_life,
           rank() OVER (ORDER BY r30.revenue/nullif(d30.denom,0) DESC NULLS LAST)::int AS rank_30d,
           rank() OVER (ORDER BY rl.revenue/nullif(dl.denom,0) DESC NULLS LAST)::int AS rank_life
    FROM rev30 r30
    JOIN den30 d30 ON d30.creative_id=r30.creative_id
    JOIN revlife rl ON rl.creative_id=r30.creative_id
    JOIN denlife dl ON dl.creative_id=r30.creative_id
    WHERE r30.revenue > 0
    ORDER BY rank_30d LIMIT 30`);
  console.table(rows.slice(0,20));
  const moves = rows.map(r=>Math.abs(Number(r.rank_30d)-Number(r.rank_life)));
  const t10a = new Set(rows.filter(r=>Number(r.rank_30d)<=10).map(r=>String(r.creative_id)));
  const t10b = new Set(rows.filter(r=>Number(r.rank_life)<=10).map(r=>String(r.creative_id)));
  const churn = [...t10a].filter(x=>!t10b.has(x));
  console.log(`\ncompared: ${rows.length}`);
  console.log(`mean |rank change|: ${(moves.reduce((a,b)=>a+b,0)/(moves.length||1)).toFixed(2)}`);
  console.log(`max  |rank change|: ${Math.max(0,...moves)}`);
  console.log(`top-10 leaving on a lifetime sort: ${churn.length} (${churn.join(", ")||"none"})`);
  console.log(`creatives with a 30d denom but <30 clickers (noisy 30d EPC): ${rows.filter(r=>Number(r.denom_30d)<30).length}`);
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
