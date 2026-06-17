import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { propagateTrackedClickers } from "@/lib/links/propagate-clickers";

// One-time (idempotent) backfill: materialize all existing clean tracked
// clicks into the `clickers` table. Safe to re-run — propagateTrackedClickers
// skips contacts already present. Going forward the score-pending cron keeps
// `clickers` current automatically.
async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    const before = (await db.execute(
      sql`select count(*)::int as n from clickers where source = 'tracked_click'`,
    )) as unknown as { n: number }[];

    const { inserted } = await propagateTrackedClickers(db as never);

    const after = (await db.execute(
      sql`select count(*)::int as n from clickers where source = 'tracked_click'`,
    )) as unknown as { n: number }[];

    console.log(
      `tracked_click clickers: before=${before[0].n}, inserted=${inserted}, after=${after[0].n}`,
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
