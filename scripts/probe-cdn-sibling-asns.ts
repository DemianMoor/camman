import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. The approved relay set is {54113, 13335, 36183, 16591}. But the
// exact ASN list also holds sibling CDN ASNs (Akamai 20940/63949/16625/12222,
// Cloudflare 132892/209242). If those carry converting traffic too, they have
// the same Private Relay problem and the relay set is incomplete.
async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  console.table((await d.execute(sql`
    WITH per_send AS (
      SELECT ss.id, cl.asn, coalesce(cl.asn_org,'(null)') AS asn_org,
             ss.converted_at IS NOT NULL AS bought, coalesce(ss.sale_revenue,0) AS revenue
      FROM stage_sends ss JOIN clicks cl ON cl.link_id = ss.link_id
      WHERE cl.asn IN (20940, 63949, 16625, 12222, 132892, 209242, 8075, 16509, 14061, 16276, 24940)
      GROUP BY ss.id, cl.asn, cl.asn_org, ss.converted_at, ss.sale_revenue
    )
    SELECT asn, asn_org, count(*)::int AS clickers,
           count(*) FILTER (WHERE bought)::int AS buyers,
           round(100.0*count(*) FILTER (WHERE bought)/nullif(count(*),0),4) AS conv_pct,
           sum(revenue)::numeric(12,2) AS revenue
    FROM per_send GROUP BY 1,2 ORDER BY 3 DESC
  `)) as unknown as unknown[]);
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
