import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. The brief's dedup default is "unique clicker per campaign", but
// four of the six EPC surfaces are per-STAGE or per-CREATIVE. Campaign-grain
// dedup does not decompose additively across stages, so stage rows would not
// reconcile to the campaign total. Measure the size of that gap.
//
// Run: npx tsx scripts/probe-epc-dedup-grain.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const rows = await d.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    return (await tx.execute(sql`
      WITH human AS (
        SELECT l.campaign_id, l.stage_id, l.creative_id, l.contact_id
        FROM clicks c JOIN links l ON l.id = c.link_id
        WHERE c.classification = 'human'
      )
      SELECT count(DISTINCT (campaign_id::text || ':' || contact_id::text))::text AS per_campaign_contact,
             count(DISTINCT (stage_id::text    || ':' || contact_id::text))::text AS per_stage_contact,
             count(DISTINCT (creative_id::text || ':' || contact_id::text))::text AS per_creative_contact,
             count(*)::text AS raw_human_taps
      FROM human
    `)) as unknown as Record<string, string>[];
  });
  console.table(rows);
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
