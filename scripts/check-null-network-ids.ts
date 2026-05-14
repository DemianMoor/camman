// Read-only diagnostic. Counts offers with NULL network_id, broken out by
// org. Used before the migration that makes offers.network_id NOT NULL —
// if any rows exist we stop and ask the user how to handle them.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);

  try {
    const totalRows = (await db.execute<{ count: string }>(drizzleSql`
      SELECT count(*)::text AS count FROM offers
    `)) as unknown as { count: string }[];
    const total = Number(totalRows[0]?.count ?? 0);

    const nullRows = (await db.execute<{ count: string }>(drizzleSql`
      SELECT count(*)::text AS count FROM offers WHERE network_id IS NULL
    `)) as unknown as { count: string }[];
    const nullCount = Number(nullRows[0]?.count ?? 0);

    console.log(`Total offers: ${total}`);
    console.log(`Offers with NULL network_id: ${nullCount}`);

    if (nullCount > 0) {
      const breakdown = (await db.execute<{
        org_id: string;
        cnt: string;
      }>(drizzleSql`
        SELECT org_id::text AS org_id, count(*)::text AS cnt
        FROM offers
        WHERE network_id IS NULL
        GROUP BY org_id
        ORDER BY count(*) DESC
      `)) as unknown as { org_id: string; cnt: string }[];

      console.log("\nBy org:");
      for (const row of breakdown) {
        console.log(`  ${row.org_id}: ${row.cnt}`);
      }

      const samples = (await db.execute<{
        id: number;
        offer_id: string;
        name: string;
        org_id: string;
      }>(drizzleSql`
        SELECT id, offer_id, name, org_id::text AS org_id
        FROM offers
        WHERE network_id IS NULL
        ORDER BY id ASC
        LIMIT 20
      `)) as unknown as {
        id: number;
        offer_id: string;
        name: string;
        org_id: string;
      }[];

      console.log("\nFirst 20 affected rows:");
      for (const row of samples) {
        console.log(
          `  id=${row.id} offer_id=${row.offer_id} name="${row.name}"`,
        );
      }
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
