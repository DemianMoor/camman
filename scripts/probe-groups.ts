import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const rows = (await db.execute(drizzleSql`
    SELECT cg.id, cg.name, cg.color,
      (SELECT count(*)::int FROM contact_contact_groups ccg WHERE ccg.contact_group_id = cg.id) AS contact_count
    FROM contact_groups cg
    WHERE cg.org_id = 'b0ce3435-5ea2-4510-ab11-8cdd0d0c125b'
    ORDER BY cg.created_at DESC
  `)) as unknown as { id: number; name: string; color: string | null; contact_count: number }[];
  console.log("Contact groups + member counts:");
  for (const r of rows) console.log(`  id=${r.id} name=${r.name} color=${r.color} count=${r.contact_count}`);

  // Also: list active rules and their stored values.
  const rules = (await db.execute(drizzleSql`
    SELECT s.id AS segment_id, s.name AS segment_name,
      sr.id AS rule_id, sr.rule_type, sr.operator, sr.value, sr.is_active
    FROM segments s
    JOIN segment_rules sr ON sr.segment_id = s.id
    WHERE s.org_id = 'b0ce3435-5ea2-4510-ab11-8cdd0d0c125b'
    ORDER BY sr.updated_at DESC
  `)) as unknown as Record<string, unknown>[];
  console.log("\nAll rules (newest first):");
  for (const r of rules) console.log(`  ${JSON.stringify(r)}`);

  await pg.end({ timeout: 3 });
}
main().catch((e) => { console.error(e); process.exit(1); });
