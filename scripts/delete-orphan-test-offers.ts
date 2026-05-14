// Hard-deletes the 6 NULL-network_id "Rules Offer ..." rows left over by
// the segment-rules test script. Before deleting, reports any FK references
// (campaigns, creative_offers junctions, clickers, etc.) that could block.
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
    const targets = (await db.execute<{ id: number; offer_id: string }>(
      drizzleSql`
        SELECT id, offer_id
        FROM offers
        WHERE network_id IS NULL
        ORDER BY id ASC
      `,
    )) as unknown as { id: number; offer_id: string }[];

    if (targets.length === 0) {
      console.log("No offers with NULL network_id. Nothing to do.");
      return;
    }

    const ids = targets.map((r) => r.id);
    console.log(`Found ${targets.length} target offers:`);
    for (const t of targets) console.log(`  id=${t.id} offer_id=${t.offer_id}`);

    // We construct the id list as a raw SQL fragment because postgres-js's
    // array binding doesn't always coerce to integer[] correctly through
    // drizzle's tagged template. IDs are server-validated integers from
    // the first query, so direct interpolation is safe here.
    const idList = drizzleSql.raw(ids.join(","));

    // FK reference scan
    const checks: { table: string; sql: ReturnType<typeof drizzleSql> }[] = [
      {
        table: "campaigns (ON DELETE RESTRICT — blocking)",
        sql: drizzleSql`SELECT count(*)::int AS n FROM campaigns WHERE offer_id IN (${idList})`,
      },
      {
        table: "creative_offers (ON DELETE CASCADE — auto-clean)",
        sql: drizzleSql`SELECT count(*)::int AS n FROM creative_offers WHERE offer_id IN (${idList})`,
      },
      {
        table: "clickers (ON DELETE SET NULL — auto-clean)",
        sql: drizzleSql`SELECT count(*)::int AS n FROM clickers WHERE offer_id IN (${idList})`,
      },
    ];

    let blocking = 0;
    for (const c of checks) {
      const rows = (await db.execute(c.sql)) as unknown as { n: number }[];
      const n = rows[0]?.n ?? 0;
      console.log(`  ${c.table}: ${n} refs`);
      if (c.table.includes("blocking") && n > 0) blocking += n;
    }

    if (blocking > 0) {
      console.error(
        `\nBlocked: ${blocking} campaigns still reference these offers (ON DELETE RESTRICT). Aborting.`,
      );
      process.exit(2);
    }

    const deleted = (await db.execute<{ id: number }>(drizzleSql`
      DELETE FROM offers WHERE id IN (${idList}) RETURNING id
    `)) as unknown as { id: number }[];
    console.log(`\nDeleted ${deleted.length} offers.`);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
