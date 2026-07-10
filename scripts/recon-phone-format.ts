// One-off recon (READ-ONLY): confirm the stored format of contacts.phone_number
// so the Telnyx lookup cache (phone_lookups.phone) normalizes to the SAME shape
// and the join actually hits. Safe to run anytime — SELECT only.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const client = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(client);

  const total = await db.execute<{ n: string }>(
    drizzleSql`SELECT count(*)::text AS n FROM contacts`,
  );
  console.log("total contacts:", total[0]?.n);

  const shape = await db.execute<{ bucket: string; n: string }>(drizzleSql`
    SELECT
      CASE
        WHEN phone_number ~ '^\\+1[0-9]{10}$'      THEN 'e164_us (+1 + 10 digits)'
        WHEN phone_number ~ '^\\+[0-9]{7,15}$'     THEN 'e164_other (+ intl)'
        WHEN phone_number ~ '^1[0-9]{10}$'         THEN 'us_11_no_plus (1XXXXXXXXXX)'
        WHEN phone_number ~ '^[0-9]{10}$'          THEN 'us_10_no_plus (XXXXXXXXXX)'
        WHEN phone_number ~ '^\\+'                 THEN 'other_plus'
        ELSE 'other'
      END AS bucket,
      count(*)::text AS n
    FROM contacts
    GROUP BY 1
    ORDER BY count(*) DESC
  `);
  console.log("\nphone_number format buckets:");
  for (const r of shape) console.log(`  ${r.bucket.padEnd(28)} ${r.n}`);

  const samples = await db.execute<{ phone_number: string }>(drizzleSql`
    SELECT phone_number FROM contacts
    WHERE phone_number !~ '^\\+1[0-9]{10}$'
    LIMIT 10
  `);
  console.log("\nsample non-(+1+10) values (up to 10):");
  if (samples.length === 0) console.log("  (none — all rows are +1XXXXXXXXXX)");
  for (const r of samples) console.log("  ", JSON.stringify(r.phone_number));

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
