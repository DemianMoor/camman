import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY post-backfill verification: did the excluded-buyer problem shrink
// as predicted, and did the human-clicker denominator move as predicted?
async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async (query: ReturnType<typeof sql>) => {
    let out: Record<string, unknown>[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as Record<string, unknown>[];
    });
    return out;
  };
  console.log("\n=== buyers vs the human denominator, AFTER backfill ===");
  console.table(await q(sql`
    WITH conv AS (
      SELECT ss.id, ss.link_id, coalesce(ss.sale_revenue,0) AS revenue
      FROM stage_sends ss WHERE ss.converted_at IS NOT NULL
    ),
    own AS (
      SELECT conv.id, conv.revenue, count(cl.id) AS taps,
             bool_or(cl.classification = 'human') AS any_human
      FROM conv LEFT JOIN clicks cl ON cl.link_id = conv.link_id
      GROUP BY conv.id, conv.revenue
    )
    SELECT CASE WHEN taps = 0 THEN 'no CamMan click at all'
                WHEN any_human THEN 'in denominator (human)'
                ELSE 'STILL EXCLUDED (needs Rule F)' END AS bucket,
           count(*)::text AS buyers, sum(revenue)::numeric(12,2) AS revenue
    FROM own GROUP BY 1 ORDER BY 2 DESC
  `));
  console.log("\n=== denominator movement (campaign grain, human clickers) ===");
  console.table(await q(sql`
    SELECT count(DISTINCT (l.campaign_id::text||':'||l.contact_id::text))::text AS human_clickers_campaign_grain,
           count(DISTINCT (l.stage_id::text||':'||l.contact_id::text))::text    AS human_clickers_stage_grain
    FROM clicks cl JOIN links l ON l.id = cl.link_id
    WHERE cl.classification = 'human'
  `));
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
