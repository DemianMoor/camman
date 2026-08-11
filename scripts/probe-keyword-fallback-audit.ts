import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import { DATACENTER_ASNS } from "../lib/links/datacenter-asns";

// READ-ONLY. Before removing the org-keyword substring fallback from
// lib/links/datacenter-asns.ts, find every (asn, asn_org) it is actually
// catching in production that the exact ASN set does NOT. Each one must be
// consciously kept (add the ASN number) or dropped (it was a false positive).
// Deleting the fallback without this audit would silently reclassify real
// hosting ASNs as human.
//
// Run: npx tsx scripts/probe-keyword-fallback-audit.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const known = [...DATACENTER_ASNS];
  const knownList = sql.join(known.map((n) => sql`${n}`), sql`, `);

  const rows = (await d.execute(sql`
    SELECT asn, coalesce(asn_org, '(null)') AS asn_org,
           count(*)::int AS taps,
           count(*) FILTER (WHERE classification = 'human')::int AS as_human,
           count(DISTINCT link_id)::int AS links
    FROM clicks
    WHERE is_datacenter = true
      AND (asn IS NULL OR asn NOT IN (${knownList}))
    GROUP BY 1, 2 ORDER BY count(*) DESC
  `)) as unknown as Record<string, unknown>[];

  console.log(`\n=== ASNs caught ONLY by the org-keyword substring fallback ===`);
  console.log(`(exact list currently holds ${known.length} ASNs)\n`);
  console.table(rows);

  const total = rows.reduce((a, r) => a + Number(r.taps), 0);
  console.log(`distinct (asn, org) pairs caught only by keyword: ${rows.length}`);
  console.log(`total taps riding on the keyword fallback: ${total}`);

  // Conversion behaviour of each keyword-only ASN — the tell for a false
  // positive (real humans convert; hosting infrastructure does not).
  console.log(`\n=== Do any keyword-only ASNs convert? (false-positive tell) ===`);
  console.table(
    (await d.execute(sql`
      WITH per_send AS (
        SELECT ss.id, cl.asn, coalesce(cl.asn_org, '(null)') AS asn_org,
               ss.converted_at IS NOT NULL AS bought,
               coalesce(ss.sale_revenue, 0) AS revenue
        FROM stage_sends ss
        JOIN clicks cl ON cl.link_id = ss.link_id
        WHERE cl.is_datacenter = true
          AND (cl.asn IS NULL OR cl.asn NOT IN (${knownList}))
        GROUP BY ss.id, cl.asn, cl.asn_org, ss.converted_at, ss.sale_revenue
      )
      SELECT asn, asn_org, count(*)::int AS clickers,
             count(*) FILTER (WHERE bought)::int AS buyers,
             round(100.0 * count(*) FILTER (WHERE bought) / nullif(count(*),0), 4) AS conv_pct,
             sum(revenue)::numeric(12,2) AS revenue
      FROM per_send GROUP BY 1, 2
      HAVING count(*) FILTER (WHERE bought) > 0
      ORDER BY 4 DESC
    `)) as unknown as unknown[],
  );

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
