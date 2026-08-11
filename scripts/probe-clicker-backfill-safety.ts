import { config } from "dotenv"; import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
// READ-ONLY. Would backfilling `clickers` cause anything to SEND?
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:1}); const d=drizzle(c);
  const q=async(x:ReturnType<typeof sql>)=>(await d.execute(x)) as unknown as unknown[];
  console.log("\n=== campaigns by status (frozen pools vs future snapshots) ===");
  console.table(await q(sql`
    SELECT status, count(*)::text AS campaigns,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM campaign_audience_pool p WHERE p.campaign_id = c.id))::text AS with_frozen_pool
    FROM campaigns c GROUP BY 1 ORDER BY count(*) DESC`));
  console.log("\n=== stages that could still fire (pending work on non-draft campaigns) ===");
  console.table(await q(sql`
    SELECT c.status AS campaign_status,
           count(*)::text AS stages_unsent,
           count(*) FILTER (WHERE cs.scheduled_at IS NOT NULL)::text AS scheduled,
           count(*) FILTER (WHERE cs.include_clickers OR cs.exclude_clickers)::text AS uses_clicker_filter
    FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.sent_at IS NULL AND cs.archived_at IS NULL AND c.status <> 'draft'
    GROUP BY 1 ORDER BY 2 DESC`));
  console.log("\n=== segments whose rules reference clicker status (future snapshots) ===");
  console.table(await q(sql`
    SELECT rule_type, count(*)::text AS rules, count(DISTINCT segment_id)::text AS segments,
           count(*) FILTER (WHERE is_active)::text AS active
    FROM segment_rules WHERE rule_type ILIKE '%clicker%' GROUP BY 1 ORDER BY 2 DESC`));
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
